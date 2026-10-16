//! FILENAME: app/src-tauri/src/mcp/bindings.rs
//! PURPOSE: The AI tool surface for OBJECT PROPERTY BINDINGS (WP-D, D §3.20):
//!          `list_object_properties` (read), `set_object_property` (write a
//!          literal) and `set_object_binding` (bind a property to a formula, or
//!          clear the binding), shared by the MCP server and the in-app chat;
//!          plus the "Canvas objects" / "Bound properties" sections that
//!          `get_sheet_summary` appends.
//! CONTEXT: Same discipline as `mcp/objects.rs` (its header, tool for tool):
//!            1. The AI access ceiling FIRST, through `objects::gate` keyed by
//!               the tool name, so `objects::required_tier` is the one policy.
//!            2. The SAME op cores the `object_bindings` Tauri command runs
//!               (`object_bindings::handle_request_async` / `set_literal_core`),
//!               so an AI edit is gated, normalised, undone and evaluated
//!               exactly like the user's -- never a second implementation.
//!            3. The cores mint the `DocumentEffect` themselves, AFTER every
//!               gate that can still refuse, and only when something changes;
//!               so this module never marks the document dirty on its own (a
//!               refused or unchanged edit must leave it clean).
//!            4. Live refresh: a binding edit announces through the binding
//!               announcer (`object-bindings:changed`, emitted by the core); a
//!               literal write emits `mutation:refresh` with the domains the
//!               family's core reports, and a canvas-page literal also emits the
//!               canvas-layout event the `object_bindings` command emits.
//!            5. Audit: every write goes in with `BindingEditSource::Ai { tool }`,
//!               so the core writes the `record_mcp_tool_action` row (surface
//!               "mcp", op, objectKind, objectId, path, formula, ok, error) --
//!               accepted OR refused.
//!
//!          Formulas on this surface are INVARIANT (en-US: `,` separators, `.`
//!          decimals), whatever the user's locale; replies quote the stored text.
//!
//! LOCKS: nothing here holds a lock across a call into `object_bindings`; every
//! read below goes through `object_json` / `list_core`, which take and release
//! each store in the documented order (the binding store and its runtime are
//! leaves).

use std::collections::{BTreeMap, HashSet};
use std::future::Future;
use std::pin::Pin;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::api_types::{
    BindingEditSource, ObjectBindingInfo, ObjectBindingKind, ObjectBindingRef, ObjectBindingsRequest,
    ObjectBindingsResponse, ResolvedBinding,
};
use crate::object_bindings::store::BindingKey;
use crate::object_bindings::{self, catalog, eval, object_json, BindingCx};
use crate::AppState;

/// The tool names, as `objects::required_tier` and the audit rows spell them.
pub const LIST_OBJECT_PROPERTIES_TOOL: &str = "list_object_properties";
pub const SET_OBJECT_PROPERTY_TOOL: &str = "set_object_property";
pub const SET_OBJECT_BINDING_TOOL: &str = "set_object_binding";

/// Longest literal / display text a summary line quotes before it is cut with `…`.
pub const MAX_SUMMARY_VALUE_CHARS: usize = 80;

// ============================================================================
// Shared helpers
// ============================================================================

/// Everything an op reaches, borrowed from the app's managed states.
fn binding_cx(handle: &AppHandle) -> BindingCx<'_> {
    BindingCx {
        state: handle.state::<AppState>().inner(),
        file_state: handle.state::<crate::persistence::FileState>().inner(),
        slicers: handle.state::<crate::slicer::SlicerState>().inner(),
        timelines: handle.state::<crate::timeline_slicer::TimelineSlicerState>().inner(),
        pivots: handle.state::<crate::pivot::types::PivotState>().inner(),
        pane: handle.state::<crate::pane_control::PaneControlState>().inner(),
        ribbon: handle.state::<crate::ribbon_filter::RibbonFilterState>().inner(),
    }
}

/// Every kind's wire name, for a refusal that lists them.
fn kind_names() -> String {
    ObjectBindingKind::ALL.iter().map(|k| k.wire_name()).collect::<Vec<_>>().join(", ")
}

