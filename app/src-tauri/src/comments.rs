//! FILENAME: app/src-tauri/src/comments.rs
//! PURPOSE: Comments and notes functionality for cell-level collaboration.
//! CONTEXT: Provides Excel-like comment threads with replies, resolution status,
//! and user mentions. Comments are stored per-sheet, keyed by cell position.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;
use crate::AppState;
use chrono::{DateTime, Utc};
use uuid::Uuid;

// ============================================================================
// TYPES
// ============================================================================

/// A mention within a comment's rich content.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentMention {
    /// The email of the mentioned user
    pub email: String,
    /// The display name of the mentioned user
    pub name: String,
    /// Start index in the rich content string
    pub start_index: usize,
    /// Length of the mention placeholder in the rich content
    pub length: usize,
}

/// A reply to a comment thread.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentReply {
    /// Unique identifier for the reply
    pub id: String,
    /// Email of the reply author
    pub author_email: String,
    /// Display name of the reply author
    pub author_name: String,
    /// Plain text content of the reply
    pub content: String,
    /// Rich content with mention placeholders (for parsing mentions)
    pub rich_content: Option<String>,
    /// Mentions within this reply
    pub mentions: Vec<CommentMention>,
    /// Creation timestamp (ISO 8601 format)
    pub created_at: String,
    /// Last modified timestamp (ISO 8601 format)
    pub modified_at: Option<String>,
}

/// Content type of a comment or reply.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CommentContentType {
    /// Plain text content
    Plain,
    /// Content with user mentions
    Mention,
}

/// A comment thread attached to a cell.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    /// Unique identifier for the comment
    pub id: String,
    /// Row of the cell this comment is attached to (0-indexed)
    pub row: u32,
    /// Column of the cell this comment is attached to (0-indexed)
    pub col: u32,
    /// Sheet index this comment belongs to
    pub sheet_index: usize,
    /// Email of the comment author
    pub author_email: String,
    /// Display name of the comment author
    pub author_name: String,
    /// Plain text content of the comment
    pub content: String,
    /// Rich content with mention placeholders (for parsing mentions)
    pub rich_content: Option<String>,
    /// Content type (plain or mention)
    pub content_type: CommentContentType,
    /// Mentions within this comment
    pub mentions: Vec<CommentMention>,
    /// Whether the comment thread is resolved
    pub resolved: bool,
    /// Replies to this comment
    pub replies: Vec<CommentReply>,
    /// Creation timestamp (ISO 8601 format)
    pub created_at: String,
    /// Last modified timestamp (ISO 8601 format)
    pub modified_at: Option<String>,
}

impl Comment {
    /// Create a new comment with the given parameters.
    pub fn new(
        row: u32,
        col: u32,
        sheet_index: usize,
        author_email: String,
        author_name: String,
        content: String,
    ) -> Self {
        let now = Utc::now().to_rfc3339();
        Comment {
            id: Uuid::new_v4().to_string(),
            row,
            col,
            sheet_index,
            author_email,
            author_name,
            content,
            rich_content: None,
            content_type: CommentContentType::Plain,
            mentions: Vec::new(),
            resolved: false,
            replies: Vec::new(),
            created_at: now,
            modified_at: None,
        }
    }

    /// Create a new comment with mentions.
    pub fn new_with_mentions(
        row: u32,
        col: u32,
        sheet_index: usize,
        author_email: String,
        author_name: String,
        content: String,
        rich_content: String,
        mentions: Vec<CommentMention>,
    ) -> Self {
        let now = Utc::now().to_rfc3339();
        Comment {
            id: Uuid::new_v4().to_string(),
            row,
            col,
            sheet_index,
            author_email,
            author_name,
            content,
            rich_content: Some(rich_content),
            content_type: if mentions.is_empty() {
                CommentContentType::Plain
            } else {
                CommentContentType::Mention
            },
            mentions,
            resolved: false,
            replies: Vec::new(),
            created_at: now,
            modified_at: None,
        }
    }

    /// Add a reply to this comment.
    pub fn add_reply(&mut self, reply: CommentReply) {
        self.replies.push(reply);
        self.modified_at = Some(Utc::now().to_rfc3339());
    }

    /// Update the content of this comment.
    pub fn update_content(&mut self, content: String) {
        self.content = content;
        self.rich_content = None;
        self.content_type = CommentContentType::Plain;
        self.mentions.clear();
        self.modified_at = Some(Utc::now().to_rfc3339());
    }

