// QQ 语音转写：把 record 段变成文字。
//
// 链路（教程路线 A + 本地 whisper）：
//   1. SnowLuma 的 `get_record` 两步：先拿新鲜下载地址，再让它转成 wav（返回 base64）。
//      一步到位会报 "Invalid data found"（SILK 解不开），所以必须两步。
//   2. 写临时 wav → 用 VoiceStudio 的 venv（faster-whisper）跑 scripts/transcribe.py。
//   3. 结果按原始 file 标识缓存 10 分钟，同一条语音重复处理不再跑模型。
//
// 任何一步失败都返回空串：语音照旧显示 `[语音]`，不影响消息主流程。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 200;
const cache = new Map();

const DEFAULT_PYTHON_CANDIDATES = [
  'C:\\Users\\15031\\.dsh\\voice-studio-venv\\Scripts\\python.exe',
];

export function defaultAsrPython() {
  if (process.env.QQ_ASR_PYTHON) return process.env.QQ_ASR_PYTHON;
  for (const candidate of DEFAULT_PYTHON_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return '';
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.text;
}

function cacheSet(key, text) {
  cache.set(key, { at: Date.now(), text });
  if (cache.size > MAX_CACHE) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, cache.size - MAX_CACHE);
    for (const [k] of oldest) cache.delete(k);
  }
}

/** 跑一次 whisper 转写（faster-whisper，venv python）。 */
function runWhisper({ python, script, audio, model, language, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, audio, '--model', model, '--language', language], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`whisper 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`whisper 退出码 ${code}：${err.trim().slice(0, 300)}`));
    });
  });
}

/**
 * 转写一条语音。
 * @param {object} opts
 * @param {(action:string, params:object)=>Promise<any>} opts.call  OneBot 调用（bridge 的 bot.raw 或 HTTP）
 * @param {string} opts.file      record 段里的 file 标识
 * @param {object} opts.asr       { enabled, python, model, language, timeoutMs }
 * @param {string} opts.script    transcribe.py 的绝对路径
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<string>}     转写文本；失败返回 ''
 */
export async function transcribeRecord({ call, file, asr = {}, script, log = () => {} }) {
  if (asr.enabled === false) return '';
  const raw = String(file ?? '').trim();
  if (!raw) return '';
  const cached = cacheGet(raw);
  if (cached !== undefined) return cached;

  const python = asr.python || defaultAsrPython();
  if (!python) {
    log('[asr] 没有可用的 python（whisper 跳过了；可设 socialV2.voice.asr.python）');
    return '';
  }
  if (!script || !fs.existsSync(script)) {
    log(`[asr] 找不到转写脚本 ${script}`);
    return '';
  }

  try {
    // ① 拿新鲜地址；② 再转 wav（两步，见文件头注释）
    const first = await call('get_record', { file: raw });
    const url = first?.file ?? first?.data?.file;
    if (!url) throw new Error('get_record 没有返回下载地址');
    const second = await call('get_record', { file: url, out_format: 'wav' });
    const base64 = second?.base64 ?? second?.data?.base64;
    if (!base64) throw new Error('get_record 没有返回 base64 音频');
    const audio = path.join(os.tmpdir(), `qq-voice-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
    fs.writeFileSync(audio, Buffer.from(base64, 'base64'));
    try {
      const text = await runWhisper({
        python,
        script,
        audio,
        model: asr.model || 'small',
        language: asr.language || 'zh',
        timeoutMs: Number(asr.timeoutMs) || 120000,
      });
      cacheSet(raw, text);
      if (text) log(`[asr] 语音转写：${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`);
      return text;
    } finally {
      try { fs.unlinkSync(audio); } catch {}
    }
  } catch (error) {
    log(`[asr] 转写失败：${error?.message ?? error}`);
    cacheSet(raw, '');
    return '';
  }
}
