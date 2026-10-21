//! FILENAME: app/src-tauri/src/object_bindings/literal.rs
// PURPOSE: The LITERAL half of a bindable property: the gates a binding on a
//          path must pass (the same ones the family's own literal write
//          applies -- a binding is never a laxer door than its literal), and the
//          `SetLiteral` op, which writes one catalog path's literal THROUGH the
//          family's own write core (D §3.9).
// CONTEXT: A literal stays in the object's own record; this module never keeps
//          a second copy. Each kind dispatches to the core its own command uses:
//            chart          chart_commands::update_chart_core
//            control        controls::set_control_property_core (+ one undo
//                           step recorded here: the core records undo only for
//                           code slots, which are never bindable); a Page
//                           Navigator's per-button path upserts ONE page's
//                           entry of `pageOverrides` (page_overrides.rs)
//            slicer         slicer::commands::update_slicer_core
//            timelineSlicer timeline_slicer::commands::update_timeline_with
//            canvasPage     sheets::set_canvas_layout_inner
//            Container rows container_literal::write_container_literal (WP-C):
//                           the leaf is checked by visual_format, then the
//                           whole container rides the family door above
//                           (pivot: update_pivot_properties_core; floating
//                           range: update_floating_range_inner)
//          so the family core's own gates, dirty flag and undo apply unchanged.
//
// LOCKS: nothing here touches the binding store or its runtime. Every family
// store is read and released before its core is called (each core takes its
// own locks), and no lock is held across a core call.

use serde_json::Value;

use crate::api_types::{ObjectBindingKind, ObjectBindingRef};
use crate::persistence::FileState;
use crate::AppState;

use super::catalog::{self, BindableOrigin, BindablePathSpec, BindableValueType};
use super::object_json::{self, ObjectLocation};

/// Longest TEXT literal `SetLiteral` writes, in characters (the binding
/// formula cap, and the S9 script validator's).
pub const MAX_LITERAL_TEXT_CHARS: usize = 8_192;

/// Everything a literal write reaches, borrowed.
pub struct LiteralWriteCtx<'a> {
    pub state: &'a AppState,
    pub file_state: &'a FileState,
    pub slicers: &'a crate::slicer::SlicerState,
    pub timelines: &'a crate::timeline_slicer::TimelineSlicerState,
    pub pivots: &'a crate::pivot::types::PivotState,
}

impl LiteralWriteCtx<'_> {
    fn stores(&self) -> object_json::ObjectStores<'_> {
        object_json::ObjectStores {
            state: self.state,
            slicers: self.slicers,
            timelines: self.timelines,
            pivots: self.pivots,
        }
    }
}

/// What a literal write did.
#[derive(Debug)]
pub enum LiteralWriteOutcome {
    /// The family core wrote it. `domains` are the MutationDomain wire names the
    /// frontend must refresh (`MUTATION_REFRESH`); `layout` is the canvas
    /// layout announcement a page write owes (`sheets::CANVAS_LAYOUT_EVENT`),
    /// emitted by the command once every guard is dropped.
    Written {
        domains: Vec<&'static str>,
        layout: Option<crate::sheets::CanvasLayoutChanged>,
    },
    /// The property already had this value: nothing was written, nothing
    /// dirtied, no undo step.
    Unchanged,
}

// ---------------------------------------------------------------------------
// The gates a binding shares with its literal (invariant 9)
// ---------------------------------------------------------------------------

/// The phrase each family's own `editObjects` refusal uses, so a refused
/// binding reads exactly like a refused literal edit.
fn protect_phrase(kind: ObjectBindingKind) -> &'static str {
    match kind {
        // update_chart_core
        ObjectBindingKind::Chart => "edit objects",
        // set_control_property_core, GEOMETRY_PROPERTIES
        ObjectBindingKind::Control => "move, resize or rotate a control",
        // set_canvas_layout_inner
        ObjectBindingKind::CanvasPage => "change the canvas layout",
        ObjectBindingKind::FloatingRange => "edit a floating range",
        ObjectBindingKind::Pivot => "edit objects",
        ObjectBindingKind::Slicer => "edit a slicer",
        ObjectBindingKind::TimelineSlicer => "edit a timeline",
    }
}

