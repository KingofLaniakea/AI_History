use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use chrono::Utc;
use reqwest::blocking::Client as BlockingHttpClient;
use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::models::{
    Attachment, Conversation, ConversationDetail, ConversationSummary, Folder, ImportBatch,
    ImportResult, ListConversationsInput, LiveCaptureRequest, Message, NormalizedConversation,
    NormalizedTurn,
    SearchResult,
};

#[derive(Clone)]
pub struct Database {
    db_path: PathBuf,
}

const UNCATEGORIZED_FOLDER_ID: &str = "uncategorized";
const UNCATEGORIZED_FOLDER_NAME: &str = "未分类";

impl Database {
    pub fn new(db_path: PathBuf) -> Result<Self, String> {
        let db = Self { db_path };
        db.migrate()?;
        Ok(db)
    }

    pub fn path(&self) -> &Path {
        &self.db_path
    }

    fn open(&self) -> Result<Connection, String> {
        Connection::open(&self.db_path).map_err(|e| format!("open db failed: {e}"))
    }

    fn migrate(&self) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS folders (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              parent_id TEXT,
              sort_order INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(parent_id) REFERENCES folders(id)
            );

            CREATE TABLE IF NOT EXISTS conversations (
              id TEXT PRIMARY KEY,
              source TEXT NOT NULL,
              source_conversation_id TEXT,
              folder_id TEXT,
              title TEXT NOT NULL,
              summary TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              fingerprint TEXT NOT NULL,
              meta_json TEXT NOT NULL,
              FOREIGN KEY(folder_id) REFERENCES folders(id)
            );

            CREATE TABLE IF NOT EXISTS messages (
              id TEXT PRIMARY KEY,
              conversation_id TEXT NOT NULL,
              seq INTEGER NOT NULL,
              role TEXT NOT NULL,
              content_markdown TEXT NOT NULL,
              thought_markdown TEXT,
              model TEXT,
              timestamp TEXT,
              token_count INTEGER,
              FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS tags (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL UNIQUE
            );

            CREATE TABLE IF NOT EXISTS conversation_tags (
              conversation_id TEXT NOT NULL,
              tag_id TEXT NOT NULL,
              PRIMARY KEY (conversation_id, tag_id),
              FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
              FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS imports (
              id TEXT PRIMARY KEY,
              source TEXT NOT NULL,
              imported_count INTEGER NOT NULL,
              skipped_count INTEGER NOT NULL,
              conflict_count INTEGER NOT NULL,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS source_profiles (
              id TEXT PRIMARY KEY,
              source TEXT NOT NULL,
              profile_name TEXT NOT NULL,
              profile_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS attachments (
              id TEXT PRIMARY KEY,
              message_id TEXT NOT NULL,
              conversation_id TEXT NOT NULL,
              kind TEXT NOT NULL,
              original_url TEXT NOT NULL,
              local_path TEXT,
              mime TEXT,
              size_bytes INTEGER,
              sha256 TEXT,
              status TEXT NOT NULL,
              error TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
              FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at);
            CREATE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages(conversation_id, seq);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_fingerprint ON conversations(fingerprint);
            CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);
            CREATE INDEX IF NOT EXISTS idx_attachments_conv_id ON attachments(conversation_id);
            CREATE INDEX IF NOT EXISTS idx_attachments_sha256 ON attachments(sha256);

            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
              message_id UNINDEXED,
              conversation_id UNINDEXED,
              content_markdown
            );
            "#,
        )
        .map_err(|e| format!("migrate failed: {e}"))?;

        // Backward-compatible column migration for existing installs.
        let _ = conn.execute("ALTER TABLE messages ADD COLUMN thought_markdown TEXT", []);
        self.ensure_system_folders(&conn)?;

        Ok(())
    }

