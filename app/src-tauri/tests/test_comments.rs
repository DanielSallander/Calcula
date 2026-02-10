//! FILENAME: tests/test_comments.rs
//! Integration tests for comment commands.

mod common;

use app_lib::{Comment, CommentReply, CommentContentType};
use common::TestHarness;
use std::collections::HashMap;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

fn create_comment(author: &str, text: &str) -> Comment {
    Comment {
        id: uuid::Uuid::new_v4().to_string(),
        row: 0,
        col: 0,
        sheet_index: 0,
        author_email: format!("{}@example.com", author.to_lowercase()),
        author_name: author.to_string(),
        content: text.to_string(),
        rich_content: None,
        content_type: CommentContentType::Plain,
        mentions: Vec::new(),
        created_at: chrono::Utc::now().to_rfc3339(),
        modified_at: None,
        resolved: false,
        replies: Vec::new(),
    }
}

// ============================================================================
// BASIC COMMENT TESTS
// ============================================================================

#[test]
fn test_create_comment() {
    let comment = create_comment("John", "This is a test comment");

    assert_eq!(comment.author_name, "John");
    assert_eq!(comment.content, "This is a test comment");
    assert!(!comment.resolved);
    assert!(comment.replies.is_empty());
}

#[test]
fn test_comment_has_id() {
    let comment = create_comment("Jane", "Test");

    assert!(!comment.id.is_empty());
    // UUID format check (basic)
    assert!(comment.id.contains('-'));
}

#[test]
fn test_comment_has_timestamp() {
    let comment = create_comment("User", "Test");

    assert!(!comment.created_at.is_empty());
}

// ============================================================================
// COMMENT STORAGE TESTS
// ============================================================================

#[test]
fn test_add_comment_to_storage() {
    let harness = TestHarness::new();

    {
        let mut comments = harness.state.comments.lock().unwrap();

        // Create storage for sheet 0
        let mut sheet_comments: HashMap<(u32, u32), Comment> = HashMap::new();

        let mut comment = create_comment("User", "Test comment");
        comment.row = 0;
        comment.col = 0;
        sheet_comments.insert((0, 0), comment);

        comments.insert(0, sheet_comments);
    }

    let comments = harness.state.comments.lock().unwrap();
    assert!(comments.contains_key(&0));
    assert!(comments.get(&0).unwrap().contains_key(&(0, 0)));
}

#[test]
fn test_multiple_comments_per_sheet() {
    let harness = TestHarness::new();

    {
        let mut comments = harness.state.comments.lock().unwrap();
        let mut sheet_comments: HashMap<(u32, u32), Comment> = HashMap::new();

        // Add comments to different cells
        for i in 0..5 {
            let mut comment = create_comment("User", &format!("Comment {}", i));
            comment.row = i;
            comment.col = 0;
            sheet_comments.insert((i, 0), comment);
        }

        comments.insert(0, sheet_comments);
    }

    let comments = harness.state.comments.lock().unwrap();
    assert_eq!(comments.get(&0).unwrap().len(), 5);
}

#[test]
fn test_comments_multiple_sheets() {
    let harness = TestHarness::with_multiple_sheets(3);

    {
        let mut comments = harness.state.comments.lock().unwrap();

        for sheet_idx in 0..3 {
            let mut sheet_comments: HashMap<(u32, u32), Comment> = HashMap::new();
            let mut comment = create_comment("User", &format!("Sheet {} comment", sheet_idx));
            comment.row = 0;
            comment.col = 0;
            sheet_comments.insert((0, 0), comment);
            comments.insert(sheet_idx, sheet_comments);
        }
    }

    let comments = harness.state.comments.lock().unwrap();
    assert_eq!(comments.len(), 3);
}

// ============================================================================
// UPDATE COMMENT TESTS
// ============================================================================

