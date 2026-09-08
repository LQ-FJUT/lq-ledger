<script setup lang="ts">
import { computed } from 'vue';
import type { ExpenseRecord, OverviewStats } from '@/types';
import { displayLocalDateTime, formatFen, formatMonthKey } from '@/utils';

const props = defineProps<{ overview: OverviewStats; latestRecords: ExpenseRecord[] }>();
const emit = defineEmits<{ go: [view: 'add' | 'records' | 'stats']; edit: [record: ExpenseRecord] }>();
const monthDelta = computed(() => {
  const current = props.overview.monthTotalFen;
  const previous = props.overview.previousMonthTotalFen;
  if (!previous) return current ? '上月暂无记录' : '上月暂无记录';
  const percent = ((current - previous) / previous) * 100;
  return `${percent >= 0 ? '较上月增加' : '较上月减少'} ${Math.abs(percent).toFixed(1)}%`;
});
const budgetRemaining = computed(() => props.overview.monthlyBudgetFen === null ? null : props.overview.monthlyBudgetFen - props.overview.monthTotalFen);
const budgetPercent = computed(() => props.overview.monthlyBudgetFen ? (props.overview.monthTotalFen / props.overview.monthlyBudgetFen) * 100 : 0);
</script>

<template>
  <section class="view-stack">
    <header class="view-heading hero-heading">
      <div>
        <p class="eyebrow">{{ formatMonthKey(overview.monthKey) }}消费</p>
        <h1>把每一笔，记得轻松一点。</h1>
      </div>
      <button class="primary-button" type="button" @click="emit('go', 'add')">＋ 记一笔</button>
    </header>

    <div class="overview-grid">
      <article class="summary-card main-summary">
        <span>本月支出</span>
        <strong>¥ {{ formatFen(overview.monthTotalFen) }}</strong>
        <small>{{ overview.monthTotalCount }} 笔 · {{ monthDelta }}</small>
      </article>
      <article class="summary-card">
        <span>今日支出</span>
        <strong>¥ {{ formatFen(overview.todayTotalFen) }}</strong>
        <small>{{ overview.todayTotalCount }} 笔消费</small>
      </article>
      <article class="summary-card">
        <span>累计支出</span>
        <strong>¥ {{ formatFen(overview.lifetimeTotalFen) }}</strong>
        <small>{{ overview.lifetimeTotalCount }} 笔消费记录</small>
      </article>
      <article class="summary-card">
        <span>本月预算</span>
        <strong v-if="overview.monthlyBudgetFen !== null" :class="{ danger: budgetRemaining !== null && budgetRemaining < 0 }">{{ budgetRemaining !== null && budgetRemaining >= 0 ? `余 ¥ ${formatFen(budgetRemaining)}` : `超 ¥ ${formatFen(Math.abs(budgetRemaining ?? 0))}` }}</strong>
        <strong v-else>未设置</strong>
        <small v-if="overview.monthlyBudgetFen">已使用 {{ budgetPercent.toFixed(1) }}%</small><small v-else>可在统计页设置或复制上月预算</small>
      </article>
    </div>

    <div v-if="overview.topCategoryName" class="insight-strip"><span>本月支出最多</span><b>{{ overview.topCategoryName }}</b><strong>¥ {{ formatFen(overview.topCategoryFen) }}</strong><button class="text-button" type="button" @click="emit('go', 'stats')">查看分析</button></div>

    <section class="content-card recent-card">
      <div class="card-heading">
        <div>
          <h2>最近记录</h2>
        <p>最近保存的 5 笔消费，点击可直接编辑</p>
        </div>
        <button class="text-button" type="button" @click="emit('go', 'records')">查看全部</button>
      </div>
      <div v-if="latestRecords.length" class="record-list compact-list">
        <button v-for="record in latestRecords" :key="record.id" class="record-row" type="button" :title="`编辑 ${record.categoryNameSnapshot} ¥${formatFen(record.amountFen)}`" @click="emit('edit', record)">
          <span class="record-icon">{{ record.parentCategoryNameSnapshot.slice(0, 1) }}</span>
          <span class="record-main">
            <b>{{ record.categoryNameSnapshot }}</b>
            <small>{{ record.merchantName || '未填写地点' }} · {{ displayLocalDateTime(record.occurredLocal) }}</small>
          </span>
          <strong>¥ {{ formatFen(record.amountFen) }}</strong>
        </button>
      </div>
      <div v-else class="empty-state">
        <span>◎</span>
        <h3>从第一笔消费开始吧</h3>
        <p>分类、地点和统计会随着记录慢慢变得更懂你。</p>
        <button class="primary-button" type="button" @click="emit('go', 'add')">现在记一笔</button>
      </div>
    </section>
  </section>
</template>
