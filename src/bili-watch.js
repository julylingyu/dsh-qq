// dsh-bili-watch 的 CLI 封装。
//
// 为什么用 CLI 而不是装插件：桌面版 0.2.1-rc.3 的 profile 里没有
// `@deepseek-ai/dsh-tools`，插件要以 peer 解析它；硬装一份会和宿主自带的
// 那份形成双实例，把**工具执行链**搞断（实测：所有工具调用返回「结果没落地」）。
// 所以把仓库放在 profile 之外（默认 E:\dsh\tools\dsh-bili-watch），只当命令行用。
//
// 命令：view / peek / comments / danmaku / search / hot / sub / frames / sheet / asr
// 只读类命令零依赖；抽帧/OCR/ASR 需要 ffmpeg 及它自己的 deps。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function resolveBiliWatchConfig(cfg = {}) {
  const b = cfg.socialV2?.bili ?? {};
  return {
    enabled: b.cliEnabled !== false,
    dir: path.resolve(String(b.cliDir || 'E:\\dsh\\tools\\dsh-bili-watch')),
    timeoutMs: Number(b.cliTimeoutMs) || 60000,
    maxChars: Number(b.cliMaxChars) || 6000,
  };
}

function run(args, { dir, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const script = path.join(dir, 'tools', 'look.mjs');
    if (!fs.existsSync(script)) {
      reject(new Error(`找不到 bili-watch CLI：${script}`));
      return;
    }
    const child = spawn(process.execPath, [script, ...args], {
      cwd: dir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error(`bili-watch 超时（${timeoutMs}ms）`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`bili-watch 退出码 ${code}：${err.trim().slice(0, 400) || out.trim().slice(0, 400)}`));
    });
  });
}

/**
 * 跑一条 bili-watch 命令。
 * @param {'view'|'peek'|'comments'|'danmaku'|'search'|'hot'|'sub'} action
 * @param {string} target  BV 号/链接（search 时是关键词，hot 时忽略）
 */
export async function runBiliWatch(action, target, { limit, format, outDir, cfg = {}, log = () => {} } = {}) {
  const c = resolveBiliWatchConfig(cfg);
  if (!c.enabled) return { ok: false, error: 'bili 的 CLI 已关闭（socialV2.bili.cliEnabled=false）' };
  const args = [action];
  let outFile = '';
  if (action === 'hot') {
    if (limit) args.push('--limit', String(limit));
  } else if (action === 'search') {
    if (!String(target ?? '').trim()) return { ok: false, error: 'search 需要关键词' };
    args.push(String(target).trim());
    if (limit) args.push('--limit', String(limit));
  } else if (action === 'comments') {
    if (!target) return { ok: false, error: `${action} 需要 BV 号或链接` };
    args.push(String(target));
    if (limit) args.push(String(limit));
  } else {
    if (!target) return { ok: false, error: `${action} 需要 BV 号或链接` };
    args.push(String(target));
    // 字幕：srt/md 带时间戳与跳转链接，直接落盘再回一段开头，避免把整篇塞进上下文。
    if (action === 'sub' && format) {
      const fmt = String(format).toLowerCase();
      if (!['text', 'srt', 'md', 'json', 'txt'].includes(fmt)) return { ok: false, error: `不支持的 format：${format}` };
      const dir = path.resolve(outDir || path.join(c.dir, 'subs'));
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(target).replace(/[^0-9A-Za-z_-]/g, '').slice(0, 40) || 'sub';
      outFile = path.join(dir, `${safe}-${Date.now()}.${fmt === 'text' ? 'txt' : fmt}`);
      args.push('--format', fmt, '--out', outFile);
    }
  }
  try {
    const text = await run(args, c);
    // --out 模式下 CLI 不往 stdout 打正文，直接从落盘文件取开头做预览。
    let preview = text;
    if (outFile && fs.existsSync(outFile)) {
      preview = fs.readFileSync(outFile, 'utf8').slice(0, c.maxChars);
    }
    const head = preview.slice(0, c.maxChars);
    const result = { ok: true, action, text: head, chars: head.length, truncated: preview.length > c.maxChars };
    if (outFile) {
      result.path = outFile;
      result.savedChars = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
    }
    return result;
  } catch (error) {
    log(`[bili] ${action} 失败：${error?.message ?? error}`);
    return { ok: false, action, error: String(error?.message ?? error) };
  }
}
