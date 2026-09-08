<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { Category, ExpenseRecord, RecordFilter } from '@/types';
import { ledgerRepository } from '@/services/repository';
import { confirmAction } from '@/services/confirm';
import { displayLocalDateTime, formatFen, monthKeyNow } from '@/utils';

const props = defineProps<{ refreshToken: number; categories: Category[]; initialFilter?: RecordFilter | null }>();
const emit = defineEmits<{ edit: [record: ExpenseRecord]; changed: [] }>();

type ListMode = 'active' | 'deleted';

const mode = ref<ListMode>('active');
const monthKey = ref(props.initialFilter?.monthKey ?? monthKeyNow());
const query = ref(props.initialFilter?.query ?? '');
const categoryKey = ref(props.initialFilter?.parentCategoryId ? `root:${props.initialFilter.parentCategoryId}` : props.initialFilter?.categoryId ? `leaf:${props.initialFilter.categoryId}` : '');
const fromDate = ref(props.initialFilter?.fromDate ?? '');
const toDate = ref(props.initialFilter?.toDate ?? '');
const minAmount = ref(props.initialFilter?.minFen === undefined ? '' : (props.initialFilter.minFen / 100).toFixed(2));
const maxAmount = ref(props.initialFilter?.maxFen === undefined ? '' : (props.initialFilter.maxFen / 100).toFixed(2));
const allMonths = ref(!props.initialFilter?.monthKey);
const records = ref<ExpenseRecord[]>([]);
const resultCount = ref(0);
const resultTotalFen = ref(0);
const nextCursor = ref<Awaited<ReturnType<typeof ledgerRepository.listRecordPage>>['nextCursor']>(null);
const loadingMore = ref(false);
const advancedOpen = ref(Boolean(props.initialFilter?.fromDate || props.initialFilter?.toDate || props.initialFilter?.minFen !== undefined || props.initialFilter?.maxFen !== undefined));
const loading = ref(false);
const message = ref('');
const undoId = ref<string | null>(null);
const selectedIds = ref<string[]>([]);
let requestId = 0;
let loadTimer: number | undefined;
let undoTimer: number | undefined;

const leafCategories = computed(() => props.categories.filter((category) => category.parentId !== null));
const rootCategories = computed(() => props.categories.filter((category) => category.parentId === null));
const leavesByRoot = computed(() => new Map(rootCategories.value.map((root) => [root.id, leafCategories.value.filter((category) => category.parentId === root.id)])));
const grouped = computed(() => {
  const groups = new Map<string, ExpenseRecord[]>();
  for (const record of records.value) groups.set(record.dateKey, [...(groups.get(record.dateKey) ?? []), record]);
  return [...groups.entries()].map(([dateKey, items]) => ({ dateKey, items, totalFen: items.reduce((sum, item) => sum + item.amountFen, 0) }));
});
const allSelected = computed(() => records.value.length > 0 && records.value.every((record) => selectedIds.value.includes(record.id)));
const selectedRecords = computed(() => records.value.filter((record) => selectedIds.value.includes(record.id)));

function dateLabel(dateKey: string): string {
  const date = new Date(`${dateKey}T12:00:00`);
  return Number.isNaN(date.getTime()) ? dateKey : date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
}

function selectMode(next: ListMode): void { mode.value = next; selectedIds.value = []; }
function onModeKeydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next: ListMode = event.key === 'ArrowLeft' || event.key === 'Home' ? 'active' : 'deleted';
  selectMode(next);
  void nextTick(() => document.querySelector<HTMLButtonElement>(`.mode-switcher button[data-mode="${next}"]`)?.focus());
}

function parseAmountFilter(value: string, label: string): number | undefined {
  if (!value.trim()) return undefined;
  const fen = Math.round(Number(value) * 100);
  if (!Number.isFinite(fen) || !Number.isInteger(fen) || fen < 0 || fen > 100_000_000) throw new Error(`${label}无效`);
  return fen;
}

