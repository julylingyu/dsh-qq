// 发图路径白名单自检。
// 背景：qq_send_image 的 path 分支等价于「读本机文件 → 发到 QQ」，
// 不设边界就能把任意文件改名成 .png 发出去（魔数校验只挡格式，不挡来源）。
// 运行：node scripts/test-image-path.mjs
import path from 'node:path';
import { normalizeImageRoots, isPathInsideRoots, describeImageRoots, DEFAULT_IMAGE_ROOTS } from '../src/image-path.js';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed += 1; console.error(`❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

const ROOT = path.resolve('E:\\dsh\\dsh-qq');

// 1. 默认根目录
const defaults = normalizeImageRoots(undefined);
check('未配置时用默认根目录', defaults.length === DEFAULT_IMAGE_ROOTS.length && defaults.every((r) => path.isAbsolute(r)), defaults.join(' | '));

// 2. 自定义配置优先，去重、去空
const custom = normalizeImageRoots(['E:\\dsh\\out', '', 'E:\\dsh\\out', '  ']);
check('自定义根目录去重去空', custom.length === 1 && custom[0] === path.resolve('E:\\dsh\\out'), custom.join(' | '));

// 3. 允许：根目录下的文件
check('根目录下文件放行', isPathInsideRoots(path.join(ROOT, 'assets', 'deepseek娘.png'), [ROOT]));
check('多层子目录放行', isPathInsideRoots(path.join(ROOT, 'a', 'b', 'c.png'), [ROOT]));

// 4. 拒绝：目录自己、上级逃逸、绝对的其他盘
check('目录本身不放行', !isPathInsideRoots(ROOT, [ROOT]));
check('../ 逃逸被拒', !isPathInsideRoots(path.join(ROOT, '..', 'secret.png'), [ROOT]));
check('其他盘被拒', !isPathInsideRoots('C:\\Windows\\System32\\config\\SAM', [ROOT]));

// 5. 拒绝：前缀相似的兄弟目录（E:\dsh-evil 不能因为 E:\dsh 而被放行）
check('兄弟目录不误放', !isPathInsideRoots('E:\\dsh-evil\\x.png', ['E:\\dsh']));

// 6. 多个根目录，命中任意一个即可
const roots = [path.resolve('E:\\dsh\\dsh-qq'), path.resolve('E:\\dsh\\work')];
check('多根目录命中第二个', isPathInsideRoots(path.join('E:\\dsh\\work', 'chart.png'), roots));

// 7. 异常输入不抛错（相对路径会被 resolve，属于正常行为，不在这里断言真假）
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
check('空路径/空根目录返回 false', isPathInsideRoots('', roots) === false && isPathInsideRoots('E:\\dsh\\x.png', []) === false);
check('非法输入不抛错', !throws(() => isPathInsideRoots('::::', roots)) && !throws(() => isPathInsideRoots(null, roots)));

// 8. 描述文案里只列存在的目录
const desc = describeImageRoots([ROOT, 'E:\\不存在的目录\\xx']);
check('describeImageRoots 只列存在的目录', desc.includes('dsh-qq') && !desc.includes('不存在的目录'), desc);

console.log(`\n${failed === 0 ? '全部通过' : '有失败项'}：${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
