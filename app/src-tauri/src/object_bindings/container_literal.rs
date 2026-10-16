//! FILENAME: app/src-tauri/src/object_bindings/container_literal.rs
// PURPOSE: The LITERAL door of a VISUAL CONTAINER field (WP-C, D-FORMAT): a
//          binding literal, a script's `property.set`, MCP `set_object_property`
//          and the in-app AI all write ONE container leaf of a chart, PivotTable
//          box, slicer, timeline or floating range through here.
// CONTEXT: One rule however the write arrives. The leaf is checked by
//          `visual_format::VisualContainerFormat::with_field` -- the same check
//          the Format pane's commit meets in each family's door (`validate`) --
//          and the WHOLE new container then goes through the family's own door,
//          which owns the DocumentEffect and the undo step:
//            chart          chart_commands::update_chart_core (spec `container`)
//            pivot          pivot::commands::update_pivot_properties_core
//                           (`canvas_frame` = the current frame + the container)
//            slicer         slicer::commands::update_slicer_core
//            timelineSlicer timeline_slicer::commands::update_timeline_slicer_core
//            floatingRange  floating_range::update_floating_range_inner
//          A control's container facts are FLAT `/properties/container*` keys
//          (Family catalog rows): they are written by literal.rs's control arm
//          through `set_control_property_core`, whose
//          `visual_format::check_control_container_value` is the same rule.
//
//          "Unchanged" is decided HERE, before any door is called: the slicer
//          door and the pivot door mint their DocumentEffect without comparing
//          (BUG-0477), so the same value twice must never reach them.
//
//          COLOURS: a bound or literal colour may be spelled `rgb(r, g, b)` /
//          `rgba(r, g, b, a)` (the binding colour type, eval.rs
//          `is_binding_color`), but a container colour is `#rgb` / `#rrggbb` /
//          `#rrggbbaa` only (`visual_format::is_safe_color`, what the painters
//          parse). [`normalize_container_colour`] converts the first into the
//          second for every container colour path -- a literal here and a
//          resolved binding value in eval.rs -- so `rgb(1,2,3)` paints as
//          `#010203` instead of being silently ignored by the resolver.
//
// LOCKS: every family store is read and RELEASED before its door is called;
// no lock is held across a door (each door takes its own).

use serde_json::Value;
use visual_format::{FieldType, VisualContainerFormat};

use crate::api_types::{ObjectBindingKind, ObjectBindingRef};

use super::catalog::{self, BindableOrigin};
use super::literal::{LiteralWriteCtx, LiteralWriteOutcome};

/// The field pointer INSIDE the container that `path` names on an object of
/// `kind` ("/spec/container/border/radius" on a chart -> "/border/radius"), or
/// `None` when `path` is not under the kind's container root.
pub fn container_suffix(kind: ObjectBindingKind, path: &str) -> Option<&str> {
    let root = catalog::container_root(kind)?;
    path.strip_prefix(root).filter(|s| s.starts_with('/'))
}

/// Is `path` a container COLOUR field of an object of `kind`? A Container row
/// of a chart / pivot / slicer / timeline / floating range, or a control's
/// flat `container*` colour key (`containerTitleColor`, ...).
pub fn is_container_colour_path(kind: ObjectBindingKind, path: &str) -> bool {
    let pointer = match kind {
        ObjectBindingKind::Control => path
            .strip_prefix("/properties/")
            .and_then(visual_format::control_container_key_pointer),
        _ => container_suffix(kind, path),
    };
    pointer.and_then(visual_format::field_type) == Some(FieldType::Color)
}

/// A colour value as a container stores it: `rgb(...)` / `rgba(...)` become
/// `#rrggbb` / `#rrggbbaa`; anything else (a hex colour, `""`, a value that is
/// no colour at all -- the leaf check names it) is returned unchanged.
pub fn normalize_container_colour(value: Value) -> Value {
    match &value {
        Value::String(s) if !s.trim().starts_with('#') && !s.trim().is_empty() => {
            match super::page_overrides::navigator_colour(s) {
                Some(hex) => Value::String(hex),
                None => value,
            }
        }
        _ => value,
    }
}

/// [`normalize_container_colour`] applied only where `path` is a container
/// colour field of `kind` (the one call site shape literal.rs and eval.rs use).
pub fn normalize_if_container_colour(kind: ObjectBindingKind, path: &str, value: Value) -> Value {
    if is_container_colour_path(kind, path) {
        normalize_container_colour(value)
    } else {
        value
    }
}

/// The container after setting ONE leaf (`Value::Null` clears it); `None` when
/// nothing is left, so the family stores no key.
fn next_container(
    current: Option<&VisualContainerFormat>,
    suffix: &str,
    value: Value,
) -> Result<Option<VisualContainerFormat>, String> {
    let next = current.cloned().unwrap_or_default().with_field(suffix, value)?;
    Ok((!next.is_empty()).then_some(next))
}

