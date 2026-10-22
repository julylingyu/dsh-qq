// 视频关键帧抽取：把 QQ 视频消息变成几张图片，交给视觉模型「看」。
//
// 为什么在本地抽帧而不是把视频交给模型：DSH 的模型输入只接受图片（image parts），
// OneBot 的 video 段是 mp4 文件/URL，模型侧没有视频通道。所以链路是
//   视频 URL / 本地缓存文件 → ffmpeg 均匀抽 N 帧（缩到 maxWidth）→ JPEG → image parts。
//
// 安全边界：
//   · 只接受 http(s) URL 或**调用方已校验过的**本地路径（见 bridge.js 的 isVideoLocalPath）；
//   · ffmpeg 用 spawn + 参数数组执行，绝不拼 shell 字符串；
//   · 有超时，超时直接 kill；临时目录用完即删；
//   · 帧数量/宽度/文件大小上限由调用方（socialV2.media.video）收敛。
//
// 这个模块不依赖 SnowLuma / DSH，可以单独跑（scripts/test-video-frames.mjs 用它做回归）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const VIDEO_DEFAULTS = Object.freeze({
  enabled: true,              // 视频抽帧总开关
  ffmpegPath: '',             // 空 = 依次找 PATH / 常见安装位置
  maxBytes: 50 * 1024 * 1024, // 单个视频文件大小上限（下载与本地文件都受它约束）
  frames: 6,                  // 每个视频抽几张关键帧
  maxWidth: 720,              // 帧的最大宽度（等比缩放，不放大）
  timeoutMs: 60000            // 单次 ffmpeg 任务超时
});

const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.ts', '.3gp']);

/** 按配置 → PATH → 常见安装位置 找一个可用的 ffmpeg 可执行文件；找不到返回 null。 */
export function resolveFfmpeg(configured, { platform = process.platform, env = process.env } = {}) {
  const exe = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [];
  const push = (p) => { if (p) candidates.push(String(p)); };
  push(configured);
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (dir) push(path.join(dir, exe));
  }
  if (platform === 'win32') {
    push(path.join(env.ProgramFiles ?? 'C:\\Program Files', 'ffmpeg', 'bin', exe));
    push(path.join(env.ProgramFiles ?? 'C:\\Program Files', 'ffmpeg', exe));
    if (env.LOCALAPPDATA) push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe));
    push('C:\\ffmpeg\\bin\\ffmpeg.exe');
  } else {
    push('/usr/bin/ffmpeg');
    push('/usr/local/bin/ffmpeg');
    push('/opt/homebrew/bin/ffmpeg');
  }
  const seen = new Set();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* 不存在就试下一个 */ }
  }
  return null;
}

/** 只按扩展名/文件名快速判断像不像视频（真正的解码交给 ffmpeg）。 */
export function looksLikeVideoFile(filePath) {
  const ext = path.extname(String(filePath ?? '')).toLowerCase();
  return VIDEO_EXTS.has(ext);
}

function runFfmpeg(ffmpegPath, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch { /* 已退出 */ }
      finish({ ok: false, timedOut: true, stderr });
    }, Math.max(1000, Number(timeoutMs) || VIDEO_DEFAULTS.timeoutMs));
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      finish({ ok: false, error: error?.message ?? String(error), stderr });
      return;
    }
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 16384) stderr += String(chunk);
    });
    child.on('error', (error) => finish({ ok: false, error: error?.message ?? String(error), stderr }));
    child.on('close', (code) => finish({ ok: code === 0, code, stderr }));
  });
}

/** 从 ffmpeg 的 stderr 里读时长（秒）。读不到返回 null。 */
export function parseDurationSeconds(stderr) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(stderr ?? ''));
  if (!m) return null;
  const total = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/** 探一下时长与分辨率；顺带确认输入确实有视频流。 */
export async function probeVideo(ffmpegPath, input, { timeoutMs = 20000 } = {}) {
  if (!ffmpegPath) return { ok: false, error: 'ffmpeg 不可用' };
  const r = await runFfmpeg(ffmpegPath, ['-hide_banner', '-i', input], timeoutMs);
  const stderr = String(r.stderr ?? '');
  const duration = parseDurationSeconds(stderr);
  const stream = /Stream #\d+:\d+.*?: Video: /.test(stderr);
  if (!stream) return { ok: false, duration, error: '输入里没有视频流' };
  const size = /, (\d{2,5})x(\d{2,5})[ ,]/.exec(stderr);
  return {
    ok: true,
    duration,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null
  };
}

