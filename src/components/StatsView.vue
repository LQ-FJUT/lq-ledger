<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { Category, MonthlyStats, RecordFilter, TrendPoint } from '@/types';
import { ledgerRepository } from '@/services/repository';
import { formatFen, formatMonthKey, monthKeyNow, parseAmountToFen, shiftMonth } from '@/utils';

const props = defineProps<{ refreshToken: number; categories: Category[] }>();
const emit = defineEmits<{ drilldown: [filter: RecordFilter] }>();
const monthKey = ref(monthKeyNow());
const stats = ref<MonthlyStats>({
  monthKey: monthKey.value, totalFen: 0, totalCount: 0, previousMonthTotalFen: 0, previousMonthTotalCount: 0,
  averageDailyFen: 0, categories: [], daily: [], maxDay: null,
  budgetPlan: { monthKey: monthKey.value, monthly: null, categories: [] },
  budgetUsage: [],
});
const trend = ref<TrendPoint[]>([]);
const message = ref('');
const loading = ref(false);
const savingBudget = ref(false);
const monthlyBudgetInput = ref('');
const categoryBudgetInputs = reactive<Record<string, string>>({});
let requestId = 0;

const donut = computed(() => {
  if (!stats.value.totalFen) return 'conic-gradient(#e8eceb 0 100%)';
  let current = 0;
  const slices = stats.value.categories.map((category) => {
    const next = current + (category.fen / stats.value.totalFen) * 100;
    const result = `${category.color} ${current.toFixed(2)}% ${next.toFixed(2)}%`;
    current = next;
    return result;
  });
  return `conic-gradient(${slices.join(', ')})`;
});
const maxDaily = computed(() => Math.max(...stats.value.daily.map((item) => item.fen), 1));
const maxTrend = computed(() => Math.max(...trend.value.map((item) => item.value), 1));
const monthlyBudget = computed(() => stats.value.budgetPlan.monthly?.amountFen ?? 0);
const monthlyBudgetPercent = computed(() => monthlyBudget.value ? (stats.value.totalFen / monthlyBudget.value) * 100 : 0);
const monthlyBudgetProgressPercent = computed(() => Math.min(monthlyBudgetPercent.value, 100));
const monthlyBudgetRemaining = computed(() => monthlyBudget.value - stats.value.totalFen);
const categoryBudgets = computed(() => new Map(stats.value.budgetPlan.categories.map((budget) => [budget.categoryId, budget])));
const budgetCategories = computed(() => [...props.categories].sort((a, b) => Number(a.parentId !== null) - Number(b.parentId !== null) || a.sortOrder - b.sortOrder));
const budgetUsage = computed(() => new Map(stats.value.budgetUsage.map((usage) => [usage.categoryId, usage])));
const monthDelta = computed(() => {
  const previous = stats.value.previousMonthTotalFen;
  if (!previous) return stats.value.totalFen ? '上月暂无记录' : '暂无上月数据';
  const percent = ((stats.value.totalFen - previous) / previous) * 100;
  return `${percent >= 0 ? '增加' : '减少'} ${Math.abs(percent).toFixed(1)}%`;
});

function syncBudgetInputs(): void {
  monthlyBudgetInput.value = monthlyBudget.value ? (monthlyBudget.value / 100).toFixed(2) : '';
  for (const category of budgetCategories.value) {
    const budget = categoryBudgets.value.get(category.id);
    categoryBudgetInputs[category.id] = budget ? (budget.amountFen / 100).toFixed(2) : '';
  }
}

async function load(): Promise<void> {
  const currentRequest = ++requestId;
  loading.value = true;
  message.value = '';
  try {
    const [nextStats, nextTrend] = await Promise.all([ledgerRepository.getMonthlyStats(monthKey.value), ledgerRepository.getTrend(monthKey.value, 6)]);
    if (currentRequest !== requestId) return;
    stats.value = nextStats;
    trend.value = nextTrend;
    syncBudgetInputs();
  } catch (error) {
    if (currentRequest === requestId) message.value = error instanceof Error ? error.message : '读取统计失败';
  } finally {
    if (currentRequest === requestId) loading.value = false;
  }
}