/// A stored container compared as the family stores it (an empty one is none).
fn effective(c: Option<VisualContainerFormat>) -> Option<VisualContainerFormat> {
    c.filter(|c| !c.is_empty())
}

/// Write ONE container leaf of `object` (`pointer` is the full catalog path,
/// e.g. `/spec/container/border/radius`) through the family's own door.
/// `value` is the COERCED literal (`literal::write_literal` coerces it to the
/// row's type and converts an `rgb(...)` colour to hex first -- the one place
/// that conversion happens on the literal path).
///
/// Refused (a sentence, before any effect): a path that is not one of the
/// kind's Container catalog rows -- this door is never laxer than the catalog,
/// even when called directly -- a value failing the leaf check, a chart
/// container carrying a second spelling of the title (`forbid_chart_title_leaves`),
/// a worksheet PivotTable (it has no box), an object that does not exist, and
/// whatever the family door itself refuses (protection, a subscribed page).
pub fn write_container_literal(
    ctx: &LiteralWriteCtx<'_>,
    object: &ObjectBindingRef,
    pointer: &str,
    value: Value,
) -> Result<LiteralWriteOutcome, String> {
    let row = catalog::match_path(object.kind, pointer)?;
    if row.origin != BindableOrigin::Container {
        return Err(format!(
            "'{pointer}' is not a format container field of a {}.",
            object.kind.label()
        ));
    }
    let suffix = container_suffix(object.kind, pointer).ok_or_else(|| {
        format!("'{pointer}' is not a format container field of a {}.", object.kind.label())
    })?;
    match object.kind {
        ObjectBindingKind::Chart => write_chart(ctx, object, suffix, value),
        ObjectBindingKind::Pivot => write_pivot(ctx, object, suffix, value),
        ObjectBindingKind::Slicer => write_slicer(ctx, object, suffix, value),
        ObjectBindingKind::TimelineSlicer => write_timeline(ctx, object, suffix, value),
        ObjectBindingKind::FloatingRange => write_floating_range(ctx, object, suffix, value),
        ObjectBindingKind::Control | ObjectBindingKind::CanvasPage => Err(format!(
            "A {} has no format container of its own.",
            object.kind.label()
        )),
    }
}

fn not_found(object: &ObjectBindingRef) -> String {
    format!("There is no {} with id '{}' in this workbook.", object.kind.label(), object.id)
}

fn entity_id(object: &ObjectBindingRef) -> Result<identity::EntityId, String> {
    identity::EntityId::parse(&object.id).ok_or_else(|| not_found(object))
}

fn written(domain: &'static str) -> LiteralWriteOutcome {
    LiteralWriteOutcome::Written { domains: vec![domain], layout: None }
}

// ---------------------------------------------------------------------------
// The families
// ---------------------------------------------------------------------------

/// A chart's container is `spec.container` inside the ChartDefinition envelope.
/// The stored one is read LENIENTLY (a spec loaded from a file is not validated
/// in Rust), so one leaf write never fails over a cosmetic value elsewhere.
fn write_chart(
    ctx: &LiteralWriteCtx<'_>,
    object: &ObjectBindingRef,
    suffix: &str,
    value: Value,
) -> Result<LiteralWriteOutcome, String> {
    let entry = {
        let charts = ctx.state.charts.read().map_err(|e| e.to_string())?;
        charts.iter().find(|c| c.id.to_string() == object.id).cloned()
    }
    .ok_or_else(|| not_found(object))?;
    let mut envelope: Value = serde_json::from_str(&entry.spec_json)
        .map_err(|e| format!("The chart's definition could not be read: {e}"))?;
    let spec = envelope
        .get_mut("spec")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "The chart's definition has no spec to format.".to_string())?;
    let current = effective(
        spec.get("container")
            .filter(|v| !v.is_null())
            .and_then(VisualContainerFormat::from_value_lenient),
    );
    let next = next_container(current.as_ref(), suffix, value)?;
    if let Some(c) = &next {
        c.forbid_chart_title_leaves()?;
    }
    if next == current {
        return Ok(LiteralWriteOutcome::Unchanged);
    }
    match &next {
        Some(c) => {
            let json = serde_json::to_value(c).map_err(|e| e.to_string())?;
            spec.insert("container".to_string(), json);
        }
        None => {
            spec.remove("container");
        }
    }
    let next_entry = crate::api_types::ChartEntry {
        id: entry.id,
        sheet_index: entry.sheet_index,
        spec_json: envelope.to_string(),
    };
    crate::chart_commands::update_chart_core(ctx.state, ctx.file_state, next_entry, None)?;
    Ok(written("objects"))
}

