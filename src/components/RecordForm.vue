<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import type { Category, EntryTemplate, ExpenseRecord, Merchant, RecordDraft } from '@/types';
import { ledgerRepository } from '@/services/repository';
import { confirmAction } from '@/services/confirm';
import { formatFen, localDateTimeNow } from '@/utils';

const props = defineProps<{
  categories: Category[];
  record?: ExpenseRecord | null;
  latestRecord?: ExpenseRecord | null;
  recentCategoryIds?: string[];
  recentMerchants?: Merchant[];
  templates?: EntryTemplate[];
}>();
const emit = defineEmits<{ saved: [record: ExpenseRecord, keepOpen?: boolean]; cancel: []; dirtyChange: [dirty: boolean]; templatesChanged: [] }>();

const form = reactive<RecordDraft>({ categoryId: '', amount: '', merchantName: '', remark: '', occurredLocal: localDateTimeNow() });
const saving = ref(false);
const message = ref('');
const suggestions = ref<Merchant[]>([]);
const amountInput = ref<HTMLInputElement | null>(null);
const keepAdding = ref(false);
const baseline = ref('');
const templateEditorOpen = ref(false);
const templateName = ref('');
const templateIncludeAmount = ref(false);
const savingTemplate = ref(false);
let suggestionRequest = 0;

const roots = computed(() => props.categories.filter((category) => category.parentId === null));
const leafCategories = computed(() => props.categories.filter((category) => category.parentId !== null));
const categoriesByRoot = computed(() => new Map(roots.value.map((root) => [root.id, leafCategories.value.filter((category) => category.parentId === root.id)])));
const recentLeafCategories = computed(() => {
  const order = props.recentCategoryIds ?? [];
  return order.map((id) => leafCategories.value.find((category) => category.id === id)).filter((category): category is Category => Boolean(category));
});
const archivedCategory = computed(() => props.record && !leafCategories.value.some((category) => category.id === props.record?.categoryId) ? props.record : null);
const editing = computed(() => Boolean(props.record));
const dirty = computed(() => baseline.value !== JSON.stringify(form));

function resetForm(record?: ExpenseRecord | null): void {
  const firstLeaf = leafCategories.value[0];
  form.categoryId = record?.categoryId ?? recentLeafCategories.value[0]?.id ?? firstLeaf?.id ?? '';
  form.amount = record ? (record.amountFen / 100).toFixed(2) : '';
  form.merchantName = record?.merchantName ?? '';
  form.remark = record?.remark ?? '';
  form.occurredLocal = record?.occurredLocal ?? localDateTimeNow();
  message.value = '';
  keepAdding.value = false;
  baseline.value = JSON.stringify(form);
}

async function loadSuggestions(): Promise<void> {
  const request = ++suggestionRequest;
  const categoryId = form.categoryId;
  const categoryMerchants = categoryId ? await ledgerRepository.listMerchants(categoryId) : [];
  const recentMerchants = (props.recentMerchants ?? []).filter((merchant) => !categoryId || merchant.categoryId === categoryId);
  const next = [...categoryMerchants, ...recentMerchants.filter((merchant) => !categoryMerchants.some((item) => item.id === merchant.id))];
  if (request === suggestionRequest) suggestions.value = next;
}

watch(() => props.record, resetForm, { immediate: true });
watch(() => props.categories, () => { if (!form.categoryId) resetForm(props.record); }, { deep: true });
watch(() => form.categoryId, () => { void loadSuggestions(); }, { immediate: true });
watch(dirty, (value) => emit('dirtyChange', value), { immediate: true });

function setNow(): void { form.occurredLocal = localDateTimeNow(); }

function setToday(): void {
  const now = localDateTimeNow();
  form.occurredLocal = `${now.slice(0, 10)}T${form.occurredLocal.slice(11) || now.slice(11)}`;
}

async function copyLatest(): Promise<void> {
  const latest = props.latestRecord;
  if (!latest) return;
  if (dirty.value && !await confirmAction('当前表单已有输入，确定用上一笔记录覆盖吗？', { title: '覆盖当前输入', confirmLabel: '使用上一笔', danger: true })) return;
  form.categoryId = latest.categoryId;
  form.amount = (latest.amountFen / 100).toFixed(2);
  form.merchantName = latest.merchantName;
  form.remark = latest.remark;
  form.occurredLocal = localDateTimeNow();
  message.value = '已复制上一笔，时间已更新为现在';
}

async function applyTemplate(template: EntryTemplate): Promise<void> {
  if (dirty.value && !await confirmAction('当前表单已有输入，确定用常用模板覆盖吗？', { title: '覆盖当前输入', confirmLabel: '使用模板', danger: true })) return;
  form.categoryId = template.categoryId;
  form.amount = template.amountFen === null ? '' : (template.amountFen / 100).toFixed(2);
  form.merchantName = template.merchantName;
  form.remark = template.remark;
  form.occurredLocal = localDateTimeNow();
  message.value = `已填入模板「${template.name}」`;
  void nextTick(() => amountInput.value?.focus());
}

async function saveAsTemplate(): Promise<void> {
  savingTemplate.value = true;
  message.value = '';
  try {
    await ledgerRepository.addEntryTemplate({
      name: templateName.value,
      categoryId: form.categoryId,
      amount: form.amount,
      includeAmount: templateIncludeAmount.value,
      merchantName: form.merchantName,
      remark: form.remark,
    });
    templateName.value = '';
    templateIncludeAmount.value = false;
    templateEditorOpen.value = false;
    emit('templatesChanged');
    message.value = '常用模板已保存';
  } catch (error) {
    message.value = error instanceof Error ? error.message : '模板保存失败';
  } finally {
    savingTemplate.value = false;
  }
}

