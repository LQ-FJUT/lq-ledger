import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import packageJson from '../../package.json';
import type { BackupEnvelopeV1, BackupSummary, LedgerRepository, SnapshotData } from '@/types';
import { assertDateKey, assertMonthKey, dateKeyNow, escapeCsv, normalizeName, parseLocalDateTime, sha256, stableStringify } from '@/utils';

const BACKUP_FORMAT = 'lq-ledger-backup';
const BACKUP_VERSION = 1 as const;
const APP_VERSION = packageJson.version;

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function summary(snapshot: SnapshotData, exportedAt: string): BackupSummary {
  return {
    exportedAt,
    records: snapshot.records.length,
    categories: snapshot.categories.length,
    merchants: snapshot.merchants.length,
    budgets: snapshot.budgets?.length ?? 0,
    templates: snapshot.templates?.length ?? 0,
  };
}

export async function createBackupEnvelope(repository: LedgerRepository): Promise<BackupEnvelopeV1> {
  const payload = await repository.exportSnapshot();
  return {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    payload,
    payloadSha256: await sha256(stableStringify(payload)),
  };
}

export async function exportJsonBackup(repository: LedgerRepository): Promise<BackupExportInfo | null> {
  const envelope = await createBackupEnvelope(repository);
  let path = await save({
    title: '导出完整备份',
    defaultPath: `L.Q记账备份-${timestampForFile()}.json`,
    filters: [{ name: 'L.Q记账完整备份', extensions: ['json'] }],
  });
  if (!path) return null;
  if (!path.toLowerCase().endsWith('.json')) path += '.json';
  await invoke('write_export_file', { path, contents: JSON.stringify(envelope, null, 2) });
  return { summary: summary(envelope.payload, envelope.exportedAt), payloadSha256: envelope.payloadSha256 };
}

export async function exportCsvReport(repository: LedgerRepository): Promise<boolean> {
  const snapshot = await repository.exportSnapshot();
  let path = await save({
    title: '导出消费报表',
    defaultPath: `L.Q记账消费报表-${timestampForFile()}.csv`,
    filters: [{ name: 'CSV 消费报表', extensions: ['csv'] }],
  });
  if (!path) return false;
  if (!path.toLowerCase().endsWith('.csv')) path += '.csv';
  const header = ['日期', '时间', '大类', '分类', '金额(元)', '商家/地点', '备注'];
  const rows = snapshot.records
    .filter((record) => !record.deletedAt)
    .sort((a, b) => b.occurredLocal.localeCompare(a.occurredLocal))
    .map((record) => [
      record.dateKey,
      record.occurredLocal.slice(11),
      record.parentCategoryNameSnapshot,
      record.categoryNameSnapshot,
      (record.amountFen / 100).toFixed(2),
      record.merchantName,
      record.remark,
    ].map(escapeCsv).join(','));
  await invoke('write_export_file', { path, contents: `\uFEFF${header.join(',')}\r\n${rows.join('\r\n')}` });
  return true;
}

export interface PendingImport {
  envelope: BackupEnvelopeV1;
  summary: BackupSummary;
}

export interface BackupExportInfo {
  summary: BackupSummary;
  payloadSha256: string;
}

export async function chooseJsonBackup(): Promise<PendingImport | null> {
  const selected = await open({ title: '选择 L.Q记账完整备份', multiple: false, filters: [{ name: 'JSON 备份', extensions: ['json'] }] });
  if (!selected || Array.isArray(selected)) return null;
  const text = await invoke<string>('read_import_file', { path: selected });
  const envelope = await parseAndValidateEnvelope(text);
  return { envelope, summary: summary(envelope.payload, envelope.exportedAt) };
}

export async function applyJsonBackup(repository: LedgerRepository, envelope: BackupEnvelopeV1): Promise<BackupSummary> {
  const beforeImport = await createBackupEnvelope(repository);
  await invoke('write_pre_import_backup', { contents: JSON.stringify(beforeImport, null, 2) });
  await repository.replaceSnapshot(envelope.payload);
  return summary(envelope.payload, envelope.exportedAt);
}

export async function chooseDailyBackupDirectory(): Promise<string | null> {
  const selected = await open({ title: '选择每日备份目录', directory: true, multiple: false });
  return typeof selected === 'string' ? selected : null;
}

