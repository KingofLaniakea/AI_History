use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, options, post};
use axum::{Json, Router};
use chrono::Utc;
use serde_json::json;
use tower_http::cors::{Any, CorsLayer};
use uuid::Uuid;

use crate::db::Database;
use crate::models::{ImportResult, LiveCaptureRequest, SessionResponse};

#[derive(Clone)]
pub struct BridgeState {
    db: Database,
    sessions: Arc<Mutex<HashMap<String, Instant>>>,
}

impl BridgeState {
    pub fn new(db: Database) -> Self {
        Self {
            db,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn issue_session(&self) -> Result<SessionResponse, String> {
        let token = Uuid::new_v4().to_string();
        let expires_at = Instant::now() + Duration::from_secs(600);
        let iso = (Utc::now() + chrono::Duration::seconds(600)).to_rfc3339();

        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "failed to lock bridge session".to_string())?;
        sessions.insert(token.clone(), expires_at);

        Ok(SessionResponse {
            token,
            expires_at: iso,
        })
    }

    pub fn verify_session(&self, token: &str) -> bool {
        let Ok(mut sessions) = self.sessions.lock() else {
            return false;
        };

        sessions.retain(|_, exp| *exp > Instant::now());
        sessions.get(token).is_some()
    }

    pub fn db(&self) -> &Database {
        &self.db
    }
}

pub async fn start_bridge_server(state: BridgeState) -> Result<(), String> {
    let app = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/session/start", post(session_start))
        .route("/v1/session/start", options(preflight))
        .route("/v1/import/live", post(import_live))
        .route("/v1/import/live", options(preflight))
        .with_state(state)
        .layer(
            CorsLayer::new()
                .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
                .allow_headers(Any)
                .allow_origin(Any),
        );

    let addr: SocketAddr = "127.0.0.1:48765"
        .parse()
        .map_err(|e| format!("invalid bridge addr: {e}"))?;

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("bind bridge port failed: {e}"))?;

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("bridge server stopped: {e}");
        }
    });

    Ok(())
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({"status": "ok"})))
}

async fn preflight() -> impl IntoResponse {
    (StatusCode::NO_CONTENT, "")
}

async fn session_start(
    State(state): State<BridgeState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !allow_origin(&headers) {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "origin_not_allowed"}))).into_response();
    }

    match state.issue_session() {
        Ok(session) => (StatusCode::OK, Json(json!(session))).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": err})),
        )
            .into_response(),
    }
}

async fn import_live(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    Json(payload): Json<LiveCaptureRequest>,
) -> impl IntoResponse {
    if !allow_origin(&headers) {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "origin_not_allowed"}))).into_response();
    }

    let Some(token) = headers.get("x-ai-history-token").and_then(|h| h.to_str().ok()) else {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "missing_token"}))).into_response();
    };

    if !state.verify_session(token) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "invalid_or_expired_token"}))).into_response();
    }

    match state.db().import_live_capture(payload) {
        Ok(result) => {
            let out: ImportResult = result;
            (StatusCode::OK, Json(json!(out))).into_response()
        }
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": err})),
        )
            .into_response(),
    }
}

fn allow_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) else {
        return true;
    };

    origin.starts_with("chrome-extension://") || origin.starts_with("edge-extension://")
}