function move(delta: number): void { monthKey.value = shiftMonth(monthKey.value, delta); }

async function saveBudget(categoryId: string | null, value: string): Promise<void> {
  savingBudget.value = true;
  message.value = '';
  try {
    const amountFen = value.trim() ? parseAmountToFen(value) : null;
    await ledgerRepository.saveBudget(monthKey.value, categoryId, amountFen);
    await load();
    message.value = categoryId ? '分类预算已保存' : '月度预算已保存';
  } catch (error) {
    message.value = error instanceof Error ? error.message : '预算保存失败';
  } finally {
    savingBudget.value = false;
  }
}

async function copyPreviousBudgets(): Promise<void> {
  savingBudget.value = true;
  message.value = '';
  try {
    const count = await ledgerRepository.copyBudgets(shiftMonth(monthKey.value, -1), monthKey.value);
    await load();
    message.value = count ? `已复制上月 ${count} 项预算` : '本月已有预算或上月没有可复制的预算';
  } catch (error) {
    message.value = error instanceof Error ? error.message : '复制预算失败';
  } finally {
    savingBudget.value = false;
  }
}

watch([monthKey, () => props.refreshToken], () => { void load(); }, { immediate: true });
</script>

<template>
  <section class="view-stack" :aria-busy="loading">
    <header class="view-heading">
      <div><p class="eyebrow">消费统计</p><h1>看见钱花在了哪里</h1></div>
      <div class="month-switcher"><button type="button" aria-label="上个月" @click="move(-1)">‹</button><input v-model="monthKey" type="month" aria-label="统计月份" /><button type="button" aria-label="下个月" @click="move(1)">›</button></div>
    </header>
    <p v-if="message" class="form-message" aria-live="polite">{{ message }}</p>
    <div class="overview-grid stats-summary">
      <article class="summary-card main-summary"><span>{{ formatMonthKey(monthKey) }}支出</span><strong>¥ {{ formatFen(stats.totalFen) }}</strong><small>{{ stats.totalCount }} 笔 · 较上月 {{ monthDelta }}</small></article>
      <article class="summary-card"><span>日均支出</span><strong>¥ {{ formatFen(stats.averageDailyFen) }}</strong><small>按当月日历天数计算</small></article>
      <article class="summary-card"><span>最高消费日</span><strong>{{ stats.maxDay ? `${Number(stats.maxDay.dateKey.slice(8))} 日` : '—' }}</strong><small>{{ stats.maxDay ? `¥ ${formatFen(stats.maxDay.fen)}` : '暂无记录' }}</small></article>
    </div>

    <section class="content-card budget-card">
      <div class="card-heading"><div><h2>预算计划</h2><p>预算只影响提醒，不会改变消费记录</p></div><span v-if="monthlyBudget" class="budget-status" :class="{ over: monthlyBudgetRemaining < 0 }">{{ monthlyBudgetRemaining >= 0 ? `剩余 ¥ ${formatFen(monthlyBudgetRemaining)}` : `超出 ¥ ${formatFen(Math.abs(monthlyBudgetRemaining))}` }}</span></div>
      <div class="budget-editor"><label class="compact-filter"><span>本月预算 ¥</span><input v-model="monthlyBudgetInput" inputmode="decimal" placeholder="不设置" /></label><button class="secondary-button" type="button" :disabled="savingBudget" @click="saveBudget(null, monthlyBudgetInput)">{{ savingBudget ? '保存中…' : '保存月度预算' }}</button><button class="text-button" type="button" :disabled="savingBudget" @click="copyPreviousBudgets">复制上月预算</button></div>
      <div v-if="monthlyBudget" class="budget-progress"><i><em :style="{ width: `${monthlyBudgetProgressPercent}%` }" /></i><small>已使用 {{ monthlyBudgetPercent.toFixed(1) }}% · ¥ {{ formatFen(stats.totalFen) }} / ¥ {{ formatFen(monthlyBudget) }}</small></div>
      <details v-if="budgetCategories.length" class="category-budget-details"><summary>设置一级及末级分类预算</summary><div class="category-budget-list"><div v-for="category in budgetCategories" :key="category.id" class="category-budget-row" :class="{ child: category.parentId }"><span>{{ category.parentId ? '↳' : '' }} {{ category.icon }} {{ category.name }}<small v-if="budgetUsage.get(category.id)">已用 ¥{{ formatFen(budgetUsage.get(category.id)!.spentFen) }}</small></span><input v-model="categoryBudgetInputs[category.id]" inputmode="decimal" placeholder="不设置" :aria-label="`${category.name}预算`" /><button class="text-button" type="button" :disabled="savingBudget" @click="saveBudget(category.id, categoryBudgetInputs[category.id] ?? '')">保存</button></div></div></details>
    </section>

    <div v-if="loading && !stats.totalCount" class="content-card empty-state"><span>◌</span><p>正在计算统计…</p></div>
    <div v-else-if="stats.totalCount" class="stats-grid">
      <section class="content-card donut-card"><div class="card-heading"><div><h2>分类占比</h2><p>按一级分类汇总，点击可查看记录</p></div></div><div class="donut-layout"><div class="donut" :style="{ background: donut }" role="img" :aria-label="`${formatMonthKey(monthKey)}分类占比`"><div><b>¥ {{ formatFen(stats.totalFen) }}</b><small>本月支出</small></div></div><div class="legend-list"><button v-for="category in stats.categories" :key="category.id" class="legend-item stat-link" type="button" @click="emit('drilldown', { monthKey, parentCategoryId: category.id })"><i :style="{ background: category.color }" /><span>{{ category.icon }} {{ category.name }}</span><b>{{ ((category.fen / stats.totalFen) * 100).toFixed(1) }}%</b></button></div></div></section>
      <section class="content-card ranking-card"><div class="card-heading"><div><h2>分类排行</h2><p>金额从高到低</p></div></div><div class="ranking-list"><div v-for="category in stats.categories" :key="category.id" class="ranking-item"><button class="stat-link ranking-link" type="button" @click="emit('drilldown', { monthKey, parentCategoryId: category.id })"><span>{{ category.icon }} {{ category.name }}</span><b>¥ {{ formatFen(category.fen) }}</b></button><i><em :style="{ width: `${(category.fen / stats.totalFen) * 100}%`, background: category.color }" /></i><small>{{ category.count }} 笔{{ categoryBudgets.has(category.id) ? ` · 预算 ¥${formatFen(categoryBudgets.get(category.id)!.amountFen)}` : '' }}</small></div></div></section>
      <section class="content-card daily-card"><div class="card-heading"><div><h2>每日消费</h2><p>点击柱形查看当天记录</p></div></div><div class="bar-chart"><button v-for="day in stats.daily" :key="day.dateKey" class="bar-item stat-link" type="button" @click="emit('drilldown', { monthKey, fromDate: day.dateKey, toDate: day.dateKey })"><b>¥{{ formatFen(day.fen) }}</b><i><em :style="{ height: `${Math.max((day.fen / maxDaily) * 100, 3)}%` }" /></i><small>{{ Number(day.dateKey.slice(8)) }}日</small></button></div></section>
      <section class="content-card trend-card"><div class="card-heading"><div><h2>近六个月趋势</h2><p>点击月份切换统计</p></div></div><div class="trend-chart"><button v-for="point in trend" :key="point.key" class="trend-item stat-link" type="button" @click="monthKey = point.key"><i><em :style="{ height: `${Math.max((point.value / maxTrend) * 100, point.value ? 4 : 1)}%` }" /></i><b>¥{{ formatFen(point.value) }}</b><small>{{ point.label }}</small></button></div></section>
    </div>
    <div v-else-if="!loading" class="content-card empty-state"><span>⌁</span><h3>这个月还没有消费记录</h3><p>保存第一笔记录后，分类占比、每日消费和趋势会自动生成。</p></div>
  </section>
</template>
