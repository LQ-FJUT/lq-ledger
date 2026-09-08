<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import packageJson from '../../package.json';
import type { Category, CategoryMergePreview, EntryTemplate, Merchant } from '@/types';
import { invoke } from '@tauri-apps/api/core';
import { applyJsonBackup, chooseDailyBackupDirectory, chooseJsonBackup, exportCsvReport, exportJsonBackup, runDailyBackupIfDue, type BackupExportInfo } from '@/services/backup';
import { ledgerRepository } from '@/services/repository';
import { confirmAction } from '@/services/confirm';

const props = defineProps<{ categories: Category[] }>();
const emit = defineEmits<{ changed: []; preferencesChanged: [] }>();

type Tab = 'categories' | 'merchants' | 'templates' | 'preferences' | 'backup' | 'about';
const tabItems: Array<{ key: Tab; label: string }> = [{ key: 'categories', label: '分类管理' }, { key: 'merchants', label: '地点管理' }, { key: 'templates', label: '常用模板' }, { key: 'preferences', label: '界面偏好' }, { key: 'backup', label: '备份与恢复' }, { key: 'about', label: '关于' }];
const tab = ref<Tab>('categories');
const allCategories = ref<Category[]>([]);
const merchants = ref<Merchant[]>([]);
const message = ref('');
const editingId = ref<string | null>(null);
const categoryForm = reactive({ parentId: '', name: '', icon: '📌', color: '#72777D' });
const savingCategory = ref(false);
const busy = ref(false);
const mergeSourceId = ref('');
const mergeTargetId = ref('');
const mergePreview = ref<CategoryMergePreview | null>(null);
const mergingCategory = ref(false);
const lastExport = ref<BackupExportInfo | null>(null);
const autoBackups = ref<string[]>([]);
const loadingBackups = ref(false);
const templates = ref<EntryTemplate[]>([]);
const theme = ref('system');
const density = ref('comfortable');
const backupDirectory = ref('');
const dailyBackupStatus = ref('');

const sourceCategories = computed(() => allCategories.value.length ? allCategories.value : props.categories);
const activeCategories = computed(() => sourceCategories.value.filter((category) => !category.deletedAt));
const deletedCategories = computed(() => sourceCategories.value.filter((category) => category.deletedAt));
const roots = computed(() => activeCategories.value.filter((category) => category.parentId === null));
const leafCategories = computed(() => activeCategories.value.filter((category) => category.parentId !== null));
const children = computed(() => new Map(roots.value.map((root) => [root.id, activeCategories.value.filter((category) => category.parentId === root.id)])));
const mergeSource = computed(() => leafCategories.value.find((category) => category.id === mergeSourceId.value) ?? null);
const mergeTargets = computed(() => mergeSource.value ? leafCategories.value.filter((category) => category.parentId === mergeSource.value?.parentId && category.id !== mergeSource.value.id) : []);
const editing = computed(() => editingId.value !== null);

function clearMessage(): void { message.value = ''; }
function onTabKeydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const current = tabItems.findIndex((item) => item.key === tab.value);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabItems.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabItems.length) % tabItems.length;
  tab.value = tabItems[next].key;
  void nextTick(() => document.querySelector<HTMLButtonElement>(`.settings-tabs button[data-tab="${tab.value}"]`)?.focus());
}
function resetCategoryForm(): void { editingId.value = null; categoryForm.parentId = ''; categoryForm.name = ''; categoryForm.icon = '📌'; categoryForm.color = '#72777D'; }
function editCategory(category: Category): void { editingId.value = category.id; categoryForm.parentId = category.parentId ?? ''; categoryForm.name = category.name; categoryForm.icon = category.icon; categoryForm.color = category.color; clearMessage(); }

async function loadCategories(): Promise<void> {
  try { allCategories.value = await ledgerRepository.listCategories(true); } catch (error) { message.value = error instanceof Error ? error.message : '读取分类失败'; }
}

