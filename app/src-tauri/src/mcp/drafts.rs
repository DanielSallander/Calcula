//! FILENAME: app/src-tauri/src/mcp/drafts.rs
//! PURPOSE: `draft_object_script` — let an AI client AUTHOR an object script and
//!          hand it to the user for review, without ever mounting or running it.
//! CONTEXT: This is the "AI as automation co-author" tool. The agent writes the
//!          macro; the human reads it in the Object Script Editor and decides
//!          whether it becomes live code. Nothing here executes JavaScript.
//!
//!          WHY DRAFTS ARE NOT `AppState.object_scripts`
//!          -------------------------------------------
//!          Saving into `AppState.object_scripts` would NOT have been "saving
//!          it unmounted". The ScriptableObjects extension's `loadAndMountScripts`
//!          registers and MOUNTS every LOCAL object script on workbook load with
//!          no per-script consent (only the global Script Security gate). So a
//!          draft written into that collection is code that runs the next time
//!          the file is opened — the exact opposite of "the user reviews and
//!          mounts it". Drafts therefore live in a SEPARATE, PROCESS-LOCAL store
//!          that:
//!            * is never persisted into the .cala workbook,
//!            * is never read by the mount path,
//!            * does not survive an app restart,
//!            * has no code path to any script runtime — the only things this
//!              module does with `source` are store it, count its lines, and
//!              read `// @capability` pragmas out of it.
//!          Promotion to a real, mountable object script is a HUMAN action in
//!          the editor (save_object_script, which is window-guarded to the main
//!          window and the editor window — an MCP client cannot reach it).
//!
//!          The store is a process-global `OnceLock<Mutex<..>>` rather than
//!          Tauri managed state on purpose: managed state must be registered in
//!          lib.rs's builder, and a review queue that outlives nothing and
//!          persists nowhere has no business in the workbook's state graph.
//!
//!          CAPABILITY TRANSPARENCY: the draft's `// @capability <id>` pragmas
//!          are parsed with the SAME authoritative parser
//!          (`persistence::parse_declared_capabilities`) that derives a local
//!          script's R19 ceiling on save, and surfaced in the tool's response
//!          and in `list_script_drafts`. The reviewer sees what the code would
//!          be allowed to ask for BEFORE mounting it, not after.

use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager};

use super::objects::{audit, gate};
use crate::scripting::types::ScriptState;

/// Hard ceiling on one drafted script's source. Generous for a macro, small
/// enough that a runaway generation cannot balloon process memory.
const MAX_DRAFT_SOURCE_BYTES: usize = 256 * 1024;

/// How many drafts the session keeps. Oldest-first eviction; a review queue is
/// a queue, not an archive.
const MAX_DRAFTS: usize = 50;

/// One AI-authored object script awaiting human review.
///
/// Deliberately NOT `persistence::SavedObjectScript`: a draft is a review
/// artifact, not workbook content, and giving it the workbook type would invite
/// someone to "just persist it".
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDraft {
    /// Draft id (NOT an object-script id — the editor assigns that on save).
    pub id: String,
    pub name: String,
    /// Target object type ("button", "chart", "sheet", "workbook", ...).
    pub object_type: String,
    /// Target instance id for component objects; None for primitives.
    pub instance_id: Option<String>,
    pub description: Option<String>,
    pub source: String,
    /// Capability ids the source declares via `// @capability` pragmas.
    pub declared_capabilities: Vec<String>,
    /// ISO-8601 creation time.
    pub created_at: String,
    /// Always false, always. Present so every consumer of this struct — the
    /// tool response, the editor payload, a future UI — states the invariant
    /// rather than assuming it.
    pub mounted: bool,
}

/// Process-local review queue. See the module docs for why it is not managed
/// state and not `AppState.object_scripts`.
fn store() -> &'static Mutex<Vec<ScriptDraft>> {
    static STORE: OnceLock<Mutex<Vec<ScriptDraft>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Vec::new()))
}

/// The object types a draft may target — the same set
/// `object_script_commands::string_to_object_type` accepts, so a draft the user
/// approves can actually be saved. Validated here so the AI gets the error at
/// draft time instead of the user getting it at save time.
const VALID_OBJECT_TYPES: &[&str] = &[
    "workbook",
    "sheet",
    "cell",
    "row",
    "column",
    "slicer",
    "chart",
    "pivot",
    "button",
    "textbox",
    "timeline",
    "shape",
    "table",
    "namedRange",
    "panel",
    "range",
];

