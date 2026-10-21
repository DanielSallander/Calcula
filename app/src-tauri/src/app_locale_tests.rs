//! FILENAME: app/src-tauri/src/app_locale_tests.rs
//! PURPOSE: Tests for `app_locale`, the one authority for the application
//! locale: the startup value (a valid persisted override, else the OS regional
//! format), the persisted override file, `set_locale`'s order (validate, write,
//! install) and the test-isolation guarantee (no test shares a global locale).
//! CONTEXT: Every test that touches the settings file runs inside
//! `profile_dir::with_test_profile` or passes its own throwaway directory, so
//! the real `%LOCALAPPDATA%\Calcula` is never read or written. Locales are
//! compared by `locale_id` because `LocaleSettings` has no `PartialEq`.

use std::path::{Path, PathBuf};

use engine::{CellValue, Grid, LocaleSettings};

use crate::app_locale::{self, AppSettingsFile, APP_SETTINGS_FILE, LOCALE_CHANGED_EVENT};
use crate::locale_commands::set_locale_core;
use crate::profile_dir::with_test_profile;

/// A fresh, empty directory unique to this test (and this process).
fn scratch_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "calcula-app-locale-{}-{}",
        std::process::id(),
        name
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create the scratch dir");
    dir
}

fn write_raw(dir: &Path, text: &str) {
    std::fs::write(dir.join(APP_SETTINGS_FILE), text).expect("write the settings file");
}

fn read_file(dir: &Path) -> AppSettingsFile {
    let text = std::fs::read_to_string(dir.join(APP_SETTINGS_FILE)).expect("the settings file exists");
    serde_json::from_str(&text).expect("the settings file is valid JSON")
}

fn os_locale_id() -> String {
    crate::os_locale::system_locale_settings().locale_id
}

fn text_of(value: CellValue) -> String {
    match value {
        CellValue::Text(t) => t.to_string(),
        other => panic!("expected text, got {:?}", other),
    }
}

/// `TEXT(1234.5,"#,##0.00")` through the ordinary host wrapper, which builds
/// its `Evaluator` through `eval_budget::apply` -- the path the mirror feeds.
fn text_formula() -> String {
    let grid = Grid::new();
    text_of(crate::evaluate_formula(&grid, "=TEXT(1234.5,\"#,##0.00\")"))
}

fn locale_id_of(state: &crate::AppState) -> String {
    state.locale.lock().unwrap().locale_id.clone()
}

// ============================================================================
// 1-3. The startup value
// ============================================================================