    /// Update the content with mentions.
    pub fn update_content_with_mentions(
        &mut self,
        content: String,
        rich_content: String,
        mentions: Vec<CommentMention>,
    ) {
        self.content = content;
        self.rich_content = Some(rich_content);
        self.content_type = if mentions.is_empty() {
            CommentContentType::Plain
        } else {
            CommentContentType::Mention
        };
        self.mentions = mentions;
        self.modified_at = Some(Utc::now().to_rfc3339());
    }
}

impl CommentReply {
    /// Create a new reply.
    pub fn new(author_email: String, author_name: String, content: String) -> Self {
        let now = Utc::now().to_rfc3339();
        CommentReply {
            id: Uuid::new_v4().to_string(),
            author_email,
            author_name,
            content,
            rich_content: None,
            mentions: Vec::new(),
            created_at: now,
            modified_at: None,
        }
    }

    /// Create a new reply with mentions.
    pub fn new_with_mentions(
        author_email: String,
        author_name: String,
        content: String,
        rich_content: String,
        mentions: Vec<CommentMention>,
    ) -> Self {
        let now = Utc::now().to_rfc3339();
        CommentReply {
            id: Uuid::new_v4().to_string(),
            author_email,
            author_name,
            content,
            rich_content: Some(rich_content),
            mentions,
            created_at: now,
            modified_at: None,
        }
    }

    /// Update the content of this reply.
    pub fn update_content(&mut self, content: String) {
        self.content = content;
        self.rich_content = None;
        self.mentions.clear();
        self.modified_at = Some(Utc::now().to_rfc3339());
    }
}

/// Storage for comments: sheet_index -> (row, col) -> Comment
pub type CommentStorage = HashMap<usize, HashMap<(u32, u32), Comment>>;

// ============================================================================
// API TYPES
// ============================================================================

/// Result of a comment operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentResult {
    pub success: bool,
    pub comment: Option<Comment>,
    pub error: Option<String>,
}

/// Result of a reply operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyResult {
    pub success: bool,
    pub reply: Option<CommentReply>,
    pub comment: Option<Comment>,
    pub error: Option<String>,
}

/// Parameters for adding a comment.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCommentParams {
    pub row: u32,
    pub col: u32,
    pub author_email: String,
    pub author_name: String,
    pub content: String,
    pub rich_content: Option<String>,
    pub mentions: Option<Vec<CommentMention>>,
}

/// Parameters for updating a comment.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCommentParams {
    pub comment_id: String,
    pub content: String,
    pub rich_content: Option<String>,
    pub mentions: Option<Vec<CommentMention>>,
}

/// Parameters for adding a reply.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddReplyParams {
    pub comment_id: String,
    pub author_email: String,
    pub author_name: String,
    pub content: String,
    pub rich_content: Option<String>,
    pub mentions: Option<Vec<CommentMention>>,
}

/// Parameters for updating a reply.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReplyParams {
    pub comment_id: String,
    pub reply_id: String,
    pub content: String,
    pub rich_content: Option<String>,
    pub mentions: Option<Vec<CommentMention>>,
}

/// Information about cells with comments (for indicators).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentIndicator {
    pub row: u32,
    pub col: u32,
    pub resolved: bool,
    pub reply_count: usize,
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Add a comment to a cell. Fails if the cell already has a note (mutual exclusivity).
#[tauri::command]
pub fn add_comment(
    state: State<AppState>,
    params: AddCommentParams,
) -> CommentResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let key = (params.row, params.col);

    // Mutual exclusivity: check if cell has a note
    {
        let notes = state.notes.lock().unwrap();
        if let Some(sheet_notes) = notes.get(&active_sheet) {
            if sheet_notes.contains_key(&key) {
                return CommentResult {
                    success: false,
                    comment: None,
                    error: Some("Cell already has a Note. Delete or convert it first.".to_string()),
                };
            }
        }
    }

    let mut comments = state.comments.lock().unwrap();

    // Check if a comment already exists at this cell
    let sheet_comments = comments.entry(active_sheet).or_insert_with(HashMap::new);

    if sheet_comments.contains_key(&key) {
        return CommentResult {
            success: false,
            comment: None,
            error: Some("A comment already exists at this cell. Use update_comment to modify it.".to_string()),
        };
    }

    // Create the comment
    let comment = if let (Some(rich_content), Some(mentions)) = (params.rich_content, params.mentions) {
        Comment::new_with_mentions(
            params.row,
            params.col,
            active_sheet,
            params.author_email,
            params.author_name,
            params.content,
            rich_content,
            mentions,
        )
    } else {
        Comment::new(
            params.row,
            params.col,
            active_sheet,
            params.author_email,
            params.author_name,
            params.content,
        )
    };

    let result = comment.clone();
    sheet_comments.insert(key, comment);

    CommentResult {
        success: true,
        comment: Some(result),
        error: None,
    }
}

