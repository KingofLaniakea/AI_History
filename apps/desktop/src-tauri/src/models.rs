use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub source: String,
    pub source_conversation_id: Option<String>,
    pub folder_id: Option<String>,
    pub title: String,
    pub summary: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub fingerprint: String,
    pub meta_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub seq: i64,
    pub role: String,
    pub content_markdown: String,
    pub thought_markdown: Option<String>,
    pub model: Option<String>,
    pub timestamp: Option<String>,
    pub token_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub message_id: String,
    pub conversation_id: String,
    pub kind: String,
    pub original_url: String,
    pub local_path: Option<String>,
    pub mime: Option<String>,
    pub size_bytes: Option<i64>,
    pub sha256: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    #[serde(flatten)]
    pub conversation: Conversation,
    pub message_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDetail {
    #[serde(flatten)]
    pub conversation: Conversation,
    pub messages: Vec<Message>,
    pub tags: Vec<String>,
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedAttachment {
    pub kind: String,
    pub original_url: String,
    pub mime: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedTurn {
    pub role: String,
    pub content_markdown: String,
    pub thought_markdown: Option<String>,
    pub attachments: Option<Vec<NormalizedAttachment>>,
    pub model: Option<String>,
    pub timestamp: Option<String>,
    pub token_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedConversation {
    pub source: String,
    pub source_conversation_id: Option<String>,
    pub title: String,
    pub summary: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub turns: Vec<NormalizedTurn>,
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBatch {
    pub conversations: Vec<NormalizedConversation>,
    pub strategy: String,
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: i64,
    pub skipped: i64,
    pub conflicts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListConversationsInput {
    pub folder_id: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub conversation: ConversationSummary,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveCaptureRequest {
    pub source: String,
    pub page_url: String,
    pub title: String,
    pub turns: Vec<NormalizedTurn>,
    pub captured_at: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    pub token: String,
    pub expires_at: String,
}
