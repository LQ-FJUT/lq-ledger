<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { ExpenseRecord, RecordFilter } from '@/types';
import { useLedgerStore } from '@/stores/ledger';
import DashboardView from '@/components/DashboardView.vue';
import RecordForm from '@/components/RecordForm.vue';
import RecordsView from '@/components/RecordsView.vue';
import StatsView from '@/components/StatsView.vue';
import SettingsView from '@/components/SettingsView.vue';
import AppIcon from '@/components/AppIcon.vue';
import ConfirmHost from '@/components/ConfirmHost.vue';
import { runDailyBackupIfDue } from '@/services/backup';
import { createCloseRequestedHandler } from '@/services/closeGuard';
import { confirmAction, confirmCloseAction } from '@/services/confirm';

type ViewName = 'dashboard' | 'add' | 'records' | 'stats' | 'settings';

const store = useLedgerStore();
const activeView = ref<ViewName>('dashboard');
const editingRecord = ref<ExpenseRecord | null>(null);
const entryReturnView = ref<ViewName>('dashboard');
const entryDirty = ref(false);
const recordsFilter = ref<RecordFilter | null>(null);
const refreshToken = ref(0);
const notice = ref('');
const initializing = ref(true);
let unlistenClose: (() => void) | undefined;

const navItems: Array<{ id: ViewName; label: string }> = [
  { id: 'dashboard', label: '概览' },
  { id: 'add', label: '记一笔' },
  { id: 'records', label: '记录' },
  { id: 'stats', label: '统计' },
  { id: 'settings', label: '设置' },
];

const activeTitle = computed(() => navItems.find((item) => item.id === activeView.value)?.label ?? 'L.Q记账');

async function confirmEntryLeave(): Promise<boolean> {
  return activeView.value !== 'add' || !entryDirty.value || confirmAction('这笔记录还有未保存内容，确定放弃吗？', { title: '放弃未保存记录', confirmLabel: '放弃记录', danger: true });
}

async function navigate(view: ViewName): Promise<void> {
  if (view !== activeView.value && !await confirmEntryLeave()) return;
  activeView.value = view;
  if (view !== 'add') {
    editingRecord.value = null;
    entryDirty.value = false;
  }
  if (view === 'records') recordsFilter.value = null;
  notice.value = '';
}

async function openAdd(): Promise<void> {
  if (activeView.value === 'add') return;
  if (!await confirmEntryLeave()) return;
  editingRecord.value = null;
  entryReturnView.value = activeView.value;
  activeView.value = 'add';
  notice.value = '';
}

async function startEdit(record: ExpenseRecord, returnView: ViewName = 'records'): Promise<void> {
  if (!await confirmEntryLeave()) return;
  editingRecord.value = record;
  entryReturnView.value = returnView;
  activeView.value = 'add';
  notice.value = '正在编辑一笔已有记录';
}

async function cancelEntry(): Promise<void> {
  if (!await confirmEntryLeave()) return;
  editingRecord.value = null;
  entryDirty.value = false;
  activeView.value = entryReturnView.value;
  notice.value = '';
}

async function openRecordsWithFilter(filter: RecordFilter): Promise<void> {
  if (!await confirmEntryLeave()) return;
  editingRecord.value = null;
  entryDirty.value = false;
  recordsFilter.value = filter;
  activeView.value = 'records';
  notice.value = '已按统计结果筛选记录';
}

async function recordSaved(_record: ExpenseRecord, keepOpen = false): Promise<void> {
  editingRecord.value = null;
  entryDirty.value = false;
  refreshToken.value += 1;
  let refreshFailed = false;
  try {
    await store.refreshDashboard();
  } catch {
    refreshFailed = true;
  }
  void runDailyBackupIfDue(store.repository).catch(() => { notice.value = '记录已保存，但每日备份失败，请到设置检查备份目录'; });
  if (keepOpen) {
    activeView.value = 'add';
    notice.value = refreshFailed ? '记录已写入，但列表刷新失败，可以稍后重试' : '已写入本地账本，可以继续记账';
  } else {
    activeView.value = 'dashboard';
    notice.value = refreshFailed ? '记录已写入，但列表刷新失败，可以稍后重试' : '已写入本地账本';
  }
}

async function refreshAfterMutation(): Promise<void> {
  refreshToken.value += 1;
  await store.refreshDashboard();
  void runDailyBackupIfDue(store.repository).catch(() => { notice.value = '数据已更新，但每日备份失败，请到设置检查备份目录'; });
}