/// Validate the draft's arguments. Pure — unit-tested.
pub(crate) fn validate_draft(
    name: &str,
    object_type: &str,
    source: &str,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("draft_object_script needs a non-empty name.".to_string());
    }
    if !VALID_OBJECT_TYPES.contains(&object_type) {
        return Err(format!(
            "Unknown object type '{}'. Use one of: {}.",
            object_type,
            VALID_OBJECT_TYPES.join(", ")
        ));
    }
    if source.trim().is_empty() {
        return Err("draft_object_script needs non-empty source code.".to_string());
    }
    if source.len() > MAX_DRAFT_SOURCE_BYTES {
        return Err(format!(
            "Script source too large ({} bytes, max {}).",
            source.len(),
            MAX_DRAFT_SOURCE_BYTES
        ));
    }
    Ok(())
}

/// Build a draft record. Pure apart from the clock — no store, no app handle,
/// no execution. Unit-tested.
pub(crate) fn build_draft(
    name: &str,
    object_type: &str,
    instance_id: Option<&str>,
    description: Option<&str>,
    source: &str,
) -> Result<ScriptDraft, String> {
    validate_draft(name, object_type, source)?;
    Ok(ScriptDraft {
        id: format!("draft-{}", uuid::Uuid::new_v4().simple()),
        name: name.trim().to_string(),
        object_type: object_type.to_string(),
        instance_id: instance_id.map(|s| s.to_string()),
        description: description.map(|s| s.to_string()),
        // The AUTHORITATIVE local-script ceiling parser. A draft that declares
        // nothing is a grid-only script, and the reviewer is told so.
        declared_capabilities: persistence::parse_declared_capabilities(source),
        source: source.to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        mounted: false,
    })
}

/// Insert a draft into the session queue, evicting the oldest past the cap.
fn remember(draft: ScriptDraft) -> Result<(), String> {
    let mut drafts = store().lock().map_err(|e| e.to_string())?;
    drafts.push(draft);
    while drafts.len() > MAX_DRAFTS {
        drafts.remove(0);
    }
    Ok(())
}

/// Every draft in this session, oldest first.
pub(crate) fn all_drafts() -> Vec<ScriptDraft> {
    store()
        .lock()
        .map(|d| d.clone())
        .unwrap_or_default()
}

/// Look one draft up by id.
pub(crate) fn find_draft(id: &str) -> Option<ScriptDraft> {
    store()
        .lock()
        .ok()
        .and_then(|d| d.iter().find(|x| x.id == id).cloned())
}

/// Clear the queue. Test-only today; the session store is dropped with the
/// process otherwise.
#[cfg(test)]
pub(crate) fn clear_drafts() {
    if let Ok(mut drafts) = store().lock() {
        drafts.clear();
    }
}

/// Render a draft inventory. Pure — unit-tested.
pub(crate) fn format_draft_inventory(drafts: &[ScriptDraft]) -> String {
    let mut out = String::new();
    for d in drafts {
        let caps = if d.declared_capabilities.is_empty() {
            "none (grid-only)".to_string()
        } else {
            d.declared_capabilities.join(", ")
        };
        out.push_str(&format!(
            "- id={} name=\"{}\" target={}{} lines={} capabilities=[{}] mounted={}\n",
            d.id,
            d.name,
            d.object_type,
            d.instance_id
                .as_deref()
                .map(|i| format!("/{}", i))
                .unwrap_or_default(),
            d.source.lines().count(),
            caps,
            d.mounted,
        ));
    }
    out
}

// ============================================================================
// Tools
// ============================================================================