/// Parse a kind as the tools spell it (the wire name).
pub(crate) fn parse_kind(kind: &str) -> Result<ObjectBindingKind, String> {
    ObjectBindingKind::from_wire(kind.trim()).ok_or_else(|| {
        format!("'{}' is not an object kind. The kinds are: {}.", kind.trim(), kind_names())
    })
}

fn object_ref(kind: &str, id: &str) -> Result<ObjectBindingRef, String> {
    let kind = parse_kind(kind)?;
    let id = id.trim();
    if id.is_empty() {
        return Err(format!(
            "Pass the {}'s id. get_sheet_summary lists every canvas object with its id.",
            kind.label()
        ));
    }
    Ok(ObjectBindingRef { kind, id: id.to_string() })
}

fn not_found(object: &ObjectBindingRef) -> String {
    format!(
        "There is no {} with id '{}' in this workbook. get_sheet_summary lists every canvas object with its \
         id, and list_object_properties with sheet_index lists the objects of one sheet.",
        object.kind.label(),
        object.id
    )
}

/// "chart Revenue card" -- how a reply names an object.
fn describe(cx: &BindingCx<'_>, object: &ObjectBindingRef) -> String {
    match object_json::locate(&cx.stores(), object) {
        Some(location) => format!("{} {}", object.kind.label(), location.name),
        None => format!("{} {}", object.kind.label(), object.id),
    }
}

/// Cut `text` to [`MAX_SUMMARY_VALUE_CHARS`] characters, marking a cut with `…`.
pub(crate) fn truncate_value(text: &str) -> String {
    if text.chars().count() <= MAX_SUMMARY_VALUE_CHARS {
        return text.to_string();
    }
    let mut out: String = text.chars().take(MAX_SUMMARY_VALUE_CHARS - 1).collect();
    out.push('…');
    out
}

/// A text quoted the way a reply quotes it (JSON string escaping), then cut.
fn quoted(text: &str) -> String {
    truncate_value(&serde_json::to_string(text).unwrap_or_else(|_| format!("\"{text}\"")))
}

/// What a binding's current value reads as, after an arrow: `"display"`,
/// `ERROR: sentence`, `(pending ...)` or `(not evaluated yet)`.
pub(crate) fn resolved_text(resolved: Option<&ResolvedBinding>) -> String {
    match resolved {
        None => "(not evaluated yet)".to_string(),
        Some(r) if r.pending => "(pending: its measure is still being read)".to_string(),
        Some(r) => match &r.error {
            Some(why) => format!("ERROR: {why}"),
            None => quoted(&r.display),
        },
    }
}

/// One binding as a summary / reply line body: `path := formula -> value`.
pub(crate) fn binding_line(info: &ObjectBindingInfo) -> String {
    let mut line = format!("{} := {} -> {}", info.path, info.formula, resolved_text(info.resolved.as_ref()));
    if let Some(model) = &info.model {
        line.push_str(&format!(" (model {model})"));
    }
    line
}

/// Every binding (of `object`, when given) with a CURRENT value: any binding
/// the runtime has never evaluated (the frontend had not asked yet, or a
/// headless client is the only one driving the app) is evaluated first.
/// Resolved values are transient: this dirties nothing and records no undo.
fn evaluated_bindings(cx: &BindingCx<'_>, object: Option<&ObjectBindingRef>) -> Vec<ObjectBindingInfo> {
    let infos = object_bindings::list_core(cx, object);
    let missing: Vec<BindingKey> = infos
        .iter()
        .filter(|i| i.resolved.is_none())
        .map(|i| BindingKey { object: i.object.clone(), path: i.path.clone() })
        .collect();
    if missing.is_empty() {
        return infos;
    }
    eval::reevaluate(&cx.stores(), cx.pane, cx.ribbon, eval::Scope::Keys(missing));
    object_bindings::list_core(cx, object)
}

// ============================================================================
// The catalog, made concrete against one object's JSON
// ============================================================================