async function saveCategory(): Promise<void> {
  savingCategory.value = true;
  clearMessage();
  try {
    if (editingId.value) await ledgerRepository.updateCategory(editingId.value, categoryForm);
    else await ledgerRepository.addCategory({ ...categoryForm, parentId: categoryForm.parentId || null });
    resetCategoryForm();
    await loadCategories();
    emit('changed');
    message.value = '分类已保存';
  } catch (error) {
    message.value = error instanceof Error ? error.message : '保存分类失败';
  } finally {
    savingCategory.value = false;
  }
}

async function removeCategory(category: Category): Promise<void> {
  const scope = category.parentId === null ? '该大类及其全部子分类' : '该分类';
  if (!await confirmAction(`确认删除${scope}「${category.name}」吗？已有消费记录不会丢失，仍会保留当时的分类名称。`, { title: '删除分类', confirmLabel: '删除分类', danger: true })) return;
  try { await ledgerRepository.deleteCategory(category.id); await loadCategories(); emit('changed'); message.value = '分类已删除，可在下方恢复'; } catch (error) { message.value = error instanceof Error ? error.message : '删除分类失败'; }
}

async function restoreCategory(category: Category): Promise<void> {
  try { await ledgerRepository.restoreCategory(category.id); await loadCategories(); emit('changed'); message.value = '分类已恢复'; } catch (error) { message.value = error instanceof Error ? error.message : '恢复分类失败'; }
}

async function moveCategory(category: Category, direction: 'up' | 'down'): Promise<void> {
  try { await ledgerRepository.moveCategory(category.id, direction); await loadCategories(); emit('changed'); } catch (error) { message.value = error instanceof Error ? error.message : '调整分类顺序失败'; }
}

function resetMerge(): void {
  mergeSourceId.value = '';
  mergeTargetId.value = '';
  mergePreview.value = null;
}

async function previewCategoryMerge(): Promise<void> {
  if (!mergeSource.value || !mergeTargets.value.some((category) => category.id === mergeTargetId.value)) {
    message.value = '请选择同一个大类下的两个末级分类';
    return;
  }
  const target = mergeTargets.value.find((category) => category.id === mergeTargetId.value);
  if (!target) return;
  try {
    mergePreview.value = await ledgerRepository.previewCategoryMerge(mergeSource.value.id, target.id);
    message.value = '合并预览已生成，请确认影响范围';
  } catch (error) {
    message.value = error instanceof Error ? error.message : '无法生成合并预览';
  }
}

async function confirmCategoryMerge(): Promise<void> {
  if (!mergePreview.value) return;
  const preview = mergePreview.value;
  if (!await confirmAction(`将「${preview.sourceName}」合并到「${preview.targetName}」？会迁移 ${preview.activeRecords} 笔有效记录、${preview.deletedRecords} 笔回收站记录、${preview.merchants} 个地点、${preview.budgets} 项预算和 ${preview.templates} 个模板；源分类将停用，历史记录分类快照会改为目标分类。`, { title: '合并分类', confirmLabel: '确认合并', danger: true })) return;
  mergingCategory.value = true;
  try {
    await ledgerRepository.mergeCategories(mergeSourceId.value, mergeTargetId.value);
    resetMerge();
    await loadCategories();
    emit('changed');
    message.value = '分类已合并，源分类已停用';
  } catch (error) {
    message.value = error instanceof Error ? error.message : '合并分类失败';
  } finally {
    mergingCategory.value = false;
  }
}