async function submit(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  message.value = '';
  try {
    const saved = await ledgerRepository.saveRecord({ ...form }, props.record?.id);
    const continueAdding = keepAdding.value && !editing.value;
    if (continueAdding) {
      resetForm();
      message.value = `已保存 ¥ ${formatFen(saved.amountFen)}，可以继续记账`;
      await nextTick();
      amountInput.value?.focus();
    }
    emit('saved', saved, continueAdding);
  } catch (error) {
    message.value = error instanceof Error ? error.message : '保存失败，请重试';
  } finally {
    saving.value = false;
  }
}

onMounted(() => { void nextTick(() => amountInput.value?.focus()); });
</script>

<template>
  <section class="view-stack form-view">
    <header class="view-heading">
      <div>
        <p class="eyebrow">{{ editing ? '编辑消费记录' : '快速记账' }}</p>
        <h1>{{ editing ? '修正这笔消费' : '记下刚发生的消费' }}</h1>
      </div>
      <button v-if="!editing && latestRecord" class="secondary-button" type="button" @click="copyLatest">复制上一笔</button>
      <button v-if="editing" class="secondary-button" type="button" @click="emit('cancel')">取消编辑</button>
    </header>

    <form class="content-card record-form" @submit.prevent="submit" @keydown.ctrl.enter.prevent="submit">
      <div v-if="!editing && templates?.length" class="template-strip field-full"><span>常用模板</span><div class="chip-row"><button v-for="template in templates" :key="template.id" class="chip template-chip" type="button" @click="applyTemplate(template)"><b>{{ template.name }}</b><small>{{ template.amountFen === null ? '填写金额' : `¥ ${formatFen(template.amountFen)}` }}</small></button></div></div>
      <label class="field amount-field">
        <span>消费金额</span>
        <div class="amount-input-wrap"><i>¥</i><input ref="amountInput" v-model="form.amount" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-describedby="amount-help" /></div>
        <small id="amount-help">支持 0.01 至 1000000.00 元及 12+8.5 等算式 · Ctrl+Enter 可保存</small>
      </label>

      <label class="field">
        <span>消费分类</span>
        <div v-if="recentLeafCategories.length" class="quick-choice-row" aria-label="最近使用分类">
          <button v-for="category in recentLeafCategories" :key="category.id" class="quick-choice" type="button" :class="{ selected: form.categoryId === category.id }" @click="form.categoryId = category.id">{{ category.icon }} {{ category.name }}</button>
        </div>
        <select v-model="form.categoryId" required>
          <optgroup v-if="archivedCategory" label="已归档分类"><option :value="archivedCategory.categoryId">{{ archivedCategory.categoryNameSnapshot }}</option></optgroup>
          <optgroup v-for="root in roots" :key="root.id" :label="`${root.icon} ${root.name}`">
            <option v-for="child in categoriesByRoot.get(root.id)" :key="child.id" :value="child.id">{{ child.icon }} {{ child.name }}</option>
          </optgroup>
        </select>
      </label>

      <label class="field">
        <span>商家或地点 <em>可选</em></span>
        <input v-model="form.merchantName" list="merchant-suggestion-list" maxlength="30" placeholder="例如：福建理工大学第一食堂" autocomplete="off" />
        <datalist id="merchant-suggestion-list"><option v-for="merchant in suggestions" :key="merchant.id" :value="merchant.name">{{ merchant.useCount }} 次</option></datalist>
      </label>
      <div v-if="suggestions.length" class="suggestion-wrap">
        <span>常用地点</span>
        <div class="chip-row">
          <button v-for="merchant in suggestions.slice(0, 8)" :key="merchant.id" class="chip" type="button" @click="form.merchantName = merchant.name">
            {{ merchant.name }}<small>{{ merchant.useCount }} 次</small>
          </button>
        </div>
      </div>

      <label class="field">
        <span>消费时间</span>
        <input v-model="form.occurredLocal" type="datetime-local" required />
        <span class="field-hints"><button type="button" class="inline-button" @click="setNow">现在</button><button type="button" class="inline-button" @click="setToday">今天</button></span>
      </label>
      <label class="field field-full">
        <span>备注 <em>可选</em></span>
        <textarea v-model="form.remark" maxlength="50" rows="3" placeholder="写点什么…" />
      </label>

      <p v-if="message" class="form-message" :class="{ success: message.startsWith('已保存') }" aria-live="polite">{{ message }}</p>
      <div v-if="!editing" class="template-editor field-full"><button v-if="!templateEditorOpen" class="text-button" type="button" @click="templateEditorOpen = true">＋ 将当前分类、地点和备注保存为常用模板</button><div v-else class="template-editor-row"><label class="compact-filter"><span>模板名称</span><input v-model="templateName" maxlength="20" placeholder="例如：工作日午餐" /></label><label class="checkbox-label"><input v-model="templateIncludeAmount" type="checkbox" /> 包含当前金额</label><button class="secondary-button" type="button" :disabled="savingTemplate || !templateName.trim() || !form.categoryId" @click="saveAsTemplate">{{ savingTemplate ? '保存中…' : '保存模板' }}</button><button class="text-button" type="button" @click="templateEditorOpen = false">取消</button></div></div>
      <div class="form-actions">
        <label v-if="!editing" class="keep-adding"><input v-model="keepAdding" type="checkbox" /> 保存后继续记账</label>
        <button class="secondary-button" type="button" @click="emit('cancel')">取消</button>
        <button class="primary-button" type="submit" :disabled="saving || !form.categoryId">{{ saving ? '保存中…' : editing ? '保存修改' : '保存这笔消费' }}</button>
      </div>
    </form>
  </section>
</template>
