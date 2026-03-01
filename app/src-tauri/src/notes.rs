//! FILENAME: app/src-tauri/src/notes.rs
//! PURPOSE: Legacy Notes (yellow sticky notes) for cell-level annotations.
//! CONTEXT: Provides Excel-like static notes attached to cells.
//! Notes are separate from Threaded Comments. A cell can have a Note OR a Comment, never both.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;
use crate::AppState;
use chrono::Utc;
use uuid::Uuid;

// ============================================================================
// TYPES
// ============================================================================

/// A legacy note (yellow sticky note) attached to a cell.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    /// Unique identifier for the note
    pub id: String,
    /// Row of the cell this note is attached to (0-indexed)
    pub row: u32,
    /// Column of the cell this note is attached to (0-indexed)
    pub col: u32,
    /// Sheet index this note belongs to
    pub sheet_index: usize,
    /// Display name of the note author
    pub author_name: String,
    /// Plain text content of the note
    pub content: String,
    /// Rich content (HTML) for formatted text
    pub rich_content: Option<String>,
    /// Width of the note box in pixels
    pub width: f64,
    /// Height of the note box in pixels
    pub height: f64,
    /// Whether the note box is persistently visible (vs only on hover)
    pub visible: bool,
    /// Creation timestamp (ISO 8601 format)
    pub created_at: String,
    /// Last modified timestamp (ISO 8601 format)
    pub modified_at: Option<String>,
}

impl Note {
    /// Create a new note with default size.
    pub fn new(
        row: u32,
        col: u32,
        sheet_index: usize,
        author_name: String,
        content: String,
    ) -> Self {
        let now = Utc::now().to_rfc3339();
        Note {
            id: Uuid::new_v4().to_string(),
            row,
            col,
            sheet_index,
            author_name,
            content,
            rich_content: None,
            width: 200.0,
            height: 100.0,
            visible: false,
            created_at: now,
            modified_at: None,
        }
    }

    /// Create a new note with custom size.
    pub fn new_with_size(
        row: u32,
        col: u32,
        sheet_index: usize,
        author_name: String,
        content: String,
        width: f64,
        height: f64,
    ) -> Self {
        let now = Utc::now().to_rfc3339();
        Note {
            id: Uuid::new_v4().to_string(),
            row,
            col,
            sheet_index,
            author_name,
            content,
            rich_content: None,
            width,
            height,
            visible: false,
            created_at: now,
            modified_at: None,
        }
    }

    /// Update the content of this note.
    pub fn update_content(&mut self, content: String) {
        self.content = content;
        self.rich_content = None;
        self.modified_at = Some(Utc::now().to_rfc3339());
    }

    /// Update the content with rich text.
    pub fn update_content_with_rich(&mut self, content: String, rich_content: String) {
        self.content = content;
        self.rich_content = Some(rich_content);
        self.modified_at = Some(Utc::now().to_rfc3339());
    }

    /// Resize the note box.
    pub fn resize(&mut self, width: f64, height: f64) {
        self.width = width;
        self.height = height;
        self.modified_at = Some(Utc::now().to_rfc3339());
    }
}

/// Storage for notes: sheet_index -> (row, col) -> Note
pub type NoteStorage = HashMap<usize, HashMap<(u32, u32), Note>>;

// ============================================================================
// API TYPES
// ============================================================================

/// Result of a note operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteResult {
    pub success: bool,
    pub note: Option<Note>,
    pub error: Option<String>,
}

/// Parameters for adding a note.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddNoteParams {
    pub row: u32,
    pub col: u32,
    pub author_name: String,
    pub content: String,
    pub rich_content: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

/// Parameters for updating a note.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNoteParams {
    pub note_id: String,
    pub content: String,
    pub rich_content: Option<String>,
}

/// Parameters for resizing a note.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeNoteParams {
    pub note_id: String,
    pub width: f64,
    pub height: f64,
}