/// DRAFT an object script for the user to review.
///
/// Writes the source into this session's review queue and asks the Object
/// Script Editor to open it. It does NOT save the script into the workbook, does
/// NOT mount it, and does NOT execute it — there is no call into any script
/// runtime anywhere in this file. Turning a draft into running code is the
/// user's action in the editor.
pub fn draft_object_script(
    handle: &AppHandle,
    name: &str,
    object_type: &str,
    instance_id: Option<&str>,
    description: Option<&str>,
    source: &str,
) -> Result<String, String> {
    {
        let script_state = handle.state::<ScriptState>();
        gate(&script_state, "draft_object_script")?;
    }

    let draft = build_draft(name, object_type, instance_id, description, source)?;
    remember(draft.clone())?;

    // Offer the draft to the frontend for review. The payload carries the FULL
    // draft, because the editor window has no access to this process-local
    // store, and `mounted: false` states the contract on the wire.
    //
    // Deliberately its OWN event rather than the ScriptableObjects extension's
    // `objscript:open-with-script`: that channel carries a SAVED object script's
    // id and the editor resolves it through `get_object_script`, which a draft
    // id cannot satisfy — reusing it would produce a "script not found" error
    // instead of a review view. A draft is a different thing and says so.
    let _ = handle.emit("mcp:script-draft", &draft);

    // A draft changes nothing persisted, so the document is NOT marked dirty.
    audit(
        handle,
        "draft_object_script",
        &format!(
            "An AI tool drafted object script \"{}\" for {} — NOT mounted, awaiting review",
            draft.name, draft.object_type
        ),
        vec![
            ("draftId", serde_json::json!(draft.id)),
            ("name", serde_json::json!(draft.name)),
            ("objectType", serde_json::json!(draft.object_type)),
            ("instanceId", serde_json::json!(draft.instance_id)),
            ("declaredCapabilities", serde_json::json!(draft.declared_capabilities)),
            ("sourceLines", serde_json::json!(draft.source.lines().count())),
            ("mounted", serde_json::json!(false)),
        ],
    );

    let caps = if draft.declared_capabilities.is_empty() {
        "none (grid-only)".to_string()
    } else {
        draft.declared_capabilities.join(", ")
    };
    Ok(format!(
        "Drafted object script \"{}\" (id={}) for {}{}.\n\
         Declared capabilities: {}.\n\
         It is NOT mounted and NOT running: it is queued for the user to review in the \
         Object Script Editor and mount if they approve. Nothing you drafted has executed.",
        draft.name,
        draft.id,
        draft.object_type,
        draft
            .instance_id
            .as_deref()
            .map(|i| format!(" instance {}", i))
            .unwrap_or_default(),
        caps,
    ))
}

/// List the drafts authored in this session. Read-only.
pub fn list_script_drafts(handle: &AppHandle) -> Result<String, String> {
    {
        let script_state = handle.state::<ScriptState>();
        gate(&script_state, "list_script_drafts")?;
    }
    let drafts = all_drafts();
    if drafts.is_empty() {
        return Ok("(no script drafts in this session)".to_string());
    }
    let mut out = String::from("Script drafts awaiting review (none are mounted or running):\n");
    out.push_str(&format_draft_inventory(&drafts));
    out.push_str("\nUse get_script_draft(draftId) for a draft's full source.");
    Ok(out)
}