/// The phrase each family's own Lock Objects refusal uses.
fn lock_phrase(kind: ObjectBindingKind) -> &'static str {
    match kind {
        ObjectBindingKind::Chart => "move or resize a chart",
        ObjectBindingKind::Control => "move or resize a control",
        ObjectBindingKind::Slicer => "move or resize a slicer",
        ObjectBindingKind::TimelineSlicer => "move or resize a timeline",
        ObjectBindingKind::Pivot => "move or resize a PivotTable",
        ObjectBindingKind::FloatingRange => "move or resize a floating range",
        ObjectBindingKind::CanvasPage => "move or resize objects",
    }
}

/// The gates the family's LITERAL write of `row` applies on the object's
/// sheet, driven by the row's flags (D §3.4): `protect_edit_objects` -> the
/// sheet-protection `editObjects` action; `lock_objects_position` -> the
/// canvas's Lock Objects. `Set` and `Clear` call this so a binding is never a
/// laxer door than its literal; `a_binding_is_never_a_laxer_door_than_its_literal`
/// pins that the two refuse together. Takes only leaf reads, each released.
pub fn check_literal_gates(
    state: &AppState,
    object: &ObjectBindingRef,
    row: &BindablePathSpec,
    location: &ObjectLocation,
) -> Result<(), String> {
    if row.protect_edit_objects {
        crate::protection::check_sheet_action(state, location.sheet_index, "editObjects", protect_phrase(object.kind))?;
    }
    if row.lock_objects_position {
        let locked = {
            let kinds = state.sheet_kinds.read().map_err(|e| e.to_string())?;
            crate::sheets::canvas_objects_locked_in(&kinds, location.sheet_index)
        };
        if locked {
            return Err(crate::sheets::canvas_objects_locked_refusal(lock_phrase(object.kind)));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Literal values
// ---------------------------------------------------------------------------

/// A literal `value` made into the catalog type of `row`, or the sentence why
/// it cannot be. `media_exists` answers whether a media hash is in the
/// document (a literal may REFERENCE media, never introduce bytes).
pub fn coerce_literal(
    value_type: BindableValueType,
    value: &Value,
    media_exists: &dyn Fn(&str) -> bool,
) -> Result<Value, String> {
    let kind_of = |v: &Value| match v {
        Value::Null => "nothing",
        Value::Bool(_) => "TRUE/FALSE",
        Value::Number(_) => "a number",
        Value::String(_) => "text",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    };
    match value_type {
        BindableValueType::Text => match value {
            Value::Null => Ok(Value::Null),
            Value::String(s) if s.chars().count() <= MAX_LITERAL_TEXT_CHARS => Ok(value.clone()),
            Value::String(_) => Err(format!(
                "A text property holds at most {MAX_LITERAL_TEXT_CHARS} characters."
            )),
            other => Err(format!("This property takes text, not {}.", kind_of(other))),
        },
        BindableValueType::Number => match value.as_f64() {
            Some(n) if n.is_finite() => Ok(value.clone()),
            _ => Err(format!("This property takes a number, not {}.", kind_of(value))),
        },
        BindableValueType::Integer => match value.as_f64() {
            Some(n) if n.is_finite() && n.fract() == 0.0 && n.abs() < 9.0e15 => Ok(serde_json::json!(n as i64)),
            Some(_) => Err("This property takes a whole number.".to_string()),
            None => Err(format!("This property takes a whole number, not {}.", kind_of(value))),
        },
        BindableValueType::Boolean => match value {
            Value::Bool(_) => Ok(value.clone()),
            other => Err(format!("This property takes TRUE or FALSE, not {}.", kind_of(other))),
        },
        BindableValueType::Color => match value {
            Value::String(s) if s.trim().is_empty() => Ok(Value::String(String::new())),
            Value::String(s) if super::eval::is_binding_color(s) => Ok(Value::String(s.trim().to_string())),
            Value::String(s) => Err(format!(
                "'{s}' is not a colour: write #RRGGBB, #RRGGBBAA or rgb(r, g, b), or \"\" for the default."
            )),
            other => Err(format!("This property takes a colour, not {}.", kind_of(other))),
        },
        BindableValueType::Enum(members) => match value {
            Value::String(s) => members
                .iter()
                .find(|m| m.eq_ignore_ascii_case(s.trim()))
                .map(|m| Value::String((*m).to_string()))
                .ok_or_else(|| format!("'{s}' is not one of: {}.", members.join(", "))),
            other => Err(format!("This property takes one of {}, not {}.", members.join(", "), kind_of(other))),
        },
        BindableValueType::Media => match value {
            Value::String(s) if s.is_empty() => Ok(value.clone()),
            Value::String(s) if s.trim().to_ascii_lowercase().starts_with("data:") => Err(
                "A picture must name media already in this document (media:...); a data: URI is never accepted. \
                 A picture enters a document through Insert > Image."
                    .to_string(),
            ),
            Value::String(s) => match calcula_format::media::parse_media_ref(s) {
                Some(hash) if media_exists(hash) => Ok(value.clone()),
                Some(_) => Err(format!("'{s}' names no media in this document.")),
                None => Err(format!("'{s}' is not a media handle (media: followed by 64 hex digits).")),
            },
            other => Err(format!("This property takes a media handle, not {}.", kind_of(other))),
        },
        BindableValueType::Scalar => match value {
            Value::Number(_) | Value::Bool(_) => Ok(value.clone()),
            Value::String(s) if s.chars().count() <= MAX_LITERAL_TEXT_CHARS => Ok(value.clone()),
            Value::String(_) => Err(format!(
                "A text value holds at most {MAX_LITERAL_TEXT_CHARS} characters."
            )),
            other => Err(format!("This property takes a number, text or TRUE/FALSE, not {}.", kind_of(other))),
        },
    }
}

/// A coerced literal as a control property STRING (controls store strings):
/// a number in its shortest round-trip spelling, a boolean as true/false,
/// nothing as "".
pub fn control_property_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match (n.as_i64(), n.as_f64()) {
            (Some(i), _) => i.to_string(),
            (None, Some(f)) => format!("{f}"),
            (None, None) => n.to_string(),
        },
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Write `value` at the UNESCAPED `segments` of `root`, creating missing
/// OBJECT members on the way (a chart without an `xAxis` gains one). An array
/// item must already exist: a series that is not there is a refusal, never a
/// padded array. Returns whether anything changed.
pub fn set_at_pointer(root: &mut Value, segments: &[String], value: Value) -> Result<bool, String> {
    let Some((last, parents)) = segments.split_last() else {
        return Err("A property path names at least one member.".to_string());
    };
    let mut cursor = root;
    let mut walked = String::new();
    for seg in parents {
        walked.push('/');
        walked.push_str(&catalog::escape_segment(seg));
        if cursor.is_null() {
            *cursor = Value::Object(serde_json::Map::new());
        }
        cursor = match cursor {
            Value::Object(map) => map.entry(seg.clone()).or_insert(Value::Null),
            Value::Array(items) => {
                let index: usize = seg
                    .parse()
                    .map_err(|_| format!("'{walked}' is not an item number."))?;
                let len = items.len();
                items
                    .get_mut(index)
                    .ok_or_else(|| format!("'{walked}' does not exist: there are {len} item(s)."))?
            }
            _ => return Err(format!("'{walked}' holds a value, not an object, so it has no members.")),
        };
    }
    if cursor.is_null() {
        *cursor = Value::Object(serde_json::Map::new());
    }
    match cursor {
        Value::Object(map) => {
            let changed = map.get(last) != Some(&value);
            map.insert(last.clone(), value);
            Ok(changed)
        }
        Value::Array(items) => {
            let index: usize = last.parse().map_err(|_| format!("'{last}' is not an item number."))?;
            let len = items.len();
            let slot = items
                .get_mut(index)
                .ok_or_else(|| format!("Item {index} does not exist: there are {len} item(s)."))?;
            let changed = *slot != value;
            *slot = value;
            Ok(changed)
        }
        _ => Err("The property's parent holds a value, not an object.".to_string()),
    }
}

// ---------------------------------------------------------------------------
// SetLiteral
// ---------------------------------------------------------------------------

/// Write the LITERAL of catalog path `path` on `object` through the family's
/// own core (D §3.9). `value` is coerced to the row's type first; the core's
/// own gates (protection, Lock Objects), dirty flag and undo apply.
pub fn write_literal(
    ctx: &LiteralWriteCtx<'_>,
    object: &ObjectBindingRef,
    path: &str,
    value: Value,
) -> Result<LiteralWriteOutcome, String> {
    // A canvas page's visual interactions are a LITERAL-only path with no
    // catalog row (P4 DC-6), written by the ASYNC door only
    // (`object_bindings::set_interactions_literal_async`): a change can move a
    // model slicer -> pivot pair to or from `none`, and the pivot re-fold it
    // needs awaits the model (DC-9). This synchronous door refuses it.
    if object.kind == ObjectBindingKind::CanvasPage && path == catalog::CANVAS_INTERACTIONS_PATH {
        return Err(INTERACTIONS_NEED_THE_ASYNC_DOOR.to_string());
    }
    let row = catalog::match_path(object.kind, path)?;
    if object_json::locate(&ctx.stores(), object).is_none() {
        return Err(format!(
            "There is no {} with id '{}' in this workbook.",
            object.kind.label(),
            object.id
        ));
    }
    let media_exists = |hash: &str| {
        ctx.state.media.read().map(|m| m.contains_key(hash)).unwrap_or(false)
    };
    let value = coerce_literal(row.value_type, &value, &media_exists)?;
    // A container colour (a Container row, or a control's flat `container*`
    // colour key) is stored as hex: `rgb(...)` is converted, never refused late.
    let value = super::container_literal::normalize_if_container_colour(object.kind, path, value);
    if row.origin == BindableOrigin::Container {
        return super::container_literal::write_container_literal(ctx, object, path, value);
    }
    let segments: Vec<String> = catalog::pointer_segments(path)?
        .iter()
        .map(|s| catalog::unescape_segment(s).unwrap_or_default())
        .collect();
    match object.kind {
        ObjectBindingKind::Chart => write_chart(ctx, object, &segments, value),
        ObjectBindingKind::Control => write_control(ctx, object, &segments, value),
        ObjectBindingKind::Slicer => write_slicer(ctx, object, &segments, value),
        ObjectBindingKind::TimelineSlicer => write_timeline(ctx, object, &segments, value),
        ObjectBindingKind::CanvasPage => write_canvas_page(ctx, object, &segments, value),
        ObjectBindingKind::Pivot | ObjectBindingKind::FloatingRange => Err(format!(
            "A {} has no family properties of its own to write.",
            object.kind.label()
        )),
    }
}

fn write_chart(
    ctx: &LiteralWriteCtx<'_>,
    object: &ObjectBindingRef,
    segments: &[String],
    value: Value,
) -> Result<LiteralWriteOutcome, String> {
    let entry = {
        let charts = ctx.state.charts.read().map_err(|e| e.to_string())?;
        charts.iter().find(|c| c.id.to_string() == object.id).cloned()
    }
    .ok_or_else(|| format!("There is no chart with id '{}' in this workbook.", object.id))?;
    let mut definition: Value = serde_json::from_str(&entry.spec_json)
        .map_err(|e| format!("The chart's definition could not be read: {e}"))?;
    // A spec the structural backstop accepted must still pass it afterwards
    // (a catalog path can never reach mark/data/series wholesale, but the size
    // cap still applies). A spec that never passed -- a Card built without a
    // series list -- is left to the family's own rules.
    let was_valid = definition
        .get("spec")
        .is_some_and(|s| crate::mcp::tools::validate_chart_spec_core(s).is_ok());
    if !set_at_pointer(&mut definition, segments, value)? {
        return Ok(LiteralWriteOutcome::Unchanged);
    }
    if was_valid {
        if let Some(spec) = definition.get("spec") {
            crate::mcp::tools::validate_chart_spec_core(spec)?;
        }
    }
    let next = crate::api_types::ChartEntry {
        id: entry.id,
        sheet_index: entry.sheet_index,
        spec_json: definition.to_string(),
    };
    crate::chart_commands::update_chart_core(ctx.state, ctx.file_state, next, None)?;
    Ok(LiteralWriteOutcome::Written { domains: vec!["objects"], layout: None })
}

fn write_control(
    ctx: &LiteralWriteCtx<'_>,
    object: &ObjectBindingRef,
    segments: &[String],
    value: Value,
) -> Result<LiteralWriteOutcome, String> {
    // `/properties/<key>`, or a Page Navigator's per-button
    // `/properties/pageOverrides/<page key>/<field>` (D §3.18a), which writes
    // the ONE `pageOverrides` string with that page's entry upserted.
    let (key, per_button) = match segments {
        [properties, key] if properties == "properties" => (key.clone(), None),
        [properties, overrides, page_key, field]
            if properties == "properties" && overrides == crate::controls::PAGE_NAVIGATOR_OVERRIDES_PROPERTY =>
        {
            (overrides.clone(), Some((page_key.clone(), field.clone())))
        }
        _ => return Err("A control's bindable properties live under /properties/.".to_string()),
    };
    // The live report pages, read and released BEFORE the control store.
    let pages = per_button.as_ref().map(|_| super::page_overrides::ReportPages::read(ctx.state));
    // The control and the ONE property's value before: the undo step this
    // arm records (the core records undo only for code slots, which are never
    // bindable). Per property, never the whole store -- a whole-store undo
    // also erased every later unrecorded write to any control.
    let anchor = {
        let controls = ctx.state.controls.read().map_err(|e| e.to_string())?;
        controls
            .iter()
            .find(|(_, meta)| object_json::control_uid(meta) == Some(object.id.as_str()))
            .map(|(k, meta)| (*k, meta.control_type.clone(), meta.properties.get(&key).cloned()))
    };
    let Some(((sheet, row, col), control_type, current)) = anchor else {
        return Err(format!("There is no control with id '{}' in this workbook.", object.id));
    };
    let text = match (&per_button, &pages) {
        (Some((page_key, field)), Some(pages)) => {
            if control_type != crate::controls::PAGE_NAVIGATOR_CONTROL_TYPE {
                return Err(format!(
                    "Per-page button settings belong to a Page Navigator; this control is a {control_type}."
                ));
            }
            let raw = current
                .as_ref()
                .filter(|p| p.value_type == "static")
                .map(|p| p.value.as_str())
                .unwrap_or_default();
            match super::page_overrides::upsert_literal(raw, page_key, field, &value, pages)? {
                Some(next) => next,
                None => return Ok(LiteralWriteOutcome::Unchanged),
            }
        }
        _ => control_property_string(&value),
    };
    if current.as_ref().is_some_and(|p| p.value_type == "static" && p.value == text) {
        return Ok(LiteralWriteOutcome::Unchanged);
    }
    let previous = crate::undo_commands::ControlPropRestoreRow {
        uid: object.id.clone(),
        key: (sheet, row, col),
        property: key.clone(),
        previous: current,
    };
    crate::controls::set_control_property_core(
        ctx.state,
        ctx.file_state,
        sheet,
        row,
        col,
        String::new(),
        key,
        "static".to_string(),
        text,
    )?;
    crate::undo_commands::record_control_props_undo(ctx.state, vec![previous], "Set property");
    Ok(LiteralWriteOutcome::Written { domains: vec!["controls"], layout: None })
}

fn write_slicer(
    ctx: &LiteralWriteCtx<'_>,
    object: &ObjectBindingRef,
    segments: &[String],
    value: Value,
) -> Result<LiteralWriteOutcome, String> {
    let id = identity::EntityId::parse(&object.id)
        .ok_or_else(|| format!("There is no slicer with id '{}' in this workbook.", object.id))?;
    let field = segments.first().map(String::as_str).unwrap_or_default();
    let current = {
        let slicers = ctx.slicers.slicers.read().map_err(|e| e.to_string())?;
        let slicer = slicers
            .get(&id)
            .ok_or_else(|| format!("There is no slicer with id '{}' in this workbook.", object.id))?;
        serde_json::to_value(slicer).map_err(|e| e.to_string())?
    };
    let patch = match field {
        "headerText" | "showHeader" => serde_json::json!({ field: value.clone() }),
        other => return Err(format!("'/{other}' is not a slicer property this door writes.")),
    };
    if current.get(field).unwrap_or(&Value::Null) == &value {
        return Ok(LiteralWriteOutcome::Unchanged);
    }
    let params: crate::slicer::types::UpdateSlicerParams =
        serde_json::from_value(patch).map_err(|e| format!("The slicer update could not be built: {e}"))?;
    crate::slicer::commands::update_slicer_core(ctx.state, ctx.file_state, ctx.slicers, id, params)?;
    Ok(LiteralWriteOutcome::Written { domains: vec!["slicer"], layout: None })
}

fn write_timeline(
    ctx: &LiteralWriteCtx<'_>,
    object: &ObjectBindingRef,
    segments: &[String],
    value: Value,
) -> Result<LiteralWriteOutcome, String> {
    let id = identity::EntityId::parse(&object.id)
        .ok_or_else(|| format!("There is no timeline slicer with id '{}' in this workbook.", object.id))?;
    let field = segments.first().map(String::as_str).unwrap_or_default().to_string();
    let before = {
        let timelines = ctx.timelines.timelines.read().map_err(|e| e.to_string())?;
        timelines
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("There is no timeline slicer with id '{}' in this workbook.", object.id))?
    };
    let mut next = before.clone();
    match field.as_str() {
        "headerText" => next.header_text = value.as_str().map(str::to_string),
        "showHeader" => next.show_header = value.as_bool().unwrap_or(next.show_header),
        other => return Err(format!("'/{other}' is not a timeline property this door writes.")),
    }
    if next == before {
        return Ok(LiteralWriteOutcome::Unchanged);
    }
    crate::timeline_slicer::commands::update_timeline_with(
        ctx.state,
        ctx.timelines,
        ctx.file_state,
        id,
        "Update timeline slicer",
        |tl| {
            tl.header_text = next.header_text.clone();
            tl.show_header = next.show_header;
        },
    )?;
    Ok(LiteralWriteOutcome::Written { domains: vec!["slicer"], layout: None })
}

/// The synchronous literal door's refusal of `/interactions` (P4 S4d).
pub const INTERACTIONS_NEED_THE_ASYNC_DOOR: &str =
    "Canvas interactions are written by the async door (the object_bindings command or the set_object_property \
     tool), which also re-folds the PivotTables a change reaches; this synchronous door does not change them.";

/// A canvas page's `/interactions` write, planned and checked but not yet
/// made: the page's index, the layout patch carrying the normalized
/// interactions, and the layout before (to tell an unchanged write apart).
#[derive(Debug)]
pub struct PlannedInteractionsWrite {
    pub index: usize,
    pub patch: crate::api_types::CanvasLayoutPatch,
    pub before: Option<::persistence::CanvasLayout>,
}

/// Plan the `/interactions` literal write on canvas page `object`: the page
/// must exist, the value must parse, normalize and validate, and every ref
/// must name an object on THAT page (see [`canvas_interactions_literal`]).
/// Every refusal is made here, before any effect. The write itself is
/// `sheets::set_canvas_layout_refolding` (protection gate, undo step, re-fold).
pub fn plan_interactions_write(
    ctx: &LiteralWriteCtx<'_>,
    object: &ObjectBindingRef,
    value: Value,
) -> Result<PlannedInteractionsWrite, String> {
    let not_found = || format!("There is no {} with id '{}' in this workbook.", object.kind.label(), object.id);
    if object.kind != ObjectBindingKind::CanvasPage || object_json::locate(&ctx.stores(), object).is_none() {
        return Err(not_found());
    }
    let id = identity::SheetId::parse(&object.id).ok_or_else(not_found)?;
    let index = {
        let ids = ctx.state.sheet_ids.read().map_err(|e| e.to_string())?;
        ids.iter().position(|s| *s == id)
    }
    .ok_or_else(not_found)?;
    let patch = crate::api_types::CanvasLayoutPatch {
        interactions: Some(canvas_interactions_literal(ctx, id, value)?),
        ..Default::default()
    };
    let before = {
        let kinds = ctx.state.sheet_kinds.read().map_err(|e| e.to_string())?;
        kinds.get(index).and_then(|k| k.canvas_layout().cloned())
    };
    Ok(PlannedInteractionsWrite { index, patch, before })
}

/// The `/interactions` literal of the canvas page `page`: the value parsed as
/// `CanvasInteractions` (`{defaultMode?, pairs: [{source, target, mode}]}`),
/// normalized as an edit is (`api_types::normalize_canvas_interactions`) and
/// validated, and every ref checked to name an interaction-capable object
/// (chart, pivot, slicer) that IS ON THIS PAGE -- refused naming the first
/// that is not. The protection gate and the undo step are the layout core's
/// (`sheets::set_canvas_layout_inner`), reached by the caller.
fn canvas_interactions_literal(
    ctx: &LiteralWriteCtx<'_>,
    page: identity::SheetId,
    value: Value,
) -> Result<::persistence::CanvasInteractions, String> {
    let parsed: ::persistence::CanvasInteractions = serde_json::from_value(value).map_err(|e| {
        format!(
            "Interactions are an object {{\"defaultMode\"?, \"pairs\": [{{\"source\": {{\"kind\", \"id\"}}, \"target\": {{\"kind\", \"id\"}}, \"mode\": \"filter\"|\"highlight\"|\"none\"}}]}}: {}",
            e
        )
    })?;
    let normalized = crate::api_types::normalize_canvas_interactions(&parsed);
    normalized.validate()?;
    let on_page = object_json::canvas_refs_by_sheet(&object_json::object_locations(&ctx.stores()))
        .remove(&page)
        .unwrap_or_default();
    for p in &normalized.pairs {
        for r in [&p.source, &p.target] {
            if !on_page.contains(r) {
                return Err(format!(
                    "Canvas interactions name {{kind: '{}', id: '{}'}}, which is not an object on this canvas page.",
                    r.kind, r.id
                ));
            }
        }
    }
    Ok(normalized)
}

fn write_canvas_page(
    ctx: &LiteralWriteCtx<'_>,
    object: &ObjectBindingRef,
    segments: &[String],
    value: Value,
) -> Result<LiteralWriteOutcome, String> {
    let id = identity::SheetId::parse(&object.id)
        .ok_or_else(|| format!("There is no canvas page with id '{}' in this workbook.", object.id))?;
    let index = {
        let ids = ctx.state.sheet_ids.read().map_err(|e| e.to_string())?;
        ids.iter().position(|s| *s == id)
    }
    .ok_or_else(|| format!("There is no canvas page with id '{}' in this workbook.", object.id))?;
    let text = value.as_str().unwrap_or_default().to_string();
    let mut patch = crate::api_types::CanvasLayoutPatch::default();
    match segments.first().map(String::as_str) {
        Some("background") => patch.background = Some(text),
        Some("wallpaper") => patch.wallpaper = Some(text),
        Some("interactions") => return Err(INTERACTIONS_NEED_THE_ASYNC_DOOR.to_string()),
        other => {
            return Err(format!(
                "'/{}' is not a canvas page property this door writes.",
                other.unwrap_or_default()
            ))
        }
    }
    let before = {
        let kinds = ctx.state.sheet_kinds.read().map_err(|e| e.to_string())?;
        kinds.get(index).and_then(|k| k.canvas_layout().cloned())
    };
    let changed = crate::sheets::set_canvas_layout_inner(ctx.state, ctx.file_state, Some(index), &patch)?;
    if before.as_ref() == Some(&changed.layout) {
        return Ok(LiteralWriteOutcome::Unchanged);
    }
    Ok(LiteralWriteOutcome::Written { domains: vec!["sheets"], layout: Some(changed) })
}
