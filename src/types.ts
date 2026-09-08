export type CategoryType = 'expense';

export interface Category {
  id: string;
  parentId: string | null;
  type: CategoryType;
  name: string;
  icon: string;
  color: string;
  sortOrder: number;
  isDefault: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Merchant {
  id: string;
  categoryId: string;
  name: string;
  normalizedName: string;
  hiddenAt: string | null;
  createdAt: string;
  updatedAt: string;
  useCount: number;
  lastUsedAt: string | null;
  categoryName?: string;
}

export interface ExpenseRecord {
  id: string;
  categoryId: string;
  categoryNameSnapshot: string;
  parentCategoryIdSnapshot: string;
  parentCategoryNameSnapshot: string;
  amountFen: number;
  merchantId: string | null;
  merchantName: string;
  remark: string;
  occurredLocal: string;
  dateKey: string;
  monthKey: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface RecordDraft {
  categoryId: string;
  amount: string;
  merchantName: string;
  remark: string;
  occurredLocal: string;
}

export interface CategoryDraft {
  parentId: string | null;
  name: string;
  icon: string;
  color: string;
}

export interface OverviewStats {
  monthKey: string;
  monthTotalFen: number;
  monthTotalCount: number;
  previousMonthTotalFen: number;
  previousMonthTotalCount: number;
  todayTotalFen: number;
  todayTotalCount: number;
  lifetimeTotalFen: number;
  lifetimeTotalCount: number;
  merchantCount: number;
  rootCategoryCount: number;
  leafCategoryCount: number;
  monthlyBudgetFen: number | null;
  topCategoryName: string;
  topCategoryFen: number;
}

export interface QuickEntryDefaults {
  categoryIds: string[];
  merchants: Merchant[];
}

export interface Budget {
  id: string;
  monthKey: string;
  categoryId: string | null;
  amountFen: number;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetPlan {
  monthKey: string;
  monthly: Budget | null;
  categories: Budget[];
}

export interface CategoryBudgetUsage {
  categoryId: string;
  scope: 'root' | 'leaf';
  name: string;
  icon: string;
  amountFen: number;
  spentFen: number;
}

export interface CategoryStat {
  id: string;
  name: string;
  icon: string;
  color: string;
  fen: number;
  count: number;
}

export interface DailyStat {
  dateKey: string;
  fen: number;
}

export interface MonthlyStats {
  monthKey: string;
  totalFen: number;
  totalCount: number;
  previousMonthTotalFen: number;
  previousMonthTotalCount: number;
  averageDailyFen: number;
  categories: CategoryStat[];
  daily: DailyStat[];
  maxDay: DailyStat | null;
  budgetPlan: BudgetPlan;
  budgetUsage: CategoryBudgetUsage[];
}

export interface TrendPoint {
  key: string;
  label: string;
  value: number;
}

export interface RecordFilter {
  monthKey?: string;
  query?: string;
  categoryId?: string;
  parentCategoryId?: string;
  fromDate?: string;
  toDate?: string;
  minFen?: number;
  maxFen?: number;
  includeDeleted?: boolean;
}

export interface RecordCursor {
  occurredLocal: string;
  createdAt: string;
  id: string;
}

export interface RecordPage {
  items: ExpenseRecord[];
  totalCount: number;
  totalFen: number;
  nextCursor: RecordCursor | null;
}

export interface CategoryMergePreview {
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
  activeRecords: number;
  deletedRecords: number;
  merchants: number;
  budgets: number;
  templates: number;
  budgetConflictMonths: string[];
}

export type CategoryMergeResult = CategoryMergePreview;

export interface EntryTemplate {
  id: string;
  name: string;
  categoryId: string;
  amountFen: number | null;
  merchantName: string;
  remark: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface EntryTemplateDraft {
  name: string;
  categoryId: string;
  amount: string;
  includeAmount: boolean;
  merchantName: string;
  remark: string;
}

export interface SnapshotData {
  categories: Category[];
  merchants: Omit<Merchant, 'useCount' | 'lastUsedAt' | 'categoryName'>[];
  records: ExpenseRecord[];
  settings: Record<string, string>;
  budgets?: Budget[];
  templates?: EntryTemplate[];
}

export interface BackupEnvelopeV1 {
  format: 'lq-ledger-backup';
  schemaVersion: 1;
  exportedAt: string;
  appVersion: string;
  payload: SnapshotData;
  payloadSha256: string;
}

export interface BackupSummary {
  exportedAt: string;
  records: number;
  categories: number;
  merchants: number;
  budgets: number;
  templates: number;
}

export interface LedgerRepository {
  initialize(): Promise<void>;
  listCategories(includeDeleted?: boolean): Promise<Category[]>;
  addCategory(draft: CategoryDraft): Promise<Category>;
  updateCategory(id: string, draft: Pick<CategoryDraft, 'name' | 'icon' | 'color'>): Promise<void>;
  deleteCategory(id: string): Promise<void>;
  restoreCategory(id: string): Promise<void>;
  moveCategory(id: string, direction: 'up' | 'down'): Promise<void>;
  previewCategoryMerge(sourceId: string, targetId: string): Promise<CategoryMergePreview>;
  mergeCategories(sourceId: string, targetId: string): Promise<CategoryMergeResult>;
  listRecords(options?: RecordFilter): Promise<ExpenseRecord[]>;
  listLatestRecords(limit?: number): Promise<ExpenseRecord[]>;
  listRecordPage(options?: RecordFilter, cursor?: RecordCursor | null, limit?: number, onlyDeleted?: boolean): Promise<RecordPage>;
  listDeletedRecords(options?: Omit<RecordFilter, 'includeDeleted'>): Promise<ExpenseRecord[]>;
  getRecord(id: string): Promise<ExpenseRecord | null>;
  saveRecord(draft: RecordDraft, id?: string): Promise<ExpenseRecord>;
  deleteRecord(id: string): Promise<void>;
  restoreRecord(id: string): Promise<void>;
  restoreRecords(ids: string[]): Promise<void>;
  purgeDeletedRecords(ids?: string[]): Promise<void>;
  listMerchants(categoryId?: string, includeHidden?: boolean): Promise<Merchant[]>;
  hideMerchant(id: string): Promise<void>;
  restoreMerchant(id: string): Promise<void>;
  getDashboardStats(monthKey?: string, dateKey?: string): Promise<OverviewStats>;
  getOverview(): Promise<OverviewStats>;
  getRecentEntryDefaults(limit?: number): Promise<QuickEntryDefaults>;
  getMonthlyStats(monthKey: string): Promise<MonthlyStats>;
  getTrend(endMonthKey: string, count: number): Promise<TrendPoint[]>;
  getBudgetPlan(monthKey: string): Promise<BudgetPlan>;
  saveBudget(monthKey: string, categoryId: string | null, amountFen: number | null): Promise<void>;
  copyBudgets(sourceMonthKey: string, targetMonthKey: string): Promise<number>;
  listEntryTemplates(): Promise<EntryTemplate[]>;
  addEntryTemplate(draft: EntryTemplateDraft): Promise<EntryTemplate>;
  deleteEntryTemplate(id: string): Promise<void>;
  moveEntryTemplate(id: string, direction: 'up' | 'down'): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  exportSnapshot(): Promise<SnapshotData>;
  replaceSnapshot(snapshot: SnapshotData): Promise<void>;
}