export async function runDailyBackupIfDue(repository: LedgerRepository, force = false): Promise<string | null> {
  const directory = await repository.getSetting('dailyBackupDirectory');
  if (!directory) return null;
  const today = dateKeyNow();
  if (!force && await repository.getSetting('lastDailyBackupDate') === today) return null;
  try {
    const envelope = await createBackupEnvelope(repository);
    const path = await invoke<string>('write_rolling_backup', {
      directory,
      contents: JSON.stringify(envelope, null, 2),
      keep: 30,
      dateKey: today,
    });
    await repository.setSetting('lastDailyBackupDate', today);
    await repository.setSetting('dailyBackupStatus', `ok|${new Date().toISOString()}|${path}`);
    return path;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await repository.setSetting('dailyBackupStatus', `error|${new Date().toISOString()}|${message}`);
    throw error;
  }
}

export async function parseAndValidateEnvelope(text: string): Promise<BackupEnvelopeV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('备份文件不是有效的 JSON');
  }
  if (!isPlainObject(parsed)) throw new Error('备份文件结构无效');
  const envelope = parsed;
  if (envelope.format !== BACKUP_FORMAT || envelope.schemaVersion !== BACKUP_VERSION) {
    throw new Error('不支持的备份格式或版本');
  }
  if (typeof envelope.exportedAt !== 'string' || !envelope.exportedAt || typeof envelope.appVersion !== 'string' || !envelope.appVersion) {
    throw new Error('备份元数据无效');
  }
  if (!isPlainObject(envelope.payload) || !Array.isArray(envelope.payload.categories) || !Array.isArray(envelope.payload.merchants) ||
    !Array.isArray(envelope.payload.records) || !isPlainObject(envelope.payload.settings)) {
    throw new Error('备份缺少完整账本数据');
  }
  if (typeof envelope.payloadSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(envelope.payloadSha256)) throw new Error('备份校验码无效');
  const actualHash = await sha256(stableStringify(envelope.payload));
  if (actualHash !== envelope.payloadSha256.toLowerCase()) throw new Error('备份校验失败，文件可能已损坏或被修改');

  const categories = envelope.payload.categories;
  if (categories.length === 0) throw new Error('备份至少需要一个分类');
  const categoryIds = new Set<string>();
  const categoryById = new Map<string, Record<string, unknown>>();
  const activeNames = new Set<string>();
  for (const category of categories) {
    if (!isPlainObject(category) || typeof category.id !== 'string' || !category.id.trim()) throw new Error('备份中的分类 ID 无效');
    if (categoryIds.has(category.id)) throw new Error('备份中的分类 ID 重复');
    if (category.type !== 'expense' || typeof category.name !== 'string' || !category.name.trim() ||
      typeof category.icon !== 'string' || typeof category.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(category.color) ||
      !Number.isInteger(category.sortOrder) || typeof category.isDefault !== 'boolean' ||
      !isNullableString(category.parentId) || !isNullableString(category.deletedAt) ||
      typeof category.createdAt !== 'string' || typeof category.updatedAt !== 'string') {
      throw new Error('备份中的分类字段无效');
    }
    categoryIds.add(category.id);
    categoryById.set(category.id, category);
    if (category.deletedAt === null) {
      const key = `${category.parentId ?? ''}\u0000${normalizeName(category.name)}`;
      if (activeNames.has(key)) throw new Error('备份中的分类名称重复');
      activeNames.add(key);
    }
  }
  for (const category of categories) {
    if (category.parentId !== null) {
      if (category.parentId === category.id) throw new Error('备份中的分类层级无效');
      const parent = categoryById.get(category.parentId);
      if (!parent || parent.parentId !== null) throw new Error('备份中的分类层级无效');
    }
  }

  const merchants = envelope.payload.merchants;
  const merchantIds = new Set<string>();
  const merchantById = new Map<string, Record<string, unknown>>();
  for (const merchant of merchants) {
    if (!isPlainObject(merchant) || typeof merchant.id !== 'string' || !merchant.id.trim() || merchantIds.has(merchant.id) ||
      typeof merchant.categoryId !== 'string' || !categoryIds.has(merchant.categoryId) ||
      typeof merchant.name !== 'string' || typeof merchant.normalizedName !== 'string' ||
      !isNullableString(merchant.hiddenAt) || typeof merchant.createdAt !== 'string' || typeof merchant.updatedAt !== 'string') {
      throw new Error('备份中的地点数据无效');
    }
    merchantIds.add(merchant.id);
    merchantById.set(merchant.id, merchant);
  }

  const records = envelope.payload.records;
  const recordIds = new Set<string>();
  for (const record of records) {
    const amountFen = isPlainObject(record) ? record.amountFen : undefined;
    if (!isPlainObject(record) || typeof record.id !== 'string' || !record.id.trim() || recordIds.has(record.id) ||
      typeof record.categoryId !== 'string' || !categoryIds.has(record.categoryId) ||
      typeof record.categoryNameSnapshot !== 'string' || typeof record.parentCategoryIdSnapshot !== 'string' ||
      typeof record.parentCategoryNameSnapshot !== 'string' || typeof amountFen !== 'number' || !Number.isInteger(amountFen) ||
      amountFen < 1 || amountFen > 100_000_000 ||
      !isNullableString(record.merchantId) || typeof record.merchantName !== 'string' || typeof record.remark !== 'string' ||
      typeof record.occurredLocal !== 'string' || typeof record.dateKey !== 'string' || typeof record.monthKey !== 'string' ||
      typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string' || !isNullableString(record.deletedAt)) {
      throw new Error('备份中的消费记录无效');
    }
    const category = categoryById.get(record.categoryId);
    if (!category || category.parentId === null || record.parentCategoryIdSnapshot !== category.parentId) {
      throw new Error('备份中的记录分类关系无效');
    }
    try {
      const time = parseLocalDateTime(record.occurredLocal);
      assertDateKey(record.dateKey);
      assertMonthKey(record.monthKey);
      if (time.dateKey !== record.dateKey || time.monthKey !== record.monthKey) throw new Error('时间键不一致');
    } catch {
      throw new Error('备份中的消费时间无效');
    }
    if (record.merchantId !== null) {
      const merchant = merchantById.get(record.merchantId);
      if (!merchant || merchant.categoryId !== record.categoryId) throw new Error('备份中的地点引用无效');
    }
    recordIds.add(record.id);
  }

  if (!Object.values(envelope.payload.settings).every((value) => typeof value === 'string')) throw new Error('备份中的设置无效');

  if (envelope.payload.budgets !== undefined) {
    if (!Array.isArray(envelope.payload.budgets)) throw new Error('备份中的预算数据无效');
    const budgetIds = new Set<string>();
    const budgetKeys = new Set<string>();
    for (const budget of envelope.payload.budgets) {
      const amountFen = isPlainObject(budget) ? budget.amountFen : undefined;
      if (!isPlainObject(budget) || typeof budget.id !== 'string' || !budget.id.trim() || budgetIds.has(budget.id) ||
        typeof budget.monthKey !== 'string' || typeof budget.categoryId !== 'string' && budget.categoryId !== null ||
        typeof amountFen !== 'number' || !Number.isInteger(amountFen) || amountFen < 1 || amountFen > 100_000_000 ||
        typeof budget.createdAt !== 'string' || typeof budget.updatedAt !== 'string') {
        throw new Error('备份中的预算数据无效');
      }
      try { assertMonthKey(budget.monthKey); } catch { throw new Error('备份中的预算月份无效'); }
      if (budget.categoryId !== null) {
        const category = categoryById.get(budget.categoryId);
        if (!category) throw new Error('备份中的预算分类无效');
      }
      const key = `${budget.monthKey}\u0000${budget.categoryId ?? ''}`;
      if (budgetKeys.has(key)) throw new Error('备份中的预算重复');
      budgetIds.add(budget.id);
      budgetKeys.add(key);
    }
  }
  if (envelope.payload.templates !== undefined) {
    if (!Array.isArray(envelope.payload.templates)) throw new Error('备份中的模板数据无效');
    const templateIds = new Set<string>();
    for (const template of envelope.payload.templates) {
      const amountFen = isPlainObject(template) ? template.amountFen : undefined;
      if (!isPlainObject(template) || typeof template.id !== 'string' || !template.id.trim() || templateIds.has(template.id) ||
        typeof template.name !== 'string' || !template.name.trim() || template.name.length > 20 ||
        typeof template.categoryId !== 'string' || !categoryIds.has(template.categoryId) ||
        amountFen !== null && (typeof amountFen !== 'number' || !Number.isInteger(amountFen) || amountFen < 1 || amountFen > 100_000_000) ||
        typeof template.merchantName !== 'string' || typeof template.remark !== 'string' || !Number.isInteger(template.sortOrder) ||
        typeof template.createdAt !== 'string' || typeof template.updatedAt !== 'string') {
        throw new Error('备份中的模板数据无效');
      }
      const category = categoryById.get(template.categoryId);
      if (!category || category.parentId === null) throw new Error('备份中的模板分类无效');
      templateIds.add(template.id);
    }
  }
  return envelope as unknown as BackupEnvelopeV1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
