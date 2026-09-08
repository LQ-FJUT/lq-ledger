const MAX_FEN = 100_000_000;

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${uuid}`;
}

export function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN');
}

export function requireText(value: string, label: string, maxLength: number): string {
  const text = value.normalize('NFKC').trim();
  if (!text) throw new Error(`请输入${label}`);
  if (text.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字`);
  return text;
}

export function parseAmountToFen(value: string): number {
  const text = value.trim();
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(text)) {
    throw new Error('请输入 0.01 至 1000000.00 的金额');
  }
  const [integer, fraction = ''] = text.split('.');
  const fen = Number(integer) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(fen) || fen < 1 || fen > MAX_FEN) {
    throw new Error('金额必须在 0.01 至 1000000.00 元之间');
  }
  return fen;
}

export function parseAmountExpressionToFen(value: string): number {
  const text = value.normalize('NFKC').replace(/\s+/g, '');
  if (!/[+\-*/()]/.test(text)) return parseAmountToFen(text);
  if (!text || text.length > 80 || !/^[0-9.+\-*/()]+$/.test(text)) throw new Error('金额算式格式无效');
  let position = 0;

  function parseNumber(): number {
    const match = /^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?/.exec(text.slice(position));
    if (!match) throw new Error('金额算式中包含无效数字');
    position += match[0].length;
    return Number(match[0]);
  }

  function parseFactor(): number {
    if (text[position] === '+') { position += 1; return parseFactor(); }
    if (text[position] === '-') { position += 1; return -parseFactor(); }
    if (text[position] === '(') {
      position += 1;
      const result = parseExpression();
      if (text[position] !== ')') throw new Error('金额算式括号不完整');
      position += 1;
      return result;
    }
    return parseNumber();
  }

  function parseTerm(): number {
    let result = parseFactor();
    while (text[position] === '*' || text[position] === '/') {
      const operator = text[position++];
      const right = parseFactor();
      if (operator === '/' && right === 0) throw new Error('金额算式不能除以 0');
      result = operator === '*' ? result * right : result / right;
    }
    return result;
  }

  function parseExpression(): number {
    let result = parseTerm();
    while (text[position] === '+' || text[position] === '-') {
      const operator = text[position++];
      const right = parseTerm();
      result = operator === '+' ? result + right : result - right;
    }
    return result;
  }

  const amount = parseExpression();
  if (position !== text.length || !Number.isFinite(amount)) throw new Error('金额算式格式无效');
  const fen = Math.round((amount + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(fen) || fen < 1 || fen > MAX_FEN) throw new Error('金额必须在 0.01 至 1000000.00 元之间');
  return fen;
}

export function formatFen(fen: number): string {
  return (fen / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function localDateTimeNow(): string {
  const d = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dateKeyNow(): string {
  return localDateTimeNow().slice(0, 10);
}

export function parseLocalDateTime(value: string): { occurredLocal: string; dateKey: string; monthKey: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('请选择有效的消费时间');
  const [, y, m, d, h, min] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min));
  if (
    date.getFullYear() !== Number(y) || date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d) ||
    date.getHours() !== Number(h) || date.getMinutes() !== Number(min)
  ) {
    throw new Error('消费时间无效');
  }
  return { occurredLocal: value, dateKey: `${y}-${m}-${d}`, monthKey: `${y}-${m}` };
}

export function assertMonthKey(value: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error('月份参数无效');
  return value;
}

export function assertDateKey(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('日期参数无效');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error('日期参数无效');
  }
  return value;
}

export function monthKeyNow(): string {
  return localDateTimeNow().slice(0, 7);
}

export function shiftMonth(monthKey: string, delta: number): string {
  assertMonthKey(monthKey);
  const [year, month] = monthKey.split('-').map(Number);
  const total = year * 12 + month - 1 + delta;
  const nextYear = Math.floor(total / 12);
  const nextMonth = (total % 12) + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
}

export function daysInMonth(monthKey: string): number {
  const validMonth = assertMonthKey(monthKey);
  const [year, month] = validMonth.split('-').map(Number);
  return new Date(year, month, 0).getDate();
}

export function formatMonthKey(monthKey: string): string {
  const validMonth = assertMonthKey(monthKey);
  return `${Number(validMonth.slice(0, 4))} 年 ${Number(validMonth.slice(5))} 月`;
}

export function displayLocalDateTime(value: string): string {
  const [date, time] = value.split('T');
  return `${date.replace(/-/g, '.')} ${time}`;
}

export function escapeCsv(value: string | number): string {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
