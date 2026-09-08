import Database from '@tauri-apps/plugin-sql';
import { nowIso } from '@/utils';

export type SqlDatabase = Database;

interface DefaultCategory {
  id: string;
  name: string;
  icon: string;
  color: string;
  children: Array<{ id: string; name: string; icon: string }>;
}

const DEFAULT_CATEGORIES: DefaultCategory[] = [
  {
    id: 'cate_food', name: '餐饮', icon: '🍚', color: '#E16E3D', children: [
      { id: 'cate_food_breakfast', name: '早餐', icon: '🍳' },
      { id: 'cate_food_lunch', name: '午餐', icon: '🍱' },
      { id: 'cate_food_dinner', name: '晚餐', icon: '🍜' },
      { id: 'cate_food_supper', name: '夜宵', icon: '🌙' },
      { id: 'cate_food_dessert', name: '甜点', icon: '🍰' },
      { id: 'cate_food_fruit', name: '水果', icon: '🍉' },
      { id: 'cate_food_coffee', name: '咖啡奶茶', icon: '🥤' },
    ],
  },
  {
    id: 'cate_life', name: '生活', icon: '🏠', color: '#3278C8', children: [
      { id: 'cate_life_phone', name: '充话费', icon: '📱' },
      { id: 'cate_life_utility', name: '水电费', icon: '💡' },
      { id: 'cate_life_daily', name: '日用品', icon: '🧻' },
      { id: 'cate_life_traffic', name: '交通', icon: '🚇' },
      { id: 'cate_life_express', name: '快递', icon: '📦' },
    ],
  },
  {
    id: 'cate_fun', name: '娱乐', icon: '🎮', color: '#8956C7', children: [
      { id: 'cate_fun_game', name: '游戏充值', icon: '🎮' },
      { id: 'cate_fun_movie', name: '电影', icon: '🎬' },
      { id: 'cate_fun_music', name: '音乐会员', icon: '🎵' },
      { id: 'cate_fun_travel', name: '旅游', icon: '✈️' },
    ],
  },
  {
    id: 'cate_study', name: '学习', icon: '📚', color: '#27845B', children: [
      { id: 'cate_study_book', name: '书籍', icon: '📚' },
      { id: 'cate_study_soft', name: '软件会员', icon: '💻' },
      { id: 'cate_study_material', name: '学习资料', icon: '📝' },
    ],
  },
  {
    id: 'cate_other', name: '其他', icon: '📌', color: '#72777D', children: [
      { id: 'cate_other_medical', name: '医疗', icon: '💊' },
      { id: 'cate_other_gift', name: '礼物', icon: '🎁' },
      { id: 'cate_other_temp', name: '临时消费', icon: '🧾' },
    ],
  },
];

let databasePromise: Promise<SqlDatabase> | null = null;

export async function getDatabase(): Promise<SqlDatabase> {
  if (!databasePromise) {
    const opening = Database.load('sqlite:lq-ledger.db').then(async (database) => {
      await database.execute('PRAGMA foreign_keys = ON');
      await seedDefaults(database);
      return database;
    });
    databasePromise = opening.catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

export async function withTransaction<T>(action: (database: SqlDatabase) => Promise<T>): Promise<T> {
  const database = await getDatabase();
  await database.execute('BEGIN IMMEDIATE');
  try {
    const result = await action(database);
    await database.execute('COMMIT');
    return result;
  } catch (error) {
    try {
      await database.execute('ROLLBACK');
    } catch {
      // The transaction might already have been rolled back by SQLite.
    }
    throw error;
  }
}

async function seedDefaults(database: SqlDatabase): Promise<void> {
  const present = await database.select<Array<{ count: number }>>('SELECT COUNT(*) AS count FROM categories');
  if (Number(present[0]?.count ?? 0) > 0) return;

  const timestamp = nowIso();
  await database.execute('BEGIN IMMEDIATE');
  try {
    for (const [parentIndex, parent] of DEFAULT_CATEGORIES.entries()) {
      await database.execute(
        `INSERT INTO categories
          (id, parent_id, type, name, normalized_name, icon, color, sort_order, is_default, deleted_at, created_at, updated_at)
         VALUES (?, NULL, 'expense', ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
        [parent.id, parent.name, parent.name, parent.icon, parent.color, parentIndex, timestamp, timestamp],
      );
      for (const [childIndex, child] of parent.children.entries()) {
        await database.execute(
          `INSERT INTO categories
            (id, parent_id, type, name, normalized_name, icon, color, sort_order, is_default, deleted_at, created_at, updated_at)
           VALUES (?, ?, 'expense', ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
          [child.id, parent.id, child.name, child.name, child.icon, parent.color, childIndex, timestamp, timestamp],
        );
      }
    }
    await database.execute(
      `INSERT INTO app_meta(key, value, updated_at) VALUES ('schema_version', '3', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [timestamp],
    );
    await database.execute('COMMIT');
  } catch (error) {
    await database.execute('ROLLBACK');
    throw error;
  }
}
