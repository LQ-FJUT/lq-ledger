use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};
use tauri::{Manager, State};
use tauri_plugin_sql::{Migration, MigrationKind};
use tokio::sync::Mutex;

const MAX_IMPORT_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveRecordRequest {
    id: String,
    editing: bool,
    category_id: String,
    category_name_snapshot: String,
    parent_category_id_snapshot: String,
    parent_category_name_snapshot: String,
    amount_fen: i64,
    merchant_id_candidate: Option<String>,
    merchant_name: String,
    merchant_normalized_name: String,
    remark: String,
    occurred_local: String,
    date_key: String,
    month_key: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveRecordResponse {
    record_id: String,
    merchant_id: Option<String>,
    saved: bool,
}

struct LedgerWriterLock(Mutex<()>);

fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_lq_ledger_schema",
            kind: MigrationKind::Up,
            sql: r#"
          PRAGMA foreign_keys = ON;

          CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY NOT NULL,
            parent_id TEXT REFERENCES categories(id),
            type TEXT NOT NULL CHECK(type IN ('expense')),
            name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            icon TEXT NOT NULL,
            color TEXT NOT NULL,
            sort_order INTEGER NOT NULL,
            is_default INTEGER NOT NULL CHECK(is_default IN (0, 1)),
            deleted_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE UNIQUE INDEX IF NOT EXISTS categories_active_name_unique
            ON categories(COALESCE(parent_id, ''), normalized_name)
            WHERE deleted_at IS NULL;

          CREATE TABLE IF NOT EXISTS merchants (
            id TEXT PRIMARY KEY NOT NULL,
            category_id TEXT NOT NULL REFERENCES categories(id),
            name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            hidden_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE UNIQUE INDEX IF NOT EXISTS merchants_category_name_unique
            ON merchants(category_id, normalized_name);

          CREATE TABLE IF NOT EXISTS records (
            id TEXT PRIMARY KEY NOT NULL,
            category_id TEXT NOT NULL REFERENCES categories(id),
            category_name_snapshot TEXT NOT NULL,
            parent_category_id_snapshot TEXT NOT NULL,
            parent_category_name_snapshot TEXT NOT NULL,
            amount_fen INTEGER NOT NULL CHECK(amount_fen > 0 AND amount_fen <= 100000000),
            merchant_id TEXT REFERENCES merchants(id),
            merchant_name TEXT NOT NULL,
            remark TEXT NOT NULL,
            occurred_local TEXT NOT NULL,
            date_key TEXT NOT NULL,
            month_key TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
          );

          CREATE INDEX IF NOT EXISTS records_month_active_idx
            ON records(month_key, occurred_local DESC) WHERE deleted_at IS NULL;
          CREATE INDEX IF NOT EXISTS records_date_active_idx
            ON records(date_key, occurred_local DESC) WHERE deleted_at IS NULL;
          CREATE INDEX IF NOT EXISTS records_category_active_idx
            ON records(category_id) WHERE deleted_at IS NULL;
          CREATE INDEX IF NOT EXISTS records_merchant_active_idx
            ON records(merchant_id) WHERE deleted_at IS NULL;
        "#,
        },
        Migration {
            version: 2,
            description: "add_budget_plans",
            kind: MigrationKind::Up,
            sql: r#"
          CREATE TABLE IF NOT EXISTS budgets (
            id TEXT PRIMARY KEY NOT NULL,
            month_key TEXT NOT NULL,
            category_id TEXT REFERENCES categories(id),
            amount_fen INTEGER NOT NULL CHECK(amount_fen > 0 AND amount_fen <= 100000000),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE UNIQUE INDEX IF NOT EXISTS budgets_month_category_unique
            ON budgets(month_key, COALESCE(category_id, ''));
          CREATE INDEX IF NOT EXISTS budgets_month_idx
            ON budgets(month_key);

          INSERT INTO app_meta(key, value, updated_at)
            VALUES ('schema_version', '2', CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
        "#,
        },
        Migration {
            version: 3,
            description: "add_entry_templates_and_query_indexes",
            kind: MigrationKind::Up,
            sql: r#"
          CREATE TABLE IF NOT EXISTS entry_templates (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            category_id TEXT NOT NULL REFERENCES categories(id),
            amount_fen INTEGER CHECK(amount_fen IS NULL OR (amount_fen > 0 AND amount_fen <= 100000000)),
            merchant_name TEXT NOT NULL,
            remark TEXT NOT NULL,
            sort_order INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE INDEX IF NOT EXISTS records_parent_category_active_idx
            ON records(parent_category_id_snapshot, occurred_local DESC) WHERE deleted_at IS NULL;
          CREATE INDEX IF NOT EXISTS records_order_active_idx
            ON records(occurred_local DESC, created_at DESC, id DESC) WHERE deleted_at IS NULL;
          CREATE INDEX IF NOT EXISTS entry_templates_order_idx
            ON entry_templates(sort_order, name);

          INSERT INTO app_meta(key, value, updated_at)
            VALUES ('schema_version', '3', CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
        "#,
        },
    ]
}

fn allowed_export_path(path: &str) -> Result<(), String> {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    match extension.as_deref() {
        Some("json") | Some("csv") => Ok(()),
        _ => Err("只能导入或导出 JSON / CSV 文件".into()),
    }
}

fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "文件路径无效".to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let temporary = path.with_file_name(format!(".{file_name}.{}-{stamp}.tmp", std::process::id()));
    let previous = path.with_file_name(format!(".{file_name}.{}-{stamp}.bak", std::process::id()));
    fs::write(&temporary, contents).map_err(|error| format!("写入临时文件失败：{error}"))?;
    if path.exists() {
        if let Err(error) = fs::rename(path, &previous) {
            let _ = fs::remove_file(&temporary);
            return Err(format!("暂存原文件失败：{error}"));
        }
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        if previous.exists() {
            let _ = fs::rename(&previous, path);
        }
        return Err(format!("完成文件替换失败：{error}"));
    }
    let _ = fs::remove_file(&previous);
    Ok(())
}

fn database_error(error: sqlx::Error) -> String {
    format!("保存失败：数据库操作失败：{error}")
}

async fn save_record_on_connection(
    connection: &mut SqliteConnection,
    request: SaveRecordRequest,
) -> Result<SaveRecordResponse, String> {
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(database_error)?;

    let result = async {
        let merchant_id = if request.merchant_name.is_empty() {
            None
        } else {
            if request.merchant_normalized_name.is_empty() {
                return Err("保存失败：地点名称无效".to_string());
            }
            let existing_merchant = sqlx::query(
                "SELECT id FROM merchants WHERE category_id = ? AND normalized_name = ?",
            )
            .bind(&request.category_id)
            .bind(&request.merchant_normalized_name)
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?;

            if let Some(row) = existing_merchant {
                let merchant_id: String = row.try_get("id").map_err(database_error)?;
                sqlx::query(
                    "UPDATE merchants SET name = ?, hidden_at = NULL, updated_at = ? WHERE id = ?",
                )
                .bind(&request.merchant_name)
                .bind(&request.updated_at)
                .bind(&merchant_id)
                .execute(&mut *connection)
                .await
                .map_err(database_error)?;
                Some(merchant_id)
            } else {
                let merchant_id = request
                    .merchant_id_candidate
                    .clone()
                    .ok_or_else(|| "保存失败：地点 ID 缺失".to_string())?;
                sqlx::query(
                    "INSERT INTO merchants (id, category_id, name, normalized_name, hidden_at, created_at, updated_at)
                     VALUES (?, ?, ?, ?, NULL, ?, ?)",
                )
                .bind(&merchant_id)
                .bind(&request.category_id)
                .bind(&request.merchant_name)
                .bind(&request.merchant_normalized_name)
                .bind(&request.created_at)
                .bind(&request.updated_at)
                .execute(&mut *connection)
                .await
                .map_err(database_error)?;
                Some(merchant_id)
            }
        };

        if request.editing {
            let update = sqlx::query(
                "UPDATE records SET category_id = ?, category_name_snapshot = ?, parent_category_id_snapshot = ?,
                 parent_category_name_snapshot = ?, amount_fen = ?, merchant_id = ?, merchant_name = ?, remark = ?,
                 occurred_local = ?, date_key = ?, month_key = ?, updated_at = ?
                 WHERE id = ? AND deleted_at IS NULL",
            )
            .bind(&request.category_id)
            .bind(&request.category_name_snapshot)
            .bind(&request.parent_category_id_snapshot)
            .bind(&request.parent_category_name_snapshot)
            .bind(request.amount_fen)
            .bind(&merchant_id)
            .bind(&request.merchant_name)
            .bind(&request.remark)
            .bind(&request.occurred_local)
            .bind(&request.date_key)
            .bind(&request.month_key)
            .bind(&request.updated_at)
            .bind(&request.id)
            .execute(&mut *connection)
            .await
            .map_err(database_error)?;
            if update.rows_affected() != 1 {
                return Err("记录不存在或已删除".to_string());
            }
        } else {
            sqlx::query(
                "INSERT INTO records
                  (id, category_id, category_name_snapshot, parent_category_id_snapshot, parent_category_name_snapshot,
                   amount_fen, merchant_id, merchant_name, remark, occurred_local, date_key, month_key, created_at, updated_at, deleted_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
            )
            .bind(&request.id)
            .bind(&request.category_id)
            .bind(&request.category_name_snapshot)
            .bind(&request.parent_category_id_snapshot)
            .bind(&request.parent_category_name_snapshot)
            .bind(request.amount_fen)
            .bind(&merchant_id)
            .bind(&request.merchant_name)
            .bind(&request.remark)
            .bind(&request.occurred_local)
            .bind(&request.date_key)
            .bind(&request.month_key)
            .bind(&request.created_at)
            .bind(&request.updated_at)
            .execute(&mut *connection)
            .await
            .map_err(database_error)?;
        }

        Ok(SaveRecordResponse {
            record_id: request.id,
            merchant_id,
            saved: true,
        })
    }
    .await;

    match result {
        Ok(response) => match sqlx::query("COMMIT").execute(&mut *connection).await {
            Ok(_) => Ok(response),
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                Err(database_error(error))
            }
        },
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

#[tauri::command]
async fn save_record_atomic(
    app: tauri::AppHandle,
    writer: State<'_, LedgerWriterLock>,
    request: SaveRecordRequest,
) -> Result<SaveRecordResponse, String> {
    let _guard = writer.0.lock().await;
    let database_path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法解析账本数据库目录：{error}"))?
        .join("lq-ledger.db");
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(3));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(database_error)?;
    let result = save_record_on_connection(&mut connection, request).await;
    let _ = connection.close().await;
    result
}

#[tauri::command]
fn write_export_file(path: String, contents: String) -> Result<(), String> {
    allowed_export_path(&path)?;
    atomic_write(Path::new(&path), &contents).map_err(|error| format!("写入文件失败：{error}"))
}

#[tauri::command]
fn read_import_file(path: String) -> Result<String, String> {
    allowed_export_path(&path)?;
    let metadata = fs::metadata(&path).map_err(|error| format!("读取文件失败：{error}"))?;
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err("导入文件超过 100 MB 限制".into());
    }
    fs::read_to_string(path).map_err(|error| format!("读取文本失败：{error}"))
}

#[tauri::command]
fn write_pre_import_backup(app: tauri::AppHandle, contents: String) -> Result<String, String> {
    let backup_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法解析应用数据目录：{error}"))?
        .join("pre-import-backups");
    fs::create_dir_all(&backup_dir).map_err(|error| format!("无法创建自动备份目录：{error}"))?;
    let filename = format!(
        "before-import-{}.json",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| format!("无法生成备份文件名：{error}"))?
            .as_millis()
    );
    let path = backup_dir.join(filename);
    atomic_write(&path, &contents).map_err(|error| format!("无法写入导入前备份：{error}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn list_pre_import_backups(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let backup_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法解析应用数据目录：{error}"))?
        .join("pre-import-backups");
    if !backup_dir.exists() {
        return Ok(Vec::new());
    }
    let mut names = fs::read_dir(&backup_dir)
        .map_err(|error| format!("无法读取自动备份目录：{error}"))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                return None;
            }
            path.file_name()
                .and_then(|value| value.to_str())
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();
    names.sort_by(|left, right| right.cmp(left));
    names.truncate(20);
    Ok(names)
}