async function applyPreferences(): Promise<void> {
  const [theme, density] = await Promise.all([store.repository.getSetting('theme'), store.repository.getSetting('density')]);
  document.documentElement.dataset.theme = theme || 'system';
  document.documentElement.dataset.density = density || 'comfortable';
}

function onKeyboard(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    void openAdd();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    void navigate('records').then(() => { if (activeView.value === 'records') {
      window.setTimeout(() => document.querySelector<HTMLInputElement>('.search-input')?.focus(), 0);
    } });
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeyboard);
  try {
    await store.initialize();
    await applyPreferences();
    const currentWindow = getCurrentWindow();
    unlistenClose = await currentWindow.onCloseRequested(createCloseRequestedHandler({
      isBlocked: () => activeView.value === 'add' && entryDirty.value,
      prepareConfirmation: async () => {
        if (await currentWindow.isMinimized()) await currentWindow.unminimize();
        await currentWindow.setFocus();
      },
      confirmDiscard: () => confirmCloseAction('这笔记录还有未保存内容，确定关闭 L.Q记账吗？', { title: '关闭应用', confirmLabel: '放弃并关闭', danger: true }),
      destroy: () => currentWindow.destroy(),
      onError: () => { notice.value = '关闭应用失败，请重试'; },
    }));
  } finally {
    initializing.value = false;
  }
});

onBeforeUnmount(() => { window.removeEventListener('keydown', onKeyboard); unlistenClose?.(); });
</script>

<template>
  <main v-if="initializing" class="launch-screen">
    <div class="launch-mark">L.Q</div>
    <h1>正在打开记账本</h1>
    <p>所有数据只保存在这台电脑上。</p>
  </main>

  <main v-else-if="store.error" class="launch-screen error-screen">
    <div class="launch-mark">!</div>
    <h1>本地账本没有打开</h1>
    <p>{{ store.error }}</p>
    <button class="primary-button" type="button" @click="store.initialize()">重新尝试</button>
  </main>

  <main v-else class="app-shell">
    <ConfirmHost />
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">L.Q</span><span><b>记账本</b><small>OFFLINE LEDGER</small></span></div>
      <nav class="sidebar-nav" aria-label="主导航">
        <button v-for="item in navItems" :key="item.id" type="button" :aria-current="activeView === item.id ? 'page' : undefined" :class="{ active: activeView === item.id }" @click="item.id === 'add' ? openAdd() : navigate(item.id)">
          <span><AppIcon :name="item.id" /></span>{{ item.label }}
        </button>
      </nav>
      <div class="sidebar-foot"><span class="status-dot" /> 数据仅存本机</div>
    </aside>

    <section class="content-shell">
      <header class="topbar">
        <div><span class="topbar-kicker">L.Q 记账本</span><b>{{ activeTitle }}</b></div>
        <div class="topbar-actions"><span v-if="notice" class="notice" aria-live="polite">{{ notice }}</span><kbd>Ctrl N</kbd><button class="quick-add" type="button" title="记一笔 (Ctrl+N)" @click="openAdd">＋</button></div>
      </header>
      <div class="page-content">
        <DashboardView v-if="activeView === 'dashboard'" :overview="store.overview" :latest-records="store.latestRecords" @go="navigate" @edit="startEdit($event, 'dashboard')" />
        <RecordForm v-else-if="activeView === 'add'" :categories="store.categories" :record="editingRecord" :latest-record="store.latestRecords[0] ?? null" :recent-category-ids="store.recentCategoryIds" :recent-merchants="store.recentMerchants" :templates="store.entryTemplates" @saved="recordSaved" @cancel="cancelEntry" @dirty-change="entryDirty = $event" @templates-changed="refreshAfterMutation" />
        <RecordsView v-else-if="activeView === 'records'" :categories="store.categories" :initial-filter="recordsFilter" :refresh-token="refreshToken" @edit="startEdit" @changed="refreshAfterMutation" />
        <StatsView v-else-if="activeView === 'stats'" :categories="store.categories" :refresh-token="refreshToken" @drilldown="openRecordsWithFilter" />
        <SettingsView v-else :categories="store.categories" @changed="refreshAfterMutation" @preferences-changed="applyPreferences" />
      </div>
    </section>

    <nav class="bottom-nav" aria-label="主导航">
      <button v-for="item in navItems" :key="item.id" type="button" :aria-current="activeView === item.id ? 'page' : undefined" :class="{ active: activeView === item.id }" @click="item.id === 'add' ? openAdd() : navigate(item.id)"><span><AppIcon :name="item.id" /></span>{{ item.label }}</button>
    </nav>
  </main>
</template>
