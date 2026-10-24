// B站视频信息：标题/UP/简介/时长 + 热门评论 + 字幕（需要登录 cookie）。
//
// 为什么这么做：让 agent「看懂」一个 B站 视频，不必真的放声音——
//   标题 + 简介 + 高赞评论 + 弹幕，已经能还原 80% 的上下文；
//   字幕是最准的，但 B站 的字幕接口要 SESSDATA cookie（配置 socialV2.bili.sessdata）。
import zlib from 'node:zlib';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

function headers(sessdata = '') {
  return {
    'user-agent': UA,
    referer: 'https://www.bilibili.com/',
    ...(sessdata ? { cookie: `SESSDATA=${sessdata}` } : {}),
  };
}

/** 从 URL / BV 号 / b23.tv 短链里取 BV 号；拿不到返回空串。 */
export function extractBvid(input) {
  const s = String(input ?? '').trim();
  const direct = /(BV[0-9A-Za-z]{10})/.exec(s);
  if (direct) return direct[1];
  const av = /\/av(\d+)/i.exec(s);
  if (av) return `av${av[1]}`;
  return '';
}

async function getJson(url, sessdata, timeoutMs = 12000) {
  const res = await fetch(url, { headers: headers(sessdata), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`B站 API HTTP ${res.status}`);
  const body = await res.json();
  if (body?.code !== 0) throw new Error(`B站 API 返回 code=${body?.code}：${body?.message ?? ''}`);
  return body.data;
}

/** 取一个视频的标题/UP/简介/时长/评论/字幕。 */
export async function fetchVideoInfo(input, { sessdata = '', maxComments = 8, maxSubtitleChars = 4000 } = {}) {
  const id = extractBvid(input);
  if (!id) return { ok: false, error: '没识别出 BV 号（给完整链接或 BVxxxxxxxxxx 都行）' };
  const key = id.startsWith('av') ? `aid=${id.slice(2)}` : `bvid=${id}`;
  const view = await getJson(`https://api.bilibili.com/x/web-interface/view?${key}`, sessdata);
  const info = {
    bvid: view.bvid,
    aid: view.aid,
    cid: view.cid,
    title: view.title,
    owner: view.owner?.name ?? '',
    durationSec: view.duration ?? 0,
    desc: String(view.desc ?? '').slice(0, 300),
    view: view.stat?.view ?? 0,
    like: view.stat?.like ?? 0,
  };

  let comments = [];
  try {
    const reply = await getJson(`https://api.bilibili.com/x/v2/reply?type=1&oid=${view.aid}&sort=2&ps=${maxComments}&pn=1`, sessdata);
    comments = (reply?.replies ?? []).map((r) => ({ user: r.member?.uname ?? '', text: String(r.content?.message ?? '').slice(0, 120), like: r.like ?? 0 }));
  } catch { /* 评论拿不到不影响主流程 */ }

  let subtitle = '';
  let subtitleLangs = [];
  try {
    const player = await getJson(`https://api.bilibili.com/x/player/v2?bvid=${view.bvid}&cid=${view.cid}`, sessdata);
    subtitleLangs = (player?.subtitle?.subtitles ?? []).map((s) => s.lan ?? '');
    const first = (player?.subtitle?.subtitles ?? [])[0];
    if (first?.subtitle_url) {
      const url = String(first.subtitle_url).replace(/^http:/, 'https:').startsWith('//') ? `https:${first.subtitle_url}` : first.subtitle_url;
      const res = await fetch(url, { headers: headers(sessdata), signal: AbortSignal.timeout(12000) });
      const body = await res.json();
      subtitle = (body?.body ?? []).map((line) => line.content).join(' ').replace(/\s+/g, ' ').slice(0, maxSubtitleChars);
    }
  } catch { /* 字幕失败不影响主流程 */ }

  return {
    ok: true,
    ...info,
    comments,
    subtitleLangs,
    subtitle,
    hasSubtitle: Boolean(subtitle),
    subtitleHint: subtitle ? undefined : (sessdata ? '这个视频没有可用字幕' : '未配置 SESSDATA，读不到字幕；可以先看简介和评论'),
  };
}

/** 取热弹幕（不需要登录）。 */
export async function fetchDanmaku(cid, { limit = 30, timeoutMs = 12000 } = {}) {
  const res = await fetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, { headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`弹幕 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let xml = '';
  try { xml = zlib.inflateRawSync(buf).toString('utf8'); } catch { xml = buf.toString('utf8'); }
  const out = [];
  const re = /<d p="[^"]*">([^<]*)<\/d>/g;
  let m;
  while ((m = re.exec(xml)) && out.length < limit * 5) {
    const text = m[1].trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return { ok: true, count: out.length, items: out.slice(0, limit) };
}
