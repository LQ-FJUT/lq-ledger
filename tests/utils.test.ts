import { describe, expect, it } from 'vitest';
import { daysInMonth, escapeCsv, escapeLikePattern, formatMonthKey, parseAmountExpressionToFen, parseAmountToFen, parseLocalDateTime, shiftMonth, stableStringify } from '../src/utils';

describe('金额', () => {
  it('以整数分解析金额，避免浮点误差', () => {
    expect(parseAmountToFen('12')).toBe(1200);
    expect(parseAmountToFen('0.01')).toBe(1);
    expect(parseAmountToFen('1000000.00')).toBe(100000000);
  });

  it('拒绝不安全或不完整的金额', () => {
    for (const value of ['', '0', '-1', '.5', '1.234', '1000000.01', '01.20']) {
      expect(() => parseAmountToFen(value)).toThrow();
    }
  });

  it('安全计算金额算式并四舍五入到分', () => {
    expect(parseAmountExpressionToFen('12 + 8.5')).toBe(2050);
    expect(parseAmountExpressionToFen('(10+2)*3')).toBe(3600);
    expect(parseAmountExpressionToFen('10/3')).toBe(333);
    for (const value of ['1/0', '2+eval(1)', '01+2', '(1+2', '1000000+0.01', '-1+0']) {
      expect(() => parseAmountExpressionToFen(value)).toThrow();
    }
  });
});

describe('本地时间和月份', () => {
  it('保留本地日期键并拒绝不存在的日期', () => {
    expect(parseLocalDateTime('2026-08-30T09:05')).toEqual({
      occurredLocal: '2026-08-30T09:05', dateKey: '2026-08-30', monthKey: '2026-08',
    });
    expect(() => parseLocalDateTime('2026-02-30T09:05')).toThrow();
  });

  it('可跨年切换月份', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(daysInMonth('2024-02')).toBe(29);
    expect(formatMonthKey('2026-09')).toBe('2026 年 9 月');
  });
});

describe('导出稳定性', () => {
  it('稳定排序对象键，保证备份校验一致', () => {
    expect(stableStringify({ z: 1, a: { d: true, b: false } })).toBe('{"a":{"b":false,"d":true},"z":1}');
  });

  it('隔离 CSV 公式并正确引用分隔符', () => {
    expect(escapeCsv('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(escapeCsv('A, B')).toBe('"A, B"');
    expect(escapeCsv('He said "hi"')).toBe('"He said ""hi"""');
    expect(escapeLikePattern('50%_off\\today')).toBe('50\\%\\_off\\\\today');
  });
});
