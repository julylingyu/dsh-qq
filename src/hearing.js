// 「听」系统声音：WASAPI 环形录音 → 归一化 → faster-whisper 转写。
//
// 为什么能不用虚拟声卡：Windows 的 WASAPI loopback（PyAudioWPatch 暴露成
// "[Loopback]" 输入）直接录默认输出设备，录到的就是正在放的声音。
//
// 三个坑（都踩过）：
//   1. 录下来的电平很小（浏览器/播放器音量低）：不归一化的话 whisper 直接返回空；
//   2. 48k 双声道必须降成 16k 单声道再喂模型；
//   3. Windows 上 python 默认 GBK 输出 → 桥接读成乱码，必须 PYTHONIOENCODING=utf-8。
//
// 失败一律返回 { ok:false, error }，调用方照旧聊天，不要因为听不到就卡住。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function run(cmd, args, { timeoutMs = 120000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error(`${path.basename(cmd)} 超时`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} 退出码 ${code}：${err.trim().slice(0, 300)}`));
    });
  });
}

/**
 * 录一段系统声音并转写。
 * @param {object} opts { seconds, python, ffmpegPath, model, gainDb, timeoutMs, log }
 * @returns {Promise<{ok:boolean, text?:string, seconds?:number, device?:string, error?:string}>}
 */
export async function hearSystemAudio({
  seconds = 8,
  python,
  ffmpegPath,
  model,
  gainDb = 18,
  timeoutMs = 180000,
  scriptDir,
  log = () => {},
} = {}) {
  const py = python;
  const ff = ffmpegPath;
  if (!py || !fs.existsSync(py)) return { ok: false, error: `找不到 python：${py || '(未配置)'}` };
  if (!ff || !fs.existsSync(ff)) return { ok: false, error: `找不到 ffmpeg：${ff || '(未配置)'}` };
  const recordScript = path.join(scriptDir || process.cwd(), 'scripts', 'record-loopback.py');
  const transcribeScript = path.join(scriptDir || process.cwd(), 'scripts', 'transcribe.py');
  const raw = path.join(os.tmpdir(), `hear-${Date.now()}.wav`);
  const norm = path.join(os.tmpdir(), `hear-${Date.now()}-16k.wav`);
  try {
    const recOut = await run(py, [recordScript, '--out', raw, '--seconds', String(seconds)], { timeoutMs });
    let meta = {};
    try { meta = JSON.parse(recOut.trim().split(/\r?\n/).pop() || '{}'); } catch {}
    // 归一化：抬电平 + 动态压缩，再降到 whisper 要的 16k 单声道
    await run(ff, ['-y', '-hide_banner', '-loglevel', 'error', '-i', raw, '-af', `volume=${gainDb}dB,dynaudnorm`, '-ar', '16000', '-ac', '1', norm], { timeoutMs });
    const text = (await run(py, [transcribeScript, norm, '--model', model, '--language', 'zh'], {
      timeoutMs,
      env: { PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1' },
    })).trim();
    log(`[hear] 录 ${meta.seconds ?? seconds}s（${meta.device ?? '默认输出'}）→ 转写 ${text.length} 字`);
    return { ok: true, text, seconds: meta.seconds ?? seconds, device: meta.device ?? '' };
  } catch (error) {
    log(`[hear] 失败：${error?.message ?? error}`);
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    for (const f of [raw, norm]) { try { fs.unlinkSync(f); } catch {} }
  }
}