/// Information about cells with notes (for rendering note markers).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteIndicator {
    pub row: u32,
    pub col: u32,
    pub visible: bool,
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Add a note to a cell. Fails if the cell already has a comment (mutual exclusivity).
#[tauri::command]
pub fn add_note(
    state: State<AppState>,
    params: AddNoteParams,
) -> NoteResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let key = (params.row, params.col);

    // Mutual exclusivity: check if cell has a comment
    {
        let comments = state.comments.lock().unwrap();
        if let Some(sheet_comments) = comments.get(&active_sheet) {
            if sheet_comments.contains_key(&key) {
                return NoteResult {
                    success: false,
                    note: None,
                    error: Some("Cell already has a Comment. Delete or convert it first.".to_string()),
                };
            }
        }
    }

    let mut notes = state.notes.lock().unwrap();
    let sheet_notes = notes.entry(active_sheet).or_insert_with(HashMap::new);

    // Check if a note already exists at this cell
    if sheet_notes.contains_key(&key) {
        return NoteResult {
            success: false,
            note: None,
            error: Some("A note already exists at this cell. Use update_note to modify it.".to_string()),
        };
    }

    // Create the note
    let note = if let (Some(width), Some(height)) = (params.width, params.height) {
        let mut n = Note::new_with_size(
            params.row,
            params.col,
            active_sheet,
            params.author_name,
            params.content,
            width,
            height,
        );
        if let Some(rich) = params.rich_content {
            n.rich_content = Some(rich);
        }
        n
    } else {
        let mut n = Note::new(
            params.row,
            params.col,
            active_sheet,
            params.author_name,
            params.content,
        );
        if let Some(rich) = params.rich_content {
            n.rich_content = Some(rich);
        }
        n
    };

    let result = note.clone();
    sheet_notes.insert(key, note);

    NoteResult {
        success: true,
        note: Some(result),
        error: None,
    }
}

/// Update an existing note's content.
#[tauri::command]
pub fn update_note(
    state: State<AppState>,
    params: UpdateNoteParams,
) -> NoteResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut notes = state.notes.lock().unwrap();

    let sheet_notes = match notes.get_mut(&active_sheet) {
        Some(sn) => sn,
        None => {
            return NoteResult {
                success: false,
                note: None,
                error: Some("No notes found on this sheet.".to_string()),
            };
        }
    };

    for note in sheet_notes.values_mut() {
        if note.id == params.note_id {
            if let Some(rich_content) = params.rich_content {
                note.update_content_with_rich(params.content, rich_content);
            } else {
                note.update_content(params.content);
            }
            return NoteResult {
                success: true,
                note: Some(note.clone()),
                error: None,
            };
        }
    }

    NoteResult {
        success: false,
        note: None,
        error: Some(format!("Note with ID '{}' not found.", params.note_id)),
    }
}

/// Delete a note.
#[tauri::command]
pub fn delete_note(
    state: State<AppState>,
    note_id: String,
) -> NoteResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut notes = state.notes.lock().unwrap();

    let sheet_notes = match notes.get_mut(&active_sheet) {
        Some(sn) => sn,
        None => {
            return NoteResult {
                success: false,
                note: None,
                error: Some("No notes found on this sheet.".to_string()),
            };
        }
    };

    let mut key_to_remove: Option<(u32, u32)> = None;
    for (key, note) in sheet_notes.iter() {
        if note.id == note_id {
            key_to_remove = Some(*key);
            break;
        }
    }

    if let Some(key) = key_to_remove {
        let removed = sheet_notes.remove(&key);
        return NoteResult {
            success: true,
            note: removed,
            error: None,
        };
    }

    NoteResult {
        success: false,
        note: None,
        error: Some(format!("Note with ID '{}' not found.", note_id)),
    }
}

/// Get a note at a specific cell.
#[tauri::command]
pub fn get_note(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> Option<Note> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let notes = state.notes.lock().unwrap();

    notes
        .get(&active_sheet)
        .and_then(|sheet_notes| sheet_notes.get(&(row, col)))
        .cloned()
}

/// Get a note by ID.
#[tauri::command]
pub fn get_note_by_id(
    state: State<AppState>,
    note_id: String,
) -> Option<Note> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let notes = state.notes.lock().unwrap();

    notes
        .get(&active_sheet)
        .and_then(|sheet_notes| {
            sheet_notes.values().find(|n| n.id == note_id).cloned()
        })
}

/// Get all notes for the current sheet.
#[tauri::command]
pub fn get_all_notes(
    state: State<AppState>,
) -> Vec<Note> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let notes = state.notes.lock().unwrap();

    notes
        .get(&active_sheet)
        .map(|sheet_notes| sheet_notes.values().cloned().collect())
        .unwrap_or_default()
}

