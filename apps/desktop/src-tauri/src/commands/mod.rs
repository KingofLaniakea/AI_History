use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, USER_AGENT};
use std::process::Command;
use tauri::State;

use crate::http::BridgeState;
use crate::models::{
    Attachment, ConversationDetail, Folder, ImportBatch, ImportResult, ListConversationsInput,
    LiveCaptureRequest, SearchResult, SessionResponse,
};
use crate::AppState;

#[tauri::command]
pub async fn list_folders(state: State<'_, AppState>) -> Result<Vec<Folder>, String> {
    state.db.list_folders()
}

#[tauri::command]
pub async fn create_folder(
    state: State<'_, AppState>,
    name: String,
    parent_id: Option<String>,
) -> Result<Folder, String> {
    state.db.create_folder(name, parent_id)
}

#[tauri::command]
pub async fn move_folder(
    state: State<'_, AppState>,
    id: String,
    parent_id: Option<String>,
) -> Result<(), String> {
    state.db.move_folder(id, parent_id)
}

#[tauri::command]
pub async fn delete_folder(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.delete_folder(id)
}

#[tauri::command]
pub async fn move_conversation(
    state: State<'_, AppState>,
    id: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    state.db.move_conversation(id, folder_id)
}

#[tauri::command]
pub async fn list_conversations(
    state: State<'_, AppState>,
    input: Option<ListConversationsInput>,
) -> Result<Vec<crate::models::ConversationSummary>, String> {
    state.db.list_conversations(input)
}

#[tauri::command]
pub async fn open_conversation(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<ConversationDetail>, String> {
    state.db.open_conversation(id)
}

#[tauri::command]
pub async fn list_conversation_attachments(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<Attachment>, String> {
    state.db.list_conversation_attachments(conversation_id)
}

#[tauri::command]
pub async fn import_files(
    state: State<'_, AppState>,
    batch: ImportBatch,
) -> Result<ImportResult, String> {
    state.db.import_files(batch)
}

#[tauri::command]
pub async fn import_live_capture(
    state: State<'_, AppState>,
    request: LiveCaptureRequest,
) -> Result<ImportResult, String> {
    state.db.import_live_capture(request)
}

#[tauri::command]
pub async fn search_conversations(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<SearchResult>, String> {
    state.db.search_conversations(query)
}

#[tauri::command]
pub async fn export_backup_zip(state: State<'_, AppState>) -> Result<String, String> {
    state.db.export_backup_zip()
}

#[tauri::command]
pub async fn fetch_url_html(_state: State<'_, AppState>, url: String) -> Result<String, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"),
    );
    headers.insert(ACCEPT, HeaderValue::from_static("text/html,application/xhtml+xml"));

    let client = reqwest::Client::builder()
        .default_headers(headers)
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .map_err(|e| format!("build client failed: {e}"))?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("fetch returned status {status}"));
    }

    response.text().await.map_err(|e| format!("read html failed: {e}"))
}

#[tauri::command]
pub async fn start_bridge_session(bridge: State<'_, BridgeState>) -> Result<SessionResponse, String> {
    bridge.issue_session()
}

fn open_target_with_system(target: &str) -> Result<(), String> {
    let normalized = target.trim();
    if normalized.is_empty() {
        return Err("open target is empty".to_string());
    }
    if normalized.starts_with('-') {
        return Err("unsupported open target".to_string());
    }
    if normalized.contains('\0') {
        return Err("invalid open target".to_string());
    }

    #[cfg(target_os = "macos")]
    let status = Command::new("open")
        .arg(normalized)
        .status()
        .map_err(|e| format!("open failed: {e}"))?;

    #[cfg(target_os = "windows")]
    let status = Command::new("rundll32")
        .arg("url.dll,FileProtocolHandler")
        .arg(normalized)
        .status()
        .map_err(|e| format!("open failed: {e}"))?;

    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open")
        .arg(normalized)
        .status()
        .map_err(|e| format!("open failed: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("open exited with status {status}"))
    }
}

#[tauri::command]
pub async fn open_external(target: String) -> Result<(), String> {
    open_target_with_system(&target)
}
