#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod http;
mod models;

use std::path::PathBuf;
use tauri::Manager;

use db::Database;
use http::{start_bridge_server, BridgeState};

#[derive(Clone)]
pub struct AppState {
    pub db: Database,
}

fn build_db_path(app: &tauri::AppHandle) -> Result<PathBuf, std::io::Error> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| std::io::Error::other(format!("failed to resolve app data dir: {e}")))?;

    std::fs::create_dir_all(&app_dir)
        .map_err(|e| std::io::Error::other(format!("create app data dir failed: {e}")))?;
    Ok(app_dir.join("ai-history.sqlite"))
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let db_path = build_db_path(app.handle())?;
            let db = Database::new(db_path).map_err(std::io::Error::other)?;

            let app_state = AppState { db: db.clone() };
            app.manage(app_state);

            let bridge_state = BridgeState::new(db.clone());
            app.manage(bridge_state.clone());

            tauri::async_runtime::spawn(async move {
                if let Err(err) = start_bridge_server(bridge_state).await {
                    eprintln!("bridge server startup error: {err}");
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_folders,
            commands::create_folder,
            commands::move_folder,
            commands::delete_folder,
            commands::move_conversation,
            commands::list_conversations,
            commands::open_conversation,
            commands::list_conversation_attachments,
            commands::import_files,
            commands::import_live_capture,
            commands::search_conversations,
            commands::export_backup_zip,
            commands::fetch_url_html,
            commands::start_bridge_session,
            commands::open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