/// The concrete paths a catalog pattern names in `json`. A `*` segment is
/// expanded over what is there (array indices, map keys); a pattern whose `*`
/// has nothing to expand over yields nothing. A pattern without `*` is
/// returned as is, present or not.
pub(crate) fn expand_pattern(pattern: &str, json: &Value) -> Vec<String> {
    let segments: Vec<&str> = pattern.trim_start_matches('/').split('/').collect();
    let mut out: Vec<(String, Option<&Value>)> = vec![(String::new(), Some(json))];
    for seg in segments {
        let mut next: Vec<(String, Option<&Value>)> = Vec::new();
        for (prefix, value) in out {
            if seg == "*" {
                match value {
                    Some(Value::Array(items)) => {
                        for (i, item) in items.iter().enumerate() {
                            next.push((format!("{prefix}/{i}"), Some(item)));
                        }
                    }
                    Some(Value::Object(map)) => {
                        for (key, item) in map {
                            next.push((format!("{prefix}/{}", catalog::escape_segment(key)), Some(item)));
                        }
                    }
                    _ => {}
                }
            } else {
                let child = value.and_then(|v| v.get(seg));
                next.push((format!("{prefix}/{seg}"), child));
            }
        }
        out = next;
    }
    out.into_iter().map(|(path, _)| path).collect()
}

/// A person-readable label for a catalog path: the segments after the
/// object's root (`spec`, `properties`), camelCase split into words.
/// `/spec/xAxis/title` -> "x axis title"; `/properties/fontSize` -> "font size".
pub(crate) fn path_label(path: &str) -> String {
    let mut words: Vec<String> = Vec::new();
    for (i, seg) in path.trim_start_matches('/').split('/').enumerate() {
        if i == 0 && (seg == "spec" || seg == "properties") {
            continue;
        }
        let seg = catalog::unescape_segment(seg).unwrap_or_else(|| seg.to_string());
        let mut word = String::new();
        for c in seg.chars() {
            if c.is_ascii_uppercase() && !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
            word.push(c.to_ascii_lowercase());
        }
        if !word.is_empty() {
            words.push(word);
        }
    }
    words.join(" ")
}

/// The bindable properties of one object: every catalog row of its kind, its
/// `*` expanded against the object's JSON (a row with nothing to expand over is
/// listed as its pattern, so the AI still learns the property exists).
fn bindable_entries(kind: ObjectBindingKind, json: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for row in catalog::rows_of(kind) {
        let mut paths = expand_pattern(row.pointer, json);
        if paths.is_empty() {
            paths.push(row.pointer.to_string());
        }
        for path in paths {
            let mut entry = Map::new();
            entry.insert("label".into(), json!(path_label(&path)));
            entry.insert("path".into(), json!(path));
            entry.insert("type".into(), json!(row.value_type.wire_name()));
            if let catalog::BindableValueType::Enum(values) = row.value_type {
                entry.insert("values".into(), json!(values));
            }
            out.push(Value::Object(entry));
        }
    }
    out
}

// ============================================================================
// list_object_properties
// ============================================================================

/// The read tool, over plain states (unit-testable).
///
/// - `kind` + `id`: ONE object, as compact JSON: `{object, json, bindable,
///   bindings}`.
/// - `sheet_index`: every object on that sheet, one line each plus its
///   bindings (`path := formula -> value`).
/// - neither: an error naming `get_sheet_summary`.
pub(crate) fn list_object_properties_core(
    cx: &BindingCx<'_>,
    kind: Option<&str>,
    id: Option<&str>,
    sheet_index: Option<usize>,
) -> Result<String, String> {
    match (kind.filter(|k| !k.trim().is_empty()), id.filter(|i| !i.trim().is_empty())) {
        (Some(kind), Some(id)) => one_object(cx, &object_ref(kind, id)?),
        (Some(_), None) | (None, Some(_)) => Err(
            "Pass BOTH kind and id for one object (or sheet_index alone for every object on a sheet).".to_string(),
        ),
        (None, None) => match sheet_index {
            Some(index) => sheet_objects(cx, index),
            None => Err(
                "Pass kind and id for one object, or sheet_index for every object on a sheet. get_sheet_summary \
                 lists the objects of every canvas, with their ids, kinds and current properties."
                    .to_string(),
            ),
        },
    }
}

