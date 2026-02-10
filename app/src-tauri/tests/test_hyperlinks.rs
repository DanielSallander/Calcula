//! FILENAME: app/src-tauri/tests/test_hyperlinks.rs
//! PURPOSE: Tests for hyperlink functionality.

mod common;

use app_lib::{
    Hyperlink, HyperlinkType, HyperlinkStorage, InternalReference,
    hyperlinks::{is_valid_url, is_valid_email, parse_cell_reference},
};
use std::collections::HashMap;

// ============================================================================
// UNIT TESTS - Hyperlink Creation
// ============================================================================

#[test]
fn test_create_url_hyperlink() {
    let h = Hyperlink::new_url(0, 0, 0, "https://example.com".to_string());

    assert_eq!(h.row, 0);
    assert_eq!(h.col, 0);
    assert_eq!(h.sheet_index, 0);
    assert_eq!(h.link_type, HyperlinkType::Url);
    assert_eq!(h.target, "https://example.com");
    assert!(h.internal_ref.is_none());
    assert!(h.display_text.is_none());
    assert!(h.tooltip.is_none());
}

#[test]
fn test_create_file_hyperlink() {
    let h = Hyperlink::new_file(1, 2, 0, "C:\\Documents\\file.xlsx".to_string());

    assert_eq!(h.row, 1);
    assert_eq!(h.col, 2);
    assert_eq!(h.link_type, HyperlinkType::File);
    assert_eq!(h.target, "C:\\Documents\\file.xlsx");
}

#[test]
fn test_create_internal_hyperlink_same_sheet() {
    let h = Hyperlink::new_internal(0, 0, 0, None, "A1".to_string());

    assert_eq!(h.link_type, HyperlinkType::InternalReference);
    assert_eq!(h.target, "A1");

    let internal_ref = h.internal_ref.unwrap();
    assert!(internal_ref.sheet_name.is_none());
    assert_eq!(internal_ref.cell_reference, "A1");
}

#[test]
fn test_create_internal_hyperlink_other_sheet() {
    let h = Hyperlink::new_internal(0, 0, 0, Some("Sheet2".to_string()), "B5".to_string());

    assert_eq!(h.link_type, HyperlinkType::InternalReference);
    assert_eq!(h.target, "'Sheet2'!B5");

    let internal_ref = h.internal_ref.unwrap();
    assert_eq!(internal_ref.sheet_name, Some("Sheet2".to_string()));
    assert_eq!(internal_ref.cell_reference, "B5");
}

#[test]
fn test_create_email_hyperlink() {
    let h = Hyperlink::new_email(0, 0, 0, "test@example.com".to_string(), None);

    assert_eq!(h.link_type, HyperlinkType::Email);
    assert_eq!(h.target, "mailto:test@example.com");
}

#[test]
fn test_create_email_hyperlink_with_subject() {
    let h = Hyperlink::new_email(0, 0, 0, "test@example.com".to_string(), Some("Hello World".to_string()));

    assert_eq!(h.link_type, HyperlinkType::Email);
    assert!(h.target.starts_with("mailto:test@example.com?subject="));
    assert!(h.target.contains("Hello"));
}

// ============================================================================
// UNIT TESTS - Storage
// ============================================================================

#[test]
fn test_hyperlink_storage() {
    let mut storage: HyperlinkStorage = HashMap::new();

    // Add hyperlink to sheet 0
    let h1 = Hyperlink::new_url(0, 0, 0, "https://example.com".to_string());
    storage.entry(0).or_insert_with(HashMap::new).insert((0, 0), h1);

    // Add hyperlink to sheet 1
    let h2 = Hyperlink::new_url(1, 1, 1, "https://other.com".to_string());
    storage.entry(1).or_insert_with(HashMap::new).insert((1, 1), h2);

    assert!(storage.contains_key(&0));
    assert!(storage.contains_key(&1));
    assert!(!storage.contains_key(&2));

    assert!(storage.get(&0).unwrap().contains_key(&(0, 0)));
    assert!(storage.get(&1).unwrap().contains_key(&(1, 1)));
}

#[test]
fn test_hyperlink_storage_multiple_per_sheet() {
    let mut storage: HyperlinkStorage = HashMap::new();
    let sheet_hyperlinks = storage.entry(0).or_insert_with(HashMap::new);

    sheet_hyperlinks.insert((0, 0), Hyperlink::new_url(0, 0, 0, "https://a.com".to_string()));
    sheet_hyperlinks.insert((0, 1), Hyperlink::new_url(0, 1, 0, "https://b.com".to_string()));
    sheet_hyperlinks.insert((1, 0), Hyperlink::new_url(1, 0, 0, "https://c.com".to_string()));

    assert_eq!(storage.get(&0).unwrap().len(), 3);
}

// ============================================================================
// UNIT TESTS - Helper Functions
// ============================================================================

#[test]
fn test_is_valid_url() {
    assert!(is_valid_url("https://example.com"));
    assert!(is_valid_url("http://example.com"));
    assert!(is_valid_url("ftp://files.example.com"));
    assert!(is_valid_url("file:///C:/Documents/file.txt"));

    assert!(!is_valid_url("example.com"));
    assert!(!is_valid_url("www.example.com"));
    assert!(!is_valid_url("mailto:test@example.com"));
}

