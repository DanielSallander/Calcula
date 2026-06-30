//! FILENAME: app/src-tauri/src/security/window_guard.rs
//! PURPOSE: Window-label guards for dangerous Tauri commands (Wave 2, S4
//! backend defense-in-depth — docs/design/script-sandbox-architecture.md §7).
//!
//! The Monaco editor windows (chart-spec-editor, object-script-editor) should be
//! as inert as their capability files imply.
//! Without these guards any webview — including a compromised secondary
//! window — can call every registered command. Guards are data: each
//! dangerous command states which window labels may call it, so exceptions
//! (e.g. the object-script editor saving scripts from its own window) are
//! one reviewable line at the call site, not a special-cased code path.
//!
//! This does NOT constrain object scripts: their workers live in the main
//! window. Constraining them is the tier broker's job (§5). Two mechanisms,
//! two axes; neither substitutes for the other.

/// The main application window label.
pub const MAIN: &[&str] = &["main"];

/// Object-script CRUD is also legitimately called from the object-script
/// editor window (verified: ObjectScriptEditorApp saves from its own window).
pub const MAIN_AND_OBJECT_SCRIPT_EDITOR: &[&str] = &["main", "object-script-editor"];

/// Reject the call unless the invoking window's label is in `allowed`.
/// First line of every guarded command:
/// `crate::security::window_guard::require_label(&window, window_guard::MAIN)?;`
pub fn require_label(window: &tauri::Window, allowed: &[&str]) -> Result<(), String> {
    let label = window.label();
    if allowed.contains(&label) {
        Ok(())
    } else {
        crate::log_warn!(
            "SECURITY",
            "Blocked command invocation from window '{}' (allowed: {:?})",
            label,
            allowed
        );
        Err(format!("This command is not permitted from window '{}'.", label))
    }
}