fn one_object(cx: &BindingCx<'_>, object: &ObjectBindingRef) -> Result<String, String> {
    let location = object_json::locate(&cx.stores(), object).ok_or_else(|| not_found(object))?;
    let json = object_json::object_json(&cx.stores(), object)?;
    let bindings: Vec<Value> = evaluated_bindings(cx, Some(object))
        .iter()
        .map(|b| {
            let resolved = b.resolved.as_ref();
            json!({
                "path": b.path,
                "formula": b.formula,
                "model": b.model,
                "display": resolved.map(|r| r.display.clone()),
                "error": resolved.and_then(|r| r.error.clone()),
                "pending": resolved.map_or(false, |r| r.pending),
            })
        })
        .collect();
    let bindable = bindable_entries(object.kind, &json);
    let out = json!({
        "object": {
            "kind": object.kind.wire_name(),
            "id": object.id,
            "name": location.name,
            "sheetIndex": location.sheet_index,
            "sheetName": location.sheet_name,
        },
        "json": json,
        "bindable": bindable,
        "bindings": bindings,
    });
    Ok(out.to_string())
}

fn sheet_objects(cx: &BindingCx<'_>, sheet_index: usize) -> Result<String, String> {
    let (name, is_canvas) = {
        let names = cx.state.sheet_names.read().map_err(|e| e.to_string())?;
        let name = names.get(sheet_index).cloned().ok_or_else(|| {
            format!(
                "Sheet index {} out of range (workbook has {} sheet(s)). list_sheets lists them.",
                sheet_index,
                names.len()
            )
        })?;
        drop(names);
        let kinds = cx.state.sheet_kinds.read().map_err(|e| e.to_string())?;
        (name, crate::sheets::is_canvas_sheet(&kinds, sheet_index))
    };
    let objects = object_json::list_objects_on_sheet(&cx.stores(), sheet_index);
    let bindings = evaluated_bindings(cx, None);
    let mut out = format!(
        "Objects on sheet \"{}\" (index={}, {}):\n",
        name,
        sheet_index,
        if is_canvas { "canvas" } else { "worksheet" }
    );
    if objects.is_empty() {
        out.push_str("(no objects)\n");
    }
    for (object, location) in &objects {
        let json = object_json::object_json(&cx.stores(), object).ok();
        out.push_str(&object_line(object, &location.name, json.as_ref()));
        out.push('\n');
        for info in bindings.iter().filter(|b| &b.object == object) {
            out.push_str(&format!("    {}\n", binding_line(info)));
        }
    }
    out.push_str(
        "Use list_object_properties with kind and id for one object's full JSON and every bindable path.",
    );
    Ok(out)
}

// ============================================================================
// set_object_property / set_object_binding
// ============================================================================

/// What `set_object_property` wrote: the reply, and the announcements the
/// handle wrapper owes (the core has no handle to emit through).
#[derive(Debug)]
pub(crate) struct PropertyWrite {
    pub reply: String,
    pub domains: Vec<String>,
    pub layout: Option<crate::sheets::CanvasLayoutChanged>,
}

/// Write the LITERAL at `path` through the family's own core (the
/// `SetLiteral` op). A literal that starts with `=` is TEXT, never a formula.
pub(crate) fn set_object_property_core(
    cx: &BindingCx<'_>,
    kind: &str,
    id: &str,
    path: &str,
    value: Value,
) -> Result<PropertyWrite, String> {
    let object = object_ref(kind, id)?;
    let shown = truncate_value(&value.to_string());
    let source = BindingEditSource::Ai { tool: SET_OBJECT_PROPERTY_TOOL.to_string() };
    let handled = object_bindings::set_literal_core(cx, &object, path, value, &source)?;
    let domains = match handled.response {
        ObjectBindingsResponse::LiteralSet { domains } => domains,
        _ => Vec::new(),
    };
    let what = describe(cx, &object);
    let mut reply = if domains.is_empty() {
        format!("{path} of {what} is already {shown}; nothing changed.")
    } else {
        format!("Set {path} of {what} to {shown} (one undo step).")
    };
    if let Some(bound) = object_bindings::list_core(cx, Some(&object)).into_iter().find(|b| b.path == path) {
        reply.push_str(&format!(
            " Note: this property is bound to {}, which is what it shows while the binding exists; clear the \
             binding with set_object_binding (formula omitted) to show this literal.",
            bound.formula
        ));
    }
    Ok(PropertyWrite { reply, domains, layout: handled.layout })
}