#[tauri::command]
fn write_rolling_backup(
    directory: String,
    contents: String,
    keep: usize,
    date_key: String,
) -> Result<String, String> {
    let backup_dir = Path::new(&directory);
    if !backup_dir.is_dir() {
        return Err("自动备份目录不存在或不可用".into());
    }
    let bytes = date_key.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| index != 4 && index != 7 && !byte.is_ascii_digit())
    {
        return Err("自动备份日期无效".into());
    }
    let filename = format!("L.Q记账-每日备份-{date_key}.json");
    let path = backup_dir.join(filename);
    atomic_write(&path, &contents).map_err(|error| format!("自动备份失败：{error}"))?;

    let mut backups = fs::read_dir(backup_dir)
        .map_err(|error| format!("无法读取自动备份目录：{error}"))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .map(|name| name.starts_with("L.Q记账-每日备份-") && name.ends_with(".json"))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    backups.sort_by_key(|entry| std::cmp::Reverse(entry.file_name()));
    for entry in backups.into_iter().skip(keep.clamp(1, 365)) {
        let _ = fs::remove_file(entry.path());
    }
    Ok(path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(LedgerWriterLock(Mutex::new(())))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:lq-ledger.db", migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            save_record_atomic,
            write_export_file,
            read_import_file,
            write_pre_import_backup,
            list_pre_import_backups,
            write_rolling_backup
        ])
        .run(tauri::generate_context!())
        .expect("error while running L.Q记账");
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_database() -> SqliteConnection {
        let mut connection = SqliteConnection::connect("sqlite::memory:")
            .await
            .expect("in-memory SQLite should open");
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&mut connection)
            .await
            .expect("foreign keys should enable");
        sqlx::query(
            "CREATE TABLE merchants (
                id TEXT PRIMARY KEY NOT NULL,
                category_id TEXT NOT NULL,
                name TEXT NOT NULL,
                normalized_name TEXT NOT NULL,
                hidden_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(category_id, normalized_name)
            )",
        )
        .execute(&mut connection)
        .await
        .expect("merchant table should create");
        sqlx::query(
            "CREATE TABLE records (
                id TEXT PRIMARY KEY NOT NULL,
                category_id TEXT NOT NULL,
                category_name_snapshot TEXT NOT NULL,
                parent_category_id_snapshot TEXT NOT NULL,
                parent_category_name_snapshot TEXT NOT NULL,
                amount_fen INTEGER NOT NULL CHECK(amount_fen > 0),
                merchant_id TEXT REFERENCES merchants(id),
                merchant_name TEXT NOT NULL,
                remark TEXT NOT NULL,
                occurred_local TEXT NOT NULL,
                date_key TEXT NOT NULL,
                month_key TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT
            )",
        )
        .execute(&mut connection)
        .await
        .expect("record table should create");
        connection
    }

    fn request(
        id: &str,
        editing: bool,
        amount_fen: i64,
        merchant_id_candidate: Option<&str>,
        merchant_name: &str,
    ) -> SaveRecordRequest {
        SaveRecordRequest {
            id: id.to_string(),
            editing,
            category_id: "leaf".to_string(),
            category_name_snapshot: "早餐".to_string(),
            parent_category_id_snapshot: "root".to_string(),
            parent_category_name_snapshot: "餐饮".to_string(),
            amount_fen,
            merchant_id_candidate: merchant_id_candidate.map(str::to_owned),
            merchant_name: merchant_name.to_string(),
            merchant_normalized_name: merchant_name.to_string(),
            remark: "豆浆".to_string(),
            occurred_local: "2026-09-01T08:00".to_string(),
            date_key: "2026-09-01".to_string(),
            month_key: "2026-09".to_string(),
            created_at: "2026-09-01T08:00:00.000Z".to_string(),
            updated_at: "2026-09-01T08:01:00.000Z".to_string(),
        }
    }

    #[tokio::test]
    async fn atomic_save_inserts_record_and_merchant_on_one_connection() {
        let mut connection = test_database().await;
        let response = save_record_on_connection(
            &mut connection,
            request("record-1", false, 650, Some("merchant-1"), "食堂"),
        )
        .await
        .expect("record should save");

        assert!(response.saved);
        assert_eq!(response.record_id, "record-1");
        assert_eq!(response.merchant_id.as_deref(), Some("merchant-1"));
        let records: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM records")
            .fetch_one(&mut connection)
            .await
            .expect("record count should query");
        let merchants: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM merchants")
            .fetch_one(&mut connection)
            .await
            .expect("merchant count should query");
        assert_eq!(records, 1);
        assert_eq!(merchants, 1);
    }

    #[tokio::test]
    async fn atomic_save_reuses_merchant_and_updates_record() {
        let mut connection = test_database().await;
        save_record_on_connection(
            &mut connection,
            request("record-1", false, 650, Some("merchant-1"), "食堂"),
        )
        .await
        .expect("initial record should save");

        let response = save_record_on_connection(
            &mut connection,
            request("record-1", true, 800, Some("merchant-2"), "食堂"),
        )
        .await
        .expect("record edit should save");

        assert_eq!(response.merchant_id.as_deref(), Some("merchant-1"));
        let amount: i64 =
            sqlx::query_scalar("SELECT amount_fen FROM records WHERE id = 'record-1'")
                .fetch_one(&mut connection)
                .await
                .expect("updated amount should query");
        let merchants: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM merchants")
            .fetch_one(&mut connection)
            .await
            .expect("merchant count should query");
        assert_eq!(amount, 800);
        assert_eq!(merchants, 1);
    }

    #[tokio::test]
    async fn atomic_save_rolls_back_merchant_when_record_constraint_fails() {
        let mut connection = test_database().await;
        let result = save_record_on_connection(
            &mut connection,
            request(
                "record-fails",
                false,
                -1,
                Some("merchant-fails"),
                "回滚地点",
            ),
        )
        .await;

        assert!(result.is_err());
        let records: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM records")
            .fetch_one(&mut connection)
            .await
            .expect("record count should query");
        let merchants: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM merchants")
            .fetch_one(&mut connection)
            .await
            .expect("merchant count should query");
        assert_eq!(records, 0);
        assert_eq!(merchants, 0);
    }
}
