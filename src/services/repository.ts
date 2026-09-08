import { invoke } from '@tauri-apps/api/core';
import type {
  Budget,
  BudgetPlan,
  Category,
  CategoryBudgetUsage,
  CategoryDraft,
  CategoryMergePreview,
  CategoryMergeResult,
  CategoryStat,
  DailyStat,
  ExpenseRecord,
  EntryTemplate,
  EntryTemplateDraft,
  LedgerRepository,
  Merchant,
  MonthlyStats,
  OverviewStats,
  QuickEntryDefaults,
  RecordFilter,
  RecordDraft,
  RecordCursor,
  RecordPage,
  SnapshotData,
  TrendPoint,
} from '@/types';
import {
  assertDateKey,
  assertMonthKey,
  dateKeyNow,
  daysInMonth,
  escapeLikePattern,
  monthKeyNow,
  newId,
  normalizeName,
  nowIso,
  parseAmountExpressionToFen,
  parseLocalDateTime,
  requireText,
  shiftMonth,
} from '@/utils';
import { getDatabase, type SqlDatabase, withTransaction } from './database';

type Row = Record<string, unknown>;
type AtomicSaveResult = { recordId: string; merchantId: string | null; saved: boolean };
const LOCAL_ONLY_SETTINGS = new Set(['dailyBackupDirectory', 'lastDailyBackupDate', 'dailyBackupStatus']);

function stringValue(row: Row, key: string): string {
  const value = row[key];
  return value === null || value === undefined ? '' : String(value);
}

function nullableString(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined || value === '' ? null : String(value);
}