function buildFilter(): RecordFilter {
  if (fromDate.value && toDate.value && fromDate.value > toDate.value) {
    throw new Error('日期范围无效：起始日期不能晚于结束日期');
  }
  const minFen = parseAmountFilter(minAmount.value, '最低金额');
  const maxFen = parseAmountFilter(maxAmount.value, '最高金额');
  if (minFen !== undefined && maxFen !== undefined && minFen > maxFen) throw new Error('金额范围无效：最低金额不能高于最高金额');
  return {
    monthKey: allMonths.value ? undefined : monthKey.value,
    query: query.value,
    categoryId: categoryKey.value.startsWith('leaf:') ? categoryKey.value.slice(5) : undefined,
    parentCategoryId: categoryKey.value.startsWith('root:') ? categoryKey.value.slice(5) : undefined,
    fromDate: fromDate.value || undefined,
    toDate: toDate.value || undefined,
    minFen,
    maxFen,
  };
}

async function load(reset = true): Promise<void> {
  const currentRequest = ++requestId;
  if (reset) loading.value = true;
  else loadingMore.value = true;
  message.value = '';
  try {
    const filter = buildFilter();
    const page = await ledgerRepository.listRecordPage(filter, reset ? null : nextCursor.value, 100, mode.value === 'deleted');
    if (currentRequest !== requestId) return;
    records.value = reset ? page.items : [...records.value, ...page.items];
    resultCount.value = page.totalCount;
    resultTotalFen.value = page.totalFen;
    nextCursor.value = page.nextCursor;
    selectedIds.value = selectedIds.value.filter((id) => records.value.some((record) => record.id === id));
  } catch (error) {
    if (currentRequest === requestId) message.value = error instanceof Error ? error.message : '加载记录失败';
  } finally {
    if (currentRequest === requestId) loading.value = false;
    if (currentRequest === requestId) loadingMore.value = false;
  }
}

function queueLoad(): void {
  if (loadTimer !== undefined) window.clearTimeout(loadTimer);
  loadTimer = window.setTimeout(() => { loadTimer = undefined; void load(true); }, 220);
}

function clearFilters(): void {
  query.value = '';
  categoryKey.value = '';
  fromDate.value = '';
  toDate.value = '';
  minAmount.value = '';
  maxAmount.value = '';
  allMonths.value = false;
  monthKey.value = monthKeyNow();
}

async function remove(record: ExpenseRecord): Promise<void> {
  if (!await confirmAction(`确认删除「${record.parentCategoryNameSnapshot} / ${record.categoryNameSnapshot} ¥${formatFen(record.amountFen)}」吗？记录会进入回收站，可随时恢复。`, { title: '删除记录', confirmLabel: '移入回收站', danger: true })) return;
  try {
    await ledgerRepository.deleteRecord(record.id);
    undoId.value = record.id;
    if (undoTimer !== undefined) window.clearTimeout(undoTimer);
    undoTimer = window.setTimeout(() => { undoId.value = null; undoTimer = undefined; }, 10_000);
    emit('changed');
    await load(true);
  } catch (error) {
    message.value = error instanceof Error ? error.message : '删除失败';
  }
}

async function undoDelete(): Promise<void> {
  if (!undoId.value) return;
  if (undoTimer !== undefined) window.clearTimeout(undoTimer);
  undoTimer = undefined;
  try {
    await ledgerRepository.restoreRecord(undoId.value);
    undoId.value = null;
    emit('changed');
    await load(true);
  } catch (error) {
    message.value = error instanceof Error ? error.message : '撤销删除失败';
  }
}

async function restore(record: ExpenseRecord): Promise<void> {
  try {
    await ledgerRepository.restoreRecord(record.id);
    selectedIds.value = selectedIds.value.filter((id) => id !== record.id);
    emit('changed');
    await load(true);
  } catch (error) {
    message.value = error instanceof Error ? error.message : '恢复失败';
  }
}

async function restoreSelected(): Promise<void> {
  const ids = selectedRecords.value.map((record) => record.id);
  if (!ids.length) return;
  try {
    await ledgerRepository.restoreRecords(ids);
    selectedIds.value = [];
    emit('changed');
    await load(true);
  } catch (error) {
    message.value = error instanceof Error ? error.message : '批量恢复失败';
  }
}