async function loadMerchants(): Promise<void> {
  try { merchants.value = await ledgerRepository.listMerchants(undefined, true); } catch (error) { message.value = error instanceof Error ? error.message : '读取地点失败'; }
}
async function hideMerchant(merchant: Merchant): Promise<void> {
  if (!await confirmAction(`不再推荐「${merchant.name}」吗？已有消费记录不会受影响，之后仍可重新启用。`, { title: '隐藏地点', confirmLabel: '不再推荐', danger: true })) return;
  try { await ledgerRepository.hideMerchant(merchant.id); await loadMerchants(); message.value = '地点已隐藏，可重新启用'; } catch (error) { message.value = error instanceof Error ? error.message : '操作失败'; }
}
async function restoreMerchant(merchant: Merchant): Promise<void> {
  try { await ledgerRepository.restoreMerchant(merchant.id); await loadMerchants(); message.value = '地点已重新启用'; } catch (error) { message.value = error instanceof Error ? error.message : '启用地点失败'; }
}
async function loadAutoBackups(): Promise<void> {
  loadingBackups.value = true;
  try { autoBackups.value = await invoke<string[]>('list_pre_import_backups'); } catch (error) { message.value = error instanceof Error ? error.message : '读取自动备份失败'; } finally { loadingBackups.value = false; }
}
async function loadTemplates(): Promise<void> { templates.value = await ledgerRepository.listEntryTemplates(); }
async function removeTemplate(template: EntryTemplate): Promise<void> {
  if (!await confirmAction(`删除常用模板「${template.name}」吗？不会影响已有消费记录。`, { title: '删除模板', confirmLabel: '删除模板', danger: true })) return;
  try { await ledgerRepository.deleteEntryTemplate(template.id); await loadTemplates(); emit('changed'); message.value = '常用模板已删除'; } catch (error) { message.value = error instanceof Error ? error.message : '删除模板失败'; }
}
async function moveTemplate(template: EntryTemplate, direction: 'up' | 'down'): Promise<void> {
  try { await ledgerRepository.moveEntryTemplate(template.id, direction); await loadTemplates(); emit('changed'); } catch (error) { message.value = error instanceof Error ? error.message : '调整模板顺序失败'; }
}
async function loadPreferences(): Promise<void> {
  theme.value = await ledgerRepository.getSetting('theme') || 'system';
  density.value = await ledgerRepository.getSetting('density') || 'comfortable';
}
async function savePreferences(): Promise<void> {
  try {
    await Promise.all([ledgerRepository.setSetting('theme', theme.value), ledgerRepository.setSetting('density', density.value)]);
    document.documentElement.dataset.theme = theme.value;
    document.documentElement.dataset.density = density.value;
    emit('preferencesChanged');
    message.value = '界面偏好已保存';
  } catch (error) { message.value = error instanceof Error ? error.message : '保存偏好失败'; }
}
async function loadDailyBackupSettings(): Promise<void> {
  backupDirectory.value = await ledgerRepository.getSetting('dailyBackupDirectory') || '';
  dailyBackupStatus.value = await ledgerRepository.getSetting('dailyBackupStatus') || '';
}
async function configureDailyBackup(): Promise<void> {
  const directory = await chooseDailyBackupDirectory();
  if (!directory) return;
  busy.value = true;
  try {
    await ledgerRepository.setSetting('dailyBackupDirectory', directory);
    backupDirectory.value = directory;
    const path = await runDailyBackupIfDue(ledgerRepository, true);
    dailyBackupStatus.value = await ledgerRepository.getSetting('dailyBackupStatus') || '';
    message.value = path ? '每日备份已启用并完成首次备份' : '每日备份已启用';
  } catch (error) { message.value = error instanceof Error ? error.message : '无法启用每日备份'; }
  finally { busy.value = false; }
}
async function runDailyBackupNow(): Promise<void> {
  busy.value = true;
  try { await runDailyBackupIfDue(ledgerRepository, true); await loadDailyBackupSettings(); message.value = '每日备份已更新'; }
  catch (error) { await loadDailyBackupSettings(); message.value = error instanceof Error ? error.message : '自动备份失败'; }
  finally { busy.value = false; }
}
async function disableDailyBackup(): Promise<void> {
  await ledgerRepository.setSetting('dailyBackupDirectory', '');
  backupDirectory.value = '';
  message.value = '每日备份已关闭，现有备份文件不会删除';
}
async function exportJson(): Promise<void> { busy.value = true; try { const result = await exportJsonBackup(ledgerRepository); if (result) { lastExport.value = result; message.value = '完整 JSON 备份已导出'; } } catch (error) { message.value = error instanceof Error ? error.message : '导出失败'; } finally { busy.value = false; } }
async function exportCsv(): Promise<void> { busy.value = true; try { if (await exportCsvReport(ledgerRepository)) message.value = 'CSV 消费报表已导出'; } catch (error) { message.value = error instanceof Error ? error.message : '导出失败'; } finally { busy.value = false; } }
async function importJson(): Promise<void> {
  busy.value = true;
  try {
    const pending = await chooseJsonBackup();
    if (!pending) return;
    const { records, categories, merchants, budgets, templates: templateCount, exportedAt } = pending.summary;
    if (!await confirmAction(`将恢复 ${new Date(exportedAt).toLocaleString('zh-CN')} 导出的备份：${records} 笔记录、${categories} 个分类、${merchants} 个地点、${budgets} 个预算、${templateCount} 个模板。当前账本会被完整替换，导入前会自动备份。`, { title: '恢复完整备份', confirmLabel: '替换当前账本', danger: true })) return;
    await applyJsonBackup(ledgerRepository, pending.envelope);
    await Promise.all([loadCategories(), loadMerchants()]);
    await loadAutoBackups();
    emit('changed');
    message.value = '备份恢复完成，当前账本已替换';
  } catch (error) { message.value = error instanceof Error ? error.message : '恢复备份失败'; } finally { busy.value = false; }
}