function numberValue(row: Row, key: string): number {
  const value = Number(row[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function toCategory(row: Row): Category {
  return {
    id: stringValue(row, 'id'),
    parentId: nullableString(row, 'parent_id'),
    type: 'expense',
    name: stringValue(row, 'name'),
    icon: stringValue(row, 'icon'),
    color: stringValue(row, 'color'),
    sortOrder: numberValue(row, 'sort_order'),
    isDefault: numberValue(row, 'is_default') === 1,
    deletedAt: nullableString(row, 'deleted_at'),
    createdAt: stringValue(row, 'created_at'),
    updatedAt: stringValue(row, 'updated_at'),
  };
}

function toRecord(row: Row): ExpenseRecord {
  return {
    id: stringValue(row, 'id'),
    categoryId: stringValue(row, 'category_id'),
    categoryNameSnapshot: stringValue(row, 'category_name_snapshot'),
    parentCategoryIdSnapshot: stringValue(row, 'parent_category_id_snapshot'),
    parentCategoryNameSnapshot: stringValue(row, 'parent_category_name_snapshot'),
    amountFen: numberValue(row, 'amount_fen'),
    merchantId: nullableString(row, 'merchant_id'),
    merchantName: stringValue(row, 'merchant_name'),
    remark: stringValue(row, 'remark'),
    occurredLocal: stringValue(row, 'occurred_local'),
    dateKey: stringValue(row, 'date_key'),
    monthKey: stringValue(row, 'month_key'),
    createdAt: stringValue(row, 'created_at'),
    updatedAt: stringValue(row, 'updated_at'),
    deletedAt: nullableString(row, 'deleted_at'),
  };
}

function toMerchant(row: Row): Merchant {
  return {
    id: stringValue(row, 'id'),
    categoryId: stringValue(row, 'category_id'),
    name: stringValue(row, 'name'),
    normalizedName: stringValue(row, 'normalized_name'),
    hiddenAt: nullableString(row, 'hidden_at'),
    createdAt: stringValue(row, 'created_at'),
    updatedAt: stringValue(row, 'updated_at'),
    useCount: numberValue(row, 'use_count'),
    lastUsedAt: nullableString(row, 'last_used_at'),
    categoryName: nullableString(row, 'category_name') ?? undefined,
  };
}

function toBudget(row: Row): Budget {
  return {
    id: stringValue(row, 'id'),
    monthKey: stringValue(row, 'month_key'),
    categoryId: nullableString(row, 'category_id'),
    amountFen: numberValue(row, 'amount_fen'),
    createdAt: stringValue(row, 'created_at'),
    updatedAt: stringValue(row, 'updated_at'),
  };
}

function toEntryTemplate(row: Row): EntryTemplate {
  return {
    id: stringValue(row, 'id'),
    name: stringValue(row, 'name'),
    categoryId: stringValue(row, 'category_id'),
    amountFen: row.amount_fen === null || row.amount_fen === undefined ? null : numberValue(row, 'amount_fen'),
    merchantName: stringValue(row, 'merchant_name'),
    remark: stringValue(row, 'remark'),
    sortOrder: numberValue(row, 'sort_order'),
    createdAt: stringValue(row, 'created_at'),
    updatedAt: stringValue(row, 'updated_at'),
  };
}

function validateCategoryDraft(draft: CategoryDraft): { name: string; icon: string; color: string } {
  const name = requireText(draft.name, '分类名称', 10);
  const icon = (draft.icon || '📌').trim().slice(0, 8);
  const color = /^#[0-9a-fA-F]{6}$/.test(draft.color) ? draft.color : '#72777D';
  return { name, icon, color };
}

async function selectOne(database: SqlDatabase, sql: string, values: unknown[] = []): Promise<Row | null> {
  const rows = await database.select<Row[]>(sql, values);
  return rows[0] ?? null;
}

async function activeCategory(database: SqlDatabase, id: string, allowDeleted = false): Promise<Category | null> {
  const predicate = allowDeleted ? '' : 'AND deleted_at IS NULL';
  const row = await selectOne(database, `SELECT * FROM categories WHERE id = ? ${predicate}`, [id]);
  return row ? toCategory(row) : null;
}

function buildRecordWhere(options: RecordFilter, onlyDeleted: boolean): { clauses: string[]; values: unknown[] } {
  const clauses = [onlyDeleted ? 'deleted_at IS NOT NULL' : options.includeDeleted ? '1 = 1' : 'deleted_at IS NULL'];
  const values: unknown[] = [];
  if (options.monthKey) { clauses.push('month_key = ?'); values.push(assertMonthKey(options.monthKey)); }
  if (options.categoryId) { clauses.push('category_id = ?'); values.push(options.categoryId); }
  if (options.parentCategoryId) { clauses.push('parent_category_id_snapshot = ?'); values.push(options.parentCategoryId); }
  if (options.fromDate) { clauses.push('date_key >= ?'); values.push(assertDateKey(options.fromDate)); }
  if (options.toDate) { clauses.push('date_key <= ?'); values.push(assertDateKey(options.toDate)); }
  if (options.fromDate && options.toDate && options.fromDate > options.toDate) throw new Error('日期范围无效：起始日期不能晚于结束日期');
  if (options.minFen !== undefined) {
    if (!Number.isInteger(options.minFen) || options.minFen < 0 || options.minFen > 100_000_000) throw new Error('最低金额参数无效');
    clauses.push('amount_fen >= ?'); values.push(options.minFen);
  }
  if (options.maxFen !== undefined) {
    if (!Number.isInteger(options.maxFen) || options.maxFen < 0 || options.maxFen > 100_000_000) throw new Error('最高金额参数无效');
    clauses.push('amount_fen <= ?'); values.push(options.maxFen);
  }
  if (options.minFen !== undefined && options.maxFen !== undefined && options.minFen > options.maxFen) throw new Error('金额范围无效：最低金额不能高于最高金额');
  if (options.query?.trim()) {
    const term = `%${escapeLikePattern(options.query.normalize('NFKC').trim())}%`;
    clauses.push("(category_name_snapshot LIKE ? ESCAPE '\\' OR parent_category_name_snapshot LIKE ? ESCAPE '\\' OR merchant_name LIKE ? ESCAPE '\\' OR remark LIKE ? ESCAPE '\\')");
    values.push(term, term, term, term);
  }
  return { clauses, values };
}

export class SqliteLedgerRepository implements LedgerRepository {
  async initialize(): Promise<void> {
    await getDatabase();
  }

  async listCategories(includeDeleted = false): Promise<Category[]> {
    const database = await getDatabase();
    const predicate = includeDeleted ? '' : 'WHERE deleted_at IS NULL';
    const rows = await database.select<Row[]>(
      `SELECT * FROM categories ${predicate}
       ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, parent_id, sort_order, name`,
    );
    return rows.map(toCategory);
  }

  async addCategory(draft: CategoryDraft): Promise<Category> {
    const database = await getDatabase();
    const value = validateCategoryDraft(draft);
    if (draft.parentId) {
      const parent = await activeCategory(database, draft.parentId);
      if (!parent || parent.parentId !== null) throw new Error('所属大类不存在');
    }

    const max = await selectOne(
      database,
      `SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM categories
       WHERE COALESCE(parent_id, '') = COALESCE(?, '') AND deleted_at IS NULL`,
      [draft.parentId],
    );
    const timestamp = nowIso();
    const category: Category = {
      id: newId('cat'), parentId: draft.parentId, type: 'expense', ...value,
      sortOrder: numberValue(max ?? {}, 'max_sort') + 1, isDefault: false, deletedAt: null,
      createdAt: timestamp, updatedAt: timestamp,
    };
    try {
      await database.execute(
        `INSERT INTO categories
          (id, parent_id, type, name, normalized_name, icon, color, sort_order, is_default, deleted_at, created_at, updated_at)
         VALUES (?, ?, 'expense', ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
        [category.id, category.parentId, category.name, normalizeName(category.name), category.icon, category.color,
          category.sortOrder, timestamp, timestamp],
      );
    } catch (error) {
      if (String(error).includes('categories_active_name_unique')) throw new Error('同级分类中已存在这个名称');
      throw error;
    }
    return category;
  }

  async updateCategory(id: string, draft: Pick<CategoryDraft, 'name' | 'icon' | 'color'>): Promise<void> {
    const database = await getDatabase();
    const category = await activeCategory(database, id);
    if (!category) throw new Error('分类不存在或已删除');
    const value = validateCategoryDraft({ parentId: category.parentId, ...draft });
    try {
      await database.execute(
        `UPDATE categories SET name = ?, normalized_name = ?, icon = ?, color = ?, updated_at = ? WHERE id = ?`,
        [value.name, normalizeName(value.name), value.icon, value.color, nowIso(), id],
      );
    } catch (error) {
      if (String(error).includes('categories_active_name_unique')) throw new Error('同级分类中已存在这个名称');
      throw error;
    }
  }

  async deleteCategory(id: string): Promise<void> {
    await withTransaction(async (database) => {
      const category = await activeCategory(database, id);
      if (!category) throw new Error('分类不存在或已删除');
      const timestamp = nowIso();
      await database.execute('UPDATE categories SET deleted_at = ?, updated_at = ? WHERE id = ?', [timestamp, timestamp, id]);
      if (category.parentId === null) {
        await database.execute(
          `UPDATE categories SET deleted_at = ?, updated_at = ? WHERE parent_id = ? AND deleted_at IS NULL`,
          [timestamp, timestamp, id],
        );
      }
    });
  }

  async restoreCategory(id: string): Promise<void> {
    const database = await getDatabase();
    const category = await activeCategory(database, id, true);
    if (!category || !category.deletedAt) throw new Error('分类不存在或已启用');
    if (category.parentId && !await activeCategory(database, category.parentId)) {
      throw new Error('请先恢复所属大类');
    }
    await database.execute('UPDATE categories SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL', [nowIso(), id]);
  }

  async moveCategory(id: string, direction: 'up' | 'down'): Promise<void> {
    const database = await getDatabase();
    const category = await activeCategory(database, id);
    if (!category) throw new Error('分类不存在或已删除');
    const rows = await database.select<Row[]>(
      `SELECT * FROM categories WHERE deleted_at IS NULL AND parent_id IS ? ORDER BY sort_order, name`,
      [category.parentId],
    );
    const index = rows.findIndex((row) => stringValue(row, 'id') === id);
    const neighborIndex = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || neighborIndex < 0 || neighborIndex >= rows.length) return;
    const neighbor = rows[neighborIndex];
    const timestamp = nowIso();
    await withTransaction(async (transaction) => {
      await transaction.execute('UPDATE categories SET sort_order = ?, updated_at = ? WHERE id = ?', [numberValue(neighbor, 'sort_order'), timestamp, id]);
      await transaction.execute('UPDATE categories SET sort_order = ?, updated_at = ? WHERE id = ?', [category.sortOrder, timestamp, stringValue(neighbor, 'id')]);
    });
  }

  async previewCategoryMerge(sourceId: string, targetId: string): Promise<CategoryMergePreview> {
    if (!sourceId || !targetId || sourceId === targetId) throw new Error('请选择两个不同的末级分类');
    const database = await getDatabase();
    const source = await activeCategory(database, sourceId);
    const target = await activeCategory(database, targetId);
    if (!source || !target || source.parentId === null || target.parentId === null) throw new Error('只能合并有效的末级分类');
    if (source.parentId !== target.parentId) throw new Error('只能合并同一个大类下的分类');
    const [activeRow, deletedRow, merchantRow, templateRow, sourceBudgets, targetBudgets] = await Promise.all([
      selectOne(database, 'SELECT COUNT(*) AS count FROM records WHERE category_id = ? AND deleted_at IS NULL', [sourceId]),
      selectOne(database, 'SELECT COUNT(*) AS count FROM records WHERE category_id = ? AND deleted_at IS NOT NULL', [sourceId]),
      selectOne(database, 'SELECT COUNT(*) AS count FROM merchants WHERE category_id = ?', [sourceId]),
      selectOne(database, 'SELECT COUNT(*) AS count FROM entry_templates WHERE category_id = ?', [sourceId]),
      database.select<Row[]>('SELECT month_key FROM budgets WHERE category_id = ? ORDER BY month_key', [sourceId]),
      database.select<Row[]>('SELECT month_key FROM budgets WHERE category_id = ?', [targetId]),
    ]);
    const targetMonths = new Set(targetBudgets.map((row) => stringValue(row, 'month_key')));
    return {
      sourceId,
      sourceName: source.name,
      targetId,
      targetName: target.name,
      activeRecords: numberValue(activeRow ?? {}, 'count'),
      deletedRecords: numberValue(deletedRow ?? {}, 'count'),
      merchants: numberValue(merchantRow ?? {}, 'count'),
      budgets: sourceBudgets.length,
      templates: numberValue(templateRow ?? {}, 'count'),
      budgetConflictMonths: sourceBudgets.map((row) => stringValue(row, 'month_key')).filter((month) => targetMonths.has(month)),
    };
  }

  async mergeCategories(sourceId: string, targetId: string): Promise<CategoryMergeResult> {
    const preview = await this.previewCategoryMerge(sourceId, targetId);
    const database = await getDatabase();
    const source = await activeCategory(database, sourceId);
    const target = await activeCategory(database, targetId);
    if (!source || !target || source.parentId === null || target.parentId === null || source.parentId !== target.parentId) {
      throw new Error('分类状态已变化，请重新预览');
    }
    const parent = await activeCategory(database, source.parentId);
    if (!parent) throw new Error('分类所属大类不存在');

    await withTransaction(async (transaction) => {
      const sourceMerchants = await transaction.select<Row[]>('SELECT id, normalized_name FROM merchants WHERE category_id = ?', [source.id]);
      const targetMerchants = await transaction.select<Row[]>('SELECT id, normalized_name FROM merchants WHERE category_id = ?', [target.id]);
      const targetByName = new Map(targetMerchants.map((row) => [stringValue(row, 'normalized_name'), stringValue(row, 'id')]));
      const timestamp = nowIso();
      for (const merchant of sourceMerchants) {
        const sourceMerchantId = stringValue(merchant, 'id');
        const targetMerchantId = targetByName.get(stringValue(merchant, 'normalized_name'));
        if (targetMerchantId) {
          await transaction.execute('UPDATE records SET merchant_id = ?, updated_at = ? WHERE merchant_id = ?', [targetMerchantId, timestamp, sourceMerchantId]);
          await transaction.execute('DELETE FROM merchants WHERE id = ?', [sourceMerchantId]);
        } else {
          await transaction.execute('UPDATE merchants SET category_id = ?, updated_at = ? WHERE id = ?', [target.id, timestamp, sourceMerchantId]);
        }
      }
      await transaction.execute(
        `UPDATE records SET category_id = ?, category_name_snapshot = ?, parent_category_id_snapshot = ?,
         parent_category_name_snapshot = ?, updated_at = ? WHERE category_id = ?`,
        [target.id, target.name, parent.id, parent.name, timestamp, source.id],
      );
      await transaction.execute('UPDATE entry_templates SET category_id = ?, updated_at = ? WHERE category_id = ?', [target.id, timestamp, source.id]);
      const sourceBudgets = await transaction.select<Row[]>('SELECT * FROM budgets WHERE category_id = ? ORDER BY month_key', [source.id]);
      for (const row of sourceBudgets) {
        const sourceBudget = toBudget(row);
        const targetBudgetRow = await selectOne(transaction, 'SELECT * FROM budgets WHERE month_key = ? AND category_id = ?', [sourceBudget.monthKey, target.id]);
        if (targetBudgetRow) {
          const targetBudget = toBudget(targetBudgetRow);
          const combined = sourceBudget.amountFen + targetBudget.amountFen;
          if (combined > 100_000_000) throw new Error(`${sourceBudget.monthKey} 合并后的预算超过 1000000.00 元，请先调整预算`);
          await transaction.execute('UPDATE budgets SET amount_fen = ?, updated_at = ? WHERE id = ?', [combined, timestamp, targetBudget.id]);
          await transaction.execute('DELETE FROM budgets WHERE id = ?', [sourceBudget.id]);
        } else {
          await transaction.execute('UPDATE budgets SET category_id = ?, updated_at = ? WHERE id = ?', [target.id, timestamp, sourceBudget.id]);
        }
      }
      await transaction.execute('UPDATE categories SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [timestamp, timestamp, source.id]);
    });
    return preview;
  }

  async listRecords(options: RecordFilter = {}): Promise<ExpenseRecord[]> {
    return this.queryRecords(options, false);
  }

  async listDeletedRecords(options: Omit<RecordFilter, 'includeDeleted'> = {}): Promise<ExpenseRecord[]> {
    return this.queryRecords(options, true);
  }

  private async queryRecords(options: RecordFilter, onlyDeleted: boolean): Promise<ExpenseRecord[]> {
    const database = await getDatabase();
    const { clauses, values } = buildRecordWhere(options, onlyDeleted);
    const rows = await database.select<Row[]>(
      `SELECT * FROM records WHERE ${clauses.join(' AND ')} ORDER BY occurred_local DESC, created_at DESC, id DESC`,
      values,
    );
    return rows.map(toRecord);
  }

  async listLatestRecords(limit = 5): Promise<ExpenseRecord[]> {
    const database = await getDatabase();
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 50);
    const rows = await database.select<Row[]>(
      `SELECT * FROM records WHERE deleted_at IS NULL ORDER BY occurred_local DESC, created_at DESC, id DESC LIMIT ${bounded}`,
    );
    return rows.map(toRecord);
  }

  async listRecordPage(options: RecordFilter = {}, cursor: RecordCursor | null = null, limit = 100, onlyDeleted = false): Promise<RecordPage> {
    const database = await getDatabase();
    const bounded = Math.min(Math.max(Math.trunc(limit), 20), 200);
    const base = buildRecordWhere(options, onlyDeleted);
    const aggregate = await selectOne(database, `SELECT COUNT(*) AS count, COALESCE(SUM(amount_fen), 0) AS total_fen FROM records WHERE ${base.clauses.join(' AND ')}`, base.values);
    const clauses = [...base.clauses];
    const values = [...base.values];
    if (cursor) {
      clauses.push('(occurred_local < ? OR (occurred_local = ? AND created_at < ?) OR (occurred_local = ? AND created_at = ? AND id < ?))');
      values.push(cursor.occurredLocal, cursor.occurredLocal, cursor.createdAt, cursor.occurredLocal, cursor.createdAt, cursor.id);
    }
    const rows = await database.select<Row[]>(
      `SELECT * FROM records WHERE ${clauses.join(' AND ')} ORDER BY occurred_local DESC, created_at DESC, id DESC LIMIT ${bounded + 1}`,
      values,
    );
    const hasMore = rows.length > bounded;
    const items = rows.slice(0, bounded).map(toRecord);
    const last = items.at(-1);
    return {
      items,
      totalCount: numberValue(aggregate ?? {}, 'count'),
      totalFen: numberValue(aggregate ?? {}, 'total_fen'),
      nextCursor: hasMore && last ? { occurredLocal: last.occurredLocal, createdAt: last.createdAt, id: last.id } : null,
    };
  }

  async getRecord(id: string): Promise<ExpenseRecord | null> {
    const database = await getDatabase();
    const row = await selectOne(database, 'SELECT * FROM records WHERE id = ? AND deleted_at IS NULL', [id]);
    return row ? toRecord(row) : null;
  }

  async saveRecord(draft: RecordDraft, id?: string): Promise<ExpenseRecord> {
    const database = await getDatabase();
    const existing = id ? await this.getRecord(id) : null;
    if (id && !existing) throw new Error('记录不存在或已删除');
    const amountFen = parseAmountExpressionToFen(draft.amount);
    const time = parseLocalDateTime(draft.occurredLocal);
    const category = await activeCategory(database, draft.categoryId, true);
    if (!category || category.parentId === null) throw new Error('请选择有效的末级分类');
    const parent = await activeCategory(database, category.parentId, true);
    if (!parent) throw new Error('分类所属大类不存在');
    if (category.deletedAt && (!existing || existing.categoryId !== category.id)) {
      throw new Error('不能为新记录选择已删除分类');
    }

    const merchantName = draft.merchantName.normalize('NFKC').trim().slice(0, 30);
    const merchantNormalizedName = merchantName ? normalizeName(merchantName) : '';
    const remark = draft.remark.normalize('NFKC').trim().slice(0, 50);
    const timestamp = nowIso();
    const record: ExpenseRecord = {
      id: existing?.id ?? newId('rec'),
      categoryId: category.id,
      categoryNameSnapshot: category.deletedAt && existing ? existing.categoryNameSnapshot : category.name,
      parentCategoryIdSnapshot: category.deletedAt && existing ? existing.parentCategoryIdSnapshot : parent.id,
      parentCategoryNameSnapshot: category.deletedAt && existing ? existing.parentCategoryNameSnapshot : parent.name,
      amountFen,
      merchantId: null,
      merchantName,
      remark,
      ...time,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };

    const result = await invoke<AtomicSaveResult>('save_record_atomic', {
      request: {
        id: record.id,
        editing: Boolean(existing),
        categoryId: record.categoryId,
        categoryNameSnapshot: record.categoryNameSnapshot,
        parentCategoryIdSnapshot: record.parentCategoryIdSnapshot,
        parentCategoryNameSnapshot: record.parentCategoryNameSnapshot,
        amountFen: record.amountFen,
        merchantIdCandidate: merchantName ? newId('merchant') : null,
        merchantName: record.merchantName,
        merchantNormalizedName,
        remark: record.remark,
        occurredLocal: record.occurredLocal,
        dateKey: record.dateKey,
        monthKey: record.monthKey,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    });
    if (!result.saved || result.recordId !== record.id) throw new Error('记录保存结果无效，请重试');
    record.merchantId = result.merchantId;
    return record;
  }

  async deleteRecord(id: string): Promise<void> {
    const database = await getDatabase();
    const timestamp = nowIso();
    const result = await database.execute(
      'UPDATE records SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
      [timestamp, timestamp, id],
    );
    if (result.rowsAffected === 0) throw new Error('记录不存在或已删除');
  }

  async restoreRecord(id: string): Promise<void> {
    const database = await getDatabase();
    const result = await database.execute(
      'UPDATE records SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL',
      [nowIso(), id],
    );
    if (result.rowsAffected === 0) throw new Error('记录不存在或已恢复');
  }

  async restoreRecords(ids: string[]): Promise<void> {
    const uniqueIds = [...new Set(ids)].filter(Boolean);
    if (!uniqueIds.length) return;
    await withTransaction(async (database) => {
      const placeholders = uniqueIds.map(() => '?').join(', ');
      const timestamp = nowIso();
      const result = await database.execute(
        `UPDATE records SET deleted_at = NULL, updated_at = ? WHERE deleted_at IS NOT NULL AND id IN (${placeholders})`,
        [timestamp, ...uniqueIds],
      );
      if (result.rowsAffected !== uniqueIds.length) throw new Error('部分记录不存在或已恢复，操作已回滚');
    });
  }

  async purgeDeletedRecords(ids?: string[]): Promise<void> {
    const database = await getDatabase();
    if (!ids?.length) {
      await database.execute('DELETE FROM records WHERE deleted_at IS NOT NULL');
      return;
    }
    const uniqueIds = [...new Set(ids)].filter(Boolean);
    if (!uniqueIds.length) return;
    const placeholders = uniqueIds.map(() => '?').join(', ');
    await database.execute(`DELETE FROM records WHERE deleted_at IS NOT NULL AND id IN (${placeholders})`, uniqueIds);
  }

  async listMerchants(categoryId?: string, includeHidden = false): Promise<Merchant[]> {
    const database = await getDatabase();
    const filters = includeHidden ? ['1 = 1'] : ['m.hidden_at IS NULL'];
    const values: unknown[] = [];
    if (categoryId) {
      filters.push('m.category_id = ?');
      values.push(categoryId);
    }
    const rows = await database.select<Row[]>(
      `SELECT m.*, c.name AS category_name, COUNT(r.id) AS use_count, MAX(r.occurred_local) AS last_used_at
       FROM merchants m
       LEFT JOIN records r ON r.merchant_id = m.id AND r.deleted_at IS NULL
       LEFT JOIN categories c ON c.id = m.category_id
       WHERE ${filters.join(' AND ')}
       GROUP BY m.id
       ORDER BY use_count DESC, last_used_at DESC, m.name COLLATE NOCASE`,
      values,
    );
    return rows.map(toMerchant);
  }

  async hideMerchant(id: string): Promise<void> {
    const database = await getDatabase();
    const timestamp = nowIso();
    const result = await database.execute('UPDATE merchants SET hidden_at = ?, updated_at = ? WHERE id = ? AND hidden_at IS NULL', [timestamp, timestamp, id]);
    if (result.rowsAffected === 0) throw new Error('地点不存在或已隐藏');
  }

  async restoreMerchant(id: string): Promise<void> {
    const database = await getDatabase();
    const result = await database.execute('UPDATE merchants SET hidden_at = NULL, updated_at = ? WHERE id = ? AND hidden_at IS NOT NULL', [nowIso(), id]);
    if (result.rowsAffected === 0) throw new Error('地点不存在或已启用');
  }

  async getDashboardStats(monthKey = monthKeyNow(), dateKey = dateKeyNow()): Promise<OverviewStats> {
    const database = await getDatabase();
    const month = assertMonthKey(monthKey);
    const today = assertDateKey(dateKey);
    const previousMonth = shiftMonth(month, -1);
    const [monthRow, previousMonthRow, todayRow, lifetimeRow, merchantRow, categoryRow, budgetRow, topCategoryRow] = await Promise.all([
      selectOne(database, 'SELECT COALESCE(SUM(amount_fen), 0) AS total_fen, COUNT(*) AS total_count FROM records WHERE month_key = ? AND deleted_at IS NULL', [month]),
      selectOne(database, 'SELECT COALESCE(SUM(amount_fen), 0) AS total_fen, COUNT(*) AS total_count FROM records WHERE month_key = ? AND deleted_at IS NULL', [previousMonth]),
      selectOne(database, 'SELECT COALESCE(SUM(amount_fen), 0) AS total_fen, COUNT(*) AS total_count FROM records WHERE date_key = ? AND deleted_at IS NULL', [today]),
      selectOne(database, 'SELECT COALESCE(SUM(amount_fen), 0) AS total_fen, COUNT(*) AS total_count FROM records WHERE deleted_at IS NULL'),
      selectOne(database, `SELECT COUNT(DISTINCT m.id) AS count
        FROM merchants m INNER JOIN records r ON r.merchant_id = m.id AND r.deleted_at IS NULL
        WHERE m.hidden_at IS NULL`),
      selectOne(database, `SELECT
        SUM(CASE WHEN parent_id IS NULL THEN 1 ELSE 0 END) AS root_count,
        SUM(CASE WHEN parent_id IS NOT NULL THEN 1 ELSE 0 END) AS leaf_count
        FROM categories WHERE deleted_at IS NULL`),
      selectOne(database, 'SELECT amount_fen FROM budgets WHERE month_key = ? AND category_id IS NULL', [month]),
      selectOne(database, `SELECT parent_category_name_snapshot AS name, SUM(amount_fen) AS fen
        FROM records WHERE month_key = ? AND deleted_at IS NULL
        GROUP BY parent_category_id_snapshot, parent_category_name_snapshot ORDER BY fen DESC LIMIT 1`, [month]),
    ]);
    return {
      monthKey: month,
      monthTotalFen: numberValue(monthRow ?? {}, 'total_fen'),
      monthTotalCount: numberValue(monthRow ?? {}, 'total_count'),
      previousMonthTotalFen: numberValue(previousMonthRow ?? {}, 'total_fen'),
      previousMonthTotalCount: numberValue(previousMonthRow ?? {}, 'total_count'),
      todayTotalFen: numberValue(todayRow ?? {}, 'total_fen'),
      todayTotalCount: numberValue(todayRow ?? {}, 'total_count'),
      lifetimeTotalFen: numberValue(lifetimeRow ?? {}, 'total_fen'),
      lifetimeTotalCount: numberValue(lifetimeRow ?? {}, 'total_count'),
      merchantCount: numberValue(merchantRow ?? {}, 'count'),
      rootCategoryCount: numberValue(categoryRow ?? {}, 'root_count'),
      leafCategoryCount: numberValue(categoryRow ?? {}, 'leaf_count'),
      monthlyBudgetFen: budgetRow ? numberValue(budgetRow, 'amount_fen') : null,
      topCategoryName: stringValue(topCategoryRow ?? {}, 'name'),
      topCategoryFen: numberValue(topCategoryRow ?? {}, 'fen'),
    };
  }

  async getOverview(): Promise<OverviewStats> {
    return this.getDashboardStats();
  }

  async getRecentEntryDefaults(limit = 6): Promise<QuickEntryDefaults> {
    const database = await getDatabase();
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 12);
    const categoryRows = await database.select<Row[]>(
      `SELECT category_id FROM records WHERE deleted_at IS NULL
       GROUP BY category_id ORDER BY MAX(occurred_local) DESC, COUNT(*) DESC LIMIT ${boundedLimit}`,
    );
    const merchants = (await this.listMerchants()).slice(0, 8);
    return { categoryIds: categoryRows.map((row) => stringValue(row, 'category_id')), merchants };
  }

  async getMonthlyStats(monthKey: string): Promise<MonthlyStats> {
    const database = await getDatabase();
    const validMonth = assertMonthKey(monthKey);
    const previousMonth = shiftMonth(validMonth, -1);
    const [summary, previousSummary, categories, daily, budgetPlan] = await Promise.all([
      selectOne(database,
        'SELECT COALESCE(SUM(amount_fen), 0) AS total_fen, COUNT(*) AS total_count FROM records WHERE month_key = ? AND deleted_at IS NULL',
        [validMonth]),
      selectOne(database,
        'SELECT COALESCE(SUM(amount_fen), 0) AS total_fen, COUNT(*) AS total_count FROM records WHERE month_key = ? AND deleted_at IS NULL',
        [previousMonth]),
      database.select<Row[]>(
        `SELECT r.parent_category_id_snapshot AS id, r.parent_category_name_snapshot AS name,
          COALESCE(c.icon, '📌') AS icon, COALESCE(c.color, '#72777D') AS color,
          SUM(r.amount_fen) AS fen, COUNT(*) AS count
         FROM records r LEFT JOIN categories c ON c.id = r.parent_category_id_snapshot
         WHERE r.month_key = ? AND r.deleted_at IS NULL
         GROUP BY r.parent_category_id_snapshot, r.parent_category_name_snapshot, c.icon, c.color
         ORDER BY fen DESC`,
        [validMonth],
      ),
      database.select<Row[]>(
        `SELECT date_key, SUM(amount_fen) AS fen FROM records
         WHERE month_key = ? AND deleted_at IS NULL GROUP BY date_key ORDER BY date_key`,
        [validMonth],
      ),
      this.getBudgetPlan(validMonth),
    ]);
    const dailyStats = daily.map((row): DailyStat => ({ dateKey: stringValue(row, 'date_key'), fen: numberValue(row, 'fen') }));
    const maxDay = dailyStats.reduce<DailyStat | null>((best, current) => (!best || current.fen > best.fen ? current : best), null);
    const budgetCategories = budgetPlan.categories.length
      ? await database.select<Row[]>(`SELECT id, parent_id, name, icon FROM categories WHERE id IN (${budgetPlan.categories.map(() => '?').join(', ')})`, budgetPlan.categories.map((budget) => budget.categoryId))
      : [];
    const categoryById = new Map(budgetCategories.map((row) => [stringValue(row, 'id'), row]));
    const budgetUsage: CategoryBudgetUsage[] = [];
    for (const budget of budgetPlan.categories) {
      if (!budget.categoryId) continue;
      const category = categoryById.get(budget.categoryId);
      if (!category) continue;
      const isRoot = nullableString(category, 'parent_id') === null;
      const spent = await selectOne(database,
        `SELECT COALESCE(SUM(amount_fen), 0) AS fen FROM records WHERE month_key = ? AND deleted_at IS NULL AND ${isRoot ? 'parent_category_id_snapshot' : 'category_id'} = ?`,
        [validMonth, budget.categoryId],
      );
      budgetUsage.push({
        categoryId: budget.categoryId,
        scope: isRoot ? 'root' : 'leaf',
        name: stringValue(category, 'name'),
        icon: stringValue(category, 'icon'),
        amountFen: budget.amountFen,
        spentFen: numberValue(spent ?? {}, 'fen'),
      });
    }
    return {
      monthKey: validMonth,
      totalFen: numberValue(summary ?? {}, 'total_fen'),
      totalCount: numberValue(summary ?? {}, 'total_count'),
      previousMonthTotalFen: numberValue(previousSummary ?? {}, 'total_fen'),
      previousMonthTotalCount: numberValue(previousSummary ?? {}, 'total_count'),
      averageDailyFen: Math.round(numberValue(summary ?? {}, 'total_fen') / daysInMonth(validMonth)),
      categories: categories.map((row): CategoryStat => ({
        id: stringValue(row, 'id'), name: stringValue(row, 'name'), icon: stringValue(row, 'icon'),
        color: stringValue(row, 'color'), fen: numberValue(row, 'fen'), count: numberValue(row, 'count'),
      })),
      daily: dailyStats,
      maxDay,
      budgetPlan,
      budgetUsage,
    };
  }

  async getBudgetPlan(monthKey: string): Promise<BudgetPlan> {
    const database = await getDatabase();
    const validMonth = assertMonthKey(monthKey);
    const rows = await database.select<Row[]>(
      'SELECT * FROM budgets WHERE month_key = ? ORDER BY category_id IS NOT NULL, category_id',
      [validMonth],
    );
    const budgets = rows.map(toBudget);
    return {
      monthKey: validMonth,
      monthly: budgets.find((budget) => budget.categoryId === null) ?? null,
      categories: budgets.filter((budget) => budget.categoryId !== null),
    };
  }

  async saveBudget(monthKey: string, categoryId: string | null, amountFen: number | null): Promise<void> {
    const database = await getDatabase();
    const validMonth = assertMonthKey(monthKey);
    if (categoryId) {
      const category = await activeCategory(database, categoryId);
      if (!category) throw new Error('分类预算必须绑定有效分类');
    }
    if (amountFen !== null && (!Number.isInteger(amountFen) || amountFen < 1 || amountFen > 100_000_000)) {
      throw new Error('预算必须在 0.01 至 1000000.00 元之间');
    }
    await withTransaction(async (transaction) => {
      const existing = await selectOne(transaction, 'SELECT id FROM budgets WHERE month_key = ? AND category_id IS ?', [validMonth, categoryId]);
      if (amountFen === null) {
        if (existing) await transaction.execute('DELETE FROM budgets WHERE id = ?', [stringValue(existing, 'id')]);
        return;
      }
      const timestamp = nowIso();
      if (existing) {
        await transaction.execute('UPDATE budgets SET amount_fen = ?, updated_at = ? WHERE id = ?', [amountFen, timestamp, stringValue(existing, 'id')]);
      } else {
        await transaction.execute(
          `INSERT INTO budgets (id, month_key, category_id, amount_fen, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [newId('budget'), validMonth, categoryId, amountFen, timestamp, timestamp],
        );
      }
    });
  }

  async copyBudgets(sourceMonthKey: string, targetMonthKey: string): Promise<number> {
    const source = assertMonthKey(sourceMonthKey);
    const target = assertMonthKey(targetMonthKey);
    if (source === target) throw new Error('来源月份和目标月份不能相同');
    return withTransaction(async (database) => {
      const sourceRows = await database.select<Row[]>('SELECT * FROM budgets WHERE month_key = ? ORDER BY category_id', [source]);
      const timestamp = nowIso();
      let copied = 0;
      for (const row of sourceRows) {
        const budget = toBudget(row);
        const existing = await selectOne(database, 'SELECT id FROM budgets WHERE month_key = ? AND category_id IS ?', [target, budget.categoryId]);
        if (existing) continue;
        await database.execute(
          'INSERT INTO budgets (id, month_key, category_id, amount_fen, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          [newId('budget'), target, budget.categoryId, budget.amountFen, timestamp, timestamp],
        );
        copied += 1;
      }
      return copied;
    });
  }

  async listEntryTemplates(): Promise<EntryTemplate[]> {
    const database = await getDatabase();
    const rows = await database.select<Row[]>(
      `SELECT t.* FROM entry_templates t INNER JOIN categories c ON c.id = t.category_id
       WHERE c.deleted_at IS NULL ORDER BY t.sort_order, t.name`,
    );
    return rows.map(toEntryTemplate);
  }

  async addEntryTemplate(draft: EntryTemplateDraft): Promise<EntryTemplate> {
    const database = await getDatabase();
    const category = await activeCategory(database, draft.categoryId);
    if (!category || category.parentId === null) throw new Error('模板必须使用有效的末级分类');
    const name = requireText(draft.name, '模板名称', 20);
    const amountFen = draft.includeAmount && draft.amount.trim() ? parseAmountExpressionToFen(draft.amount) : null;
    const merchantName = draft.merchantName.normalize('NFKC').trim().slice(0, 30);
    const remark = draft.remark.normalize('NFKC').trim().slice(0, 50);
    const max = await selectOne(database, 'SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM entry_templates');
    const timestamp = nowIso();
    const template: EntryTemplate = {
      id: newId('tpl'), name, categoryId: category.id, amountFen, merchantName, remark,
      sortOrder: numberValue(max ?? {}, 'max_sort') + 1, createdAt: timestamp, updatedAt: timestamp,
    };
    await database.execute(
      `INSERT INTO entry_templates (id, name, category_id, amount_fen, merchant_name, remark, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [template.id, template.name, template.categoryId, template.amountFen, template.merchantName, template.remark,
        template.sortOrder, template.createdAt, template.updatedAt],
    );
    return template;
  }

  async deleteEntryTemplate(id: string): Promise<void> {
    const database = await getDatabase();
    const result = await database.execute('DELETE FROM entry_templates WHERE id = ?', [id]);
    if (result.rowsAffected === 0) throw new Error('模板不存在');
  }

  async moveEntryTemplate(id: string, direction: 'up' | 'down'): Promise<void> {
    const database = await getDatabase();
    const rows = await database.select<Row[]>('SELECT id, sort_order FROM entry_templates ORDER BY sort_order, name');
    const index = rows.findIndex((row) => stringValue(row, 'id') === id);
    const neighborIndex = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || neighborIndex < 0 || neighborIndex >= rows.length) return;
    await withTransaction(async (transaction) => {
      const timestamp = nowIso();
      await transaction.execute('UPDATE entry_templates SET sort_order = ?, updated_at = ? WHERE id = ?', [numberValue(rows[neighborIndex], 'sort_order'), timestamp, id]);
      await transaction.execute('UPDATE entry_templates SET sort_order = ?, updated_at = ? WHERE id = ?', [numberValue(rows[index], 'sort_order'), timestamp, stringValue(rows[neighborIndex], 'id')]);
    });
  }

  async getSetting(key: string): Promise<string | null> {
    const database = await getDatabase();
    const row = await selectOne(database, 'SELECT value FROM settings WHERE key = ?', [requireText(key, '设置名称', 100)]);
    return row ? nullableString(row, 'value') : null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    const database = await getDatabase();
    const settingKey = requireText(key, '设置名称', 100);
    const settingValue = value.normalize('NFKC').slice(0, 500);
    await database.execute(
      `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [settingKey, settingValue, nowIso()],
    );
  }

  async getTrend(endMonthKey: string, count: number): Promise<TrendPoint[]> {
    const database = await getDatabase();
    const end = assertMonthKey(endMonthKey);
    const boundedCount = Math.min(Math.max(Math.trunc(count), 1), 24);
    const start = shiftMonth(end, -(boundedCount - 1));
    const rows = await database.select<Row[]>(
      `SELECT month_key, SUM(amount_fen) AS fen FROM records
       WHERE month_key >= ? AND month_key <= ? AND deleted_at IS NULL GROUP BY month_key`,
      [start, end],
    );
    const values = new Map(rows.map((row) => [stringValue(row, 'month_key'), numberValue(row, 'fen')]));
    return Array.from({ length: boundedCount }, (_, index) => {
      const key = shiftMonth(end, index - (boundedCount - 1));
      return { key, label: `${Number(key.slice(5))}月`, value: values.get(key) ?? 0 };
    });
  }

  async exportSnapshot(): Promise<SnapshotData> {
    const database = await getDatabase();
    const [categories, merchants, records, settings, budgets, templates] = await Promise.all([
      database.select<Row[]>('SELECT * FROM categories ORDER BY parent_id IS NOT NULL, parent_id, sort_order, id'),
      database.select<Row[]>('SELECT * FROM merchants ORDER BY category_id, normalized_name, id'),
      database.select<Row[]>('SELECT * FROM records ORDER BY occurred_local, id'),
      database.select<Row[]>('SELECT key, value FROM settings ORDER BY key'),
      database.select<Row[]>('SELECT * FROM budgets ORDER BY month_key, category_id'),
      database.select<Row[]>('SELECT * FROM entry_templates ORDER BY sort_order, id'),
    ]);
    return {
      categories: categories.map(toCategory),
      merchants: merchants.map((row) => {
        const merchant = toMerchant(row);
        const { useCount, lastUsedAt, categoryName, ...snapshotMerchant } = merchant;
        return snapshotMerchant;
      }),
      records: records.map(toRecord),
      settings: Object.fromEntries(settings.map((row) => [stringValue(row, 'key'), stringValue(row, 'value')]).filter(([key]) => !LOCAL_ONLY_SETTINGS.has(key))),
      budgets: budgets.map(toBudget),
      templates: templates.map(toEntryTemplate),
    };
  }

  async replaceSnapshot(snapshot: SnapshotData): Promise<void> {
    await withTransaction(async (database) => {
      const localSettings = await database.select<Row[]>(`SELECT key, value FROM settings WHERE key IN ('dailyBackupDirectory', 'lastDailyBackupDate', 'dailyBackupStatus')`);
      await database.execute('DELETE FROM entry_templates');
      await database.execute('DELETE FROM records');
      await database.execute('DELETE FROM merchants');
      await database.execute('DELETE FROM budgets');
      await database.execute('DELETE FROM categories');
      await database.execute('DELETE FROM settings');

      const categories = [...snapshot.categories].sort((a, b) => Number(a.parentId !== null) - Number(b.parentId !== null));
      for (const category of categories) {
        await database.execute(
          `INSERT INTO categories
            (id, parent_id, type, name, normalized_name, icon, color, sort_order, is_default, deleted_at, created_at, updated_at)
           VALUES (?, ?, 'expense', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [category.id, category.parentId, category.name, normalizeName(category.name), category.icon, category.color,
            category.sortOrder, category.isDefault ? 1 : 0, category.deletedAt, category.createdAt, category.updatedAt],
        );
      }
      for (const merchant of snapshot.merchants) {
        await database.execute(
          `INSERT INTO merchants (id, category_id, name, normalized_name, hidden_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [merchant.id, merchant.categoryId, merchant.name, merchant.normalizedName, merchant.hiddenAt, merchant.createdAt, merchant.updatedAt],
        );
      }
      for (const record of snapshot.records) {
        await database.execute(
          `INSERT INTO records
            (id, category_id, category_name_snapshot, parent_category_id_snapshot, parent_category_name_snapshot,
             amount_fen, merchant_id, merchant_name, remark, occurred_local, date_key, month_key, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [record.id, record.categoryId, record.categoryNameSnapshot, record.parentCategoryIdSnapshot,
            record.parentCategoryNameSnapshot, record.amountFen, record.merchantId, record.merchantName, record.remark,
            record.occurredLocal, record.dateKey, record.monthKey, record.createdAt, record.updatedAt, record.deletedAt],
        );
      }
      for (const budget of snapshot.budgets ?? []) {
        await database.execute(
          `INSERT INTO budgets (id, month_key, category_id, amount_fen, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [budget.id, budget.monthKey, budget.categoryId, budget.amountFen, budget.createdAt, budget.updatedAt],
        );
      }
      for (const [key, value] of Object.entries(snapshot.settings)) {
        await database.execute('INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)', [key, value, nowIso()]);
      }
      for (const row of localSettings) {
        await database.execute('INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?, ?, ?)', [stringValue(row, 'key'), stringValue(row, 'value'), nowIso()]);
      }
      for (const template of snapshot.templates ?? []) {
        await database.execute(
          `INSERT INTO entry_templates (id, name, category_id, amount_fen, merchant_name, remark, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [template.id, template.name, template.categoryId, template.amountFen, template.merchantName, template.remark,
            template.sortOrder, template.createdAt, template.updatedAt],
        );
      }
    });
  }

}

export const ledgerRepository = new SqliteLedgerRepository();