/// Return one draft's full source, so an agent can iterate on what it wrote.
/// Read-only.
pub fn get_script_draft(handle: &AppHandle, draft_id: &str) -> Result<String, String> {
    {
        let script_state = handle.state::<ScriptState>();
        gate(&script_state, "get_script_draft")?;
    }
    let draft = find_draft(draft_id).ok_or_else(|| {
        format!("No script draft with id '{}'. Use list_script_drafts to see draft ids.", draft_id)
    })?;
    serde_json::to_string_pretty(&draft).map_err(|e| e.to_string())
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// The draft store is process-global by design, so the tests that OBSERVE
    /// it must not run concurrently with each other. (Tests that only call the
    /// pure builders need no lock.)
    fn store_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    const SAMPLE: &str = "// @capability bi.query\n\
                          // @capability net.fetch https://example.com\n\
                          export function onClick() { Calcula.setCellValue(0, 0, 'hi'); }\n";

    #[test]
    fn a_draft_captures_the_source_and_its_declared_capability_ceiling() {
        let draft = build_draft(
            "Refresh Sales",
            "button",
            Some("btn-1"),
            Some("Refreshes the sales block"),
            SAMPLE,
        )
        .expect("valid draft");

        assert_eq!(draft.name, "Refresh Sales");
        assert_eq!(draft.object_type, "button");
        assert_eq!(draft.instance_id.as_deref(), Some("btn-1"));
        assert_eq!(draft.source, SAMPLE);
        // Parsed by the SAME parser that sets a saved local script's ceiling.
        assert_eq!(
            draft.declared_capabilities,
            vec!["bi.query".to_string(), "net.fetch".to_string()]
        );
        assert!(draft.id.starts_with("draft-"));
    }

    /// The invariant the whole feature rests on.
    #[test]
    fn a_draft_is_never_mounted() {
        let draft = build_draft("X", "workbook", None, None, "console.log(1);").unwrap();
        assert!(!draft.mounted, "a draft must never be marked mounted");
        // And it says so on the wire, too.
        let json = serde_json::to_value(&draft).unwrap();
        assert_eq!(json["mounted"], serde_json::json!(false));
    }

    /// Drafting is inert: the source is stored verbatim and nothing about the
    /// draft path evaluates it. A source whose mere EXECUTION would be
    /// observable (it would panic the QuickJS runtime budget / throw) round-
    /// trips unchanged and produces no error.
    #[test]
    fn drafting_stores_source_without_evaluating_it() {
        let _guard = store_guard();
        clear_drafts();
        let hostile = "while (true) { throw new Error('this must never run'); }";
        let draft = build_draft("Runaway", "sheet", None, None, hostile).unwrap();
        remember(draft.clone()).unwrap();

        // Stored byte-for-byte...
        let stored = find_draft(&draft.id).expect("draft is in the queue");
        assert_eq!(stored.source, hostile);
        // ...and it declared nothing, because it has no pragmas — the parser is
        // the only thing that ever looked at the text.
        assert!(stored.declared_capabilities.is_empty());
        assert!(!stored.mounted);
        clear_drafts();
    }

    /// The draft queue is separate from the workbook's object scripts, which is
    /// what keeps a draft out of the mount-on-load path.
    #[test]
    fn drafts_never_enter_the_workbooks_object_scripts() {
        let _guard = store_guard();
        clear_drafts();
        let state = crate::create_app_state();
        assert!(state.object_scripts.lock().unwrap().is_empty());

        let draft = build_draft("Sneaky", "button", Some("btn-9"), None, SAMPLE).unwrap();
        remember(draft.clone()).unwrap();

        // The draft is in the review queue...
        assert_eq!(all_drafts().len(), 1);
        // ...and the workbook — the collection `loadAndMountScripts` reads and
        // mounts on open — is untouched.
        assert!(
            state.object_scripts.lock().unwrap().is_empty(),
            "a draft must never land in AppState.object_scripts: local object \
             scripts there are MOUNTED on workbook load"
        );
        clear_drafts();
    }

    #[test]
    fn validation_rejects_empty_names_unknown_targets_oversized_and_empty_source() {
        assert!(validate_draft("  ", "button", "x").is_err());
        assert!(validate_draft("N", "spaceship", "x").is_err());
        assert!(validate_draft("N", "button", "   ").is_err());
        let huge = "x".repeat(MAX_DRAFT_SOURCE_BYTES + 1);
        assert!(validate_draft("N", "button", &huge).is_err());
        // Every accepted object type is one save_object_script would accept.
        for t in VALID_OBJECT_TYPES {
            assert!(validate_draft("N", t, "x").is_ok(), "type {} should be valid", t);
        }
    }

    #[test]
    fn the_queue_evicts_oldest_past_the_cap() {
        let _guard = store_guard();
        clear_drafts();
        for i in 0..(MAX_DRAFTS + 5) {
            let d = build_draft(&format!("S{}", i), "sheet", None, None, "x").unwrap();
            remember(d).unwrap();
        }
        let drafts = all_drafts();
        assert_eq!(drafts.len(), MAX_DRAFTS);
        // Oldest-first eviction: S0..S4 are gone, the newest survives.
        assert_eq!(drafts.first().unwrap().name, "S5");
        assert_eq!(drafts.last().unwrap().name, format!("S{}", MAX_DRAFTS + 4));
        clear_drafts();
    }

    #[test]
    fn draft_inventory_shows_the_target_capabilities_and_the_mounted_flag() {
        let a = build_draft("Refresh", "button", Some("btn-1"), None, SAMPLE).unwrap();
        let b = build_draft("Plain", "workbook", None, None, "let x = 1;\nlet y = 2;\n").unwrap();
        let out = format_draft_inventory(&[a, b]);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("target=button/btn-1"));
        assert!(lines[0].contains("capabilities=[bi.query, net.fetch]"));
        assert!(lines[0].contains("mounted=false"));
        assert!(lines[1].contains("target=workbook"));
        assert!(lines[1].contains("capabilities=[none (grid-only)]"));
        assert!(lines[1].contains("lines=2"));
    }

    #[test]
    fn draft_inventory_is_empty_for_none() {
        assert_eq!(format_draft_inventory(&[]), "");
    }
}
