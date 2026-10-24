// MuMu 模拟器（adb）控制：截图、点按、滑动、按键、开 App、连招。
//
// 为什么走 adb：MuMu 自带 adb（nx_device\12.0\shell\adb.exe），它的 adb 版本和
// 系统装的不一定一致，混用会出现 "adb server version doesn't match" 冲突。
// 所以这里**只用配置里指定的 adb.exe**，绝不去 PATH 里找。
//
// 连接地址：MuMu 12 的 ADB 端口在模拟器设置里（默认 16384），雷电是 5555。
// 配置 phone.address 可覆盖；autoConnect 时连不上会自动 adb connect 一次。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_ADB = 'C:\\Program Files\\Netease\\MuMu\\nx_device\\12.0\\shell\\adb.exe';
const DEFAULT_ADDRESS = '127.0.0.1:16384';

export function resolvePhoneConfig(cfg = {}) {
  const p = cfg.phone && typeof cfg.phone === 'object' ? cfg.phone : {};
  return {
    enabled: p.enabled !== false,
    adbPath: String(p.adbPath || process.env.QQ_ADB_PATH || DEFAULT_ADB),
    address: String(p.address || process.env.QQ_ADB_ADDRESS || DEFAULT_ADDRESS),
    autoConnect: p.autoConnect !== false,
    screenshotDir: String(p.screenshotDir || path.join(os.tmpdir(), 'qq-phone-shots')),
    timeoutMs: Number(p.timeoutMs) || 20000,
  };
}

function runAdb(cfg, args, { encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cfg.adbPath, args, { windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    const chunks = [];
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`adb 超时：${args.join(' ')}`));
    }, cfg.timeoutMs);
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const buffer = Buffer.concat(chunks);
      if (code !== 0 && !(args[0] === 'devices' && buffer.length)) {
        reject(new Error(`adb 退出码 ${code}：${err.trim().slice(0, 300) || `${buffer.length} bytes`}`));
        return;
      }
      resolve({ code, buffer, text: encoding === 'utf8' ? buffer.toString('utf8') : '' });
    });
  });
}

/** 设备是否在线；不在线时按需 connect 一次。返回 { ok, devices, address }。 */
export async function ensureDevice(cfg) {
  if (!cfg.enabled) return { ok: false, devices: [], reason: 'phone.enabled=false' };
  if (!fs.existsSync(cfg.adbPath)) return { ok: false, devices: [], reason: `找不到 adb：${cfg.adbPath}` };
  const list = async () => {
    const r = await runAdb(cfg, ['devices']);
    return r.text.split(/\r?\n/).slice(1).map((l) => l.trim()).filter((l) => l && /device$/.test(l)).map((l) => l.split(/\s+/)[0]);
  };
  let devices = await list();
  if (devices.includes(cfg.address)) return { ok: true, devices, address: cfg.address };
  if (devices.length) return { ok: true, devices, address: devices[0] };
  if (cfg.autoConnect) {
    try { await runAdb(cfg, ['connect', cfg.address]); } catch {}
    devices = await list();
    if (devices.includes(cfg.address)) return { ok: true, devices, address: cfg.address };
    if (devices.length) return { ok: true, devices, address: devices[0] };
  }
  return { ok: false, devices, address: cfg.address };
}

async function adbFor(cfg, args) {
  const device = await ensureDevice(cfg);
  if (!device.ok) throw new Error(`模拟器不在线（${device.reason || device.address}）——先在 MuMu 里启动模拟器，或检查 phone.address`);
  const full = device.address ? ['-s', device.address, ...args] : args;
  return { device, result: await runAdb(cfg, full) };
}

/** 截屏，返回 { path, base64, bytes }。 */
export async function screenshot(cfg) {
  const { result } = await adbFor(cfg, ['exec-out', 'screencap', '-p']);
  const png = result.buffer;
  if (!png.length || png[0] !== 0x89) throw new Error('截图失败：返回的不是 PNG（模拟器未就绪？）');
  fs.mkdirSync(cfg.screenshotDir, { recursive: true });
  const file = path.join(cfg.screenshotDir, `screen-${Date.now()}.png`);
  fs.writeFileSync(file, png);
  return { path: file, base64: png.toString('base64'), bytes: png.length };
}

function parseBounds(value) {
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(String(value ?? ''));
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  return { x1, y1, x2, y2, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) };
}