async function purge(ids?: string[]): Promise<void> {
  const targetIds = ids ?? selectedRecords.value.map((record) => record.id);
  if (!targetIds.length) return;
  const label = targetIds.length === records.value.length ? '当前回收站中的全部记录' : `${targetIds.length} 笔记录`;
  if (!await confirmAction(`确定永久清除${label}吗？此操作不能撤销，但不会影响其他记录。`, { title: '永久清除记录', confirmLabel: '永久清除', danger: true })) return;
  try {
    await ledgerRepository.purgeDeletedRecords(targetIds);
    selectedIds.value = [];
    emit('changed');
    await load(true);
  } catch (error) {
    message.value = error instanceof Error ? error.message : '清空回收站失败';
  }
}

function toggleSelection(id: string): void {
  selectedIds.value = selectedIds.value.includes(id) ? selectedIds.value.filter((item) => item !== id) : [...selectedIds.value, id];
}

function toggleAll(): void {
  selectedIds.value = allSelected.value ? [] : records.value.map((record) => record.id);
}

function applyInitialFilter(filter: RecordFilter | null | undefined): void {
  if (!filter) return;
  monthKey.value = filter.monthKey ?? monthKeyNow();
  query.value = filter.query ?? '';
  categoryKey.value = filter.parentCategoryId ? `root:${filter.parentCategoryId}` : filter.categoryId ? `leaf:${filter.categoryId}` : '';
  fromDate.value = filter.fromDate ?? '';
  toDate.value = filter.toDate ?? '';
  minAmount.value = filter.minFen === undefined ? '' : (filter.minFen / 100).toFixed(2);
  maxAmount.value = filter.maxFen === undefined ? '' : (filter.maxFen / 100).toFixed(2);
  allMonths.value = !filter.monthKey;
}

watch(() => props.initialFilter, applyInitialFilter, { deep: true });
watch([monthKey, query, categoryKey, fromDate, toDate, minAmount, maxAmount, allMonths, mode, () => props.refreshToken], queueLoad, { immediate: true });
onBeforeUnmount(() => {
  if (loadTimer !== undefined) window.clearTimeout(loadTimer);
  if (undoTimer !== undefined) window.clearTimeout(undoTimer);
});
</script>

