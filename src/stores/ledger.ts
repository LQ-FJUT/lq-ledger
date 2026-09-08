import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { Category, EntryTemplate, ExpenseRecord, Merchant, OverviewStats } from '@/types';
import { ledgerRepository } from '@/services/repository';

export const useLedgerStore = defineStore('ledger', () => {
  const ready = ref(false);
  const loading = ref(false);
  const error = ref('');
  const categories = ref<Category[]>([]);
  const overview = ref<OverviewStats>({
    monthKey: '', monthTotalFen: 0, monthTotalCount: 0, previousMonthTotalFen: 0, previousMonthTotalCount: 0,
    todayTotalFen: 0, todayTotalCount: 0, lifetimeTotalFen: 0, lifetimeTotalCount: 0,
    merchantCount: 0, rootCategoryCount: 0, leafCategoryCount: 0,
    monthlyBudgetFen: null, topCategoryName: '', topCategoryFen: 0,
  });
  const latestRecords = ref<ExpenseRecord[]>([]);
  const recentCategoryIds = ref<string[]>([]);
  const recentMerchants = ref<Merchant[]>([]);
  const entryTemplates = ref<EntryTemplate[]>([]);
  const activeCategories = computed(() => categories.value);

  async function initialize(): Promise<void> {
    loading.value = true;
    error.value = '';
    try {
      await ledgerRepository.initialize();
      await refreshDashboard();
      ready.value = true;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '无法初始化本地账本';
      throw cause;
    } finally {
      loading.value = false;
    }
  }

  async function refreshDashboard(): Promise<void> {
    const [nextCategories, nextOverview, nextRecords, defaults, templates] = await Promise.all([
      ledgerRepository.listCategories(), ledgerRepository.getDashboardStats(), ledgerRepository.listLatestRecords(5),
      ledgerRepository.getRecentEntryDefaults(), ledgerRepository.listEntryTemplates(),
    ]);
    categories.value = nextCategories;
    overview.value = nextOverview;
    latestRecords.value = nextRecords;
    recentCategoryIds.value = defaults.categoryIds;
    recentMerchants.value = defaults.merchants;
    entryTemplates.value = templates;
  }

  return {
    ready, loading, error, categories: activeCategories, overview, latestRecords, recentCategoryIds, recentMerchants, entryTemplates,
    initialize, refreshDashboard, repository: ledgerRepository,
  };
});