/** dump 当前界面，返回可点元素清单：[{text, desc, cls, bounds}]。 */
export async function dumpUi(cfg) {
  await adbFor(cfg, ['shell', 'uiautomator', 'dump', '/sdcard/qq-window.xml']);
  const { result } = await adbFor(cfg, ['shell', 'cat', '/sdcard/qq-window.xml']);
  const xml = result.text;
  const nodes = [];
  const re = /<node\b[^>]*?text="([^"]*)"[^>]*?bounds="([^"]*)"[^>]*?\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const text = decodeXml(m[1]).trim();
    const bounds = parseBounds(m[2]);
    if (!bounds) continue;
    if (!text && !/clickable="true"/.test(m[0])) continue;
    nodes.push({ text, bounds });
  }
  const withDesc = [];
  const reDesc = /<node\b[^>]*?content-desc="([^"]*)"[^>]*?bounds="([^"]*)"/g;
  while ((m = reDesc.exec(xml))) {
    const desc = decodeXml(m[1]).trim();
    const bounds = parseBounds(m[2]);
    if (desc && bounds) withDesc.push({ text: desc, bounds });
  }
  return [...nodes, ...withDesc].slice(0, 80);
}

function decodeXml(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

export async function tap(cfg, x, y) {
  await adbFor(cfg, ['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
  return { ok: true };
}

/** 按文字点：dump → 找包含 text 的节点 → 点中心。找不到时抛错并给候选。 */
export async function tapText(cfg, needle) {
  const nodes = await dumpUi(cfg);
  const want = String(needle ?? '').trim();
  const hit = nodes.find((n) => n.text && n.text.includes(want)) ?? nodes.find((n) => n.text && want.includes(n.text));
  if (!hit) {
    const sample = nodes.filter((n) => n.text).slice(0, 12).map((n) => n.text).join(' / ');
    throw new Error(`界面上找不到「${want}」。当前可点文字：${sample || '（没有）'}`);
  }
  await tap(cfg, hit.bounds.cx, hit.bounds.cy);
  return { ok: true, tapped: hit.text, at: [hit.bounds.cx, hit.bounds.cy] };
}

export async function swipe(cfg, x1, y1, x2, y2, durationMs = 300) {
  await adbFor(cfg, ['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(Math.max(50, Number(durationMs) || 300))]);
  return { ok: true };
}

export async function key(cfg, code) {
  const map = { back: 4, home: 3, enter: 66, del: 67, power: 26, volume_up: 24, volume_down: 25 };
  const value = typeof code === 'number' ? code : (map[String(code)] ?? 0);
  if (!value) throw new Error(`未知按键：${code}（可用 back/home/enter/del/power/volume_up/volume_down 或 keycode 数字）`);
  await adbFor(cfg, ['shell', 'input', 'keyevent', String(value)]);
  return { ok: true, keycode: value };
}

export async function inputText(cfg, text) {
  const value = String(text ?? '');
  if (!value) throw new Error('text 不能为空');
  // adb input text 不支持空格与中文，空格用 %s 代替；中文需要输入法（ADBKeyboard）
  const encoded = value.replace(/ /g, '%s');
  await adbFor(cfg, ['shell', 'input', 'text', encoded]);
  return { ok: true, hint: /[\u4e00-\u9fa5]/.test(value) ? '中文可能没上屏：adb 不支持直接输入中文，需装 ADBKeyboard 并切换输入法' : undefined };
}

export async function openApp(cfg, target) {
  const t = String(target ?? '').trim();
  if (!t) throw new Error('需要 package 或 Activity');
  if (/^[\w.]+\/[\w.$]+$/.test(t)) {
    await adbFor(cfg, ['shell', 'am', 'start', '-n', t]);
  } else {
    await adbFor(cfg, ['shell', 'monkey', '-p', t, '-c', 'android.intent.category.LAUNCHER', '1']);
  }
  return { ok: true };
}

/** 连招：[{do:'tap',x,y}|{do:'tapText',text}|{do:'swipe',...}|{do:'key',key}|{do:'text',text}|{do:'sleep',ms}|{do:'openApp',target}] */
export async function macro(cfg, steps, { maxSteps = 20 } = {}) {
  const list = Array.isArray(steps) ? steps.slice(0, maxSteps) : [];
  const done = [];
  for (const step of list) {
    const op = String(step?.do ?? '').toLowerCase();
    if (op === 'tap') await tap(cfg, step.x, step.y);
    else if (op === 'taptext') await tapText(cfg, step.text);
    else if (op === 'swipe') await swipe(cfg, step.x1, step.y1, step.x2, step.y2, step.ms);
    else if (op === 'key') await key(cfg, step.key);
    else if (op === 'text') await inputText(cfg, step.text);
    else if (op === 'openapp') await openApp(cfg, step.target);
    else if (op === 'sleep') await new Promise((r) => setTimeout(r, Math.max(0, Number(step.ms) || 500)));
    else throw new Error(`未知动作：${op}`);
    done.push(op);
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: true, steps: done.length, done };
}