/// A boxed, `Send` future whose concrete type is ERASED.
pub(crate) type BoxedReply<'a> = Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;

/// Bind `path` of the object to `formula` (INVARIANT), or clear its binding
/// when `formula` is absent or empty. Runs the measure pass for the object's
/// page before answering (the `Set` op of the async dispatcher), so the reply
/// carries the value, not `pending`.
///
/// WHY THE FUTURE IS ERASED HERE: its concrete type nests the design-query
/// engine (DataFusion's session state) under five layers of async functions.
/// Proving that type `Send` at the far end of the in-app chat dispatcher (two
/// more layers plus Tauri's command wrapper) overflowed the trait solver's
/// recursion limit (E0275). Proving it once, here -- the same depth the
/// `object_bindings` command already proves -- and handing the callers a
/// `dyn Future + Send` keeps every caller shallow.
pub(crate) fn set_object_binding_core<'a>(
    cx: &'a BindingCx<'a>,
    bi: &'a crate::bi::types::BiState,
    kind: &'a str,
    id: &'a str,
    path: &'a str,
    formula: Option<&'a str>,
    model: Option<&'a str>,
) -> BoxedReply<'a> {
    Box::pin(set_object_binding_inner(cx, bi, kind, id, path, formula, model))
}

/// The async dispatcher's future, boxed and ERASED at the shallowest point:
/// proving its concrete type `Send` walks the design-query engine's types,
/// and every async layer wrapped around it before the proof spends the trait
/// solver's recursion budget (E0275 at 128).
fn dispatch<'a>(
    cx: &'a BindingCx<'a>,
    bi: &'a crate::bi::types::BiState,
    request: ObjectBindingsRequest,
) -> Pin<Box<dyn Future<Output = Result<object_bindings::Handled, String>> + Send + 'a>> {
    Box::pin(object_bindings::handle_request_async(cx, bi, request))
}

async fn set_object_binding_inner(
    cx: &BindingCx<'_>,
    bi: &crate::bi::types::BiState,
    kind: &str,
    id: &str,
    path: &str,
    formula: Option<&str>,
    model: Option<&str>,
) -> Result<String, String> {
    let object = object_ref(kind, id)?;
    let source = BindingEditSource::Ai { tool: SET_OBJECT_BINDING_TOOL.to_string() };
    let before = object_bindings::list_core(cx, Some(&object)).into_iter().find(|b| b.path == path);
    let formula = formula.map(str::trim).filter(|f| !f.is_empty());
    match formula {
        None => {
            let request = ObjectBindingsRequest::Clear { object: object.clone(), path: path.to_string(), source: Some(source) };
            let handled = dispatch(cx, bi, request).await?;
            let removed = matches!(handled.response, ObjectBindingsResponse::Cleared { removed: true });
            let what = describe(cx, &object);
            Ok(match (removed, before) {
                (true, Some(was)) => format!(
                    "Removed the binding of {path} on {what} (it was {}); the property shows its literal again (one \
                     undo step).",
                    was.formula
                ),
                (true, None) => format!("Removed the binding of {path} on {what} (one undo step)."),
                (false, _) => format!("{path} of {what} has no binding; nothing changed."),
            })
        }
        Some(text) => {
            let request = ObjectBindingsRequest::Set {
                object: object.clone(),
                path: path.to_string(),
                formula: text.to_string(),
                model: model.map(str::trim).filter(|m| !m.is_empty()).map(str::to_string),
                invariant: Some(true),
                source: Some(source),
            };
            let handled = dispatch(cx, bi, request).await?;
            let ObjectBindingsResponse::Binding { binding } = handled.response else {
                return Err("The binding was set but its answer could not be read.".to_string());
            };
            let unchanged = before
                .as_ref()
                .map_or(false, |b| b.formula == binding.formula && b.model == binding.model);
            let what = describe(cx, &object);
            let mut reply = format!(
                "Bound {} of {} to {} -> {}",
                binding.path,
                what,
                binding.formula,
                resolved_text(binding.resolved.as_ref())
            );
            if let Some(model) = &binding.model {
                reply.push_str(&format!(" (model {model})"));
            }
            reply.push_str(if unchanged {
                " (it was already bound to that formula; nothing changed)."
            } else {
                " (one undo step)."
            });
            Ok(reply)
        }
    }
}

