// json / ark 卡片段的可读化。
//
// SnowLuma 下发的卡片消息只有一个 `data` 字符串，真正的业务 JSON 在里面：
//   {"app":"com.tencent.miniapp_01","prompt":"[QQ小程序]快来农场一起摇奶茶！",
//    "meta":{"detail_1":{"title":"QQ经典农场","desc":"快来农场一起摇奶茶！"}}}
// 以前整段被丢成字面量 "[卡片消息]"，模型只能看到四个字，等于什么都没收到。
// 这里把 prompt / 标题 / 描述 抠出来，让模型至少知道对方分享了什么。
//
// 原则：解析任何一步失败都退回 "[卡片消息]"，绝不抛错 —— 卡片格式由腾讯改，
// 不能因为一个新字段就让整条消息的处理链断掉。

const LABEL_MAX_CHARS = 160;
const TITLE_MAX_CHARS = 40;
const DESC_MAX_CHARS = 60;

/** 压掉控制字符与换行并限长：卡片文案会进入模型上下文，不能让它伪造出新的提示词段落。 */
function cleanText(value, max) {
  const s = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 取出卡片业务 JSON：可能是对象，也可能是待解析的字符串。失败返回 null。 */
function parseCardPayload(data) {
  const raw = data?.data ?? data?.content;
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw ?? '').trim();
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 把一个 OneBot 卡片段（或其 data 字段）描述成人能读的一行。
 * 返回形如 `[卡片:QQ经典农场 · 快来农场一起摇奶茶！]`，解析不出来时返回 `[卡片消息]`。
 */
export function describeCardSegment(data) {
  const meta = parseCardPayload(data);
  if (!meta) return '[卡片消息]';

  const bag = meta.meta && typeof meta.meta === 'object' ? meta.meta : {};
  const detail = bag.detail_1 ?? bag.news ?? bag.detail ?? bag.music ?? null;
  const detailObj = detail && typeof detail === 'object' ? detail : {};

  const title = cleanText(detailObj.title, TITLE_MAX_CHARS);
  const desc = cleanText(detailObj.desc, DESC_MAX_CHARS);
  const prompt = cleanText(meta.prompt, DESC_MAX_CHARS);
  const topDesc = cleanText(meta.desc, DESC_MAX_CHARS);
  // 分享链接卡 / B 站卡 / 公众号卡都带跳转地址：带上它，模型才能自己 web_fetch 看正文。
  const url = cleanText(detailObj.jumpUrl ?? detailObj.qqdocurl ?? detailObj.url ?? '', 120);

  let label = '';
  if (title && desc && desc !== title) label = `${title} · ${desc}`;
  else label = title || desc || prompt || topDesc;
  if (!label) return '[卡片消息]';
  if (url && /^https?:\/\//i.test(url)) label = `${label} · ${url}`;

  return `[卡片:${cleanText(label, LABEL_MAX_CHARS)}]`;
}