/// Update an existing comment's content.
#[tauri::command]
pub fn update_comment(
    state: State<AppState>,
    params: UpdateCommentParams,
) -> CommentResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut comments = state.comments.lock().unwrap();

    let sheet_comments = match comments.get_mut(&active_sheet) {
        Some(sc) => sc,
        None => {
            return CommentResult {
                success: false,
                comment: None,
                error: Some("No comments found on this sheet.".to_string()),
            };
        }
    };

    // Find the comment by ID
    for comment in sheet_comments.values_mut() {
        if comment.id == params.comment_id {
            if let (Some(rich_content), Some(mentions)) = (params.rich_content, params.mentions) {
                comment.update_content_with_mentions(params.content, rich_content, mentions);
            } else {
                comment.update_content(params.content);
            }
            return CommentResult {
                success: true,
                comment: Some(comment.clone()),
                error: None,
            };
        }
    }

    CommentResult {
        success: false,
        comment: None,
        error: Some(format!("Comment with ID '{}' not found.", params.comment_id)),
    }
}

/// Delete a comment and all its replies.
#[tauri::command]
pub fn delete_comment(
    state: State<AppState>,
    comment_id: String,
) -> CommentResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut comments = state.comments.lock().unwrap();

    let sheet_comments = match comments.get_mut(&active_sheet) {
        Some(sc) => sc,
        None => {
            return CommentResult {
                success: false,
                comment: None,
                error: Some("No comments found on this sheet.".to_string()),
            };
        }
    };

    // Find and remove the comment by ID
    let mut key_to_remove: Option<(u32, u32)> = None;
    for (key, comment) in sheet_comments.iter() {
        if comment.id == comment_id {
            key_to_remove = Some(*key);
            break;
        }
    }

    if let Some(key) = key_to_remove {
        let removed = sheet_comments.remove(&key);
        return CommentResult {
            success: true,
            comment: removed,
            error: None,
        };
    }

    CommentResult {
        success: false,
        comment: None,
        error: Some(format!("Comment with ID '{}' not found.", comment_id)),
    }
}

/// Get a comment at a specific cell.
#[tauri::command]
pub fn get_comment(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> Option<Comment> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let comments = state.comments.lock().unwrap();

    comments
        .get(&active_sheet)
        .and_then(|sheet_comments| sheet_comments.get(&(row, col)))
        .cloned()
}

/// Get a comment by ID.
#[tauri::command]
pub fn get_comment_by_id(
    state: State<AppState>,
    comment_id: String,
) -> Option<Comment> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let comments = state.comments.lock().unwrap();

    comments
        .get(&active_sheet)
        .and_then(|sheet_comments| {
            sheet_comments.values().find(|c| c.id == comment_id).cloned()
        })
}

/// Get all comments for the current sheet.
#[tauri::command]
pub fn get_all_comments(
    state: State<AppState>,
) -> Vec<Comment> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let comments = state.comments.lock().unwrap();

    comments
        .get(&active_sheet)
        .map(|sheet_comments| sheet_comments.values().cloned().collect())
        .unwrap_or_default()
}

/// Get all comments for a specific sheet.
#[tauri::command]
pub fn get_comments_for_sheet(
    state: State<AppState>,
    sheet_index: usize,
) -> Vec<Comment> {
    let comments = state.comments.lock().unwrap();

    comments
        .get(&sheet_index)
        .map(|sheet_comments| sheet_comments.values().cloned().collect())
        .unwrap_or_default()
}

