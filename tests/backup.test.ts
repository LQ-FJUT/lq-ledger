import { describe, expect, it } from 'vitest';
import { parseAndValidateEnvelope } from '../src/services/backup';
import { sha256, stableStringify } from '../src/utils';

function createPayload() {
  return {
    categories: [
      { id: 'root_food', parentId: null, type: 'expense' as const, name: '餐饮', icon: '🍚', color: '#E16E3D', sortOrder: 0, isDefault: true, deletedAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
      { id: 'leaf_breakfast', parentId: 'root_food', type: 'expense' as const, name: '早餐', icon: '🍳', color: '#E16E3D', sortOrder: 0, isDefault: true, deletedAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
    ],
    merchants: [
      { id: 'merchant_1', categoryId: 'leaf_breakfast', name: '食堂', normalizedName: '食堂', hiddenAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
    ],
    records: [
      { id: 'record_1', categoryId: 'leaf_breakfast', categoryNameSnapshot: '早餐', parentCategoryIdSnapshot: 'root_food', parentCategoryNameSnapshot: '餐饮', amountFen: 650, merchantId: 'merchant_1', merchantName: '食堂', remark: '', occurredLocal: '2026-09-01T08:00', dateKey: '2026-09-01', monthKey: '2026-09', createdAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-01T08:00:00.000Z', deletedAt: null },
    ],
    settings: { entryMode: 'keyboard' },
    budgets: [
      { id: 'budget_1', monthKey: '2026-09', categoryId: 'root_food', amountFen: 10000, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
    ],
    templates: [
      { id: 'template_1', name: '工作日早餐', categoryId: 'leaf_breakfast', amountFen: null, merchantName: '食堂', remark: '', sortOrder: 0, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
    ],
  };
}

async function envelopeFor(payload: ReturnType<typeof createPayload>) {
  return {
    format: 'lq-ledger-backup' as const,
    schemaVersion: 1 as const,
    exportedAt: '2026-09-01T00:00:00.000Z',
    appVersion: '1.1.0',
    payload,
    payloadSha256: await sha256(stableStringify(payload)),
  };
}

describe('备份校验', () => {
  it('接受包含预算的完整备份', async () => {
    const envelope = await envelopeFor(createPayload());
    await expect(parseAndValidateEnvelope(JSON.stringify(envelope))).resolves.toEqual(envelope);
  });

  it('兼容没有预算字段的旧版备份', async () => {
    const payload = createPayload();
    delete (payload as { budgets?: unknown }).budgets;
    const envelope = await envelopeFor(payload);
    await expect(parseAndValidateEnvelope(JSON.stringify(envelope))).resolves.toEqual(envelope);
  });

  it('拒绝日期键与消费时间不一致的数据', async () => {
    const payload = createPayload();
    payload.records[0].dateKey = '2026-09-02';
    const envelope = await envelopeFor(payload);
    await expect(parseAndValidateEnvelope(JSON.stringify(envelope))).rejects.toThrow('消费时间无效');
  });

  it('拒绝超出上限的金额和无效的地点引用', async () => {
    const payload = createPayload();
    payload.records[0].amountFen = 100_000_001;
    payload.records[0].merchantId = 'missing';
    const envelope = await envelopeFor(payload);
    await expect(parseAndValidateEnvelope(JSON.stringify(envelope))).rejects.toThrow('消费记录无效');
  });

  it('拒绝引用一级分类或重复 ID 的模板', async () => {
    const payload = createPayload();
    payload.templates[0].categoryId = 'root_food';
    const envelope = await envelopeFor(payload);
    await expect(parseAndValidateEnvelope(JSON.stringify(envelope))).rejects.toThrow('模板分类无效');
  });
});