watch(tab, (value) => { clearMessage(); if (value === 'merchants') void loadMerchants(); if (value === 'templates') void loadTemplates(); if (value === 'preferences') void loadPreferences(); if (value === 'backup') { void loadAutoBackups(); void loadDailyBackupSettings(); } });
watch(() => props.categories, () => { void loadCategories(); }, { deep: true });
watch(mergeSourceId, () => {
  if (!mergeTargets.value.some((category) => category.id === mergeTargetId.value)) mergeTargetId.value = mergeTargets.value[0]?.id ?? '';
  mergePreview.value = null;
});
onMounted(() => { void loadCategories(); });
</script>

<template>
  <section class="view-stack">
    <header class="view-heading"><div><p class="eyebrow">设置与数据</p><h1>让账本按你的习惯工作</h1></div></header>
    <section class="content-card settings-card">
      <nav class="settings-tabs" role="tablist" aria-label="设置分类" @keydown="onTabKeydown"><button v-for="item in tabItems" :key="item.key" type="button" role="tab" :data-tab="item.key" :tabindex="tab === item.key ? 0 : -1" :aria-selected="tab === item.key" :class="{ active: tab === item.key }" @click="tab = item.key">{{ item.label }}</button></nav>
      <p v-if="message" class="form-message" :class="{ success: message.includes('已') || message.includes('完成') }" aria-live="polite">{{ message }}</p>

      <div v-if="tab === 'categories'" class="settings-section">
        <div class="settings-layout">
          <div class="category-tree"><section v-for="root in roots" :key="root.id" class="category-block"><div class="category-parent"><span>{{ root.icon }} {{ root.name }}</span><div class="category-actions"><button class="icon-button" type="button" title="上移" @click="moveCategory(root, 'up')">↑</button><button class="icon-button" type="button" title="下移" @click="moveCategory(root, 'down')">↓</button><button class="text-button" type="button" @click="editCategory(root)">编辑</button><button class="danger-text" type="button" @click="removeCategory(root)">删除</button></div></div><div class="category-children"><div v-for="child in children.get(root.id)" :key="child.id" class="category-child"><span>{{ child.icon }} {{ child.name }}</span><div class="category-actions"><button class="icon-button" type="button" title="上移" @click="moveCategory(child, 'up')">↑</button><button class="icon-button" type="button" title="下移" @click="moveCategory(child, 'down')">↓</button><button class="text-button" type="button" @click="editCategory(child)">编辑</button><button class="danger-text" type="button" @click="removeCategory(child)">删除</button></div></div></div></section></div>
          <form class="mini-form" @submit.prevent="saveCategory"><h2>{{ editing ? '编辑分类' : '新增分类' }}</h2><label v-if="!editing" class="field"><span>所属大类</span><select v-model="categoryForm.parentId"><option value="">新增为一级分类</option><option v-for="root in roots" :key="root.id" :value="root.id">{{ root.icon }} {{ root.name }}</option></select></label><label class="field"><span>名称</span><input v-model="categoryForm.name" maxlength="10" placeholder="不超过 10 个字" required /></label><div class="form-inline"><label class="field"><span>图标</span><input v-model="categoryForm.icon" maxlength="8" /></label><label class="field"><span>颜色</span><input v-model="categoryForm.color" type="color" /></label></div><div class="form-actions"><button class="primary-button" type="submit" :disabled="savingCategory">{{ savingCategory ? '保存中…' : '保存分类' }}</button><button v-if="editing" class="secondary-button" type="button" @click="resetCategoryForm">取消</button></div></form>
        </div>
        <section v-if="leafCategories.length > 1" class="merge-section"><div class="card-heading"><div><h2>合并末级分类</h2><p>只允许合并同一个大类下的分类，合并前会显示完整影响范围。</p></div></div><div class="merge-controls"><label class="field"><span>源分类</span><select v-model="mergeSourceId"><option value="">请选择</option><option v-for="category in leafCategories" :key="category.id" :value="category.id">{{ category.icon }} {{ category.name }}</option></select></label><label class="field"><span>目标分类</span><select v-model="mergeTargetId" :disabled="!mergeTargets.length"><option value="">请选择</option><option v-for="category in mergeTargets" :key="category.id" :value="category.id">{{ category.icon }} {{ category.name }}</option></select></label><button class="secondary-button" type="button" :disabled="!mergeTargetId || mergingCategory" @click="previewCategoryMerge">预览合并</button></div><div v-if="mergePreview" class="merge-preview"><p>将把「{{ mergePreview.sourceName }}」合并到「{{ mergePreview.targetName }}」：{{ mergePreview.activeRecords }} 笔有效记录、{{ mergePreview.deletedRecords }} 笔回收站记录、{{ mergePreview.merchants }} 个地点、{{ mergePreview.budgets }} 项预算、{{ mergePreview.templates }} 个模板。<template v-if="mergePreview.budgetConflictMonths.length">预算冲突月份将相加：{{ mergePreview.budgetConflictMonths.join('、') }}。</template></p><button class="danger-button" type="button" :disabled="mergingCategory" @click="confirmCategoryMerge">{{ mergingCategory ? '合并中…' : '确认合并并停用源分类' }}</button><button class="text-button" type="button" :disabled="mergingCategory" @click="resetMerge">取消</button></div></section>
        <div v-if="deletedCategories.length" class="deleted-settings"><div class="card-heading"><div><h2>已删除分类</h2><p>恢复后即可再次用于新记录</p></div></div><div v-for="category in deletedCategories" :key="category.id" class="deleted-setting-row"><span>{{ category.icon }} {{ category.name }}<small>{{ category.parentId ? '末级分类' : '一级分类' }}</small></span><button class="text-button" type="button" @click="restoreCategory(category)">恢复</button></div></div>
      </div>

      <div v-else-if="tab === 'merchants'" class="settings-section"><div v-if="merchants.length" class="merchant-list"><article v-for="merchant in merchants" :key="merchant.id" class="merchant-row" :class="{ hidden: merchant.hiddenAt }"><div><b>{{ merchant.name }}</b><small>{{ merchant.categoryName || '已删除分类' }} · {{ merchant.useCount }} 笔有效记录{{ merchant.hiddenAt ? ' · 已隐藏' : '' }}</small></div><button v-if="merchant.hiddenAt" type="button" class="text-button" @click="restoreMerchant(merchant)">重新启用</button><button v-else type="button" class="danger-text" @click="hideMerchant(merchant)">不再推荐</button></article></div><div v-else class="empty-state small"><span>⌁</span><p>还没有常用地点。填写商家或地点后会自动出现在这里。</p></div></div>

      <div v-else-if="tab === 'templates'" class="settings-section"><div v-if="templates.length" class="merchant-list"><article v-for="template in templates" :key="template.id" class="merchant-row"><div><b>{{ template.name }}</b><small>{{ activeCategories.find((category) => category.id === template.categoryId)?.name || '已停用分类' }} · {{ template.amountFen === null ? '每次填写金额' : `¥ ${(template.amountFen / 100).toFixed(2)}` }}{{ template.merchantName ? ` · ${template.merchantName}` : '' }}</small></div><div class="category-actions"><button class="icon-button" type="button" title="上移" @click="moveTemplate(template, 'up')">↑</button><button class="icon-button" type="button" title="下移" @click="moveTemplate(template, 'down')">↓</button><button class="danger-text" type="button" @click="removeTemplate(template)">删除</button></div></article></div><div v-else class="empty-state small"><span>✦</span><p>还没有常用模板。可在“记一笔”页面把当前表单保存为模板。</p></div></div>

      <div v-else-if="tab === 'preferences'" class="settings-section preferences-section"><div class="preference-grid"><label class="field"><span>界面主题</span><select v-model="theme"><option value="system">跟随 Windows</option><option value="light">浅色</option><option value="dark">深色</option></select></label><label class="field"><span>信息密度</span><select v-model="density"><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label></div><button class="primary-button" type="button" @click="savePreferences">保存界面偏好</button></div>

      <div v-else-if="tab === 'backup'" class="settings-section backup-section">
        <article><h2>完整备份</h2><p>导出包含分类、地点、全部记录、预算、模板和设置的 JSON 文件。Windows 与未来 Android 使用同一格式手动互传。</p><div><button class="primary-button" type="button" :disabled="busy" @click="exportJson">导出完整 JSON</button><button class="secondary-button" type="button" :disabled="busy" @click="importJson">恢复 JSON 备份</button></div><div v-if="lastExport" class="backup-status"><b>最近一次导出</b><span>{{ new Date(lastExport.summary.exportedAt).toLocaleString('zh-CN') }} · {{ lastExport.summary.records }} 笔记录 · {{ lastExport.summary.categories }} 个分类 · {{ lastExport.summary.budgets }} 个预算 · {{ lastExport.summary.templates }} 个模板</span><small>SHA-256 {{ lastExport.payloadSha256.slice(0, 16) }}… · 内容校验通过</small></div></article>
        <article><h2>滚动每日备份</h2><p>每天首次修改账本后自动备份到你选择的目录，只清理本功能生成的旧文件，默认保留 30 份。</p><p v-if="backupDirectory" class="backup-directory">{{ backupDirectory }}</p><div><button class="secondary-button" type="button" :disabled="busy" @click="configureDailyBackup">{{ backupDirectory ? '更换目录' : '选择目录并启用' }}</button><button v-if="backupDirectory" class="secondary-button" type="button" :disabled="busy" @click="runDailyBackupNow">立即备份</button><button v-if="backupDirectory" class="danger-text" type="button" :disabled="busy" @click="disableDailyBackup">关闭</button></div><small v-if="dailyBackupStatus" class="backup-loading">{{ dailyBackupStatus.startsWith('ok|') ? '最近备份成功' : '最近备份失败，请检查目录权限' }}</small></article>
        <article><h2>消费报表</h2><p>CSV 仅供 Excel 查看与分析，不用于恢复账本。以 UTF-8 BOM 输出并处理公式注入风险。</p><button class="secondary-button" type="button" :disabled="busy" @click="exportCsv">导出 CSV 报表</button></article>
        <article class="backup-history"><h2>导入前自动备份</h2><p>每次恢复前会自动保留当前账本，最多显示最近 20 份。</p><div v-if="loadingBackups" class="backup-loading">正在读取自动备份…</div><ul v-else-if="autoBackups.length"><li v-for="name in autoBackups" :key="name">{{ name }}</li></ul><p v-else class="backup-loading">暂无自动备份</p></article>
        <p class="backup-note">恢复前会自动将当前账本备份到应用数据目录；恢复失败不会写入半份数据。导入会校验日期、分类关系、金额、地点和预算引用。</p>
      </div>

      <div v-else class="settings-section about-section"><h2>L.Q记账 {{ packageJson.version }}</h2><p>一款不联网、不注册账号的个人消费账本。账本数据保存在当前 Windows 用户的数据目录中，不随卸载程序删除。</p><ul><li>金额以整数分保存，避免浮点误差。</li><li>分类改名或删除后，历史记录保持原有分类快照。</li><li>完整 JSON 备份可用于手动迁移到未来 Android 版本。</li><li>删除的消费记录可在回收站恢复，回收站记录不参与统计。</li></ul></div>
    </section>
  </section>
</template>