/// Get note indicators for the current sheet (for rendering note markers).
#[tauri::command]
pub fn get_note_indicators(
    state: State<AppState>,
) -> Vec<NoteIndicator> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let notes = state.notes.lock().unwrap();

    notes
        .get(&active_sheet)
        .map(|sheet_notes| {
            sheet_notes
                .values()
                .map(|n| NoteIndicator {
                    row: n.row,
                    col: n.col,
                    visible: n.visible,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Get note indicators for a viewport range.
#[tauri::command]
pub fn get_note_indicators_in_range(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Vec<NoteIndicator> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let notes = state.notes.lock().unwrap();

    notes
        .get(&active_sheet)
        .map(|sheet_notes| {
            sheet_notes
                .values()
                .filter(|n| {
                    n.row >= start_row && n.row <= end_row &&
                    n.col >= start_col && n.col <= end_col
                })
                .map(|n| NoteIndicator {
                    row: n.row,
                    col: n.col,
                    visible: n.visible,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Resize a note's box dimensions.
#[tauri::command]
pub fn resize_note(
    state: State<AppState>,
    params: ResizeNoteParams,
) -> NoteResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut notes = state.notes.lock().unwrap();

    let sheet_notes = match notes.get_mut(&active_sheet) {
        Some(sn) => sn,
        None => {
            return NoteResult {
                success: false,
                note: None,
                error: Some("No notes found on this sheet.".to_string()),
            };
        }
    };

    for note in sheet_notes.values_mut() {
        if note.id == params.note_id {
            note.resize(params.width, params.height);
            return NoteResult {
                success: true,
                note: Some(note.clone()),
                error: None,
            };
        }
    }

    NoteResult {
        success: false,
        note: None,
        error: Some(format!("Note with ID '{}' not found.", params.note_id)),
    }
}

/// Toggle the visibility of a single note.
#[tauri::command]
pub fn toggle_note_visibility(
    state: State<AppState>,
    note_id: String,
    visible: bool,
) -> NoteResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut notes = state.notes.lock().unwrap();

    let sheet_notes = match notes.get_mut(&active_sheet) {
        Some(sn) => sn,
        None => {
            return NoteResult {
                success: false,
                note: None,
                error: Some("No notes found on this sheet.".to_string()),
            };
        }
    };

    for note in sheet_notes.values_mut() {
        if note.id == note_id {
            note.visible = visible;
            note.modified_at = Some(Utc::now().to_rfc3339());
            return NoteResult {
                success: true,
                note: Some(note.clone()),
                error: None,
            };
        }
    }

    NoteResult {
        success: false,
        note: None,
        error: Some(format!("Note with ID '{}' not found.", note_id)),
    }
}

/// Show or hide all notes on the current sheet.
/// Returns the number of notes affected.
#[tauri::command]
pub fn show_all_notes(
    state: State<AppState>,
    visible: bool,
) -> usize {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut notes = state.notes.lock().unwrap();

    let sheet_notes = match notes.get_mut(&active_sheet) {
        Some(sn) => sn,
        None => return 0,
    };

    let now = Utc::now().to_rfc3339();
    let mut count = 0;
    for note in sheet_notes.values_mut() {
        note.visible = visible;
        note.modified_at = Some(now.clone());
        count += 1;
    }

    count
}

/// Move a note to a different cell (used when rows/columns are inserted/deleted).
#[tauri::command]
pub fn move_note(
    state: State<AppState>,
    note_id: String,
    new_row: u32,
    new_col: u32,
) -> NoteResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut notes = state.notes.lock().unwrap();

    let sheet_notes = match notes.get_mut(&active_sheet) {
        Some(sn) => sn,
        None => {
            return NoteResult {
                success: false,
                note: None,
                error: Some("No notes found on this sheet.".to_string()),
            };
        }
    };

    // Find the note and its current key
    let mut old_key: Option<(u32, u32)> = None;
    for (key, note) in sheet_notes.iter() {
        if note.id == note_id {
            old_key = Some(*key);
            break;
        }
    }

    let old_key = match old_key {
        Some(k) => k,
        None => {
            return NoteResult {
                success: false,
                note: None,
                error: Some(format!("Note with ID '{}' not found.", note_id)),
            };
        }
    };

    // Check if the new position already has a note
    let new_key = (new_row, new_col);
    if sheet_notes.contains_key(&new_key) && old_key != new_key {
        return NoteResult {
            success: false,
            note: None,
            error: Some("A note already exists at the target cell.".to_string()),
        };
    }

    // Move the note
    if let Some(mut note) = sheet_notes.remove(&old_key) {
        note.row = new_row;
        note.col = new_col;
        note.modified_at = Some(Utc::now().to_rfc3339());
        let result = note.clone();
        sheet_notes.insert(new_key, note);
        return NoteResult {
            success: true,
            note: Some(result),
            error: None,
        };
    }

    NoteResult {
        success: false,
        note: None,
        error: Some("Failed to move note.".to_string()),
    }
}

/// Check if a cell has a note.
#[tauri::command]
pub fn has_note(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> bool {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let notes = state.notes.lock().unwrap();

    notes
        .get(&active_sheet)
        .map(|sheet_notes| sheet_notes.contains_key(&(row, col)))
        .unwrap_or(false)
}

/// Clear all notes from the current sheet.
#[tauri::command]
pub fn clear_all_notes(
    state: State<AppState>,
) -> usize {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut notes = state.notes.lock().unwrap();

    notes
        .get_mut(&active_sheet)
        .map(|sheet_notes| {
            let count = sheet_notes.len();
            sheet_notes.clear();
            count
        })
        .unwrap_or(0)
}

/// Clear notes in a range (used when deleting rows/columns or clearing a range).
#[tauri::command]
pub fn clear_notes_in_range(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> usize {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut notes = state.notes.lock().unwrap();

    let sheet_notes = match notes.get_mut(&active_sheet) {
        Some(sn) => sn,
        None => return 0,
    };

    let keys_to_remove: Vec<(u32, u32)> = sheet_notes
        .keys()
        .filter(|(r, c)| {
            *r >= start_row && *r <= end_row &&
            *c >= start_col && *c <= end_col
        })
        .cloned()
        .collect();

    let count = keys_to_remove.len();
    for key in keys_to_remove {
        sheet_notes.remove(&key);
    }

    count
}

/// Convert a note to a threaded comment.
/// Deletes the note and creates a comment with the same content.
#[tauri::command]
pub fn convert_note_to_comment(
    state: State<AppState>,
    note_id: String,
    author_email: String,
) -> crate::comments::CommentResult {
    let active_sheet = *state.active_sheet.lock().unwrap();

    // Find and remove the note
    let removed_note = {
        let mut notes = state.notes.lock().unwrap();
        let sheet_notes = match notes.get_mut(&active_sheet) {
            Some(sn) => sn,
            None => {
                return crate::comments::CommentResult {
                    success: false,
                    comment: None,
                    error: Some("No notes found on this sheet.".to_string()),
                };
            }
        };

        let mut key_to_remove: Option<(u32, u32)> = None;
        for (key, note) in sheet_notes.iter() {
            if note.id == note_id {
                key_to_remove = Some(*key);
                break;
            }
        }

        match key_to_remove {
            Some(key) => sheet_notes.remove(&key),
            None => {
                return crate::comments::CommentResult {
                    success: false,
                    comment: None,
                    error: Some(format!("Note with ID '{}' not found.", note_id)),
                };
            }
        }
    };

    let note = match removed_note {
        Some(n) => n,
        None => {
            return crate::comments::CommentResult {
                success: false,
                comment: None,
                error: Some("Failed to retrieve note for conversion.".to_string()),
            };
        }
    };

    // Create a comment with the note's content
    let comment = crate::comments::Comment::new(
        note.row,
        note.col,
        active_sheet,
        author_email,
        note.author_name.clone(),
        note.content.clone(),
    );

    let result = comment.clone();

    let mut comments = state.comments.lock().unwrap();
    let sheet_comments = comments.entry(active_sheet).or_insert_with(HashMap::new);
    sheet_comments.insert((note.row, note.col), comment);

    crate::comments::CommentResult {
        success: true,
        comment: Some(result),
        error: None,
    }
}