<template>
  <section class="view-stack">
    <header class="view-heading records-heading">
      <div><p class="eyebrow">消费历史</p><h1>{{ mode === 'active' ? '每一笔都有据可查' : '误删的记录可以找回' }}</h1></div>
      <div class="mode-switcher" role="tablist" aria-label="记录视图" @keydown="onModeKeydown">
        <button type="button" role="tab" data-mode="active" :tabindex="mode === 'active' ? 0 : -1" :aria-selected="mode === 'active'" :class="{ active: mode === 'active' }" @click="selectMode('active')">消费记录</button>
        <button type="button" role="tab" data-mode="deleted" :tabindex="mode === 'deleted' ? 0 : -1" :aria-selected="mode === 'deleted'" :class="{ active: mode === 'deleted' }" @click="selectMode('deleted')">回收站</button>
      </div>
    </header>

    <section class="content-card records-card">
      <div class="filter-row">
        <input v-model="query" class="search-input" type="search" placeholder="搜索分类、地点或备注" aria-label="搜索记录" />
        <label class="month-filter"><input v-model="monthKey" type="month" :disabled="allMonths" /><span>月份</span></label>
        <label class="checkbox-label"><input v-model="allMonths" type="checkbox" /> 查看全部月份</label>
        <select v-model="categoryKey" class="filter-select" aria-label="按分类筛选"><option value="">全部分类</option><optgroup v-for="root in rootCategories" :key="root.id" :label="`${root.icon} ${root.name}`"><option :value="`root:${root.id}`">全部 {{ root.name }}</option><option v-for="category in leavesByRoot.get(root.id)" :key="category.id" :value="`leaf:${category.id}`">↳ {{ category.icon }} {{ category.name }}</option></optgroup></select>
        <button class="text-button" type="button" :aria-expanded="advancedOpen" @click="advancedOpen = !advancedOpen">{{ advancedOpen ? '收起高级筛选' : '高级筛选' }}</button>
      </div>
      <div v-if="advancedOpen" class="filter-row filter-row-secondary">
        <label class="compact-filter"><span>从</span><input v-model="fromDate" type="date" /></label>
        <label class="compact-filter"><span>到</span><input v-model="toDate" type="date" /></label>
        <label class="compact-filter"><span>最低 ¥</span><input v-model="minAmount" inputmode="decimal" placeholder="0" /></label>
        <label class="compact-filter"><span>最高 ¥</span><input v-model="maxAmount" inputmode="decimal" placeholder="不限" /></label>
        <button class="text-button" type="button" @click="clearFilters">清除筛选</button>
      </div>
      <div class="record-summary"><span>{{ loading ? '正在读取…' : `共 ${resultCount} 笔` }} · ¥ {{ formatFen(resultTotalFen) }}<small v-if="records.length < resultCount"> · 已加载 {{ records.length }} 笔</small></span><span v-if="mode === 'deleted'">回收站记录不会参与统计</span><button v-if="undoId && mode === 'active'" class="undo-button" type="button" @click="undoDelete">撤销刚才的删除</button></div>
      <p v-if="message" class="form-message" aria-live="polite">{{ message }}</p>

      <div v-if="mode === 'deleted' && records.length" class="bulk-actions"><label class="checkbox-label"><input type="checkbox" :checked="allSelected" @change="toggleAll" /> 全选</label><button class="secondary-button" type="button" :disabled="!selectedIds.length" @click="restoreSelected">恢复选中</button><button class="danger-button" type="button" :disabled="!selectedIds.length" @click="purge()">永久清除选中</button><button class="danger-text" type="button" @click="purge(records.map((record) => record.id))">清空当前回收站</button></div>
      <div v-if="loading && !records.length" class="empty-state small"><span>◌</span><p>正在读取本地账本…</p></div>
      <div v-else-if="grouped.length" class="history-groups">
        <section v-for="group in grouped" :key="group.dateKey" class="history-group">
          <div class="group-title"><b>{{ dateLabel(group.dateKey) }}</b><span>当日 ¥ {{ formatFen(group.totalFen) }}</span></div>
          <div class="record-list">
            <article v-for="record in group.items" :key="record.id" class="history-row" :class="{ deleted: mode === 'deleted' }">
              <label v-if="mode === 'deleted'" class="row-check"><input type="checkbox" :checked="selectedIds.includes(record.id)" :aria-label="`选择 ${record.categoryNameSnapshot}`" @change="toggleSelection(record.id)" /></label>
              <span class="record-icon">{{ record.categoryNameSnapshot.slice(0, 1) }}</span>
              <div class="record-main"><b>{{ record.parentCategoryNameSnapshot }} / {{ record.categoryNameSnapshot }}</b><small>{{ record.merchantName || '未填写地点' }} · {{ displayLocalDateTime(record.occurredLocal).slice(11) }}{{ record.remark ? ` · ${record.remark}` : '' }}</small></div>
              <strong>¥ {{ formatFen(record.amountFen) }}</strong>
              <div class="row-actions" v-if="mode === 'active'"><button type="button" class="text-button" @click="emit('edit', record)">编辑</button><button type="button" class="danger-text" @click="remove(record)">删除</button></div>
              <div class="row-actions" v-else><button type="button" class="text-button" @click="restore(record)">恢复</button><button type="button" class="danger-text" @click="purge([record.id])">永久清除</button></div>
            </article>
          </div>
        </section>
      </div>
      <div v-else class="empty-state"><span>{{ mode === 'deleted' ? '✓' : '⌁' }}</span><h3>{{ mode === 'deleted' ? '回收站是空的' : '没有符合条件的记录' }}</h3><p>{{ mode === 'deleted' ? '删除的记录会暂时保留在这里。' : '换一个筛选条件或先记下一笔消费。' }}</p></div>
      <div v-if="nextCursor" class="load-more"><button class="secondary-button" type="button" :disabled="loadingMore" @click="load(false)">{{ loadingMore ? '正在加载…' : `继续加载（剩余 ${Math.max(resultCount - records.length, 0)} 笔）` }}</button></div>
    </section>
  </section>
</template>