function listFrames(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => /^f-\d+\.jpg$/i.test(name))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/**
 * 从一个本地视频文件抽帧。
 * @returns {Promise<{frames: Array<{buffer: Buffer, mimeType: string}>, duration: number|null, error?: string}>}
 */
export async function extractVideoFramesFromFile(input, {
  ffmpegPath,
  frames = VIDEO_DEFAULTS.frames,
  maxWidth = VIDEO_DEFAULTS.maxWidth,
  timeoutMs = VIDEO_DEFAULTS.timeoutMs
} = {}) {
  const ffmpeg = ffmpegPath || resolveFfmpeg('');
  if (!ffmpeg) return { frames: [], duration: null, error: '找不到 ffmpeg：请安装 ffmpeg，或在 config.json 的 socialV2.media.video.ffmpegPath 指定路径' };
  if (!input) return { frames: [], duration: null, error: '没有视频输入' };
  let stat;
  try { stat = fs.statSync(input); } catch { return { frames: [], duration: null, error: `视频文件不存在：${input}` }; }
  if (!stat.isFile() || stat.size === 0) return { frames: [], duration: null, error: '视频文件为空或不是普通文件' };

  const want = Math.min(12, Math.max(1, Math.round(Number(frames) || VIDEO_DEFAULTS.frames)));
  const width = Math.min(1280, Math.max(160, Math.round(Number(maxWidth) || VIDEO_DEFAULTS.maxWidth)));
  const probe = await probeVideo(ffmpeg, input, { timeoutMs: Math.min(30000, Number(timeoutMs) || 20000) });
  const duration = probe.duration;

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-video-'));
  const outPattern = path.join(outDir, 'f-%02d.jpg');
  // scale 表达式里含逗号，必须用单引号包住（spawn 不走 shell，ffmpeg 的 filter 解析器认单引号）。
  const scale = `scale='min(${width},iw)':-2`;
  const attempts = [];
  if (duration) {
    const fps = Math.min(4, want / duration);
    attempts.push(`fps=${fps.toFixed(4)},${scale}`);
  }
  attempts.push(`select='eq(pict_type,I)',${scale}`);
  attempts.push(`fps=1,${scale}`);

  let lastError = probe.ok ? '' : (probe.error ?? '探测失败');
  try {
    for (const vf of attempts) {
      for (const name of listFrames(outDir)) {
        try { fs.rmSync(name, { force: true }); } catch { /* ignore */ }
      }
      const r = await runFfmpeg(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-i', input,
        '-vf', vf,
        '-vsync', 'vfr',
        '-frames:v', String(want),
        '-q:v', '3',
        outPattern
      ], Math.min(180000, Number(timeoutMs) || VIDEO_DEFAULTS.timeoutMs));
      const produced = listFrames(outDir);
      if (produced.length) {
        const out = [];
        for (const file of produced.slice(0, want)) {
          try { out.push({ buffer: fs.readFileSync(file), mimeType: 'image/jpeg' }); } catch { /* ignore */ }
        }
        if (out.length) return { frames: out, duration };
        continue;
      }
      if (r.timedOut) lastError = `ffmpeg 超时（${timeoutMs}ms）`;
      else if (r.error) lastError = r.error;
      else lastError = String(r.stderr ?? '').trim().slice(0, 300) || `ffmpeg 退出码 ${r.code}`;
    }
    return { frames: [], duration, error: lastError || '没能从视频里抽出任何帧' };
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 从内存里的视频字节抽帧（先落一个临时文件：mp4 的解复用需要可 seek 的输入）。 */
export async function extractVideoFramesFromBuffer(buffer, options = {}) {
  if (!buffer || !buffer.length) return { frames: [], duration: null, error: '视频字节为空' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-video-src-'));
  const file = path.join(dir, `src-${crypto.randomBytes(4).toString('hex')}.mp4`);
  try {
    fs.writeFileSync(file, buffer);
    return await extractVideoFramesFromFile(file, options);
  } catch (error) {
    return { frames: [], duration: null, error: error?.message ?? String(error) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