// ============================================================================
// The tool entry points (AppHandle wrappers)
// ============================================================================

/// `list_object_properties`: read-only, no ceiling (like every list_* tool).
pub fn list_object_properties(
    handle: &AppHandle,
    kind: Option<&str>,
    id: Option<&str>,
    sheet_index: Option<usize>,
) -> Result<String, String> {
    let script_state = handle.state::<crate::scripting::types::ScriptState>();
    super::objects::gate(&script_state, LIST_OBJECT_PROPERTIES_TOOL)?;
    let cx = binding_cx(handle);
    list_object_properties_core(&cx, kind, id, sheet_index)
}

/// `set_object_property`: write a literal through the family's own core, then
/// announce the domains it reports (`mutation:refresh`) and, for a canvas
/// page, the canvas-layout change.
pub fn set_object_property(
    handle: &AppHandle,
    kind: &str,
    id: &str,
    path: &str,
    value: Value,
) -> Result<String, String> {
    let script_state = handle.state::<crate::scripting::types::ScriptState>();
    super::objects::gate(&script_state, "set_object_property")?;
    let cx = binding_cx(handle);
    let written = set_object_property_core(&cx, kind, id, path, value)?;
    use tauri::Emitter;
    if !written.domains.is_empty() {
        let _ = handle.emit(
            crate::object_deps::MUTATION_REFRESH_EVENT,
            crate::object_deps::MutationRefreshEvent { domains: written.domains.clone(), source: "commit".to_string() },
        );
    }
    if let Some(layout) = written.layout {
        let _ = handle.emit(crate::sheets::CANVAS_LAYOUT_EVENT, layout);
    }
    Ok(written.reply)
}

/// `set_object_binding`: bind (or, with no formula, unbind) a property. The
/// binding announcer emits `object-bindings:changed`; nothing else is owed.
pub async fn set_object_binding(
    handle: &AppHandle,
    kind: &str,
    id: &str,
    path: &str,
    formula: Option<&str>,
    model: Option<&str>,
) -> Result<String, String> {
    {
        let script_state = handle.state::<crate::scripting::types::ScriptState>();
        super::objects::gate(&script_state, "set_object_binding")?;
    }
    let cx = binding_cx(handle);
    let bi = handle.state::<crate::bi::types::BiState>().inner();
    // Boxed (and type-erased, see `set_object_binding_core`): the dispatcher
    // nests the measure pass and the evaluator; a tokio worker has a 2 MB stack.
    set_object_binding_core(&cx, bi, kind, id, path, formula, model).await
}

// ============================================================================
// get_sheet_summary: "## Canvas objects" and "## Bound properties (worksheets)"
// ============================================================================

/// One object, as the summary shows it.
#[derive(Debug, Clone)]
pub(crate) struct SummaryObject {
    pub object: ObjectBindingRef,
    pub name: String,
    /// The object's AI-visible JSON (`None` when it could not be read).
    pub json: Option<Value>,
    /// Its bindings, each with its current value.
    pub bindings: Vec<ObjectBindingInfo>,
}

/// One sheet's objects.
#[derive(Debug, Clone)]
pub(crate) struct SummarySheet {
    pub sheet_index: usize,
    pub sheet_name: String,
    pub is_canvas: bool,
    pub objects: Vec<SummaryObject>,
}