/// Get comment indicators for the current sheet (for rendering comment markers).
#[tauri::command]
pub fn get_comment_indicators(
    state: State<AppState>,
) -> Vec<CommentIndicator> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let comments = state.comments.lock().unwrap();

    comments
        .get(&active_sheet)
        .map(|sheet_comments| {
            sheet_comments
                .values()
                .map(|c| CommentIndicator {
                    row: c.row,
                    col: c.col,
                    resolved: c.resolved,
                    reply_count: c.replies.len(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Get comment indicators for a viewport range.
#[tauri::command]
pub fn get_comment_indicators_in_range(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Vec<CommentIndicator> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let comments = state.comments.lock().unwrap();

    comments
        .get(&active_sheet)
        .map(|sheet_comments| {
            sheet_comments
                .values()
                .filter(|c| {
                    c.row >= start_row && c.row <= end_row &&
                    c.col >= start_col && c.col <= end_col
                })
                .map(|c| CommentIndicator {
                    row: c.row,
                    col: c.col,
                    resolved: c.resolved,
                    reply_count: c.replies.len(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Set the resolved status of a comment.
#[tauri::command]
pub fn resolve_comment(
    state: State<AppState>,
    comment_id: String,
    resolved: bool,
) -> CommentResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut comments = state.comments.lock().unwrap();

    let sheet_comments = match comments.get_mut(&active_sheet) {
        Some(sc) => sc,
        None => {
            return CommentResult {
                success: false,
                comment: None,
                error: Some("No comments found on this sheet.".to_string()),
            };
        }
    };

    for comment in sheet_comments.values_mut() {
        if comment.id == comment_id {
            comment.resolved = resolved;
            comment.modified_at = Some(Utc::now().to_rfc3339());
            return CommentResult {
                success: true,
                comment: Some(comment.clone()),
                error: None,
            };
        }
    }

    CommentResult {
        success: false,
        comment: None,
        error: Some(format!("Comment with ID '{}' not found.", comment_id)),
    }
}

/// Add a reply to a comment.
#[tauri::command]
pub fn add_reply(
    state: State<AppState>,
    params: AddReplyParams,
) -> ReplyResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut comments = state.comments.lock().unwrap();

    let sheet_comments = match comments.get_mut(&active_sheet) {
        Some(sc) => sc,
        None => {
            return ReplyResult {
                success: false,
                reply: None,
                comment: None,
                error: Some("No comments found on this sheet.".to_string()),
            };
        }
    };

    for comment in sheet_comments.values_mut() {
        if comment.id == params.comment_id {
            let reply = if let (Some(rich_content), Some(mentions)) = (params.rich_content, params.mentions) {
                CommentReply::new_with_mentions(
                    params.author_email,
                    params.author_name,
                    params.content,
                    rich_content,
                    mentions,
                )
            } else {
                CommentReply::new(
                    params.author_email,
                    params.author_name,
                    params.content,
                )
            };

            let reply_clone = reply.clone();
            comment.add_reply(reply);

            return ReplyResult {
                success: true,
                reply: Some(reply_clone),
                comment: Some(comment.clone()),
                error: None,
            };
        }
    }

    ReplyResult {
        success: false,
        reply: None,
        comment: None,
        error: Some(format!("Comment with ID '{}' not found.", params.comment_id)),
    }
}

/// Update a reply's content.
#[tauri::command]
pub fn update_reply(
    state: State<AppState>,
    params: UpdateReplyParams,
) -> ReplyResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut comments = state.comments.lock().unwrap();

    let sheet_comments = match comments.get_mut(&active_sheet) {
        Some(sc) => sc,
        None => {
            return ReplyResult {
                success: false,
                reply: None,
                comment: None,
                error: Some("No comments found on this sheet.".to_string()),
            };
        }
    };

    for comment in sheet_comments.values_mut() {
        if comment.id == params.comment_id {
            for reply in &mut comment.replies {
                if reply.id == params.reply_id {
                    if let (Some(rich_content), Some(mentions)) = (params.rich_content.clone(), params.mentions.clone()) {
                        reply.content = params.content.clone();
                        reply.rich_content = Some(rich_content);
                        reply.mentions = mentions;
                    } else {
                        reply.update_content(params.content.clone());
                    }
                    reply.modified_at = Some(Utc::now().to_rfc3339());

                    return ReplyResult {
                        success: true,
                        reply: Some(reply.clone()),
                        comment: Some(comment.clone()),
                        error: None,
                    };
                }
            }
            return ReplyResult {
                success: false,
                reply: None,
                comment: None,
                error: Some(format!("Reply with ID '{}' not found.", params.reply_id)),
            };
        }
    }

    ReplyResult {
        success: false,
        reply: None,
        comment: None,
        error: Some(format!("Comment with ID '{}' not found.", params.comment_id)),
    }
}

/// Delete a reply from a comment.
#[tauri::command]
pub fn delete_reply(
    state: State<AppState>,
    comment_id: String,
    reply_id: String,
) -> ReplyResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut comments = state.comments.lock().unwrap();

    let sheet_comments = match comments.get_mut(&active_sheet) {
        Some(sc) => sc,
        None => {
            return ReplyResult {
                success: false,
                reply: None,
                comment: None,
                error: Some("No comments found on this sheet.".to_string()),
            };
        }
    };

    for comment in sheet_comments.values_mut() {
        if comment.id == comment_id {
            // Find and remove the reply
            let reply_index = comment.replies.iter().position(|r| r.id == reply_id);

            if let Some(index) = reply_index {
                let removed = comment.replies.remove(index);
                comment.modified_at = Some(Utc::now().to_rfc3339());

                return ReplyResult {
                    success: true,
                    reply: Some(removed),
                    comment: Some(comment.clone()),
                    error: None,
                };
            } else {
                return ReplyResult {
                    success: false,
                    reply: None,
                    comment: None,
                    error: Some(format!("Reply with ID '{}' not found.", reply_id)),
                };
            }
        }
    }

    ReplyResult {
        success: false,
        reply: None,
        comment: None,
        error: Some(format!("Comment with ID '{}' not found.", comment_id)),
    }
}

/// Move a comment to a different cell (used when rows/columns are inserted/deleted).
#[tauri::command]
pub fn move_comment(
    state: State<AppState>,
    comment_id: String,
    new_row: u32,
    new_col: u32,
) -> CommentResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut comments = state.comments.lock().unwrap();

    let sheet_comments = match comments.get_mut(&active_sheet) {
        Some(sc) => sc,
        None => {
            return CommentResult {
                success: false,
                comment: None,
                error: Some("No comments found on this sheet.".to_string()),
            };
        }
    };

    // Find the comment and its current key
    let mut old_key: Option<(u32, u32)> = None;
    for (key, comment) in sheet_comments.iter() {
        if comment.id == comment_id {
            old_key = Some(*key);
            break;
        }
    }

    let old_key = match old_key {
        Some(k) => k,
        None => {
            return CommentResult {
                success: false,
                comment: None,
                error: Some(format!("Comment with ID '{}' not found.", comment_id)),
            };
        }
    };

    // Check if the new position already has a comment
    let new_key = (new_row, new_col);
    if sheet_comments.contains_key(&new_key) && old_key != new_key {
        return CommentResult {
            success: false,
            comment: None,
            error: Some("A comment already exists at the target cell.".to_string()),
        };
    }

    // Move the comment
    if let Some(mut comment) = sheet_comments.remove(&old_key) {
        comment.row = new_row;
        comment.col = new_col;
        comment.modified_at = Some(Utc::now().to_rfc3339());
        let result = comment.clone();
        sheet_comments.insert(new_key, comment);
        return CommentResult {
            success: true,
            comment: Some(result),
            error: None,
        };
    }

    CommentResult {
        success: false,
        comment: None,
        error: Some("Failed to move comment.".to_string()),
    }
}

/// Get the total count of comments on the current sheet.
#[tauri::command]
pub fn get_comment_count(
    state: State<AppState>,
) -> usize {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let comments = state.comments.lock().unwrap();

    comments
        .get(&active_sheet)
        .map(|sheet_comments| sheet_comments.len())
        .unwrap_or(0)
}

/// Check if a cell has a comment.
#[tauri::command]
pub fn has_comment(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> bool {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let comments = state.comments.lock().unwrap();

    comments
        .get(&active_sheet)
        .map(|sheet_comments| sheet_comments.contains_key(&(row, col)))
        .unwrap_or(false)
}

/// Clear all comments from the current sheet.
#[tauri::command]
pub fn clear_all_comments(
    state: State<AppState>,
) -> usize {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut comments = state.comments.lock().unwrap();

    comments
        .get_mut(&active_sheet)
        .map(|sheet_comments| {
            let count = sheet_comments.len();
            sheet_comments.clear();
            count
        })
        .unwrap_or(0)
}

/// Clear comments in a range (used when deleting rows/columns or clearing a range).
#[tauri::command]
pub fn clear_comments_in_range(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> usize {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut comments = state.comments.lock().unwrap();

    let sheet_comments = match comments.get_mut(&active_sheet) {
        Some(sc) => sc,
        None => return 0,
    };

    let keys_to_remove: Vec<(u32, u32)> = sheet_comments
        .keys()
        .filter(|(r, c)| {
            *r >= start_row && *r <= end_row &&
            *c >= start_col && *c <= end_col
        })
        .cloned()
        .collect();

    let count = keys_to_remove.len();
    for key in keys_to_remove {
        sheet_comments.remove(&key);
    }

    count
}
