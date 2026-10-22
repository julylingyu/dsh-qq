// 发图路径白名单：qq_send_image 的 path 只能指向允许的根目录之下。
//
// 为什么要有：path 分支等价于「读本机文件 → 发到 QQ」。不设边界的话，
// 任何凭据文件只要被改名成 .png 就会被发出去（魔数校验只挡格式，不挡来源）。
// 默认只放行桥接目录（ROOT）、DSH 工作区（E:\dsh）和显式配置的额外根目录。

import fs from 'node:fs';
import path from 'node:path';

/** 默认允许的根目录：桥接仓库 + DSH 工作区。都不存在时自动跳过。 */
export const DEFAULT_IMAGE_ROOTS = ['E:\\dsh\\dsh-qq', 'E:\\dsh'];

/** 把配置里的 allowRoots 规整成绝对路径数组；空/非法包含项丢弃。 */
export function normalizeImageRoots(configured, { defaults = DEFAULT_IMAGE_ROOTS } = {}) {
  const list = Array.isArray(configured) && configured.length ? configured : defaults;
  const out = [];
  for (const item of list) {
    const raw = String(item ?? '').trim();
    if (!raw) continue;
    try {
      const abs = path.resolve(raw);
      if (!out.includes(abs)) out.push(abs);
    } catch {}
  }
  return out;
}

/** abs 是否落在 roots 里任意一个目录之下（含其子目录）。同路径或 ../ 逃逸都不算。 */
export function isPathInsideRoots(abs, roots) {
  let target;
  try {
    target = path.resolve(String(abs ?? ''));
  } catch {
    return false;
  }
  for (const root of roots ?? []) {
    let r;
    try {
      r = path.resolve(String(root ?? ''));
    } catch {
      continue;
    }
    if (!r) continue;
    const rel = path.relative(r, target);
    if (!rel) continue;                       // 目录本身不算文件
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    return true;
  }
  return false;
}

/** 便于错误提示：只回显存在的根目录，别把不存在的配置项也说成可用。 */
export function describeImageRoots(roots) {
  const alive = (roots ?? []).filter((r) => {
    try { return fs.statSync(r).isDirectory(); } catch { return false; }
  });
  return (alive.length ? alive : roots ?? []).join('、') || '（未配置）';
}
