import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecordsView from '../src/components/RecordsView.vue';
import type { Category, ExpenseRecord, RecordPage } from '../src/types';

const mocks = vi.hoisted(() => ({ listRecordPage: vi.fn(), restoreRecords: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/services/repository', () => ({ ledgerRepository: {
  listRecordPage: mocks.listRecordPage,
  deleteRecord: vi.fn(),
  restoreRecord: vi.fn(),
  restoreRecords: mocks.restoreRecords,
  purgeDeletedRecords: vi.fn(),
} }));

const categories: Category[] = [
  { id: 'root', parentId: null, type: 'expense', name: '餐饮', icon: '🍚', color: '#E16E3D', sortOrder: 0, isDefault: true, deletedAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
  { id: 'leaf', parentId: 'root', type: 'expense', name: '早餐', icon: '🍳', color: '#E16E3D', sortOrder: 0, isDefault: true, deletedAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
];

const deletedRecord: ExpenseRecord = {
  id: 'deleted', categoryId: 'leaf', categoryNameSnapshot: '早餐', parentCategoryIdSnapshot: 'root', parentCategoryNameSnapshot: '餐饮', amountFen: 600,
  merchantId: null, merchantName: '', remark: '', occurredLocal: '2026-09-01T08:00', dateKey: '2026-09-01', monthKey: '2026-09',
  createdAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-01T08:00:00.000Z', deletedAt: '2026-09-01T09:00:00.000Z',
};

function page(items: ExpenseRecord[] = []): RecordPage {
  return { items, totalCount: items.length, totalFen: items.reduce((sum, item) => sum + item.amountFen, 0), nextCursor: null };
}

describe('记录列表', () => {
  beforeEach(() => { vi.useFakeTimers(); mocks.listRecordPage.mockReset(); mocks.restoreRecords.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('统计页一级分类下钻使用 parentCategoryId', async () => {
    mocks.listRecordPage.mockResolvedValue(page());
    const wrapper = mount(RecordsView, { props: { categories, refreshToken: 0, initialFilter: { monthKey: '2026-09', parentCategoryId: 'root' } } });
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(mocks.listRecordPage).toHaveBeenCalledWith(expect.objectContaining({ parentCategoryId: 'root', categoryId: undefined }), null, 100, false);
    wrapper.unmount();
  });

  it('批量恢复只调用一次事务接口', async () => {
    mocks.listRecordPage.mockImplementation(async (_filter, _cursor, _limit, onlyDeleted) => page(onlyDeleted ? [deletedRecord] : []));
    const wrapper = mount(RecordsView, { props: { categories, refreshToken: 0 } });
    await vi.advanceTimersByTimeAsync(250);
    await wrapper.findAll('[role="tab"]')[1].trigger('click');
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    await wrapper.get('.bulk-actions input[type="checkbox"]').trigger('change');
    await wrapper.get('.bulk-actions .secondary-button').trigger('click');
    await flushPromises();
    expect(mocks.restoreRecords).toHaveBeenCalledTimes(1);
    expect(mocks.restoreRecords).toHaveBeenCalledWith(['deleted']);
    wrapper.unmount();
  });
});