#[test]
fn test_is_valid_email() {
    assert!(is_valid_email("test@example.com"));
    assert!(is_valid_email("user.name@domain.co.uk"));
    assert!(is_valid_email("a@b.c"));

    assert!(!is_valid_email("test@"));
    assert!(!is_valid_email("@example.com"));
    assert!(!is_valid_email("test"));
    assert!(!is_valid_email("test@example"));
}

#[test]
fn test_parse_cell_reference() {
    // Basic references
    assert_eq!(parse_cell_reference("A1"), Some((0, 0)));
    assert_eq!(parse_cell_reference("B1"), Some((0, 1)));
    assert_eq!(parse_cell_reference("A2"), Some((1, 0)));
    assert_eq!(parse_cell_reference("B2"), Some((1, 1)));

    // Multi-letter columns
    assert_eq!(parse_cell_reference("AA1"), Some((0, 26)));
    assert_eq!(parse_cell_reference("AB1"), Some((0, 27)));
    assert_eq!(parse_cell_reference("AZ1"), Some((0, 51)));

    // Large row numbers
    assert_eq!(parse_cell_reference("A100"), Some((99, 0)));
    assert_eq!(parse_cell_reference("Z1000"), Some((999, 25)));

    // Case insensitive
    assert_eq!(parse_cell_reference("a1"), Some((0, 0)));
    assert_eq!(parse_cell_reference("aa1"), Some((0, 26)));

    // With whitespace
    assert_eq!(parse_cell_reference("  A1  "), Some((0, 0)));
}

#[test]
fn test_parse_cell_reference_invalid() {
    assert_eq!(parse_cell_reference(""), None);
    assert_eq!(parse_cell_reference("A"), None);
    assert_eq!(parse_cell_reference("1"), None);
    assert_eq!(parse_cell_reference("1A"), None);
}

// ============================================================================
// INTEGRATION TESTS - Using TestHarness
// ============================================================================

#[test]
fn test_add_and_get_hyperlink() {
    let harness = common::TestHarness::new();

    // Add a hyperlink
    {
        let mut hyperlinks = harness.state.hyperlinks.lock().unwrap();
        let h = Hyperlink::new_url(0, 0, 0, "https://example.com".to_string());
        hyperlinks.entry(0).or_insert_with(HashMap::new).insert((0, 0), h);
    }

    // Retrieve it
    {
        let hyperlinks = harness.state.hyperlinks.lock().unwrap();
        let h = hyperlinks.get(&0).unwrap().get(&(0, 0)).unwrap();
        assert_eq!(h.target, "https://example.com");
    }
}

#[test]
fn test_remove_hyperlink() {
    let harness = common::TestHarness::new();

    // Add hyperlinks
    {
        let mut hyperlinks = harness.state.hyperlinks.lock().unwrap();
        let sheet = hyperlinks.entry(0).or_insert_with(HashMap::new);
        sheet.insert((0, 0), Hyperlink::new_url(0, 0, 0, "https://a.com".to_string()));
        sheet.insert((0, 1), Hyperlink::new_url(0, 1, 0, "https://b.com".to_string()));
    }

    // Remove one
    {
        let mut hyperlinks = harness.state.hyperlinks.lock().unwrap();
        let sheet = hyperlinks.get_mut(&0).unwrap();
        sheet.remove(&(0, 0));
    }

    // Verify
    {
        let hyperlinks = harness.state.hyperlinks.lock().unwrap();
        let sheet = hyperlinks.get(&0).unwrap();
        assert!(!sheet.contains_key(&(0, 0)));
        assert!(sheet.contains_key(&(0, 1)));
    }
}

#[test]
fn test_clear_hyperlinks_in_range() {
    let harness = common::TestHarness::new();

    // Add hyperlinks in a 3x3 grid
    {
        let mut hyperlinks = harness.state.hyperlinks.lock().unwrap();
        let sheet = hyperlinks.entry(0).or_insert_with(HashMap::new);
        for r in 0..3 {
            for c in 0..3 {
                sheet.insert((r, c), Hyperlink::new_url(r, c, 0, format!("https://{}{}.com", r, c)));
            }
        }
    }

    // Clear range (1,1) to (2,2)
    {
        let mut hyperlinks = harness.state.hyperlinks.lock().unwrap();
        let sheet = hyperlinks.get_mut(&0).unwrap();
        let keys_to_remove: Vec<_> = sheet.keys()
            .filter(|(r, c)| *r >= 1 && *r <= 2 && *c >= 1 && *c <= 2)
            .cloned()
            .collect();
        for key in keys_to_remove {
            sheet.remove(&key);
        }
    }

    // Verify: (0,0), (0,1), (0,2), (1,0), (2,0) should remain
    {
        let hyperlinks = harness.state.hyperlinks.lock().unwrap();
        let sheet = hyperlinks.get(&0).unwrap();

        // These should remain
        assert!(sheet.contains_key(&(0, 0)));
        assert!(sheet.contains_key(&(0, 1)));
        assert!(sheet.contains_key(&(0, 2)));
        assert!(sheet.contains_key(&(1, 0)));
        assert!(sheet.contains_key(&(2, 0)));

        // These should be removed
        assert!(!sheet.contains_key(&(1, 1)));
        assert!(!sheet.contains_key(&(1, 2)));
        assert!(!sheet.contains_key(&(2, 1)));
        assert!(!sheet.contains_key(&(2, 2)));
    }
}

