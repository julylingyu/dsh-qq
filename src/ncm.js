// 网易云音乐 PC 端「耳朵」：通过 CDP 读当前播放状态。
//
// 前提：网易云要以调试参数启动（它的参数每次重启都会丢）：
//   cloudmusic.exe --remote-debugging-port=9222 --remote-allow-origins=*
// 端口/路径都可在 config.json 的 ears 段覆盖；拿不到状态时返回 null，不影响聊天。
//
// 实现细节：
//   - 先 GET /json 找 type=page 的 target；CDP 的 Runtime.evaluate 走 WebSocket，
//     Node 22+ 自带全局 WebSocket，不用额外依赖。
//   - 页面里的播放条 DOM 类名会随版本变，所以按「多个候选 selector 依次尝试」，
//     都不中就当没在播。
//   - 结果缓存 15 秒：唤醒频率高于轮询频率时不要每次都问一遍。
import fs from 'node:fs';

const CACHE_TTL_MS = 15000;
let cache = { at: 0, value: null };

export function resolveEarsConfig(cfg = {}) {
  const e = cfg.ears && typeof cfg.ears === 'object' ? cfg.ears : {};
  return {
    enabled: e.enabled !== false,
    port: Number(e.port) || 9222,
    cacheTtlMs: Number(e.cacheTtlMs) || CACHE_TTL_MS,
    launchPath: String(e.launchPath || ''),
    timeoutMs: Number(e.timeoutMs) || 2500,
  };
}

async function listTargets(port, timeoutMs) {
  const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`CDP /json HTTP ${res.status}`);
  const list = await res.json();
  return Array.isArray(list) ? list : [];
}

function pickTarget(targets) {
  const pages = targets.filter((t) => t && t.type === 'page' && t.webSocketDebuggerUrl);
  return pages.find((t) => /orpheus|cloudmusic|music\.163/i.test(String(t.url ?? ''))) ?? pages[0] ?? null;
}

function evaluate(wsUrl, expression, timeoutMs) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('CDP evaluate 超时'));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: false } }));
    });
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (msg.error) reject(new Error(`CDP 错误：${msg.error.message ?? JSON.stringify(msg.error)}`));
      else resolve(msg.result?.result?.value);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP WebSocket 连接失败'));
    });
  });
}

const EXPRESSION = `(() => {
  const pick = (sels) => {
    for (const s of sels) {
      const el = document.querySelector(s);
      const t = el && (el.innerText || el.textContent);
      if (t && String(t).trim()) return String(t).trim();
    }
    return '';
  };
  // 新版网易云（Orpheus）播放条的类名一直在变，所以先试一批常见选择器，
  // 再退回 document.title —— 它播放时会被改成「歌名 - 歌手 - 网易云音乐」，最稳。
  let title = pick([
    '.title-playing', '[class*="title-playing"]',
    '.m-playbar .words .name a', '.m-playbar .words .name', '.playbar .words .name',
    '.songName', '.song-name', '[class*="songName"]', '[class*="nowPlaying"] [class*="name"]',
    '.player-bar .name', '.title',
  ]);
  let artist = pick([
    '.sub-title-playing', '[class*="sub-title-playing"]', '.artists',
    '.m-playbar .words .by a', '.m-playbar .words .by', '.songName .artist', '.artist', '.singerName', '[class*="singer"]',
  ]);
  const lyric = pick([
    '.lyric-current', '.current-lyric', '.m-playbar .lyric .current',
    '.lyric .active', '[class*="lyric"] .active', '[class*="Lyric"] [class*="current"]',
  ]);
  const docTitle = String(document.title || '').replace(/\\s*-\\s*网易云音乐\\s*$/, '').trim();
  if (!title && docTitle && docTitle !== '网易云音乐') {
    const parts = docTitle.split(/\\s+-\\s+/);
    title = parts[0] || '';
    if (!artist && parts.length > 1) artist = parts.slice(1).join(' - ');
  }
  return JSON.stringify({ title, artist, lyric });
})()`;

/**
 * 读当前播放状态；没在播 / 没开 CDP / 读失败都返回 null。
 * @returns {Promise<null|{title:string, artist:string, lyric:string}>}
 */
export async function readNowPlaying(cfg = {}, { now = Date.now() } = {}) {
  const ears = resolveEarsConfig(cfg);
  if (!ears.enabled) return null;
  if (cache.value && now - cache.at < ears.cacheTtlMs) return cache.value;
  let value = null;
  try {
    const targets = await listTargets(ears.port, ears.timeoutMs);
    const target = pickTarget(targets);
    if (target) {
      const raw = await evaluate(target.webSocketDebuggerUrl, EXPRESSION, ears.timeoutMs);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.title) {
          value = {
            title: String(parsed.title).slice(0, 80),
            artist: String(parsed.artist ?? '').slice(0, 60),
            lyric: String(parsed.lyric ?? '').slice(0, 80),
          };
        }
      }
    }
  } catch {
    value = null;
  }
  cache = { at: now, value };
  return value;
}

/** 拼成提示词里的「他在听什么」小节；没在播返回空串。 */
export function buildMusicContext(nowPlaying) {
  if (!nowPlaying?.title) return '';
  const who = nowPlaying.artist ? ` - ${nowPlaying.artist}` : '';
  const line = nowPlaying.lyric ? `，他正听到这一句：「${nowPlaying.lyric}」` : '';
  return `【他在听什么·实时】他在听《${nowPlaying.title}》${who}${line}\n`;
}

/** 起始网易云（会先杀掉现有进程再带调试参数启动）。返回 { ok, path, port }。 */
export function launchWithCdp(ears) {
  const launchPath = String(ears.launchPath || 'C:\\Program Files\\Netease\\CloudMusic\\cloudmusic.exe');
  if (!fs.existsSync(launchPath)) throw new Error(`找不到网易云：${launchPath}（可在 ears.launchPath 指定）`);
  return { ok: true, path: launchPath, port: ears.port };
}