#[test]
fn test_update_comment_text() {
    let harness = TestHarness::new();

    {
        let mut comments = harness.state.comments.lock().unwrap();
        let mut sheet_comments: HashMap<(u32, u32), Comment> = HashMap::new();

        let mut comment = create_comment("User", "Original text");
        comment.row = 0;
        comment.col = 0;
        sheet_comments.insert((0, 0), comment);
        comments.insert(0, sheet_comments);
    }

    // Update
    {
        let mut comments = harness.state.comments.lock().unwrap();
        if let Some(sheet_comments) = comments.get_mut(&0) {
            if let Some(comment) = sheet_comments.get_mut(&(0, 0)) {
                comment.content = "Updated text".to_string();
                comment.modified_at = Some(chrono::Utc::now().to_rfc3339());
            }
        }
    }

    let comments = harness.state.comments.lock().unwrap();
    let comment = comments.get(&0).unwrap().get(&(0, 0)).unwrap();
    assert_eq!(comment.content, "Updated text");
    assert!(comment.modified_at.is_some());
}

// ============================================================================
// DELETE COMMENT TESTS
// ============================================================================

#[test]
fn test_delete_comment() {
    let harness = TestHarness::new();

    {
        let mut comments = harness.state.comments.lock().unwrap();
        let mut sheet_comments: HashMap<(u32, u32), Comment> = HashMap::new();

        let mut comment = create_comment("User", "To delete");
        comment.row = 0;
        comment.col = 0;
        sheet_comments.insert((0, 0), comment);
        comments.insert(0, sheet_comments);
    }

    // Delete
    {
        let mut comments = harness.state.comments.lock().unwrap();
        if let Some(sheet_comments) = comments.get_mut(&0) {
            sheet_comments.remove(&(0, 0));
        }
    }

    let comments = harness.state.comments.lock().unwrap();
    assert!(!comments.get(&0).unwrap().contains_key(&(0, 0)));
}

#[test]
fn test_clear_all_comments_for_sheet() {
    let harness = TestHarness::new();

    {
        let mut comments = harness.state.comments.lock().unwrap();
        let mut sheet_comments: HashMap<(u32, u32), Comment> = HashMap::new();

        for i in 0..10 {
            let mut comment = create_comment("User", &format!("Comment {}", i));
            comment.row = i;
            comment.col = 0;
            sheet_comments.insert((i, 0), comment);
        }

        comments.insert(0, sheet_comments);
    }

    // Clear all
    {
        let mut comments = harness.state.comments.lock().unwrap();
        if let Some(sheet_comments) = comments.get_mut(&0) {
            sheet_comments.clear();
        }
    }

    let comments = harness.state.comments.lock().unwrap();
    assert!(comments.get(&0).unwrap().is_empty());
}

// ============================================================================
// REPLY TESTS
// ============================================================================

#[test]
fn test_add_reply() {
    let harness = TestHarness::new();

    {
        let mut comments = harness.state.comments.lock().unwrap();
        let mut sheet_comments: HashMap<(u32, u32), Comment> = HashMap::new();

        let mut comment = create_comment("User1", "Original comment");
        comment.row = 0;
        comment.col = 0;
        sheet_comments.insert((0, 0), comment);
        comments.insert(0, sheet_comments);
    }

    // Add reply
    {
        let mut comments = harness.state.comments.lock().unwrap();
        if let Some(sheet_comments) = comments.get_mut(&0) {
            if let Some(comment) = sheet_comments.get_mut(&(0, 0)) {
                comment.replies.push(CommentReply {
                    id: uuid::Uuid::new_v4().to_string(),
                    author_email: "user2@example.com".to_string(),
                    author_name: "User2".to_string(),
                    content: "This is a reply".to_string(),
                    rich_content: None,
                    mentions: Vec::new(),
                    created_at: chrono::Utc::now().to_rfc3339(),
                    modified_at: None,
                });
            }
        }
    }

    let comments = harness.state.comments.lock().unwrap();
    let comment = comments.get(&0).unwrap().get(&(0, 0)).unwrap();
    assert_eq!(comment.replies.len(), 1);
    assert_eq!(comment.replies[0].author_name, "User2");
}