#[test]
fn test_move_hyperlink() {
    let harness = common::TestHarness::new();

    // Add a hyperlink
    {
        let mut hyperlinks = harness.state.hyperlinks.lock().unwrap();
        let sheet = hyperlinks.entry(0).or_insert_with(HashMap::new);
        let mut h = Hyperlink::new_url(0, 0, 0, "https://example.com".to_string());
        h.display_text = Some("Example".to_string());
        sheet.insert((0, 0), h);
    }

    // Move it
    {
        let mut hyperlinks = harness.state.hyperlinks.lock().unwrap();
        let sheet = hyperlinks.get_mut(&0).unwrap();
        if let Some(mut h) = sheet.remove(&(0, 0)) {
            h.row = 5;
            h.col = 5;
            sheet.insert((5, 5), h);
        }
    }

    // Verify
    {
        let hyperlinks = harness.state.hyperlinks.lock().unwrap();
        let sheet = hyperlinks.get(&0).unwrap();

        assert!(!sheet.contains_key(&(0, 0)));
        assert!(sheet.contains_key(&(5, 5)));

        let h = sheet.get(&(5, 5)).unwrap();
        assert_eq!(h.target, "https://example.com");
        assert_eq!(h.display_text, Some("Example".to_string()));
        assert_eq!(h.row, 5);
        assert_eq!(h.col, 5);
    }
}

#[test]
fn test_hyperlink_with_display_text_and_tooltip() {
    let harness = common::TestHarness::new();

    {
        let mut hyperlinks = harness.state.hyperlinks.lock().unwrap();
        let sheet = hyperlinks.entry(0).or_insert_with(HashMap::new);

        let mut h = Hyperlink::new_url(0, 0, 0, "https://example.com".to_string());
        h.display_text = Some("Click here".to_string());
        h.tooltip = Some("Opens example.com".to_string());
        sheet.insert((0, 0), h);
    }

    {
        let hyperlinks = harness.state.hyperlinks.lock().unwrap();
        let h = hyperlinks.get(&0).unwrap().get(&(0, 0)).unwrap();

        assert_eq!(h.display_text, Some("Click here".to_string()));
        assert_eq!(h.tooltip, Some("Opens example.com".to_string()));
    }
}

#[test]
fn test_hyperlinks_across_sheets() {
    let harness = common::TestHarness::with_multiple_sheets(3);

    // Add hyperlinks to different sheets
    {
        let mut hyperlinks = harness.state.hyperlinks.lock().unwrap();

        hyperlinks.entry(0).or_insert_with(HashMap::new)
            .insert((0, 0), Hyperlink::new_url(0, 0, 0, "https://sheet1.com".to_string()));

        hyperlinks.entry(1).or_insert_with(HashMap::new)
            .insert((0, 0), Hyperlink::new_url(0, 0, 1, "https://sheet2.com".to_string()));

        hyperlinks.entry(2).or_insert_with(HashMap::new)
            .insert((0, 0), Hyperlink::new_url(0, 0, 2, "https://sheet3.com".to_string()));
    }

    // Verify each sheet has its own hyperlink
    {
        let hyperlinks = harness.state.hyperlinks.lock().unwrap();

        assert_eq!(hyperlinks.get(&0).unwrap().get(&(0, 0)).unwrap().target, "https://sheet1.com");
        assert_eq!(hyperlinks.get(&1).unwrap().get(&(0, 0)).unwrap().target, "https://sheet2.com");
        assert_eq!(hyperlinks.get(&2).unwrap().get(&(0, 0)).unwrap().target, "https://sheet3.com");
    }
}

#[test]
fn test_hyperlink_types_serialization() {
    // Test that HyperlinkType serializes correctly for frontend
    let url_type = HyperlinkType::Url;
    let file_type = HyperlinkType::File;
    let internal_type = HyperlinkType::InternalReference;
    let email_type = HyperlinkType::Email;

    assert_eq!(serde_json::to_string(&url_type).unwrap(), "\"url\"");
    assert_eq!(serde_json::to_string(&file_type).unwrap(), "\"file\"");
    assert_eq!(serde_json::to_string(&internal_type).unwrap(), "\"internalReference\"");
    assert_eq!(serde_json::to_string(&email_type).unwrap(), "\"email\"");
}

#[test]
fn test_hyperlink_json_serialization() {
    let h = Hyperlink::new_url(1, 2, 0, "https://example.com".to_string());
    let json = serde_json::to_string(&h).unwrap();

    // Should use camelCase
    assert!(json.contains("\"linkType\""));
    assert!(json.contains("\"sheetIndex\""));
    assert!(!json.contains("\"link_type\""));
    assert!(!json.contains("\"sheet_index\""));
}