/// Read every user sheet's objects and bindings (bindings evaluated first when
/// the runtime has never evaluated them). Object-backed sheets are skipped and
/// user-hidden ones kept, exactly as the "## Canvases" section filters them
/// (`crate::sheets::is_user_sheet`).
pub(crate) fn gather_object_summary(cx: &BindingCx<'_>) -> Vec<SummarySheet> {
    let (names, visibility, kinds) = {
        let names = cx.state.sheet_names.read().map(|g| g.clone()).unwrap_or_default();
        let visibility = cx.state.sheet_visibility.read().map(|g| g.clone()).unwrap_or_default();
        let kinds = cx.state.sheet_kinds.read().map(|g| g.clone()).unwrap_or_default();
        (names, visibility, kinds)
    };
    let stores = cx.stores();
    let all_objects = object_json::object_locations(&stores);
    // Bindings are only worth evaluating when there are any.
    let mut by_object: BTreeMap<ObjectBindingRef, Vec<ObjectBindingInfo>> = BTreeMap::new();
    let has_bindings = cx.state.object_bindings.read().map(|s| !s.bindings.is_empty()).unwrap_or(false);
    if has_bindings {
        for info in evaluated_bindings(cx, None) {
            by_object.entry(info.object.clone()).or_default().push(info);
        }
    }
    let mut out = Vec::new();
    for (index, name) in names.iter().enumerate() {
        if !crate::sheets::is_user_sheet(&visibility, index) {
            continue;
        }
        let is_canvas = crate::sheets::is_canvas_sheet(&kinds, index);
        let mut objects = Vec::new();
        for (object, location) in all_objects.iter().filter(|(_, l)| l.sheet_index == index) {
            let bindings = by_object.get(object).cloned().unwrap_or_default();
            // A worksheet object is only summarised when it is bound: the
            // worksheet's own inventories (charts, pivots...) already list it.
            if !is_canvas && bindings.is_empty() {
                continue;
            }
            objects.push(SummaryObject {
                object: object.clone(),
                name: location.name.clone(),
                json: object_json::object_json(&stores, object).ok(),
                bindings,
            });
        }
        if is_canvas || !objects.is_empty() {
            out.push(SummarySheet { sheet_index: index, sheet_name: name.clone(), is_canvas, objects });
        }
    }
    out
}

/// A number as a summary writes it (`40`, not `40.0`).
fn number_text(v: &Value) -> Option<String> {
    let n = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    Some(if n.fract() == 0.0 && n.abs() < 1e15 { format!("{}", n as i64) } else { format!("{n}") })
}

/// `(x, y, width, height)` of an object, from wherever its kind keeps it.
fn geometry(kind: ObjectBindingKind, json: &Value) -> Option<(String, String, String, String)> {
    let frame = match kind {
        ObjectBindingKind::Pivot => json.get("canvasFrame")?,
        ObjectBindingKind::Control => json.get("properties")?,
        ObjectBindingKind::CanvasPage => return None,
        _ => json,
    };
    let x = number_text(frame.get("x")?)?;
    let y = number_text(frame.get("y")?)?;
    let w = frame.get("width").and_then(number_text).unwrap_or_else(|| "?".to_string());
    let h = frame.get("height").and_then(number_text).unwrap_or_else(|| "?".to_string());
    Some((x, y, w, h))
}

/// The header line of one object: kind, id, name, mark / control type, place.
pub(crate) fn object_line(object: &ObjectBindingRef, name: &str, json: Option<&Value>) -> String {
    let mut line = format!("- {} id={} name={}", object.kind.wire_name(), object.id, quoted(name));
    if let Some(json) = json {
        match object.kind {
            ObjectBindingKind::Chart => {
                if let Some(mark) = json.pointer("/spec/mark").and_then(Value::as_str) {
                    line.push_str(&format!(" mark={mark}"));
                }
            }
            ObjectBindingKind::Control => {
                if let Some(t) = json.get("controlType").and_then(Value::as_str) {
                    line.push_str(&format!(" type={t}"));
                }
            }
            _ => {}
        }
        if let Some((x, y, w, h)) = geometry(object.kind, json) {
            line.push_str(&format!(" at {x},{y} size {w}x{h}"));
        }
        if object.kind == ObjectBindingKind::Control {
            if let Some(text) = json.pointer("/properties/text").and_then(Value::as_str) {
                line.push_str(&format!(" text={}", quoted(text)));
            }
        }
    }
    line
}