#[test]
fn test_multiple_replies() {
    let harness = TestHarness::new();

    {
        let mut comments = harness.state.comments.lock().unwrap();
        let mut sheet_comments: HashMap<(u32, u32), Comment> = HashMap::new();

        let mut comment = create_comment("User1", "Discussion topic");
        comment.row = 0;
        comment.col = 0;

        // Add multiple replies
        for i in 0..5 {
            comment.replies.push(CommentReply {
                id: uuid::Uuid::new_v4().to_string(),
                author_email: format!("user{}@example.com", i + 2),
                author_name: format!("User{}", i + 2),
                content: format!("Reply {}", i),
                rich_content: None,
                mentions: Vec::new(),
                created_at: chrono::Utc::now().to_rfc3339(),
                modified_at: None,
            });
        }

        sheet_comments.insert((0, 0), comment);
        comments.insert(0, sheet_comments);
    }

    let comments = harness.state.comments.lock().unwrap();
    let comment = comments.get(&0).unwrap().get(&(0, 0)).unwrap();
    assert_eq!(comment.replies.len(), 5);
}

#[test]
fn test_delete_reply() {
    let harness = TestHarness::new();

    let reply_id: String;

    {
        let mut comments = harness.state.comments.lock().unwrap();
        let mut sheet_comments: HashMap<(u32, u32), Comment> = HashMap::new();

        let mut comment = create_comment("User1", "Comment with reply");
        comment.row = 0;
        comment.col = 0;

        let reply = CommentReply {
            id: uuid::Uuid::new_v4().to_string(),
            author_email: "user2@example.com".to_string(),
            author_name: "User2".to_string(),
            content: "To delete".to_string(),
            rich_content: None,
            mentions: Vec::new(),
            created_at: chrono::Utc::now().to_rfc3339(),
            modified_at: None,
        };
        reply_id = reply.id.clone();
        comment.replies.push(reply);

        sheet_comments.insert((0, 0), comment);
        comments.insert(0, sheet_comments);
    }

    // Delete reply
    {
        let mut comments = harness.state.comments.lock().unwrap();
        if let Some(sheet_comments) = comments.get_mut(&0) {
            if let Some(comment) = sheet_comments.get_mut(&(0, 0)) {
                comment.replies.retain(|r| r.id != reply_id);
            }
        }
    }

    let comments = harness.state.comments.lock().unwrap();
    let comment = comments.get(&0).unwrap().get(&(0, 0)).unwrap();
    assert!(comment.replies.is_empty());
}

// ============================================================================
// RESOLVE TESTS
// ============================================================================

#[test]
fn test_resolve_comment() {
    let harness = TestHarness::new();

    {
        let mut comments = harness.state.comments.lock().unwrap();
        let mut sheet_comments: HashMap<(u32, u32), Comment> = HashMap::new();

        let mut comment = create_comment("User", "Issue to fix");
        comment.row = 0;
        comment.col = 0;
        sheet_comments.insert((0, 0), comment);
        comments.insert(0, sheet_comments);
    }

    // Resolve
    {
        let mut comments = harness.state.comments.lock().unwrap();
        if let Some(sheet_comments) = comments.get_mut(&0) {
            if let Some(comment) = sheet_comments.get_mut(&(0, 0)) {
                comment.resolved = true;
            }
        }
    }

    let comments = harness.state.comments.lock().unwrap();
    let comment = comments.get(&0).unwrap().get(&(0, 0)).unwrap();
    assert!(comment.resolved);
}

