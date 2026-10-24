// 她的日记本：一天一个 Markdown 文件 + 一份索引。
//
// 设计取舍：
//   - 一天一个文件（`YYYY-MM-DD.md`）而不是一个大文件：注入时只读最近几篇，
//     不需要解析整本；也让「今天还没写」这种判断变成一次 existsSync。
//   - 索引 `index.jsonl` 一行一篇，给「最近 N 篇」按时间倒序取，避免每天扫目录。
//   - 写入永远追加（同一天多次写 → 同一文件里多个 `## HH:MM` 小节），不覆盖。
//
// 目录：默认 `<repo>/state/diary`，可用环境变量或 config `socialV2.diary.dir` 覆盖。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_ENTRY_CHARS = 2000;

function pad(n) {
  return String(n).padStart(2, '0');
}

export function localDayStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localClock(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function resolveDiaryDir({ root, configured } = {}) {
  const raw = String(configured ?? process.env.DSH_DIARY_DIR ?? '').trim();
  if (raw) return path.resolve(raw);
  return path.join(root ?? process.cwd(), 'state', 'diary');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 写一篇日记；返回 { ok, day, file, entryChars }。 */
export function writeDiary(dir, { text, title = '', mood = '', tags = [] } = {}, { maxChars = DEFAULT_MAX_ENTRY_CHARS, now = new Date() } = {}) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('text 不能为空');
  const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}…[截断]` : body;
  const day = localDayStamp(now);
  ensureDir(dir);
  const file = path.join(dir, `${day}.md`);
  const fresh = !fs.existsSync(file);
  const lines = [];
  if (fresh) lines.push(`# ${day}`, '');
  lines.push(`## ${localClock(now)}${title ? ` · ${title}` : ''}${mood ? `（${mood}）` : ''}`);
  lines.push('');
  lines.push(clipped);
  if (Array.isArray(tags) && tags.length) lines.push('', `标签：${tags.map((t) => String(t).trim()).filter(Boolean).join('、')}`);
  lines.push('');
  fs.appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');

  const index = path.join(dir, 'index.jsonl');
  const record = { at: now.toISOString(), day, title: String(title ?? '').slice(0, 80), mood: String(mood ?? '').slice(0, 40), chars: clipped.length };
  fs.appendFileSync(index, `${JSON.stringify(record)}\n`, 'utf8');
  return { ok: true, day, file, entryChars: clipped.length, firstOfDay: fresh };
}

/** 最近 N 篇的完整正文（按文件里的小节倒序拼），用于注入提示词。 */
export function readRecentDiary(dir, count = 3, { maxCharsPerEntry = 600 } = {}) {
  const out = [];
  const index = path.join(dir, 'index.jsonl');
  let records = [];
  try {
    records = fs.readFileSync(index, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return out;
  }
  const days = [...new Set(records.map((r) => r.day))].sort().reverse();
  for (const day of days) {
    if (out.length >= count) break;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, `${day}.md`), 'utf8'); } catch { continue; }
    const sections = text.split(/^## /m).slice(1);
    if (!sections.length) continue;
    out.push({ day, text: `## ${sections[sections.length - 1].trim()}`.slice(0, maxCharsPerEntry) });
  }
  return out;
}

/** 拼成提示词里的日记小节；没有日记时返回空串。 */
export function buildDiaryContext(dir, count = 3) {
  const entries = readRecentDiary(dir, count);
  if (!entries.length) return '';
  return ['【你最近写的日记】（这是你写的，别装作不记得；今天还没写的话，找机会补一条）', ...entries.map((e) => e.text), ''].join('\n');
}

export function hasWrittenToday(dir, now = new Date()) {
  return fs.existsSync(path.join(dir, `${localDayStamp(now)}.md`));
}
