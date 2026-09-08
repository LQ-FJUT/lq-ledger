import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RecordForm from '../src/components/RecordForm.vue';
import type { Category, ExpenseRecord } from '../src/types';

const repositoryMocks = vi.hoisted(() => ({
  listMerchants: vi.fn().mockResolvedValue([]),
  saveRecord: vi.fn(),
}));

vi.mock('@/services/repository', () => ({ ledgerRepository: repositoryMocks }));

const categories: Category[] = [
  { id: 'root', parentId: null, type: 'expense', name: '餐饮', icon: '🍚', color: '#E16E3D', sortOrder: 0, isDefault: true, deletedAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
  { id: 'leaf', parentId: 'root', type: 'expense', name: '早餐', icon: '🍳', color: '#E16E3D', sortOrder: 0, isDefault: true, deletedAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
];

const latest: ExpenseRecord = {
  id: 'record', categoryId: 'leaf', categoryNameSnapshot: '早餐', parentCategoryIdSnapshot: 'root', parentCategoryNameSnapshot: '餐饮',
  amountFen: 650, merchantId: null, merchantName: '食堂', remark: '豆浆', occurredLocal: '2026-09-01T08:00', dateKey: '2026-09-01', monthKey: '2026-09',
  createdAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-01T08:00:00.000Z', deletedAt: null,
};

describe('快速记账表单', () => {
  beforeEach(() => {
    repositoryMocks.listMerchants.mockResolvedValue([]);
    repositoryMocks.saveRecord.mockReset();
  });

  it('复制上一笔后保持未保存状态', async () => {
    const wrapper = mount(RecordForm, { attachTo: document.body, props: { categories, latestRecord: latest } });
    await wrapper.get('button.secondary-button').trigger('click');
    await nextTick();
    const dirtyEvents = wrapper.emitted('dirtyChange') ?? [];
    expect(dirtyEvents.at(-1)).toEqual([true]);
    expect((wrapper.get('.amount-input-wrap input').element as HTMLInputElement).value).toBe('6.50');
    wrapper.unmount();
  });

  it('填入模板后保持未保存状态且不覆盖时间', async () => {
    const wrapper = mount(RecordForm, {
      attachTo: document.body,
      props: { categories, templates: [{ id: 'tpl', name: '早餐', categoryId: 'leaf', amountFen: 800, merchantName: '食堂', remark: '', sortOrder: 0, createdAt: latest.createdAt, updatedAt: latest.updatedAt }] },
    });
    await wrapper.get('.template-chip').trigger('click');
    await nextTick();
    expect((wrapper.get('.amount-input-wrap input').element as HTMLInputElement).value).toBe('8.00');
    expect((wrapper.emitted('dirtyChange') ?? []).at(-1)).toEqual([true]);
    wrapper.unmount();
  });

  it('保存成功后发出已保存事件', async () => {
    const saved = { ...latest, id: 'saved-record' };
    repositoryMocks.saveRecord.mockResolvedValueOnce(saved);
    const wrapper = mount(RecordForm, { attachTo: document.body, props: { categories } });

    await wrapper.get('.amount-input-wrap input').setValue('6.50');
    await wrapper.get('select').setValue('leaf');
    await wrapper.get('form').trigger('submit');
    await nextTick();

    expect(repositoryMocks.saveRecord).toHaveBeenCalledOnce();
    expect(wrapper.emitted('saved')).toEqual([[saved, false]]);
    wrapper.unmount();
  });

  it('保存失败后显示错误并解除保存中状态', async () => {
    repositoryMocks.saveRecord.mockRejectedValueOnce(new Error('保存失败：数据库操作失败'));
    const wrapper = mount(RecordForm, { attachTo: document.body, props: { categories } });

    await wrapper.get('.amount-input-wrap input').setValue('6.50');
    await wrapper.get('select').setValue('leaf');
    await wrapper.get('form').trigger('submit');
    await nextTick();

    expect(wrapper.get('.form-message').text()).toContain('保存失败：数据库操作失败');
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.emitted('saved')).toBeUndefined();
    wrapper.unmount();
  });

  it('保存进行中忽略重复提交', async () => {
    let resolveSave!: (record: ExpenseRecord) => void;
    const saved = { ...latest, id: 'saved-record' };
    repositoryMocks.saveRecord.mockReturnValueOnce(new Promise<ExpenseRecord>((resolve) => { resolveSave = resolve; }));
    const wrapper = mount(RecordForm, { attachTo: document.body, props: { categories } });

    await wrapper.get('.amount-input-wrap input').setValue('6.50');
    await wrapper.get('select').setValue('leaf');
    const firstSubmit = wrapper.get('form').trigger('submit');
    await nextTick();
    await wrapper.get('form').trigger('submit');
    expect(repositoryMocks.saveRecord).toHaveBeenCalledOnce();

    resolveSave(saved);
    await firstSubmit;
    await flushPromises();
    wrapper.unmount();
  });

  it('进入页面后自动聚焦金额框', async () => {
    const wrapper = mount(RecordForm, { attachTo: document.body, props: { categories } });
    await nextTick();
    await nextTick();

    expect(document.activeElement).toBe(wrapper.get('.amount-input-wrap input').element);
    wrapper.unmount();
  });
});