#[test]
fn no_settings_file_gives_the_os_locale_and_no_override() {
    let dir = scratch_dir("no-file");
    let (locale, override_id) = with_test_profile(&dir, app_locale::startup_locale);
    assert_eq!(locale.locale_id, os_locale_id());
    assert_eq!(override_id, None);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_persisted_override_wins_at_startup_and_reaches_the_evaluator_only_when_installed() {
    let dir = scratch_dir("override-de");
    write_raw(&dir, r#"{"localeOverride":"de-DE"}"#);
    let (locale, override_id) = with_test_profile(&dir, app_locale::startup_locale);
    assert_eq!(locale.locale_id, "de-DE");
    assert_eq!(override_id.as_deref(), Some("de-DE"));

    // Inside the test slot the evaluator formats with the German separators...
    let inside = app_locale::with_test_display_locale(locale, text_formula);
    assert_eq!(inside, "1.234,50");
    // ...and the slot is restored on the way out: same thread, invariant again.
    assert_eq!(app_locale::display_locale_opt().map(|l| l.locale_id), None);
    assert_eq!(text_formula(), "1,234.50");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_unknown_id_or_invalid_json_in_the_file_is_ignored_for_the_os_locale() {
    // THE BUG GUARD: `from_locale_id` answers en-US for any id it does not know,
    // so trusting the file would silently turn a Swedish machine American.
    for (name, raw) in [
        ("bad-id", r#"{"localeOverride":"xx-XX"}"#),
        ("bad-json", "{ this is not json"),
        ("wrong-type", r#"{"localeOverride":42}"#),
    ] {
        let dir = scratch_dir(name);
        write_raw(&dir, raw);
        let (locale, override_id) = with_test_profile(&dir, app_locale::startup_locale);
        assert_eq!(locale.locale_id, os_locale_id(), "{name}: must follow the OS");
        assert_eq!(override_id, None, "{name}: no override may be reported");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ============================================================================
// 4-7. set_locale: validate, write, install
// ============================================================================

#[test]
fn set_locale_persists_atomically_installs_and_reports_the_override() {
    let dir = scratch_dir("set-de");
    let state = crate::create_app_state();
    let data = set_locale_core(&state, &dir, "de-DE").expect("de-DE is supported");

    assert_eq!(read_file(&dir).locale_override.as_deref(), Some("de-DE"));
    let leftovers: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n != APP_SETTINGS_FILE)
        .collect();
    assert!(leftovers.is_empty(), "the atomic write left files behind: {leftovers:?}");

    assert_eq!(locale_id_of(&state), "de-DE");
    assert_eq!(data.locale_id, "de-DE");
    assert_eq!(data.override_id.as_deref(), Some("de-DE"));
    assert_eq!(data.decimal_separator, ",");
    assert_eq!(data.month_names_long[2], "M\u{00E4}rz");

    // The SAME id again is still an explicit choice and stays persisted.
    set_locale_core(&state, &dir, "de-DE").expect("re-selecting is fine");
    assert_eq!(read_file(&dir).locale_override.as_deref(), Some("de-DE"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn set_locale_system_removes_the_override_and_follows_the_os() {
    let dir = scratch_dir("set-system");
    let state = crate::create_app_state();
    set_locale_core(&state, &dir, "sv-SE").expect("sv-SE");
    assert_eq!(read_file(&dir).locale_override.as_deref(), Some("sv-SE"));

    let data = set_locale_core(&state, &dir, app_locale::SYSTEM_LOCALE_ID).expect("system");
    assert_eq!(read_file(&dir).locale_override, None);
    assert_eq!(data.override_id, None);
    assert_eq!(locale_id_of(&state), os_locale_id());
    // And a restart now follows the OS too.
    let (locale, override_id) = with_test_profile(&dir, app_locale::startup_locale);
    assert_eq!((locale.locale_id, override_id), (os_locale_id(), None));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn set_locale_refuses_an_unknown_id_and_changes_nothing() {
    let dir = scratch_dir("set-unknown");
    let state = crate::create_app_state();
    let before = locale_id_of(&state);
    let err = set_locale_core(&state, &dir, "nope").expect_err("unknown ids are refused");
    assert!(err.contains("nope"), "the refusal names the id: {err}");
    assert_eq!(locale_id_of(&state), before);
    assert!(!dir.join(APP_SETTINGS_FILE).exists(), "a refused id must not be persisted");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_failed_write_installs_nothing() {
    // The settings "directory" is a FILE, so creating the directory and writing
    // into it both fail on every platform (a read-only attribute on a Windows
    // directory does not stop files being created inside it).
    let parent = scratch_dir("write-fails");
    let not_a_dir = parent.join("occupied");
    std::fs::write(&not_a_dir, b"a file where the profile directory should be").unwrap();

    let state = crate::create_app_state();
    let before = locale_id_of(&state);
    let target = if before == "de-DE" { "fr-FR" } else { "de-DE" };
    let err = set_locale_core(&state, &not_a_dir, target).expect_err("the write must fail");
    assert!(err.contains("Could not save"), "unexpected error: {err}");
    assert_eq!(locale_id_of(&state), before, "the app and the disk must never disagree");
    let _ = std::fs::remove_dir_all(&parent);
}

// ============================================================================
// 8. No document state
// ============================================================================

/// The production text of a source file: everything before its first
/// `#[cfg(test)]`, with line comments dropped (a COMMENT must not satisfy or
/// fail a census -- memory build_comment_fabricates_call_edge).
fn production_code(src: &str) -> String {
    let cut = src.find("#[cfg(test)]").unwrap_or(src.len());
    src[..cut]
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn set_locale_creates_no_document_effect_and_leaves_the_workbook_clean() {
    let dir = scratch_dir("clean");
    let state = crate::create_app_state();
    let file = crate::persistence::FileState::default();
    assert!(!file.is_dirty());
    set_locale_core(&state, &dir, "fr-FR").expect("fr-FR");
    assert!(!file.is_dirty(), "a locale switch must not dirty the workbook");

    // Structural: the locale code constructs no DocumentEffect at all, so it
    // cannot dirty a workbook through any FileState it might be handed later.
    for (name, src) in [
        ("app_locale.rs", include_str!("app_locale.rs")),
        ("locale_commands.rs", include_str!("locale_commands.rs")),
    ] {
        let code = production_code(src);
        for needle in ["DocumentEffect::", "FileState", "mark_saved"] {
            assert!(!code.contains(needle), "{name} must not reach document state ({needle})");
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// ============================================================================
// 9. Tests never share a global locale
// ============================================================================

#[test]
fn installs_and_test_slots_never_cross_threads() {
    // create_app_state() installs -- on THIS thread nothing process-wide moves.
    let state = crate::create_app_state();
    crate::app_locale::install(&state, LocaleSettings::from_locale_id("de-DE"), Some("de-DE".into()));
    assert_eq!(locale_id_of(&state), "de-DE", "install always writes state.locale");
    assert_eq!(
        app_locale::display_locale_opt().map(|l| l.locale_id),
        None,
        "install must not write the evaluator mirror in a test build"
    );
    let other = std::thread::spawn(|| {
        let _ = crate::create_app_state();
        app_locale::display_locale_opt().map(|l| l.locale_id)
    })
    .join()
    .unwrap();
    assert_eq!(other, None, "create_app_state on another thread leaked a locale");
    assert_eq!(app_locale::display_locale_opt().map(|l| l.locale_id), None);

    // A test slot on this thread is invisible to another one.
    let seen_elsewhere = app_locale::with_test_display_locale(LocaleSettings::from_locale_id("de-DE"), || {
        assert_eq!(app_locale::display_locale().locale_id, "de-DE");
        std::thread::spawn(|| app_locale::display_locale_opt().map(|l| l.locale_id))
            .join()
            .unwrap()
    });
    assert_eq!(seen_elsewhere, None, "with_test_display_locale leaked across threads");
    assert_eq!(app_locale::display_locale().locale_id, LocaleSettings::invariant().locale_id);
}

// ============================================================================
// 10. The wire shape
// ============================================================================

#[test]
fn locale_settings_data_carries_the_calendar_in_camel_case() {
    let sv = crate::api_types::LocaleSettingsData::from(&LocaleSettings::from_locale_id("sv-SE"));
    let json = serde_json::to_value(&sv).unwrap();
    assert_eq!(json["overrideId"], serde_json::Value::Null);
    assert_eq!(json["quarterLabels"], serde_json::json!(["Kv1", "Kv2", "Kv3", "Kv4"]));
    assert_eq!(json["monthNamesShort"][9], "okt");
    assert_eq!(json["monthNamesLong"].as_array().unwrap().len(), 12);
    // Sunday first, as CalendarNames and the TS calendar expect.
    assert_eq!(json["dayNamesLong"][0], "s\u{00F6}ndag");
    assert_eq!(json["dayNamesShort"].as_array().unwrap().len(), 7);
    assert_eq!(
        serde_json::to_value(sv.with_override(Some("sv-SE".into()))).unwrap()["overrideId"],
        "sv-SE"
    );
    // The event name the TS listener subscribes to (also pinned by
    // crossLayerConstantDrift.test.ts against app/src/api/locale.ts).
    assert_eq!(LOCALE_CHANGED_EVENT, "locale:changed");
}