    fn ensure_system_folders(&self, conn: &Connection) -> Result<(), String> {
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM folders WHERE id = ?1 LIMIT 1",
                params![UNCATEGORIZED_FOLDER_ID],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        if existing.is_some() {
            return Ok(());
        }

        let sort_order: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM folders WHERE parent_id IS NULL",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let now = now_iso();
        conn.execute(
            r#"
            INSERT INTO folders (id, name, parent_id, sort_order, created_at, updated_at)
            VALUES (?1, ?2, NULL, ?3, ?4, ?5)
            "#,
            params![
                UNCATEGORIZED_FOLDER_ID,
                UNCATEGORIZED_FOLDER_NAME,
                sort_order,
                now.clone(),
                now
            ],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn list_folders(&self) -> Result<Vec<Folder>, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, name, parent_id, sort_order, created_at, updated_at
                FROM folders
                ORDER BY sort_order ASC, created_at ASC
                "#,
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok(Folder {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    parent_id: row.get(2)?,
                    sort_order: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut folders = Vec::new();
        for row in rows {
            folders.push(row.map_err(|e| e.to_string())?);
        }
        Ok(folders)
    }

    pub fn create_folder(&self, name: String, parent_id: Option<String>) -> Result<Folder, String> {
        let conn = self.open()?;
        self.ensure_system_folders(&conn)?;
        let now = now_iso();
        let id = Uuid::new_v4().to_string();

        let sort_order: i64 = if parent_id.is_some() {
            conn.query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM folders WHERE parent_id = ?1",
                params![parent_id.clone()],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?
        } else {
            conn.query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM folders WHERE parent_id IS NULL",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?
        };

        conn.execute(
            r#"
            INSERT INTO folders (id, name, parent_id, sort_order, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
            params![id, name, parent_id, sort_order, now, now],
        )
        .map_err(|e| e.to_string())?;

        Ok(Folder {
            id,
            name,
            parent_id,
            sort_order,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn move_folder(&self, id: String, parent_id: Option<String>) -> Result<(), String> {
        if id == UNCATEGORIZED_FOLDER_ID {
            return Err("未分类文件夹不可移动".to_string());
        }
        let conn = self.open()?;
        conn.execute(
            "UPDATE folders SET parent_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![parent_id, now_iso(), id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_folder(&self, id: String) -> Result<(), String> {
        if id == UNCATEGORIZED_FOLDER_ID {
            return Err("未分类文件夹不可删除".to_string());
        }
        let conn = self.open()?;
        self.ensure_system_folders(&conn)?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

        tx.execute(
            "UPDATE folders SET parent_id = NULL, updated_at = ?1 WHERE parent_id = ?2",
            params![now_iso(), id.clone()],
        )
        .map_err(|e| e.to_string())?;

        tx.execute(
            "UPDATE conversations SET folder_id = ?1, updated_at = ?2 WHERE folder_id = ?3",
            params![UNCATEGORIZED_FOLDER_ID, now_iso(), id.clone()],
        )
        .map_err(|e| e.to_string())?;

        tx.execute("DELETE FROM folders WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;

        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn move_conversation(&self, id: String, folder_id: Option<String>) -> Result<(), String> {
        let conn = self.open()?;
        self.ensure_system_folders(&conn)?;
        let normalized_folder = folder_id.or_else(|| Some(UNCATEGORIZED_FOLDER_ID.to_string()));
        conn.execute(
            "UPDATE conversations SET folder_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![normalized_folder, now_iso(), id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_conversations(
        &self,
        input: Option<ListConversationsInput>,
    ) -> Result<Vec<ConversationSummary>, String> {
        let conn = self.open()?;
        self.ensure_system_folders(&conn)?;
        let mut sql = String::from(
            r#"
            SELECT
              c.id,
              c.source,
              c.source_conversation_id,
              c.folder_id,
              c.title,
              c.summary,
              c.created_at,
              c.updated_at,
              c.fingerprint,
              c.meta_json,
              COUNT(m.id) as message_count
            FROM conversations c
            LEFT JOIN messages m ON m.conversation_id = c.id
            WHERE 1 = 1
            "#,
        );

        let mut values: Vec<Value> = Vec::new();
        if let Some(i) = input {
            if let Some(folder_id) = i.folder_id {
                if folder_id == UNCATEGORIZED_FOLDER_ID {
                    sql.push_str(" AND (c.folder_id = ? OR c.folder_id IS NULL) ");
                    values.push(Value::Text(folder_id));
                } else {
                    sql.push_str(" AND c.folder_id = ? ");
                    values.push(Value::Text(folder_id));
                }
            }

            if let Some(source) = i.source {
                if source != "all" {
                    sql.push_str(" AND c.source = ? ");
                    values.push(Value::Text(source));
                }
            }
        }

        sql.push_str(" GROUP BY c.id ORDER BY c.created_at DESC ");

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params_from_iter(values.iter()), |row| {
                let conv = row_to_conversation(row)?;
                Ok(ConversationSummary {
                    conversation: conv,
                    message_count: row.get(10)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut list = Vec::new();
        for row in rows {
            list.push(row.map_err(|e| e.to_string())?);
        }

        Ok(list)
    }

    pub fn open_conversation(&self, id: String) -> Result<Option<ConversationDetail>, String> {
        let conn = self.open()?;

        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, source, source_conversation_id, folder_id, title, summary, created_at, updated_at, fingerprint, meta_json
                FROM conversations
                WHERE id = ?1
                LIMIT 1
                "#,
            )
            .map_err(|e| e.to_string())?;

        let mut rows = stmt.query(params![id]).map_err(|e| e.to_string())?;
        let Some(row) = rows.next().map_err(|e| e.to_string())? else {
            return Ok(None);
        };

        let conversation = Conversation {
            id: row.get(0).map_err(|e| e.to_string())?,
            source: row.get(1).map_err(|e| e.to_string())?,
            source_conversation_id: row.get(2).map_err(|e| e.to_string())?,
            folder_id: row.get(3).map_err(|e| e.to_string())?,
            title: row.get(4).map_err(|e| e.to_string())?,
            summary: row.get(5).map_err(|e| e.to_string())?,
            created_at: row.get(6).map_err(|e| e.to_string())?,
            updated_at: row.get(7).map_err(|e| e.to_string())?,
            fingerprint: row.get(8).map_err(|e| e.to_string())?,
            meta_json: row.get(9).map_err(|e| e.to_string())?,
        };
        self.promote_attachment_kinds(&conversation.id)?;

        let mut message_stmt = conn
            .prepare(
                r#"
                SELECT id, conversation_id, seq, role, content_markdown, thought_markdown, model, timestamp, token_count
                FROM messages
                WHERE conversation_id = ?1
                ORDER BY seq ASC
                "#,
            )
            .map_err(|e| e.to_string())?;

        let message_rows = message_stmt
            .query_map(params![conversation.id.clone()], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    seq: row.get(2)?,
                    role: row.get(3)?,
                    content_markdown: row.get(4)?,
                    thought_markdown: row.get(5)?,
                    model: row.get(6)?,
                    timestamp: row.get(7)?,
                    token_count: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut messages = Vec::new();
        for row in message_rows {
            messages.push(row.map_err(|e| e.to_string())?);
        }

        let mut tag_stmt = conn
            .prepare(
                r#"
                SELECT t.name
                FROM tags t
                JOIN conversation_tags ct ON ct.tag_id = t.id
                WHERE ct.conversation_id = ?1
                ORDER BY t.name ASC
                "#,
            )
            .map_err(|e| e.to_string())?;

        let tag_rows = tag_stmt
            .query_map(params![conversation.id.clone()], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;

        let mut tags = Vec::new();
        for tag in tag_rows {
            tags.push(tag.map_err(|e| e.to_string())?);
        }

        let mut attachment_stmt = conn
            .prepare(
                r#"
                SELECT id, message_id, conversation_id, kind, original_url, local_path, mime, size_bytes, sha256, status, error, created_at
                FROM attachments
                WHERE conversation_id = ?1
                ORDER BY created_at ASC
                "#,
            )
            .map_err(|e| e.to_string())?;

        let attachment_rows = attachment_stmt
            .query_map(params![conversation.id.clone()], |row| {
                Ok(crate::models::Attachment {
                    id: row.get(0)?,
                    message_id: row.get(1)?,
                    conversation_id: row.get(2)?,
                    kind: row.get(3)?,
                    original_url: row.get(4)?,
                    local_path: row.get(5)?,
                    mime: row.get(6)?,
                    size_bytes: row.get(7)?,
                    sha256: row.get(8)?,
                    status: row.get(9)?,
                    error: row.get(10)?,
                    created_at: row.get(11)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut attachments = Vec::new();
        for row in attachment_rows {
            attachments.push(row.map_err(|e| e.to_string())?);
        }
        append_virtual_named_attachments(
            &conversation.id,
            &conversation.updated_at,
            &messages,
            &mut attachments,
        );

        let needs_attachment_cache = attachments
            .iter()
            .any(|attachment| {
                ((attachment.status == "remote_only" || attachment.status == "failed")
                    && !looks_like_cloud_drive_file_url(&attachment.original_url)
                    && !is_virtual_attachment_url(&attachment.original_url))
                    || (attachment.status == "cached"
                        && attachment.local_path.is_none()
                        && is_data_url(&attachment.original_url))
            });
        if needs_attachment_cache {
            self.schedule_attachment_cache(conversation.id.clone());
        }

        Ok(Some(ConversationDetail {
            conversation,
            messages,
            tags,
            attachments,
        }))
    }

    fn promote_attachment_kinds(&self, conversation_id: &str) -> Result<(), String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, original_url, mime
                FROM attachments
                WHERE conversation_id = ?1 AND kind = 'file'
                "#,
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![conversation_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut updates: Vec<(String, String, Option<String>)> = Vec::new();
        for row in rows {
            let (id, original_url, mime) = row.map_err(|e| e.to_string())?;
            let normalized_url = normalize_attachment_url(&original_url);
            if normalized_url.is_empty() {
                continue;
            }

            let kind = classify_attachment_kind("file", &normalized_url, mime.as_deref());
            if kind == "image" || kind == "pdf" {
                updates.push((
                    id,
                    kind,
                    mime.or_else(|| infer_attachment_mime(&normalized_url)),
                ));
            }
        }
        drop(stmt);

        for (id, kind, mime) in updates {
            conn.execute(
                "UPDATE attachments SET kind = ?1, mime = COALESCE(?2, mime) WHERE id = ?3",
                params![kind, mime, id],
            )
            .map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    pub fn search_conversations(&self, query: String) -> Result<Vec<SearchResult>, String> {
        let conn = self.open()?;
        let trimmed = query.trim().to_string();
        if trimmed.is_empty() {
            return Ok(vec![]);
        }

        let escaped = trimmed.replace('"', " ").replace('\'', " ");
        let fts_query = format!("\"{}\"", escaped);

        let mut results_map: HashMap<String, SearchResult> = HashMap::new();

        let mut fts_stmt = conn
            .prepare(
                r#"
                SELECT
                  c.id,
                  c.source,
                  c.source_conversation_id,
                  c.folder_id,
                  c.title,
                  c.summary,
                  c.created_at,
                  c.updated_at,
                  c.fingerprint,
                  c.meta_json,
                  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
                  snippet(messages_fts, 2, '[', ']', '…', 12) as snippet
                FROM messages_fts
                JOIN conversations c ON c.id = messages_fts.conversation_id
                WHERE messages_fts MATCH ?1
                GROUP BY c.id
                ORDER BY c.updated_at DESC
                LIMIT 100
                "#,
            )
            .map_err(|e| e.to_string())?;

        let fts_rows = fts_stmt
            .query_map(params![fts_query], |row| {
                let summary = ConversationSummary {
                    conversation: Conversation {
                        id: row.get(0)?,
                        source: row.get(1)?,
                        source_conversation_id: row.get(2)?,
                        folder_id: row.get(3)?,
                        title: row.get(4)?,
                        summary: row.get(5)?,
                        created_at: row.get(6)?,
                        updated_at: row.get(7)?,
                        fingerprint: row.get(8)?,
                        meta_json: row.get(9)?,
                    },
                    message_count: row.get(10)?,
                };

                Ok(SearchResult {
                    conversation: summary,
                    snippet: row.get(11)?,
                })
            })
            .map_err(|e| e.to_string())?;

        for row in fts_rows {
            let result = row.map_err(|e| e.to_string())?;
            results_map.insert(result.conversation.conversation.id.clone(), result);
        }

        let like_query = format!("%{}%", trimmed);
        let mut title_stmt = conn
            .prepare(
                r#"
                SELECT
                  c.id,
                  c.source,
                  c.source_conversation_id,
                  c.folder_id,
                  c.title,
                  c.summary,
                  c.created_at,
                  c.updated_at,
                  c.fingerprint,
                  c.meta_json,
                  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
                FROM conversations c
                WHERE c.title LIKE ?1
                ORDER BY c.updated_at DESC
                LIMIT 50
                "#,
            )
            .map_err(|e| e.to_string())?;

        let title_rows = title_stmt
            .query_map(params![like_query], |row| {
                Ok(ConversationSummary {
                    conversation: Conversation {
                        id: row.get(0)?,
                        source: row.get(1)?,
                        source_conversation_id: row.get(2)?,
                        folder_id: row.get(3)?,
                        title: row.get(4)?,
                        summary: row.get(5)?,
                        created_at: row.get(6)?,
                        updated_at: row.get(7)?,
                        fingerprint: row.get(8)?,
                        meta_json: row.get(9)?,
                    },
                    message_count: row.get(10)?,
                })
            })
            .map_err(|e| e.to_string())?;

        for row in title_rows {
            let summary = row.map_err(|e| e.to_string())?;
            results_map.entry(summary.conversation.id.clone()).or_insert(SearchResult {
                snippet: summary.conversation.title.clone(),
                conversation: summary,
            });
        }

        let mut results: Vec<SearchResult> = results_map.into_values().collect();
        results.sort_by(|a, b| b.conversation.conversation.updated_at.cmp(&a.conversation.conversation.updated_at));
        results.truncate(100);

        Ok(results)
    }

    pub fn import_files(&self, batch: ImportBatch) -> Result<ImportResult, String> {
        let conn = self.open()?;
        self.ensure_system_folders(&conn)?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

        let mut imported = 0_i64;
        let mut skipped = 0_i64;
        let mut conflicts = 0_i64;
        let mut imported_conversation_ids: Vec<String> = Vec::new();
        let target_folder_id = batch
            .folder_id
            .clone()
            .or_else(|| Some(UNCATEGORIZED_FOLDER_ID.to_string()));

        for conv in &batch.conversations {
            if conv.turns.is_empty() {
                continue;
            }

            let mut source_conversation_id = conv.source_conversation_id.clone();
            let mut fingerprint = compute_fingerprint(conv);
            let existing_by_source = if let Some(source_id) = source_conversation_id.as_ref() {
                find_existing_by_source_ref(&tx, &conv.source, source_id)?
            } else {
                None
            };

            if let Some((existing_id, _existing_title)) = existing_by_source {
                conflicts += 1;
                match batch.strategy.as_str() {
                    "skip" => {
                        skipped += 1;
                        continue;
                    }
                    "overwrite" => {
                        delete_conversation_for_overwrite(&tx, &existing_id)?;
                    }
                    "duplicate" => {
                        source_conversation_id = source_conversation_id
                            .map(|id| format!("{}#dup-{}", id, Uuid::new_v4()));
                        fingerprint = format!("{}-dup-{}", fingerprint, Uuid::new_v4());
                    }
                    _ => {
                        skipped += 1;
                        continue;
                    }
                }
            } else {
                let existing_by_fingerprint = find_existing_by_fingerprint(&tx, &fingerprint)?;
                if let Some((existing_id, _existing_title)) = existing_by_fingerprint {
                    conflicts += 1;
                    match batch.strategy.as_str() {
                        "skip" => {
                            skipped += 1;
                            continue;
                        }
                        "overwrite" => {
                            delete_conversation_for_overwrite(&tx, &existing_id)?;
                        }
                        "duplicate" => {
                            fingerprint = format!("{}-dup-{}", fingerprint, Uuid::new_v4());
                        }
                        _ => {
                            skipped += 1;
                            continue;
                        }
                    }
                }
            }

            let conversation_id = Uuid::new_v4().to_string();
            let created_at = now_iso();
            let updated_at = created_at.clone();
            let meta_json = conv
                .meta
                .clone()
                .unwrap_or_else(|| serde_json::json!({}))
                .to_string();

            tx.execute(
                r#"
                INSERT INTO conversations (
                    id, source, source_conversation_id, folder_id, title, summary,
                    created_at, updated_at, fingerprint, meta_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                "#,
                params![
                    conversation_id.clone(),
                    conv.source.clone(),
                    source_conversation_id,
                    target_folder_id.clone(),
                    conv.title.clone(),
                    conv.summary.clone(),
                    created_at,
                    updated_at,
                    fingerprint,
                    meta_json,
                ],
            )
            .map_err(|e| e.to_string())?;

            for (idx, turn) in conv.turns.iter().enumerate() {
                let msg_id = Uuid::new_v4().to_string();
                let seq = idx as i64;
                let thought_markdown = if conv.source == "gemini" {
                    None
                } else {
                    turn.thought_markdown.clone()
                };
                tx.execute(
                    r#"
                    INSERT INTO messages (
                      id, conversation_id, seq, role, content_markdown, thought_markdown, model, timestamp, token_count
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                    "#,
                    params![
                        msg_id,
                        conversation_id.clone(),
                        seq,
                        turn.role.clone(),
                        turn.content_markdown.clone(),
                        thought_markdown,
                        turn.model.clone(),
                        turn.timestamp.clone(),
                        turn.token_count,
                    ],
                )
                .map_err(|e| e.to_string())?;

                tx.execute(
                    "INSERT INTO messages_fts (message_id, conversation_id, content_markdown) VALUES (?1, ?2, ?3)",
                    params![msg_id.clone(), conversation_id.clone(), turn.content_markdown.clone()],
                )
                .map_err(|e| e.to_string())?;

                let mut seen_attachment_urls: HashSet<String> = HashSet::new();
                let mut has_non_virtual_attachment = false;
                if let Some(attachments) = turn.attachments.as_ref() {
                    for attachment in attachments {
                        let normalized_url = normalize_attachment_url(&attachment.original_url);
                        if normalized_url.is_empty() {
                            continue;
                        }
                        if is_navigation_url(&normalized_url) {
                            continue;
                        }
                        if !seen_attachment_urls.insert(normalized_url.clone()) {
                            continue;
                        }
                        if !is_virtual_attachment_url(&normalized_url) {
                            has_non_virtual_attachment = true;
                        }
                        let normalized_kind = classify_attachment_kind(
                            &attachment.kind,
                            &normalized_url,
                            attachment.mime.as_deref(),
                        );
                        if normalized_kind == "file" && !looks_like_file_url(&normalized_url) {
                            continue;
                        }

                        let status = attachment
                            .status
                            .as_ref()
                            .map(|s| s.as_str())
                            .unwrap_or("remote_only");

                        tx.execute(
                            r#"
                            INSERT INTO attachments (
                              id, message_id, conversation_id, kind, original_url, local_path,
                              mime, size_bytes, sha256, status, error, created_at
                            ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, NULL, NULL, ?7, NULL, ?8)
                            "#,
                            params![
                                Uuid::new_v4().to_string(),
                                msg_id.clone(),
                                conversation_id.clone(),
                                normalized_kind,
                                normalized_url,
                                attachment
                                    .mime
                                    .clone()
                                    .or_else(|| infer_attachment_mime(&normalized_url)),
                                status,
                                now_iso(),
                            ],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                }

                for (kind, url, mime) in extract_inline_attachments(&turn.content_markdown) {
                    if kind != "image" && kind != "pdf" && kind != "file" {
                        continue;
                    }
                    if !seen_attachment_urls.insert(url.clone()) {
                        continue;
                    }
                    if !is_virtual_attachment_url(&url) {
                        has_non_virtual_attachment = true;
                    }
                    tx.execute(
                        r#"
                        INSERT INTO attachments (
                          id, message_id, conversation_id, kind, original_url, local_path,
                          mime, size_bytes, sha256, status, error, created_at
                        ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, NULL, NULL, 'remote_only', NULL, ?7)
                        "#,
                        params![
                            Uuid::new_v4().to_string(),
                            msg_id.clone(),
                            conversation_id.clone(),
                            kind,
                            url,
                            mime,
                            now_iso(),
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                }

                if turn.role.eq_ignore_ascii_case("user") && !has_non_virtual_attachment {
                    for (kind, url, mime) in extract_named_file_attachments(&turn.content_markdown) {
                        if kind != "image" && kind != "pdf" && kind != "file" {
                            continue;
                        }
                        if !seen_attachment_urls.insert(url.clone()) {
                            continue;
                        }
                        tx.execute(
                            r#"
                            INSERT INTO attachments (
                              id, message_id, conversation_id, kind, original_url, local_path,
                              mime, size_bytes, sha256, status, error, created_at
                            ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, NULL, NULL, 'remote_only', NULL, ?7)
                            "#,
                            params![
                                Uuid::new_v4().to_string(),
                                msg_id.clone(),
                                conversation_id.clone(),
                                kind,
                                url,
                                mime,
                                now_iso(),
                            ],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                }
            }

            imported += 1;
            imported_conversation_ids.push(conversation_id);
        }

        tx.execute(
            "INSERT INTO imports (id, source, imported_count, skipped_count, conflict_count, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                Uuid::new_v4().to_string(),
                "batch",
                imported,
                skipped,
                conflicts,
                now_iso(),
            ],
        )
        .map_err(|e| e.to_string())?;

        tx.commit().map_err(|e| e.to_string())?;
        for conversation_id in imported_conversation_ids {
            self.schedule_attachment_cache(conversation_id);
        }

        Ok(ImportResult {
            imported,
            skipped,
            conflicts,
        })
    }

    pub fn import_live_capture(&self, request: LiveCaptureRequest) -> Result<ImportResult, String> {
        let LiveCaptureRequest {
            source,
            page_url,
            title,
            turns,
            captured_at,
            version,
        } = request;

        let canonical_page_url = canonicalize_source_url(&page_url);
        let sanitized_turns = sanitize_live_capture_turns(&source, turns);
        if sanitized_turns.is_empty() {
            return Err("未提取到有效会话内容".to_string());
        }

        let conv = NormalizedConversation {
            source: source.clone(),
            source_conversation_id: Some(canonical_page_url.clone()),
            title,
            summary: None,
            created_at: Some(captured_at.clone()),
            updated_at: Some(captured_at),
            turns: sanitized_turns,
            meta: Some(serde_json::json!({
                "capturedBy": "extension",
                "version": version
            })),
        };

        self.import_files(ImportBatch {
            conversations: vec![conv],
            strategy: "overwrite".to_string(),
            folder_id: None,
        })
    }

    pub fn list_conversation_attachments(
        &self,
        conversation_id: String,
    ) -> Result<Vec<Attachment>, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, message_id, conversation_id, kind, original_url, local_path, mime, size_bytes, sha256, status, error, created_at
                FROM attachments
                WHERE conversation_id = ?1
                ORDER BY created_at ASC
                "#,
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![conversation_id], |row| {
                Ok(Attachment {
                    id: row.get(0)?,
                    message_id: row.get(1)?,
                    conversation_id: row.get(2)?,
                    kind: row.get(3)?,
                    original_url: row.get(4)?,
                    local_path: row.get(5)?,
                    mime: row.get(6)?,
                    size_bytes: row.get(7)?,
                    sha256: row.get(8)?,
                    status: row.get(9)?,
                    error: row.get(10)?,
                    created_at: row.get(11)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|e| e.to_string())?);
        }

        let mut message_stmt = conn
            .prepare(
                r#"
                SELECT id, conversation_id, seq, role, content_markdown, thought_markdown, model, timestamp, token_count
                FROM messages
                WHERE conversation_id = ?1
                ORDER BY seq ASC
                "#,
            )
            .map_err(|e| e.to_string())?;
        let message_rows = message_stmt
            .query_map(params![conversation_id.clone()], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    seq: row.get(2)?,
                    role: row.get(3)?,
                    content_markdown: row.get(4)?,
                    thought_markdown: row.get(5)?,
                    model: row.get(6)?,
                    timestamp: row.get(7)?,
                    token_count: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut messages = Vec::new();
        for row in message_rows {
            messages.push(row.map_err(|e| e.to_string())?);
        }
        append_virtual_named_attachments(&conversation_id, &now_iso(), &messages, &mut items);

        Ok(items)
    }

    fn schedule_attachment_cache(&self, conversation_id: String) {
        let db = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(err) = db.cache_attachments_for_conversation(&conversation_id) {
                eprintln!(
                    "attachment cache background task failed: conversation_id={}, error={}",
                    conversation_id, err
                );
            }
        });
    }

    fn cache_attachments_for_conversation(&self, conversation_id: &str) -> Result<(), String> {
        let pending = {
            let conn = self.open()?;
            let mut stmt = conn
                .prepare(
                    r#"
                    SELECT a.id, a.kind, a.original_url, a.mime, c.source
                    FROM attachments a
                    JOIN conversations c ON c.id = a.conversation_id
                    WHERE a.conversation_id = ?1
                      AND (
                        a.status = 'remote_only'
                        OR a.status = 'failed'
                        OR (a.status = 'cached' AND a.local_path IS NULL AND a.original_url LIKE 'data:%')
                      )
                    ORDER BY a.created_at ASC
                    "#,
                )
                .map_err(|e| e.to_string())?;

            let rows = stmt
                .query_map(params![conversation_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                })
                .map_err(|e| e.to_string())?;

            let mut items = Vec::new();
            for row in rows {
                items.push(row.map_err(|e| e.to_string())?);
            }
            items
        };

        let assets_dir = self
            .db_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("assets");
        fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;

        let client = BlockingHttpClient::builder()
            .timeout(std::time::Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|e| e.to_string())?;

        for (attachment_id, kind, original_url, mime_hint, source) in pending {
            let normalized_url = normalize_attachment_url(&original_url);
            if normalized_url.is_empty() {
                self.mark_attachment_failed(&attachment_id, "invalid_url".to_string())?;
                continue;
            }
            if is_virtual_attachment_url(&normalized_url) {
                continue;
            }
            let current_kind = normalize_attachment_kind(&kind);
            if is_data_url(&normalized_url) {
                let Some((data_mime, bytes)) = decode_data_url(&normalized_url) else {
                    self.mark_attachment_failed(&attachment_id, "invalid_data_url".to_string())?;
                    continue;
                };
                if bytes.is_empty() {
                    self.mark_attachment_failed(&attachment_id, "empty_data_url".to_string())?;
                    continue;
                }

                let mut hasher = Sha256::new();
                hasher.update(&bytes);
                let sha = format!("{:x}", hasher.finalize());

                let mime = mime_hint.or(data_mime);
                let final_kind =
                    classify_attachment_kind(&current_kind, &normalized_url, mime.as_deref());
                let ext = infer_file_extension(&normalized_url, mime.as_deref());
                let file_name = if ext.is_empty() {
                    sha.clone()
                } else {
                    format!("{sha}.{ext}")
                };
                let file_path = assets_dir.join(file_name);
                if !file_path.exists() {
                    fs::write(&file_path, &bytes).map_err(|e| e.to_string())?;
                }

                let local_path = file_path.to_string_lossy().to_string();
                self.mark_attachment_cached(
                    &attachment_id,
                    local_path,
                    mime,
                    bytes.len() as i64,
                    sha,
                )?;
                if final_kind != current_kind {
                    self.update_attachment_kind(&attachment_id, final_kind)?;
                }
                continue;
            }
            let inferred_kind =
                classify_attachment_kind(&current_kind, &normalized_url, mime_hint.as_deref());
            let should_attempt_download = is_http_or_https_url(&normalized_url)
                && (inferred_kind != "file" || looks_like_file_url(&normalized_url));
            if (source == "gemini" || source == "ai_studio")
                && looks_like_cloud_drive_file_url(&normalized_url)
            {
                continue;
            }
            if !should_attempt_download {
                continue;
            }

            let response = match client
                .get(normalized_url.clone())
                .header(
                    reqwest::header::USER_AGENT,
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                )
                .header(reqwest::header::ACCEPT, "*/*")
                .send()
            {
                Ok(resp) => resp,
                Err(err) => {
                    self.mark_attachment_failed(&attachment_id, err.to_string())?;
                    continue;
                }
            };

            if !response.status().is_success() {
                self.mark_attachment_failed(
                    &attachment_id,
                    format!("http_status_{}", response.status().as_u16()),
                )?;
                continue;
            }

            let header_mime = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(|v| v.to_string());

            let bytes = match response.bytes() {
                Ok(bytes) => bytes,
                Err(err) => {
                    self.mark_attachment_failed(&attachment_id, err.to_string())?;
                    continue;
                }
            };

            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            let sha = format!("{:x}", hasher.finalize());

            let mime = header_mime.or(mime_hint);
            let final_kind =
                classify_attachment_kind(&current_kind, &normalized_url, mime.as_deref());
            let ext = infer_file_extension(&normalized_url, mime.as_deref());
            let file_name = if ext.is_empty() {
                sha.clone()
            } else {
                format!("{sha}.{ext}")
            };
            let file_path = assets_dir.join(file_name);
            if !file_path.exists() {
                fs::write(&file_path, &bytes).map_err(|e| e.to_string())?;
            }

            let local_path = file_path.to_string_lossy().to_string();
            self.mark_attachment_cached(
                &attachment_id,
                local_path,
                mime,
                bytes.len() as i64,
                sha,
            )?;
            if final_kind != current_kind {
                self.update_attachment_kind(&attachment_id, final_kind)?;
            }
        }

        Ok(())
    }

    fn mark_attachment_failed(&self, attachment_id: &str, error: String) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute(
            "UPDATE attachments SET status = 'failed', error = ?1 WHERE id = ?2",
            params![truncate_error(&error), attachment_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn mark_attachment_cached(
        &self,
        attachment_id: &str,
        local_path: String,
        mime: Option<String>,
        size_bytes: i64,
        sha256: String,
    ) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute(
            "UPDATE attachments SET status = 'cached', local_path = ?1, mime = ?2, size_bytes = ?3, sha256 = ?4, error = NULL WHERE id = ?5",
            params![local_path, mime, size_bytes, sha256, attachment_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn update_attachment_kind(&self, attachment_id: &str, kind: String) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute(
            "UPDATE attachments SET kind = ?1 WHERE id = ?2",
            params![kind, attachment_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn export_backup_zip(&self) -> Result<String, String> {
        let conn = self.open()?;
        let mut ids_stmt = conn
            .prepare("SELECT id FROM conversations ORDER BY updated_at DESC")
            .map_err(|e| e.to_string())?;

        let id_rows = ids_stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;

        let mut conversation_ids = Vec::new();
        for row in id_rows {
            conversation_ids.push(row.map_err(|e| e.to_string())?);
        }

        let mut conversations = Vec::new();
        for id in conversation_ids {
            if let Some(detail) = self.open_conversation(id)? {
                conversations.push(detail);
            }
        }

        let backup_json = serde_json::json!({
            "schema_version": 1,
            "generated_at": now_iso(),
            "conversations": conversations,
        });

        let backup_dir = self
            .db_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("backups");
        fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;

        let file_name = format!(
            "ai-history-backup-{}.zip",
            Utc::now().format("%Y%m%d-%H%M%S")
        );
        let backup_path = backup_dir.join(file_name);

        let file = File::create(&backup_path).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        zip.start_file("backup.jsonl", options)
            .map_err(|e| e.to_string())?;

        let mut lines = Vec::new();
        lines.push(
            serde_json::json!({
                "type": "meta",
                "schema_version": 1,
                "generated_at": now_iso()
            })
            .to_string(),
        );

        if let Some(items) = backup_json.get("conversations").and_then(|v| v.as_array()) {
            for item in items {
                lines.push(
                    serde_json::json!({
                        "type": "conversation",
                        "payload": item
                    })
                    .to_string(),
                );
            }
        }

        zip.write_all(lines.join("\n").as_bytes())
            .map_err(|e| e.to_string())?;
        zip.finish().map_err(|e| e.to_string())?;

        Ok(backup_path.to_string_lossy().to_string())
    }
}

fn row_to_conversation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: row.get(0)?,
        source: row.get(1)?,
        source_conversation_id: row.get(2)?,
        folder_id: row.get(3)?,
        title: row.get(4)?,
        summary: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        fingerprint: row.get(8)?,
        meta_json: row.get(9)?,
    })
}

fn find_existing_by_fingerprint(
    conn: &rusqlite::Transaction<'_>,
    fingerprint: &str,
) -> Result<Option<(String, String)>, String> {
    let mut stmt = conn
        .prepare("SELECT id, title FROM conversations WHERE fingerprint = ?1 LIMIT 1")
        .map_err(|e| e.to_string())?;

    let mut rows = stmt.query(params![fingerprint]).map_err(|e| e.to_string())?;
    let Some(row) = rows.next().map_err(|e| e.to_string())? else {
        return Ok(None);
    };

    let id: String = row.get(0).map_err(|e| e.to_string())?;
    let title: String = row.get(1).map_err(|e| e.to_string())?;
    Ok(Some((id, title)))
}

fn find_existing_by_source_ref(
    conn: &rusqlite::Transaction<'_>,
    source: &str,
    source_conversation_id: &str,
) -> Result<Option<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title FROM conversations WHERE source = ?1 AND source_conversation_id = ?2 ORDER BY updated_at DESC LIMIT 1",
        )
        .map_err(|e| e.to_string())?;

    let mut rows = stmt
        .query(params![source, source_conversation_id])
        .map_err(|e| e.to_string())?;
    let Some(row) = rows.next().map_err(|e| e.to_string())? else {
        return Ok(None);
    };

    let id: String = row.get(0).map_err(|e| e.to_string())?;
    let title: String = row.get(1).map_err(|e| e.to_string())?;
    Ok(Some((id, title)))
}

fn delete_conversation_for_overwrite(
    tx: &rusqlite::Transaction<'_>,
    conversation_id: &str,
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM messages_fts WHERE conversation_id = ?1",
        params![conversation_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM messages WHERE conversation_id = ?1",
        params![conversation_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM conversations WHERE id = ?1", params![conversation_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn compute_fingerprint(conv: &NormalizedConversation) -> String {
    let mut message_hashes: HashSet<String> = HashSet::new();
    for turn in &conv.turns {
        let mut hasher = Sha256::new();
        hasher.update(turn.role.as_bytes());
        hasher.update(turn.content_markdown.as_bytes());
        let digest = hasher.finalize();
        message_hashes.insert(format!("{:x}", digest));
    }

    let mut hashes_sorted: Vec<String> = message_hashes.into_iter().collect();
    hashes_sorted.sort();

    let mut hasher = Sha256::new();
    hasher.update(conv.source.as_bytes());
    hasher.update(conv.source_conversation_id.clone().unwrap_or_default().as_bytes());
    for hash in hashes_sorted {
        hasher.update(hash.as_bytes());
    }

    format!("{:x}", hasher.finalize())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn normalize_attachment_kind(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("pdf") {
        return "pdf".to_string();
    }
    if lower.contains("image") || lower.contains("img") {
        return "image".to_string();
    }
    "file".to_string()
}

fn classify_attachment_kind(raw_kind: &str, url: &str, mime: Option<&str>) -> String {
    let normalized = normalize_attachment_kind(raw_kind);
    if normalized == "image" {
        if looks_like_image_url(url)
            || mime
                .map(|value| value.to_lowercase().starts_with("image/"))
                .unwrap_or(false)
        {
            return "image".to_string();
        }
    }
    if normalized == "pdf" {
        if looks_like_pdf_url(url)
            || mime
                .map(|value| value.to_lowercase().contains("pdf"))
                .unwrap_or(false)
        {
            return "pdf".to_string();
        }
    }

    if let Some(raw_mime) = mime {
        let lower_mime = raw_mime.to_lowercase();
        if lower_mime.contains("pdf") {
            return "pdf".to_string();
        }
        if lower_mime.starts_with("image/") {
            return "image".to_string();
        }
    }

    if looks_like_image_url(url) {
        return "image".to_string();
    }
    if looks_like_pdf_url(url) {
        return "pdf".to_string();
    }
    "file".to_string()
}

fn normalize_attachment_url(url: &str) -> String {
    let trimmed = url.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() {
        return String::new();
    }

    if let Ok(parsed) = reqwest::Url::parse(trimmed) {
        if parsed.scheme() == "http"
            || parsed.scheme() == "https"
            || parsed.scheme() == "aihistory"
            || parsed.scheme() == "data"
        {
            return parsed.to_string();
        }
    }

    String::new()
}

fn canonicalize_source_url(raw: &str) -> String {
    let trimmed = raw.trim();
    let Ok(mut parsed) = reqwest::Url::parse(trimmed) else {
        return trimmed.to_string();
    };

    parsed.set_fragment(None);
    if let Some(host) = parsed.host_str() {
        if host.contains("chatgpt.com")
            || host.contains("gemini.google.com")
            || host.contains("bard.google.com")
            || host.contains("aistudio.google.com")
        {
            parsed.set_query(None);
        }
    }

    parsed.to_string()
}

fn normalize_markdown_text(raw: &str) -> String {
    let mut text = raw.replace("\r", "").replace('\u{00a0}', " ");
    text = text
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n")
        .replace("</p>", "\n")
        .replace("</div>", "\n");

    let mut lines = Vec::new();
    let mut seen_content = false;
    for line in text.lines() {
        let right_trimmed = line.trim_end();
        let marker_check = right_trimmed.trim();
        if marker_check.is_empty() {
            lines.push(String::new());
            continue;
        }

        let lower = marker_check.to_lowercase();
        let noisy = [
            "more_vert",
            "chevron_right",
            "chevron_left",
            "expand_more",
            "model thoughts",
            "skip to main content",
        ]
        .iter()
        .any(|marker| lower == *marker || lower.starts_with(&format!("{marker} ")));
        if noisy {
            continue;
        }
        if !seen_content && is_gemini_ui_prefix_line(marker_check) {
            continue;
        }

        lines.push(right_trimmed.to_string());
        seen_content = true;
    }

    let mut collapsed = Vec::new();
    let mut last_empty = false;
    for line in lines {
        if line.is_empty() {
            if !last_empty {
                collapsed.push(line);
            }
            last_empty = true;
        } else {
            collapsed.push(line);
            last_empty = false;
        }
    }

    collapsed.join("\n").trim().to_string()
}

const GEMINI_BOILERPLATE_MARKERS: [&str; 7] = [
    "如果你想让我保存或删除我们对话中关于你的信息",
    "你需要先开启过往对话记录",
    "你也可以手动添加或更新你给gemini的指令",
    "从而定制gemini的回复",
    "ifyouwantmetosaveordeleteinformationfromourconversations",
    "youneedtoturnonchathistory",
    "youcanalsomanuallyaddorupdateyourinstructionsforgemini",
];

fn normalize_for_gemini_filter(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn normalize_for_prefix_match(text: &str) -> String {
    text.trim()
        .trim_end_matches(':')
        .trim_end_matches('：')
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn is_gemini_ui_prefix_line(line: &str) -> bool {
    let compact = normalize_for_prefix_match(line);
    compact == "yousaid"
        || compact == "geminisaid"
        || compact.starts_with("显示思路id_")
        || compact.starts_with("显示思路id")
}

fn strip_gemini_ui_prefixes(text: &str) -> String {
    let mut seen_content = false;
    let mut kept: Vec<&str> = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if !seen_content {
            if trimmed.is_empty() {
                continue;
            }
            if is_gemini_ui_prefix_line(trimmed) {
                continue;
            }
            seen_content = true;
        }
        kept.push(line);
    }

    kept.join("\n").trim().to_string()
}

fn strip_gemini_boilerplate(text: &str) -> String {
    let mut kept = Vec::new();
    for paragraph in text.split("\n\n") {
        let normalized = normalize_for_gemini_filter(paragraph);
        if normalized.is_empty() {
            continue;
        }
        let is_boilerplate = GEMINI_BOILERPLATE_MARKERS
            .iter()
            .any(|marker| normalized.contains(marker));
        if !is_boilerplate {
            kept.push(paragraph.trim().to_string());
        }
    }
    kept.join("\n\n")
}

fn sanitize_live_capture_turns(source: &str, turns: Vec<NormalizedTurn>) -> Vec<NormalizedTurn> {
    let mut out = Vec::new();

    for mut turn in turns {
        let content_without_prefix = if source == "gemini" {
            strip_gemini_ui_prefixes(&turn.content_markdown)
        } else {
            turn.content_markdown.clone()
        };
        let raw_content = if source == "gemini" && turn.role.eq_ignore_ascii_case("assistant") {
            strip_gemini_boilerplate(&content_without_prefix)
        } else {
            content_without_prefix
        };

        let mut cleaned_content = normalize_markdown_text(&raw_content);
        let has_attachments = turn
            .attachments
            .as_ref()
            .map(|items| !items.is_empty())
            .unwrap_or(false);
        if cleaned_content.is_empty() {
            if has_attachments {
                cleaned_content = "（仅附件消息）".to_string();
            } else {
                continue;
            }
        }

        let cleaned_thought = if source == "gemini" {
            None
        } else {
            turn.thought_markdown
                .as_ref()
                .map(|value| normalize_markdown_text(value))
                .filter(|value| !value.is_empty())
        };

        turn.content_markdown = cleaned_content;
        turn.thought_markdown = cleaned_thought;
        out.push(turn);
    }

    out
}

fn append_virtual_named_attachments(
    conversation_id: &str,
    fallback_created_at: &str,
    messages: &[Message],
    attachments: &mut Vec<Attachment>,
) {
    let mut message_has_attachment: HashSet<String> = HashSet::new();
    let mut seen_urls: HashSet<String> = HashSet::new();
    for attachment in attachments.iter() {
        message_has_attachment.insert(attachment.message_id.clone());
        seen_urls.insert(attachment.original_url.clone());
    }

    for message in messages {
        if !message.role.eq_ignore_ascii_case("user") {
            continue;
        }
        if message_has_attachment.contains(&message.id) {
            continue;
        }

        let inferred = extract_named_file_attachments(&message.content_markdown);
        for (idx, (kind, original_url, mime)) in inferred.into_iter().enumerate() {
            if !seen_urls.insert(original_url.clone()) {
                continue;
            }

            attachments.push(Attachment {
                id: format!("virtual-{}-{idx}", message.id),
                message_id: message.id.clone(),
                conversation_id: conversation_id.to_string(),
                kind,
                original_url,
                local_path: None,
                mime,
                size_bytes: None,
                sha256: None,
                status: "remote_only".to_string(),
                error: None,
                created_at: message
                    .timestamp
                    .clone()
                    .unwrap_or_else(|| fallback_created_at.to_string()),
            });
        }
    }
}

fn extract_inline_attachments(markdown: &str) -> Vec<(String, String, Option<String>)> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for (kind, prefix) in [("image", "![")].iter() {
        let mut cursor = markdown;
        while let Some(start) = cursor.find(prefix) {
            let rest = &cursor[start..];
            let Some(open) = rest.find('(') else {
                break;
            };
            let rest = &rest[(open + 1)..];
            let Some(close) = rest.find(')') else {
                break;
            };
            let url = normalize_attachment_url(&rest[..close]);
            if !url.is_empty() && seen.insert(url.clone()) {
                out.push(((*kind).to_string(), url.clone(), infer_attachment_mime(&url)));
            }
            cursor = &rest[(close + 1)..];
        }
    }

    let mut cursor = markdown;
    while let Some(start) = cursor.find('[') {
        let rest = &cursor[start..];
        let Some(mid) = rest.find("](") else {
            break;
        };
        let label = &rest[1..mid];
        let rest = &rest[(mid + 2)..];
        let Some(close) = rest.find(')') else {
            break;
        };
        let url = normalize_attachment_url(&rest[..close]);
        if !url.is_empty() {
            if is_navigation_url(&url) {
                cursor = &rest[(close + 1)..];
                continue;
            }
            let lower_label = label.to_lowercase();
            let kind = if lower_label.contains("pdf") || looks_like_pdf_url(&url) {
                "pdf"
            } else if lower_label.contains("image")
                || lower_label.contains("图片")
                || looks_like_image_url(&url)
            {
                "image"
            } else if looks_like_file_url(&url) {
                "file"
            } else {
                cursor = &rest[(close + 1)..];
                continue;
            };

            if kind == "file"
                && !looks_like_supported_document_url(&url)
                && !looks_like_cloud_drive_file_url(&url)
            {
                cursor = &rest[(close + 1)..];
                continue;
            }

            if seen.insert(url.clone()) {
                let mime = infer_attachment_mime(&url);
                out.push((kind.to_string(), url, mime));
            }
        }
        cursor = &rest[(close + 1)..];
    }

    for raw in markdown.split_whitespace() {
        let trimmed = raw
            .trim_matches(|ch: char| ch == '(' || ch == ')' || ch == '[' || ch == ']' || ch == '<' || ch == '>' || ch == '"' || ch == '\'' || ch == ',' || ch == ';');
        if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
            continue;
        }
        let url = normalize_attachment_url(trimmed);
        if url.is_empty() || is_navigation_url(&url) || seen.contains(&url) {
            continue;
        }
        if looks_like_pdf_url(&url) {
            seen.insert(url.clone());
            out.push(("pdf".to_string(), url.clone(), infer_attachment_mime(&url)));
            continue;
        }
        if looks_like_image_url(&url) {
            seen.insert(url.clone());
            out.push(("image".to_string(), url.clone(), infer_attachment_mime(&url)));
            continue;
        }
        if looks_like_supported_document_url(&url) || looks_like_cloud_drive_file_url(&url) {
            seen.insert(url.clone());
            out.push(("file".to_string(), url.clone(), infer_attachment_mime(&url)));
        }
    }

    out
}

fn extract_named_file_attachments(markdown: &str) -> Vec<(String, String, Option<String>)> {
    let mut out = Vec::new();
    let mut seen_names = HashSet::new();

    for raw_line in markdown.lines() {
        for file_name in filename_candidates_from_line(raw_line) {
            let normalized = file_name.to_lowercase();
            if !seen_names.insert(normalized) {
                continue;
            }
            let ext = file_name
                .rsplit('.')
                .next()
                .map(|value| value.to_lowercase())
                .unwrap_or_default();
            if ext.is_empty() {
                continue;
            }

            let kind = if matches!(
                ext.as_str(),
                "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "svg"
            ) {
                "image"
            } else if ext == "pdf" {
                "pdf"
            } else {
                "file"
            };
            let virtual_url = virtual_attachment_url_from_name(&file_name);
            out.push((
                kind.to_string(),
                virtual_url.clone(),
                infer_attachment_mime(&virtual_url),
            ));
        }
    }

    out
}

fn filename_candidates_from_line(raw_line: &str) -> Vec<String> {
    let line = raw_line.trim();
    if line.is_empty() || line.len() > 220 || line.contains("://") {
        return Vec::new();
    }

    let mut matches = Vec::new();
    let lower = line.to_lowercase();
    for ext in [
        "docx", "pptx", "xlsx", "xls", "csv", "jpeg", "pdf", "doc", "ppt", "md", "png", "jpg",
        "webp", "gif", "bmp", "svg",
    ] {
        let needle = format!(".{ext}");
        let mut start = 0usize;
        while let Some(found) = lower[start..].find(&needle) {
            let ext_start = start + found;
            let ext_end = ext_start + needle.len();

            let mut left = ext_start;
            for (idx, ch) in line[..ext_start].char_indices().rev() {
                if is_filename_boundary(ch) {
                    left = idx + ch.len_utf8();
                    break;
                }
                left = idx;
            }

            let right_ch = line[ext_end..].chars().next();
            if right_ch.map(is_filename_boundary).unwrap_or(true) {
                let candidate = line[left..ext_end]
                    .trim_matches(|ch: char| {
                        ch.is_whitespace()
                            || matches!(
                                ch,
                                '"' | '\'' | '`' | '(' | ')' | '[' | ']' | '{' | '}' | '，'
                                    | '。' | '；' | '：' | ',' | ';' | ':' | '!' | '?' | '！'
                                    | '？'
                            )
                    })
                    .trim();

                if candidate.len() >= 4
                    && candidate.len() <= 180
                    && !candidate.contains('/')
                    && !candidate.contains('\\')
                    && !candidate.starts_with("www.")
                {
                    matches.push(candidate.to_string());
                }
            }

            start = ext_end;
        }
    }

    matches.sort();
    matches.dedup();
    matches
}

fn is_filename_boundary(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '"' | '\'' | '`'
                | '('
                | ')'
                | '['
                | ']'
                | '{'
                | '}'
                | '<'
                | '>'
                | ','
                | ';'
                | ':'
                | '!'
                | '?'
                | '，'
                | '。'
                | '；'
                | '：'
                | '！'
                | '？'
                | '|'
                | '/'
                | '\\'
        )
}

fn percent_encode_component(input: &str) -> String {
    let mut out = String::new();
    for byte in input.as_bytes() {
        let value = *byte;
        if value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_' | b'.' | b'~') {
            out.push(value as char);
        } else {
            out.push_str(&format!("%{value:02X}"));
        }
    }
    out
}

fn virtual_attachment_url_from_name(file_name: &str) -> String {
    format!("aihistory://upload/{}", percent_encode_component(file_name))
}

const FILE_LIKE_EXTENSIONS: [&str; 24] = [
    "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv", "txt", "zip", "rar", "7z",
    "json", "md", "png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "mp3", "mp4", "wav",
];
const SUPPORTED_FILE_EXTENSIONS: [&str; 10] = [
    "doc",
    "docx",
    "ppt",
    "pptx",
    "xls",
    "xlsx",
    "csv",
    "tsv",
    "md",
    "txt",
];

fn extract_url_extension(url: &str) -> String {
    let lower = url.to_lowercase();
    let clean = lower.split('?').next().unwrap_or(lower.as_str());
    let clean = clean.split('#').next().unwrap_or(clean);
    clean.rsplit('.').next().unwrap_or_default().to_string()
}

fn looks_like_pdf_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    if lower.starts_with("data:application/pdf") {
        return true;
    }
    lower.contains(".pdf")
        || lower.contains("format=pdf")
        || lower.contains("mime=application/pdf")
}

fn looks_like_cloud_drive_file_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("drive.google.com/file/")
        || lower.contains("drive.google.com/open")
        || lower.contains("docs.google.com/document/")
        || lower.contains("docs.google.com/presentation/")
        || lower.contains("docs.google.com/spreadsheets/")
}

fn is_data_url(url: &str) -> bool {
    url.to_lowercase().starts_with("data:")
}

fn decode_data_url(url: &str) -> Option<(Option<String>, Vec<u8>)> {
    if !is_data_url(url) {
        return None;
    }
    let (meta, payload) = url.split_once(',')?;
    if !meta.to_lowercase().contains(";base64") {
        return None;
    }

    let mime = meta
        .strip_prefix("data:")
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase());

    let bytes = BASE64_STANDARD.decode(payload.as_bytes()).ok()?;
    Some((mime, bytes))
}

fn hex_to_u8(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(10 + byte - b'a'),
        b'A'..=b'F' => Some(10 + byte - b'A'),
        _ => None,
    }
}

fn decode_url_component_lossy(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut idx = 0;
    while idx < bytes.len() {
        if bytes[idx] == b'+' {
            out.push(b' ');
            idx += 1;
            continue;
        }
        if bytes[idx] == b'%' && idx + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex_to_u8(bytes[idx + 1]), hex_to_u8(bytes[idx + 2]))
            {
                out.push((high << 4) | low);
                idx += 3;
                continue;
            }
        }
        out.push(bytes[idx]);
        idx += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn sanitize_filename(input: &str) -> String {
    let trimmed = input.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() {
        return String::new();
    }
    trimmed
        .chars()
        .map(|ch| match ch {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            control if control.is_control() => '_',
            value => value,
        })
        .collect::<String>()
        .trim()
        .chars()
        .take(240)
        .collect::<String>()
}

fn parse_content_disposition_filename(raw: &str) -> Option<String> {
    for segment in raw.split(';') {
        let part = segment.trim();
        if let Some(value) = part.strip_prefix("filename*=") {
            let stripped = value.trim().trim_matches('"').trim_matches('\'');
            let encoded = stripped
                .split("''")
                .last()
                .map(str::trim)
                .unwrap_or_default();
            let decoded = sanitize_filename(&decode_url_component_lossy(encoded));
            if !decoded.is_empty() {
                return Some(decoded);
            }
        }
    }
    for segment in raw.split(';') {
        let part = segment.trim();
        if let Some(value) = part.strip_prefix("filename=") {
            let decoded = sanitize_filename(&decode_url_component_lossy(value));
            if !decoded.is_empty() {
                return Some(decoded);
            }
        }
    }
    None
}

fn extract_data_url_filename(url: &str) -> Option<String> {
    if !is_data_url(url) {
        return None;
    }
    let (meta, _) = url.split_once(',')?;
    for segment in meta.split(';').skip(1) {
        let part = segment.trim();
        if let Some(value) = part.strip_prefix("name=") {
            let decoded = sanitize_filename(&decode_url_component_lossy(value));
            if !decoded.is_empty() {
                return Some(decoded);
            }
        }
        if let Some(value) = part.strip_prefix("filename=") {
            let decoded = sanitize_filename(&decode_url_component_lossy(value));
            if !decoded.is_empty() {
                return Some(decoded);
            }
        }
    }
    None
}

fn extract_filename_from_url(url: &str) -> Option<String> {
    if let Some(name) = extract_data_url_filename(url) {
        return Some(name);
    }
    let parsed = reqwest::Url::parse(url).ok()?;
    for (key, value) in parsed.query_pairs() {
        let key_l = key.to_lowercase();
        if key_l == "filename" || key_l == "file" || key_l == "name" {
            let normalized = sanitize_filename(&decode_url_component_lossy(value.as_ref()));
            if !normalized.is_empty() {
                return Some(normalized);
            }
        }
        if key_l == "response-content-disposition" {
            if let Some(name) = parse_content_disposition_filename(value.as_ref()) {
                return Some(name);
            }
        }
    }
    let segment = parsed
        .path_segments()
        .and_then(|segments| segments.filter(|item| !item.is_empty()).last())
        .map(decode_url_component_lossy)
        .map(|name| sanitize_filename(&name))
        .unwrap_or_default();
    if segment.contains('.') && !segment.is_empty() {
        return Some(segment);
    }
    None
}

fn is_virtual_attachment_url(url: &str) -> bool {
    url.to_lowercase().starts_with("aihistory://upload/")
}

fn is_http_or_https_url(url: &str) -> bool {
    if let Ok(parsed) = reqwest::Url::parse(url) {
        return parsed.scheme() == "http" || parsed.scheme() == "https";
    }
    false
}

fn looks_like_image_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    if lower.starts_with("data:image/") {
        return true;
    }
    if lower.contains("format=png")
        || lower.contains("format=jpg")
        || lower.contains("format=jpeg")
        || lower.contains("format=webp")
        || lower.contains("format=gif")
        || lower.contains("format=bmp")
        || lower.contains("format=svg")
        || lower.contains("mime=image/")
    {
        return true;
    }

    matches!(
        extract_url_extension(url).as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "svg"
    )
}

fn looks_like_supported_document_url(url: &str) -> bool {
    let ext = extract_url_extension(url);
    if SUPPORTED_FILE_EXTENSIONS
        .iter()
        .any(|candidate| *candidate == ext.as_str())
    {
        return true;
    }

    let lower = url.to_lowercase();
    SUPPORTED_FILE_EXTENSIONS.iter().any(|candidate| {
        lower.contains(&format!(".{candidate}"))
            || lower.contains(&format!("filename=.{candidate}"))
            || lower.contains(&format!("filename={candidate}"))
            || lower.contains(&format!("filename%3d.{candidate}"))
    })
}

fn infer_attachment_mime(url: &str) -> Option<String> {
    if let Some(meta) = url.strip_prefix("data:") {
        let mime = meta
            .split(',')
            .next()
            .and_then(|value| value.split(';').next())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_lowercase());
        if mime.is_some() {
            return mime;
        }
    }
    if looks_like_pdf_url(url) {
        return Some("application/pdf".to_string());
    }
    match extract_url_extension(url).as_str() {
        "png" => Some("image/png".to_string()),
        "jpg" | "jpeg" => Some("image/jpeg".to_string()),
        "webp" => Some("image/webp".to_string()),
        "gif" => Some("image/gif".to_string()),
        "bmp" => Some("image/bmp".to_string()),
        "svg" => Some("image/svg+xml".to_string()),
        "md" => Some("text/markdown".to_string()),
        "txt" => Some("text/plain".to_string()),
        "csv" => Some("text/csv".to_string()),
        "tsv" => Some("text/tab-separated-values".to_string()),
        "json" => Some("application/json".to_string()),
        "doc" => Some("application/msword".to_string()),
        "docx" => Some(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document".to_string(),
        ),
        "ppt" => Some("application/vnd.ms-powerpoint".to_string()),
        "pptx" => Some(
            "application/vnd.openxmlformats-officedocument.presentationml.presentation".to_string(),
        ),
        "xls" => Some("application/vnd.ms-excel".to_string()),
        "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string()),
        _ => None,
    }
}

fn looks_like_file_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    if is_data_url(url) {
        return true;
    }
    if is_virtual_attachment_url(url) {
        return true;
    }
    if lower.contains("googleusercontent.com/gg/") {
        return true;
    }
    if looks_like_cloud_drive_file_url(url) {
        return true;
    }
    if lower.contains("/backend-api/files/")
        || lower.contains("/backend-api/estuary/content")
        || lower.contains("/api/files/")
        || lower.contains("/files/")
    {
        return true;
    }
    if lower.contains("download=") || lower.contains("filename=") || lower.contains("attachment=") {
        return true;
    }
    let ext = extract_url_extension(url);
    if looks_like_image_url(url) || looks_like_pdf_url(url) {
        return true;
    }
    FILE_LIKE_EXTENSIONS
        .iter()
        .any(|candidate| *candidate == ext.as_str())
}

fn is_navigation_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let lower = parsed.as_str().to_lowercase();
    if lower.contains("/backend-api/files/")
        || lower.contains("/backend-api/estuary/content")
        || lower.contains("/api/files/")
        || lower.contains("/files/")
        || lower.contains("/prompts/")
        || looks_like_file_url(parsed.as_str())
        || looks_like_image_url(parsed.as_str())
        || looks_like_pdf_url(parsed.as_str())
    {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.to_lowercase();
    host.contains("gemini.google.com")
        || host.contains("bard.google.com")
        || host.contains("chatgpt.com")
        || host.contains("aistudio.google.com")
}

fn infer_file_extension(url: &str, mime: Option<&str>) -> String {
    if let Some(m) = mime {
        let lower = m.to_lowercase();
        if lower.contains("png") {
            return "png".to_string();
        }
        if lower.contains("jpeg") || lower.contains("jpg") {
            return "jpg".to_string();
        }
        if lower.contains("webp") {
            return "webp".to_string();
        }
        if lower.contains("gif") {
            return "gif".to_string();
        }
        if lower.contains("pdf") {
            return "pdf".to_string();
        }
        if lower.contains("wordprocessingml.document") {
            return "docx".to_string();
        }
        if lower.contains("msword") {
            return "doc".to_string();
        }
        if lower.contains("presentationml.presentation") {
            return "pptx".to_string();
        }
        if lower.contains("ms-powerpoint") {
            return "ppt".to_string();
        }
        if lower.contains("spreadsheetml.sheet") {
            return "xlsx".to_string();
        }
        if lower.contains("ms-excel") {
            return "xls".to_string();
        }
        if lower.contains("text/markdown") {
            return "md".to_string();
        }
        if lower.contains("text/plain") {
            return "txt".to_string();
        }
        if lower.contains("text/csv") {
            return "csv".to_string();
        }
        if lower.contains("tab-separated-values") {
            return "tsv".to_string();
        }
        if lower.contains("application/json") {
            return "json".to_string();
        }
    }

    if let Some(file_name) = extract_filename_from_url(url) {
        let name_ext = extract_url_extension(&file_name);
        if !name_ext.is_empty()
            && name_ext.len() <= 10
            && name_ext.chars().all(|ch| ch.is_ascii_alphanumeric())
        {
            return name_ext;
        }
    }

    let clean = url.split('?').next().unwrap_or(url);
    let ext = clean.rsplit('.').next().unwrap_or_default();
    let ext = ext.to_lowercase();
    if ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return ext;
    }

    String::new()
}

fn truncate_error(error: &str) -> String {
    const MAX: usize = 300;
    if error.len() <= MAX {
        return error.to_string();
    }
    error[..MAX].to_string()
}