/// The property lines under one object: `path = literal` for every catalog
/// path PRESENT in its JSON and not bound, `path := formula -> value` for
/// every binding (catalog order first, then any binding the catalog walk did
/// not reach).
pub(crate) fn property_lines(object: &SummaryObject) -> Vec<String> {
    let mut out = Vec::new();
    let mut shown: HashSet<&str> = HashSet::new();
    let bound = |path: &str| object.bindings.iter().find(|b| b.path == path);
    if let Some(json) = &object.json {
        for row in catalog::rows_of(object.object.kind) {
            for path in expand_pattern(row.pointer, json) {
                if let Some(info) = bound(&path) {
                    if shown.insert(info.path.as_str()) {
                        out.push(format!("    {}", binding_line(info)));
                    }
                    continue;
                }
                match json.pointer(&path) {
                    None | Some(Value::Null) => {}
                    Some(Value::String(s)) => out.push(format!("    {path} = {}", quoted(s))),
                    Some(other) => out.push(format!("    {path} = {}", truncate_value(&other.to_string()))),
                }
            }
        }
    }
    for info in &object.bindings {
        if shown.insert(info.path.as_str()) {
            out.push(format!("    {}", binding_line(info)));
        }
    }
    out
}

/// The two summary sections, or `None` when the workbook has no canvas and no
/// bound object. Pure: everything it prints was gathered first.
///
/// ```text
/// ## Canvas objects
/// ### Overview (index=2)
/// - chart id=... name="Revenue card" mark=card at 40,40 size 240x140
///     /spec/title = "Revenue"
///     /spec/markOptions/goal := =[Revenue]*1.1 -> "12,345,678" (model ...)
/// ## Bound properties (worksheets)
/// ```
pub(crate) fn format_canvas_objects(sheets: &[SummarySheet]) -> Option<String> {
    let mut canvas = String::new();
    let mut worksheets = String::new();
    for sheet in sheets {
        if sheet.is_canvas {
            canvas.push_str(&format!("\n### {} (index={})\n", sheet.sheet_name, sheet.sheet_index));
            if sheet.objects.is_empty() {
                canvas.push_str("- (no objects)\n");
            }
            for object in &sheet.objects {
                canvas.push_str(&object_line(&object.object, &object.name, object.json.as_ref()));
                canvas.push('\n');
                for line in property_lines(object) {
                    canvas.push_str(&line);
                    canvas.push('\n');
                }
            }
        } else {
            for object in sheet.objects.iter().filter(|o| !o.bindings.is_empty()) {
                worksheets.push_str(&object_line(&object.object, &object.name, object.json.as_ref()));
                worksheets.push_str(&format!(" on sheet {} (index={})\n", quoted(&sheet.sheet_name), sheet.sheet_index));
                for info in &object.bindings {
                    worksheets.push_str(&format!("    {}\n", binding_line(info)));
                }
            }
        }
    }
    if canvas.is_empty() && worksheets.is_empty() {
        return None;
    }
    let mut out = String::new();
    if !canvas.is_empty() {
        out.push_str(
            "\n\n## Canvas objects\nEach object's properties at their JSON Pointer paths. `path = value` is a \
             literal; `path := formula -> value` is a BINDING (the property follows the formula; the value is \
             what it shows now). Change a literal with set_object_property, bind or unbind with \
             set_object_binding; list_object_properties shows every bindable path of one object.",
        );
        out.push_str(canvas.trim_end_matches('\n'));
    }
    if !worksheets.is_empty() {
        out.push_str("\n\n## Bound properties (worksheets)\n");
        out.push_str(worksheets.trim_end_matches('\n'));
    }
    Some(out)
}

/// Append `section` to `summary` only when it fits the char budget (`0` = no
/// budget) -- the same guard every host section of the summary applies.
/// Returns whether it was appended.
pub(crate) fn append_within_budget(summary: &mut String, section: &str, max_chars: usize) -> bool {
    if max_chars == 0 || summary.len() + section.len() <= max_chars {
        summary.push_str(section);
        true
    } else {
        false
    }
}

/// The summary's object sections for the running app (`None` = nothing to say).
pub(crate) fn canvas_objects_section(handle: &AppHandle) -> Option<String> {
    let cx = binding_cx(handle);
    format_canvas_objects(&gather_object_summary(&cx))
}