/// A canvas PivotTable box's container is `canvas_frame.container`. The door is
/// `update_pivot_properties_core` with the CURRENT frame (geometry unchanged,
/// so Lock Objects lets it through) carrying the new container: one
/// "Format pivot" step.
fn write_pivot(
    ctx: &LiteralWriteCtx<'_>,
    object: &ObjectBindingRef,
    suffix: &str,
    value: Value,
) -> Result<LiteralWriteOutcome, String> {
    let id = entity_id(object)?;
    let frame = {
        let tables = ctx.pivots.pivot_tables.read().map_err(|e| e.to_string())?;
        tables.get(&id).map(|(def, _)| def.canvas_frame.clone())
    }
    .ok_or_else(|| not_found(object))?
    .ok_or_else(|| {
        "This PivotTable is on a worksheet: only a PivotTable box on a canvas page has a format container."
            .to_string()
    })?;
    let current = effective(frame.container.clone());
    let next = next_container(current.as_ref(), suffix, value)?;
    if next == current {
        return Ok(LiteralWriteOutcome::Unchanged);
    }
    let mut config: crate::pivot::types::CanvasFrameConfig = frame.into();
    config.container = next;
    let request = crate::pivot::types::UpdatePivotPropertiesRequest {
        pivot_id: id,
        name: None,
        allow_multiple_filters_per_field: None,
        enable_data_value_editing: None,
        refresh_on_open: None,
        use_custom_sort_lists: None,
        canvas_frame: Some(config),
        style: None,
    };
    crate::pivot::commands::update_pivot_properties_core(ctx.state, ctx.file_state, ctx.pivots, request)?;
    Ok(written("pivot"))
}

/// The wire spelling of a container patch (`{"container": <value or null>}`):
/// the families' params are deserialize-only with a double-option `container`,
/// so they are built the way the frontend sends them.
fn container_patch(next: &Option<VisualContainerFormat>) -> Result<Value, String> {
    let c = match next {
        Some(c) => serde_json::to_value(c).map_err(|e| e.to_string())?,
        None => Value::Null,
    };
    Ok(serde_json::json!({ "container": c }))
}

fn write_slicer(
    ctx: &LiteralWriteCtx<'_>,
    object: &ObjectBindingRef,
    suffix: &str,
    value: Value,
) -> Result<LiteralWriteOutcome, String> {
    let id = entity_id(object)?;
    let current = {
        let slicers = ctx.slicers.slicers.read().map_err(|e| e.to_string())?;
        slicers.get(&id).map(|s| s.container.clone())
    }
    .ok_or_else(|| not_found(object))?;
    let current = effective(current);
    let next = next_container(current.as_ref(), suffix, value)?;
    if next == current {
        return Ok(LiteralWriteOutcome::Unchanged);
    }
    let params: crate::slicer::types::UpdateSlicerParams = serde_json::from_value(container_patch(&next)?)
        .map_err(|e| format!("The slicer update could not be built: {e}"))?;
    crate::slicer::commands::update_slicer_core(ctx.state, ctx.file_state, ctx.slicers, id, params)?;
    Ok(written("slicer"))
}

fn write_timeline(
    ctx: &LiteralWriteCtx<'_>,
    object: &ObjectBindingRef,
    suffix: &str,
    value: Value,
) -> Result<LiteralWriteOutcome, String> {
    let id = entity_id(object)?;
    let current = {
        let timelines = ctx.timelines.timelines.read().map_err(|e| e.to_string())?;
        timelines.get(&id).map(|t| t.container.clone())
    }
    .ok_or_else(|| not_found(object))?;
    let current = effective(current);
    let next = next_container(current.as_ref(), suffix, value)?;
    if next == current {
        return Ok(LiteralWriteOutcome::Unchanged);
    }
    let params: crate::timeline_slicer::types::UpdateTimelineParams =
        serde_json::from_value(container_patch(&next)?)
            .map_err(|e| format!("The timeline update could not be built: {e}"))?;
    crate::timeline_slicer::commands::update_timeline_slicer_core(
        ctx.state,
        ctx.timelines,
        ctx.file_state,
        id,
        params,
    )?;
    Ok(written("slicer"))
}

fn write_floating_range(
    ctx: &LiteralWriteCtx<'_>,
    object: &ObjectBindingRef,
    suffix: &str,
    value: Value,
) -> Result<LiteralWriteOutcome, String> {
    let id = entity_id(object)?;
    let current = {
        let rows = ctx.state.floating_ranges.read().map_err(|e| e.to_string())?;
        rows.iter().find(|fr| fr.id == id).map(|fr| fr.container.clone())
    }
    .ok_or_else(|| not_found(object))?;
    let current = effective(current);
    let next = next_container(current.as_ref(), suffix, value)?;
    if next == current {
        return Ok(LiteralWriteOutcome::Unchanged);
    }
    let patch = crate::api_types::FloatingRangePatch { container: Some(next), ..Default::default() };
    crate::floating_range::update_floating_range_inner(ctx.state, ctx.file_state, id, patch)?;
    Ok(written("floatingRanges"))
}