#[test]
fn test_unresolve_comment() {
    let harness = TestHarness::new();

    {
        let mut comments = harness.state.comments.lock().unwrap();
        let mut sheet_comments: HashMap<(u32, u32), Comment> = HashMap::new();

        let mut comment = create_comment("User", "Resolved issue");
        comment.row = 0;
        comment.col = 0;
        comment.resolved = true;
        sheet_comments.insert((0, 0), comment);
        comments.insert(0, sheet_comments);
    }

    // Unresolve
    {
        let mut comments = harness.state.comments.lock().unwrap();
        if let Some(sheet_comments) = comments.get_mut(&0) {
            if let Some(comment) = sheet_comments.get_mut(&(0, 0)) {
                comment.resolved = false;
            }
        }
    }

    let comments = harness.state.comments.lock().unwrap();
    let comment = comments.get(&0).unwrap().get(&(0, 0)).unwrap();
    assert!(!comment.resolved);
}

// ============================================================================
// MOVE COMMENT TESTS
// ============================================================================

#[test]
fn test_move_comment() {
    let harness = TestHarness::new();

    {
        let mut comments = harness.state.comments.lock().unwrap();
        let mut sheet_comments: HashMap<(u32, u32), Comment> = HashMap::new();

        let mut comment = create_comment("User", "Moving comment");
        comment.row = 0;
        comment.col = 0;
        sheet_comments.insert((0, 0), comment);
        comments.insert(0, sheet_comments);
    }

    // Move from (0,0) to (5,5)
    {
        let mut comments = harness.state.comments.lock().unwrap();
        if let Some(sheet_comments) = comments.get_mut(&0) {
            if let Some(mut comment) = sheet_comments.remove(&(0, 0)) {
                comment.row = 5;
                comment.col = 5;
                sheet_comments.insert((5, 5), comment);
            }
        }
    }

    let comments = harness.state.comments.lock().unwrap();
    assert!(!comments.get(&0).unwrap().contains_key(&(0, 0)));
    assert!(comments.get(&0).unwrap().contains_key(&(5, 5)));
}

// ============================================================================
// COMMENT COUNT TESTS
// ============================================================================

#[test]
fn test_get_comment_count() {
    let harness = TestHarness::new();

    {
        let mut comments = harness.state.comments.lock().unwrap();
        let mut sheet_comments: HashMap<(u32, u32), Comment> = HashMap::new();

        for i in 0..25 {
            let mut comment = create_comment("User", &format!("Comment {}", i));
            comment.row = i;
            comment.col = 0;
            sheet_comments.insert((i, 0), comment);
        }

        comments.insert(0, sheet_comments);
    }

    let comments = harness.state.comments.lock().unwrap();
    assert_eq!(comments.get(&0).unwrap().len(), 25);
}

#[test]
fn test_has_comment() {
    let harness = TestHarness::new();

    {
        let mut comments = harness.state.comments.lock().unwrap();
        let mut sheet_comments: HashMap<(u32, u32), Comment> = HashMap::new();

        let mut comment = create_comment("User", "Test");
        comment.row = 5;
        comment.col = 3;
        sheet_comments.insert((5, 3), comment);
        comments.insert(0, sheet_comments);
    }

    let comments = harness.state.comments.lock().unwrap();
    assert!(comments.get(&0).unwrap().contains_key(&(5, 3)));
    assert!(!comments.get(&0).unwrap().contains_key(&(0, 0)));
}

// ============================================================================
// EDGE CASES
// ============================================================================

#[test]
fn test_empty_comment_text() {
    let comment = create_comment("User", "");
    assert!(comment.content.is_empty());
}

#[test]
fn test_very_long_comment() {
    let long_text = "A".repeat(10000);
    let comment = create_comment("User", &long_text);
    assert_eq!(comment.content.len(), 10000);
}

#[test]
fn test_unicode_in_comment() {
    let comment = create_comment("用户", "这是一条评论 🎉");
    assert_eq!(comment.author_name, "用户");
    assert!(comment.content.contains("🎉"));
}

#[test]
fn test_empty_comments_storage() {
    let harness = TestHarness::new();
    let comments = harness.state.comments.lock().unwrap();
    assert!(comments.is_empty());
}
