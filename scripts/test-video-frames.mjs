#!/usr/bin/env node
// 视频抽帧回归：用 ffmpeg 自己造一段测试视频，再让 src/video-frames.mjs 抽帧。
//
// 覆盖：
//   1. resolveFfmpeg 能找到可执行文件；
//   2. 从本地文件抽帧：帧数、JPEG 魔数、时长解析；
//   3. 从内存字节抽帧（走临时文件那一路）；
//   4. 非法输入（不存在的文件 / 非视频字节）返回空帧 + 错误，而不是抛异常。
//
// 跑法：npm run test:video
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractVideoFramesFromBuffer, extractVideoFramesFromFile, resolveFfmpeg, VIDEO_DEFAULTS } from '../src/video-frames.mjs';

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const ffmpeg = resolveFfmpeg(process.env.QQ_BRIDGE_FFMPEG ?? '');
if (!ffmpeg) {
  console.error('找不到 ffmpeg：先安装 ffmpeg，或用 QQ_BRIDGE_FFMPEG=<路径> 指定');
  process.exit(1);
}
console.log(`ffmpeg: ${ffmpeg}`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-video-test-'));
const sample = path.join(dir, 'sample.mp4');
try {
  const made = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=6:size=640x360:rate=30',
    '-pix_fmt', 'yuv420p', sample
  ], { encoding: 'utf8', timeout: 60000 });
  check('生成测试视频', made.status === 0 && fs.existsSync(sample) && fs.statSync(sample).size > 0, made.stderr?.trim()?.slice(0, 200));

  const fromFile = await extractVideoFramesFromFile(sample, {
    ffmpegPath: ffmpeg,
    frames: VIDEO_DEFAULTS.frames,
    maxWidth: 480,
    timeoutMs: 60000
  });
  check('文件抽帧数量', fromFile.frames.length >= 3, `frames=${fromFile.frames.length} error=${fromFile.error ?? '-'}`);
  check('时长解析', Math.abs((fromFile.duration ?? 0) - 6) <= 1, `duration=${fromFile.duration}`);
  check('帧是 JPEG', fromFile.frames.every((f) => f.mimeType === 'image/jpeg' && f.buffer[0] === 0xff && f.buffer[1] === 0xd8));
  check('帧宽不超上限', fromFile.frames.every((f) => {
    // 只做粗略校验：JPEG SOF 段里读宽高，读不到就跳过
    try {
      const buf = f.buffer;
      for (let i = 2; i + 9 < buf.length; i += 1) {
        if (buf[i] !== 0xff) continue;
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
          const width = buf.readUInt16BE(i + 7);
          return width <= 480 && width > 0;
        }
      }
    } catch { /* ignore */ }
    return true;
  }));

  const fromBuffer = await extractVideoFramesFromBuffer(fs.readFileSync(sample), { ffmpegPath: ffmpeg, frames: 3, maxWidth: 320 });
  check('内存字节抽帧', fromBuffer.frames.length >= 2, `frames=${fromBuffer.frames.length} error=${fromBuffer.error ?? '-'}`);

  const missing = await extractVideoFramesFromFile(path.join(dir, 'nope.mp4'), { ffmpegPath: ffmpeg });
  check('不存在的文件不抛异常', missing.frames.length === 0 && typeof missing.error === 'string');

  const junk = await extractVideoFramesFromBuffer(Buffer.from('not a video at all'), { ffmpegPath: ffmpeg, timeoutMs: 8000 });
  check('非视频字节不抛异常', junk.frames.length === 0 && typeof junk.error === 'string');
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (failures.length) {
  console.error(`\n${failures.length} 项失败：${failures.join(' / ')}`);
  process.exit(1);
}
console.log('\n视频抽帧回归全部通过');
