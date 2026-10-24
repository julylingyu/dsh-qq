// MuMu 模拟器 MCP server（stdio）：把 adb 能力暴露给模型。
//
// 工具：
//   phone_status     设备在不在线（直接 adb devices，必要时 connect 一次）
//   phone_screenshot 截屏，图片本体直接给模型看（不是只给路径）
//   phone_dump       当前界面可点元素清单
//   phone_tap        按坐标点
//   phone_tap_text   按文字点（dump 后找节点，比坐标稳）
//   phone_swipe      滑动
//   phone_key        按键（back/home/enter/del/power/...）
//   phone_text       输入文本（中文需要 ADBKeyboard，会在返回里提示）
//   phone_open_app   开 App（包名或 Activity）
//   phone_macro      连招：一次执行一串动作（tap/tapText/swipe/key/text/openApp/sleep）
//
// 配置见 config.json 的 phone 段（adbPath / address / autoConnect / screenshotDir）。
// 只用配置里那个 MuMu 自带 adb，避免和系统 adb server 版本打架。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  resolvePhoneConfig, ensureDevice, screenshot, dumpUi, tap, tapText,
  swipe, key, inputText, openApp, macro,
} from './phone.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = () => resolvePhoneConfig(loadConfig());
const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const fail = (error) => ({ content: [{ type: 'text', text: `phone: ${error?.message ?? error}` }], isError: true });

const server = new McpServer({ name: 'phone', version: '1.0.3' });

server.tool(
  'phone_status',
  '查看 MuMu 模拟器是否在线（adb devices，必要时自动 connect 一次）。返回 adb 路径、目标地址和在线设备列表。',
  {},
  async () => {
    try {
      const c = cfg();
      const d = await ensureDevice(c);
      return ok({ online: d.ok, address: d.address, devices: d.devices, adbPath: c.adbPath, reason: d.reason });
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'phone_screenshot',
  '给模拟器截屏，并把图片本体直接返回（模型能真的看见屏幕）。图片同时保存到本地，返回路径。',
  {},
  async () => {
    try {
      const shot = await screenshot(cfg());
      return {
        content: [
          { type: 'image', data: shot.base64, mimeType: shot.mimeType ?? 'image/png' },
          { type: 'text', text: JSON.stringify({ ok: true, path: shot.path, bytes: shot.bytes }, null, 2) },
        ],
      };
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'phone_dump',
  '读取当前界面的可点元素清单（text/content-desc + 坐标）。点按之前先看它，比猜坐标稳。',
  {},
  async () => {
    try {
      const nodes = await dumpUi(cfg());
      return ok({ count: nodes.length, nodes });
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'phone_tap',
  '按屏幕坐标点一下（像素，基于截图分辨率）。',
  { x: z.number().int().nonnegative(), y: z.number().int().nonnegative() },
  async ({ x, y }) => {
    try { return ok(await tap(cfg(), x, y)); } catch (error) { return fail(error); }
  }
);

server.tool(
  'phone_tap_text',
  '按界面上的文字点按（先 dump 再找包含该文字的节点，点它的中心）。找不到会返回当前可点文字清单。',
  { text: z.string().describe('要点的文字（包含匹配即可）') },
  async ({ text }) => {
    try { return ok(await tapText(cfg(), text)); } catch (error) { return fail(error); }
  }
);

server.tool(
  'phone_swipe',
  '从 (x1,y1) 滑到 (x2,y2)，durationMs 控制快慢（默认 300ms）。',
  {
    x1: z.number().int().nonnegative(), y1: z.number().int().nonnegative(),
    x2: z.number().int().nonnegative(), y2: z.number().int().nonnegative(),
    durationMs: z.number().int().positive().optional(),
  },
  async ({ x1, y1, x2, y2, durationMs }) => {
    try { return ok(await swipe(cfg(), x1, y1, x2, y2, durationMs ?? 300)); } catch (error) { return fail(error); }
  }
);

server.tool(
  'phone_key',
  '按一个键：back/home/enter/del/power/volume_up/volume_down，或直接给 Android keycode 数字。',
  { key: z.union([z.string(), z.number()]) },
  async ({ key: k }) => {
    try { return ok(await key(cfg(), k)); } catch (error) { return fail(error); }
  }
);

server.tool(
  'phone_text',
  '向当前输入框输入文本。adb 不支持中文直接输入，中文需要装 ADBKeyboard 并切换输入法。',
  { text: z.string() },
  async ({ text }) => {
    try { return ok(await inputText(cfg(), text)); } catch (error) { return fail(error); }
  }
);

server.tool(
  'phone_open_app',
  '打开一个 App：给包名（如 com.tencent.mobileqq）或 Activity（a/b 形式）。',
  { target: z.string() },
  async ({ target }) => {
    try { return ok(await openApp(cfg(), target)); } catch (error) { return fail(error); }
  }
);

server.tool(
  'phone_macro',
  '连招：一次执行一串动作。steps 里每项 {do:"tap",x,y} / {do:"tapText",text} / {do:"swipe",x1,y1,x2,y2,ms} / {do:"key",key} / {do:"text",text} / {do:"openApp",target} / {do:"sleep",ms}。最多 20 步。',
  {
    steps: z.array(z.object({
      do: z.string(),
      x: z.number().optional(), y: z.number().optional(),
      x1: z.number().optional(), y1: z.number().optional(), x2: z.number().optional(), y2: z.number().optional(),
      ms: z.number().optional(), key: z.union([z.string(), z.number()]).optional(),
      text: z.string().optional(), target: z.string().optional(),
    })).min(1),
  },
  async ({ steps }) => {
    try { return ok(await macro(cfg(), steps)); } catch (error) { return fail(error); }
  }
);

await server.connect(new StdioServerTransport());
