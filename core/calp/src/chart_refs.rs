//! FILENAME: core/calp/src/chart_refs.rs
//! PURPOSE: Find, stamp and remap the sheets a chart's data sources name.
//! CONTEXT: A chart's `spec` is the whole ChartDefinition envelope as JSON
//! (`SavedChart.spec`, an embedded object since `.cala` v10) (`{chartId, name, sheetIndex, x, y, ..., spec: ChartSpec}`) or, for
//! a chart written by a script or an older build, a bare ChartSpec. Inside it a
//! coordinate data source (a DataRangeRef, any object with `startRow`) names its
//! sheet two ways: `sheetId`, the workbook's stable sheet uuid, which WINS when
//! present, and `sheetIndex`, read only when there is no id. A string source is
//! an A1 reference ("Sheet1!A1:D10", bound by sheet NAME) or a named-range name.
//!
//! A spec carries sources in FOUR places, and a walk that forgets one is a
//! source that silently goes on following the wrong sheet:
//!   - `spec.data`                         the chart's own source
//!   - `spec.layers[].data`                a layer's own source
//!   - `spec.transform[type=lookup].from`  a lookup table
//!   - `spec.concat.charts[]`              child specs, recursively (depth-capped)
//!
//! This is the Rust twin of `app/extensions/Charts/lib/chartSheetRefs.ts` and
//! must visit exactly what it visits. It is pure: nothing here reads a
//! workspace or a workbook; callers hand in the sheet list or the id map.
//!
//! WHY `pull.rs` NEVER CALLS THE REMAP. `pull()` serves subscribe (fresh local
//! ids), checkout (the application's ids) and refresh, and refresh DISCARDS
//! pull's fresh ids in favour of the old local ones. Only the host's
//! materializer knows which local sheet an application sheet finally became, so
//! only the host may rewrite a spec. The pulled `spec` is the publisher's
//! value, verbatim.
//!
//! THE REWRITERS EDIT IN PLACE AND RETURN WHETHER ANYTHING CHANGED. The spec is
//! a `serde_json::Value` (built without `preserve_order`, so its object keys
//! are SORTED and it serialises deterministically): an untouched chart writes
//! the same bytes whether or not a rewriter visited it, so there is no "keep
//! the original bytes" path to protect any more. The `bool` exists for the
//! callers that count or report rewrites.
//!
//! A rewrite can be undone -- a checkout renames an application's string
//! sources to this workbook's names and the push renames them back -- and the
//! SPELLING of a sheet prefix may not come home identical ('DATA'!A1 vs
//! Data!A1). What a version diff compares is therefore
//! [`comparable_chart_spec`]: the spelling of a source's sheet prefix is not an
//! edit (and key order never was one for a `Value`).

use std::collections::HashMap;

use identity::{EntityId, SheetId};
use serde_json::{Map, Value};

/// Bound on `concat` nesting, matching `MAX_STAMP_DEPTH` in chartSheetRefs.ts:
/// a spec at depth <= 16 is visited, its children beyond that are not.
const MAX_WALK_DEPTH: usize = 16;

/// The `sheetId` a publish stamps onto a DataRangeRef whose `sheetIndex` names
/// no sheet of the publisher's workbook: an id NO sheet can answer to.
///
/// Leaving such a ref unstamped is what let it go wrong. The subscriber's load
/// migration (`stampSpecSheetIds` in chartSheetRefs.ts) stamps every id-less ref
/// from its index in the SUBSCRIBER's workbook, so a chart that errored for its
/// publisher silently charted an unrelated sheet of the subscriber's own. With
/// a non-empty id the TS side reads the ref as stamped (`isUnstamped` is false),
/// and its resolver maps the id through the live sheet list, finds nothing and
/// refuses it ("the chart's source sheet no longer exists") -- never a fall back
/// to the index. `ref_sheet` here reads it the same way: an id no sheet has.
///
/// The RFC 9562 MAX uuid rather than the nil one, deliberately: `SheetId::ZERO`
/// (nil) is the type's `Default`, the "not yet assigned" sentinel, so a padded
/// id vector anywhere could hand a real sheet that id and the chart would bind
/// to it. The max uuid carries version nibble `f`; the v7 generator never
/// produces it and nothing defaults to it.
pub const UNRESOLVABLE_SHEET_ID: SheetId = SheetId::from_bytes([0xff; 16]);

/// One sheet a chart's data sources name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChartSourceSheet {
    /// A DataRangeRef's stable `sheetId` (wins over its index).
    Id(SheetId),
    /// A DataRangeRef with no id: its `sheetIndex`, in the workbook's own order.
    Index(usize),
    /// A sheet-qualified A1 string source (`"Data!A1:B5"`, `"'My Sheet'!A1"`),
    /// bound by NAME.
    Name(String),
}

/// One data source as the walk found it. Crate-internal because the publish
/// warnings also need the string sources that name NO sheet at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ChartSource {
    /// A source that names a sheet.
    Sheet(ChartSourceSheet),
    /// A string source with no sheet prefix: an A1 range read from whichever
    /// sheet is active, or a named-range name.
    Unqualified(String),
    /// A PIVOT source (`{type: "pivot", pivotId}`): the chart reads a pivot
    /// table's aggregated output, so it travels only if that pivot does -- and
    /// the pivot travels only with its destination AND its grid source sheet.
    /// The raw `pivotId` text, as the spec carries it.
    Pivot(String),
}

/// Every pivot table a chart reads (`{type: "pivot", pivotId}` sources in the
/// four places the module header lists), deduplicated, in walk order. An id that
/// does not parse names no pivot and is skipped. A spec that is not an object
/// (an unparseable spec kept as a string) yields nothing.
pub fn chart_spec_pivot_ids(spec: &Value) -> Vec<EntityId> {
    let mut out: Vec<EntityId> = Vec::new();
    for source in chart_spec_sources(spec) {
        if let ChartSource::Pivot(raw) = source {
            if let Some(id) = EntityId::parse(&raw) {
                if !out.contains(&id) {
                    out.push(id);
                }
            }
        }
    }
    out
}

/// Every sheet a chart's data sources name, deduplicated, in walk order.
///
/// A DataRangeRef contributes its `sheetId` when it has a non-empty one (an id
/// that does not parse names no sheet, exactly as the resolver refuses it rather
/// than falling back), otherwise its `sheetIndex`. A sheet-qualified A1 string
/// contributes the sheet's name. Unqualified strings, pivot and design-query
/// sources name no sheet and contribute nothing. A spec that is not an object
/// yields nothing.
pub fn chart_spec_source_sheets(spec: &Value) -> Vec<ChartSourceSheet> {
    let mut out: Vec<ChartSourceSheet> = Vec::new();
    for source in chart_spec_sources(spec) {
        if let ChartSource::Sheet(sheet) = source {
            if !out.contains(&sheet) {
                out.push(sheet);
            }
        }
    }
    out
}

/// Every data source of a chart, deduplicated, in walk order -- the sheets it
/// names, the unqualified strings that name none, and the pivot tables it reads.
pub(crate) fn chart_spec_sources(spec: &Value) -> Vec<ChartSource> {
    let mut raw: Vec<&Value> = Vec::new();
    collect_sources(spec_root(spec), 0, &mut raw);

    let mut out: Vec<ChartSource> = Vec::new();
    for source in raw {
        let item = match source {
            Value::Object(m) if is_range_ref(m) => ref_sheet(m).map(ChartSource::Sheet),
            Value::Object(m) if m.get("type").and_then(Value::as_str) == Some("pivot") => m
                .get("pivotId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(|id| ChartSource::Pivot(id.to_string())),
            Value::String(s) => {
                let text = s.trim();
                if text.is_empty() {
                    None
                } else {
                    match crate::publish::reference_sheet_name(text) {
                        // "!A1" names an EMPTY sheet, which the resolver reads as
                        // unqualified (an empty name is falsy there).
                        Some(name) if !name.is_empty() => {
                            Some(ChartSource::Sheet(ChartSourceSheet::Name(name)))
                        }
                        _ => Some(ChartSource::Unqualified(text.to_string())),
                    }
                }
            }
            _ => None,
        };
        if let Some(item) = item {
            if !out.contains(&item) {
                out.push(item);
            }
        }
    }
    out
}

/// Rewrite every DataRangeRef whose `sheetId` is a key of `map` (APPLICATION
/// sheet id -> (LOCAL sheet id, LOCAL sheet index)): its `sheetId` becomes the
/// local id and its `sheetIndex` the local index, so id-first and index-only
/// consumers agree. Refs whose id is not in the map, refs with no id, and string
/// sources are left exactly as they are -- an unmapped id then resolves to the
/// honest "source sheet no longer exists" error rather than to some other
/// sheet's cells.
///
/// Edits `spec` in place; returns `false` when nothing changed (including a
/// spec that is not an object and an empty map). A map entry that sends an id to
/// itself AND to the index the ref already carries changes nothing; an identity
/// id with a DIFFERENT index still rewrites the index.
pub fn remap_chart_spec_sheet_ids(
    spec: &mut Value,
    map: &HashMap<SheetId, (SheetId, usize)>,
) -> bool {
    if map.is_empty() {
        return false;
    }
    for_each_range_ref_mut(spec_root_mut(spec), 0, &mut |r| {
        let Some(id) = r.get("sheetId").and_then(Value::as_str).and_then(SheetId::parse) else {
            return false;
        };
        let Some(&(local_id, local_index)) = map.get(&id) else {
            return false;
        };
        let mut touched = false;
        if local_id != id {
            r.insert("sheetId".to_string(), Value::String(local_id.to_string()));
            touched = true;
        }
        if r.get("sheetIndex").and_then(Value::as_u64) != Some(local_index as u64) {
            r.insert("sheetIndex".to_string(), Value::from(local_index as u64));
            touched = true;
        }
        touched
    })
}

/// Rename the sheet prefix of every sheet-qualified STRING source
/// (`"Data!A1:B5"`, `"'My Data'!A1"`) through `renames`, in the four places the
/// module header lists (BUG-0151). A string source binds its sheet by NAME, so
/// when a pull renames the application's "Data" to "Data (2)" on arrival, the
/// chart otherwise reads the SUBSCRIBER's own "Data". DataRangeRefs (bound by
/// id) and unqualified strings are left alone.
///
/// Edits `spec` in place; returns `false` when nothing changed (including a
/// spec that is not an object and an empty rename set).
pub fn rename_chart_spec_sheet_names(
    spec: &mut Value,
    renames: &crate::sheet_renames::SheetRenames,
) -> bool {
    if renames.is_empty() {
        return false;
    }
    for_each_source_mut(spec_root_mut(spec), 0, &mut |source| {
        let Value::String(text) = source else {
            return false;
        };
        match renames.rename_reference(text) {
            Some(renamed) => {
                *text = renamed;
                true
            }
            None => false,
        }
    })
}

/// A chart spec in the form two spellings of the SAME chart share: every
/// string source's sheet prefix spelled the one comparable way
/// (`crate::sheet_renames::comparable_reference`). Key order is already
/// irrelevant to a `Value`'s equality. A spec that is not an object (an
/// unparseable spec kept as a string) is returned as it is and compares as
/// that string.
///
/// The version diff compares charts through this, because a checkout rename
/// and the push's undo of it can change the spelling of an untouched spec's
/// sheet prefixes (see the module header): compared raw, every such chart
/// shipped as "modified" and blocked a merge with a teammate who DID edit it.
pub fn comparable_chart_spec(spec: &Value) -> Value {
    let mut value = spec.clone();
    for_each_source_mut(spec_root_mut(&mut value), 0, &mut |source| {
        let Value::String(text) = source else {
            return false;
        };
        let comparable = crate::sheet_renames::comparable_reference(text);
        let changed = comparable != *text;
        *text = comparable;
        changed
    });
    value
}

/// Stamp `sheetId` onto every DataRangeRef that lacks one (absent, not a
/// string, or empty -- the TS `isUnstamped` rule), taking the id of the sheet
/// its `sheetIndex` names in `sheet_ids` (the workbook's sheets, in index
/// order). A ref whose index NO sheet answers to (out of range, or no usable
/// index at all) is stamped with [`UNRESOLVABLE_SHEET_ID`], so no downstream
/// migration can bind it by position; a ref that already carries an id is never
/// touched.
///
/// Used where a chart LEAVES the publisher: a ref that carries only the
/// publisher's index would otherwise be stamped on the subscriber with whatever
/// sheet sits at that index there. Edits `spec` in place; returns `false`
/// when nothing changed.
pub fn stamp_chart_spec_sheet_ids(spec: &mut Value, sheet_ids: &[SheetId]) -> bool {
    for_each_range_ref_mut(spec_root_mut(spec), 0, &mut |r| {
        let stamped = matches!(r.get("sheetId"), Some(Value::String(s)) if !s.is_empty());
        if stamped {
            return false;
        }
        let id = r
            .get("sheetIndex")
            .and_then(Value::as_u64)
            .and_then(|i| usize::try_from(i).ok())
            .and_then(|i| sheet_ids.get(i))
            .copied()
            .unwrap_or(UNRESOLVABLE_SHEET_ID);
        r.insert("sheetId".to_string(), Value::String(id.to_string()));
        true
    })
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/// The ChartSpec inside `value`: its `spec` when that is an object (the
/// ChartDefinition envelope), otherwise `value` itself (a bare spec). The same
/// rule as the chart store's load path.
fn spec_root(value: &Value) -> &Value {
    match value.get("spec") {
        Some(spec) if spec.is_object() => spec,
        _ => value,
    }
}

/// [`spec_root`], mutably.
fn spec_root_mut(value: &mut Value) -> &mut Value {
    if value.get("spec").is_some_and(Value::is_object) {
        // `get` just proved `value` is an object holding "spec", so indexing
        // neither panics nor inserts.
        &mut value["spec"]
    } else {
        value
    }
}

/// A DataRangeRef is any object carrying `startRow` (`isDataRangeRef`).
fn is_range_ref(m: &Map<String, Value>) -> bool {
    m.contains_key("startRow")
}

/// The sheet one DataRangeRef names: its non-empty `sheetId` (None when that
/// does not parse -- the resolver refuses such an id rather than falling back),
/// otherwise its `sheetIndex`. An id that parses but that no sheet carries --
/// [`UNRESOLVABLE_SHEET_ID`] among them -- is returned as `Id` and resolves to
/// no sheet wherever it is looked up; it never falls back to the index.
fn ref_sheet(m: &Map<String, Value>) -> Option<ChartSourceSheet> {
    match m.get("sheetId") {
        Some(Value::String(s)) if !s.is_empty() => SheetId::parse(s).map(ChartSourceSheet::Id),
        _ => m
            .get("sheetIndex")
            .and_then(Value::as_u64)
            .and_then(|i| usize::try_from(i).ok())
            .map(ChartSourceSheet::Index),
    }
}

/// Push every data source of `spec` (and of its concat children, to the depth
/// cap) onto `out`, in the four places the module header lists.
fn collect_sources<'a>(spec: &'a Value, depth: usize, out: &mut Vec<&'a Value>) {
    let Some(obj) = spec.as_object() else {
        return;
    };
    if let Some(data) = obj.get("data") {
        out.push(data);
    }
    if let Some(layers) = obj.get("layers").and_then(Value::as_array) {
        for layer in layers {
            if let Some(data) = layer.as_object().and_then(|l| l.get("data")) {
                out.push(data);
            }
        }
    }
    if let Some(transforms) = obj.get("transform").and_then(Value::as_array) {
        for t in transforms {
            let Some(t) = t.as_object() else { continue };
            if t.get("type").and_then(Value::as_str) != Some("lookup") {
                continue;
            }
            if let Some(from) = t.get("from") {
                out.push(from);
            }
        }
    }
    if depth < MAX_WALK_DEPTH {
        if let Some(children) = obj
            .get("concat")
            .and_then(|c| c.get("charts"))
            .and_then(Value::as_array)
        {
            for child in children {
                collect_sources(child, depth + 1, out);
            }
        }
    }
}

/// Call `f` on every DataRangeRef of `spec` (the same places as
/// [`collect_sources`]); true when any call reported a change.
fn for_each_range_ref_mut(
    spec: &mut Value,
    depth: usize,
    f: &mut dyn FnMut(&mut Map<String, Value>) -> bool,
) -> bool {
    let Some(obj) = spec.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    if let Some(data) = obj.get_mut("data") {
        changed |= visit_range_ref_mut(data, f);
    }
    if let Some(layers) = obj.get_mut("layers").and_then(Value::as_array_mut) {
        for layer in layers {
            if let Some(data) = layer.as_object_mut().and_then(|l| l.get_mut("data")) {
                changed |= visit_range_ref_mut(data, f);
            }
        }
    }
    if let Some(transforms) = obj.get_mut("transform").and_then(Value::as_array_mut) {
        for t in transforms {
            let Some(t) = t.as_object_mut() else { continue };
            if t.get("type").and_then(Value::as_str) != Some("lookup") {
                continue;
            }
            if let Some(from) = t.get_mut("from") {
                changed |= visit_range_ref_mut(from, f);
            }
        }
    }
    if depth < MAX_WALK_DEPTH {
        if let Some(children) = obj
            .get_mut("concat")
            .and_then(|c| c.get_mut("charts"))
            .and_then(Value::as_array_mut)
        {
            for child in children {
                changed |= for_each_range_ref_mut(child, depth + 1, f);
            }
        }
    }
    changed
}

fn visit_range_ref_mut(
    source: &mut Value,
    f: &mut dyn FnMut(&mut Map<String, Value>) -> bool,
) -> bool {
    match source.as_object_mut() {
        Some(m) if is_range_ref(m) => f(m),
        _ => false,
    }
}

/// Call `f` on every data SOURCE value of `spec` -- whatever its shape -- in the
/// same places as [`collect_sources`]; true when any call reported a change.
fn for_each_source_mut(
    spec: &mut Value,
    depth: usize,
    f: &mut dyn FnMut(&mut Value) -> bool,
) -> bool {
    let Some(obj) = spec.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    if let Some(data) = obj.get_mut("data") {
        changed |= f(data);
    }
    if let Some(layers) = obj.get_mut("layers").and_then(Value::as_array_mut) {
        for layer in layers {
            if let Some(data) = layer.as_object_mut().and_then(|l| l.get_mut("data")) {
                changed |= f(data);
            }
        }
    }
    if let Some(transforms) = obj.get_mut("transform").and_then(Value::as_array_mut) {
        for t in transforms {
            let Some(t) = t.as_object_mut() else { continue };
            if t.get("type").and_then(Value::as_str) != Some("lookup") {
                continue;
            }
            if let Some(from) = t.get_mut("from") {
                changed |= f(from);
            }
        }
    }
    if depth < MAX_WALK_DEPTH {
        if let Some(children) = obj
            .get_mut("concat")
            .and_then(|c| c.get_mut("charts"))
            .and_then(Value::as_array_mut)
        {
            for child in children {
                changed |= for_each_source_mut(child, depth + 1, f);
            }
        }
    }
    changed
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sid() -> SheetId {
        SheetId::from_bytes(identity::generate_uuid_v7())
    }

    fn range_ref(sheet_index: u64, sheet_id: Option<SheetId>) -> Value {
        let mut r = json!({
            "sheetIndex": sheet_index,
            "startRow": 0, "startCol": 0, "endRow": 4, "endCol": 1
        });
        if let Some(id) = sheet_id {
            r["sheetId"] = Value::String(id.to_string());
        }
        r
    }

    /// A spec using all four places: its own data, a layer, a lookup transform
    /// (plus a NON-lookup transform whose `from` must be ignored), and a concat
    /// child which itself has a concat grandchild.
    fn four_path_spec(a: SheetId, c: SheetId, d: SheetId) -> Value {
        json!({
            "mark": "bar",
            "data": range_ref(0, Some(a)),
            "layers": [
                { "mark": "line", "data": range_ref(3, None) },
                { "mark": "point" },
                "not-an-object"
            ],
            "transform": [
                { "type": "lookup", "from": "'My Sheet'!A1:B9" },
                { "type": "filter", "from": range_ref(7, None) }
            ],
            "concat": {
                "charts": [
                    { "data": range_ref(1, Some(c)) },
                    { "data": { "type": "pivot", "pivotId": "p1" },
                      "concat": { "charts": [ { "data": range_ref(2, Some(d)) } ] } }
                ]
            }
        })
    }

    fn envelope(spec: Value) -> Value {
        json!({
            "chartId": 7, "name": "Sales", "sheetIndex": 5, "x": 10, "y": 20,
            "spec": spec
        })
    }

    #[test]
    fn the_walk_finds_all_four_paths_and_nested_concat() {
        let (a, c, d) = (sid(), sid(), sid());
        let found = chart_spec_source_sheets(&envelope(four_path_spec(a, c, d)));
        assert_eq!(
            found,
            vec![
                ChartSourceSheet::Id(a),
                ChartSourceSheet::Index(3),
                ChartSourceSheet::Name("My Sheet".to_string()),
                ChartSourceSheet::Id(c),
                ChartSourceSheet::Id(d),
            ],
            "data, layer, lookup, concat child and concat grandchild -- and NOT the \
             filter transform's `from` (index 7) nor the pivot source"
        );
    }

    #[test]
    fn a_bare_spec_and_an_envelope_walk_the_same() {
        let (a, c, d) = (sid(), sid(), sid());
        let spec = four_path_spec(a, c, d);
        assert_eq!(chart_spec_source_sheets(&spec), chart_spec_source_sheets(&envelope(spec.clone())));
        // The ENVELOPE's own `sheetIndex` is the chart's placement, not a data
        // source: an envelope with no spec data names no sheet at all.
        assert!(chart_spec_source_sheets(&envelope(json!({ "mark": "bar" }))).is_empty());
    }

    #[test]
    fn string_sources_bind_by_name_and_unqualified_ones_name_no_sheet() {
        let spec = json!({
            "data": "Sheet1!A1:B5",
            "layers": [
                { "data": "'It''s'!C1:C5" },
                { "data": "A1:B5" },
                { "data": "SalesData" },
                { "data": "!A1:A3" },
                { "data": "   " }
            ]
        });
        assert_eq!(
            chart_spec_source_sheets(&spec),
            vec![
                ChartSourceSheet::Name("Sheet1".to_string()),
                ChartSourceSheet::Name("It's".to_string()),
            ]
        );
        assert_eq!(
            chart_spec_sources(&spec),
            vec![
                ChartSource::Sheet(ChartSourceSheet::Name("Sheet1".to_string())),
                ChartSource::Sheet(ChartSourceSheet::Name("It's".to_string())),
                ChartSource::Unqualified("A1:B5".to_string()),
                ChartSource::Unqualified("SalesData".to_string()),
                ChartSource::Unqualified("!A1:A3".to_string()),
            ]
        );
    }

    #[test]
    fn an_empty_or_unparseable_id_falls_to_the_index_or_names_nothing() {
        let spec = json!({
            "data": { "sheetIndex": 2, "sheetId": "", "startRow": 0 },
            "layers": [
                { "data": { "sheetIndex": 4, "sheetId": "not-a-uuid", "startRow": 0 } },
                { "data": { "sheetIndex": 6, "sheetId": null, "startRow": 0 } }
            ]
        });
        assert_eq!(
            chart_spec_source_sheets(&spec),
            vec![ChartSourceSheet::Index(2), ChartSourceSheet::Index(6)],
            "an empty or null id is unstamped (index); a bad id names no sheet"
        );
    }

    #[test]
    fn duplicates_are_reported_once() {
        let a = sid();
        let spec = json!({
            "data": range_ref(0, Some(a)),
            "layers": [ { "data": range_ref(9, Some(a)) } ]
        });
        assert_eq!(chart_spec_source_sheets(&spec), vec![ChartSourceSheet::Id(a)]);
    }

    #[test]
    fn remap_rewrites_id_and_index_on_every_path() {
        let (a, c, d) = (sid(), sid(), sid());
        let (la, lc, ld) = (sid(), sid(), sid());
        let mut map = HashMap::new();
        map.insert(a, (la, 10));
        map.insert(c, (lc, 11));
        map.insert(d, (ld, 12));
        let mut v = envelope(four_path_spec(a, c, d));
        assert!(remap_chart_spec_sheet_ids(&mut v, &map), "mapped ids must rewrite");
        let spec = &v["spec"];
        assert_eq!(spec["data"]["sheetId"], la.to_string());
        assert_eq!(spec["data"]["sheetIndex"], 10);
        assert_eq!(spec["concat"]["charts"][0]["data"]["sheetId"], lc.to_string());
        assert_eq!(spec["concat"]["charts"][0]["data"]["sheetIndex"], 11);
        let grandchild = &spec["concat"]["charts"][1]["concat"]["charts"][0]["data"];
        assert_eq!(grandchild["sheetId"], ld.to_string());
        assert_eq!(grandchild["sheetIndex"], 12);
        // The id-less layer ref and the name-bound lookup are untouched.
        assert!(spec["layers"][0]["data"].get("sheetId").is_none());
        assert_eq!(spec["layers"][0]["data"]["sheetIndex"], 3);
        assert_eq!(spec["transform"][0]["from"], "'My Sheet'!A1:B9");
        // The envelope's placement index is not a data source.
        assert_eq!(v["sheetIndex"], 5);
        assert_eq!(v["name"], "Sales");
    }

    #[test]
    fn remap_rewrites_a_layer_and_a_lookup_ref_too() {
        let (a, b) = (sid(), sid());
        let (la, lb) = (sid(), sid());
        let mut v = json!({
            "layers": [ { "data": range_ref(0, Some(a)) } ],
            "transform": [ { "type": "lookup", "from": range_ref(1, Some(b)) } ]
        });
        let mut map = HashMap::new();
        map.insert(a, (la, 4));
        map.insert(b, (lb, 5));
        assert!(remap_chart_spec_sheet_ids(&mut v, &map));
        assert_eq!(v["layers"][0]["data"]["sheetId"], la.to_string());
        assert_eq!(v["layers"][0]["data"]["sheetIndex"], 4);
        assert_eq!(v["transform"][0]["from"]["sheetId"], lb.to_string());
        assert_eq!(v["transform"][0]["from"]["sheetIndex"], 5);
    }

    #[test]
    fn remap_leaves_unmapped_ids_alone() {
        let (a, stranger) = (sid(), sid());
        let la = sid();
        let mut v = json!({
            "data": range_ref(0, Some(a)),
            "layers": [ { "data": range_ref(8, Some(stranger)) } ]
        });
        let mut map = HashMap::new();
        map.insert(a, (la, 2));
        assert!(remap_chart_spec_sheet_ids(&mut v, &map));
        assert_eq!(v["data"]["sheetId"], la.to_string());
        assert_eq!(
            v["layers"][0]["data"]["sheetId"],
            stranger.to_string(),
            "an id the map does not know keeps pointing where it pointed"
        );
        assert_eq!(v["layers"][0]["data"]["sheetIndex"], 8);
    }

    #[test]
    fn remap_reports_no_change_when_nothing_changed() {
        let a = sid();
        let spec = envelope(json!({ "data": range_ref(3, Some(a)), "mark": "bar" }));
        // An empty map.
        let mut v = spec.clone();
        assert!(!remap_chart_spec_sheet_ids(&mut v, &HashMap::new()));
        assert_eq!(v, spec);
        // A map that knows none of the spec's ids.
        let mut other = HashMap::new();
        other.insert(sid(), (sid(), 0));
        assert!(!remap_chart_spec_sheet_ids(&mut v, &other));
        assert_eq!(v, spec);
        // The identity at the index the ref already carries (a checkout laid out
        // like the publisher's workbook).
        let mut identity = HashMap::new();
        identity.insert(a, (a, 3));
        assert!(!remap_chart_spec_sheet_ids(&mut v, &identity));
        assert_eq!(v, spec);
        // ...but the identity at ANOTHER index still moves the index.
        let mut moved = HashMap::new();
        moved.insert(a, (a, 6));
        assert!(remap_chart_spec_sheet_ids(&mut v, &moved));
        assert_eq!(v["spec"]["data"]["sheetId"], a.to_string());
        assert_eq!(v["spec"]["data"]["sheetIndex"], 6);
        // A spec with no ref at all.
        let mut map = HashMap::new();
        map.insert(a, (sid(), 1));
        assert!(!remap_chart_spec_sheet_ids(&mut json!({ "kind": "bar" }), &map));
    }

    #[test]
    fn stamp_fills_only_unstamped_refs_from_the_index() {
        let ids = vec![sid(), sid(), sid(), sid()];
        let already = sid();
        let mut v = json!({
            "data": range_ref(1, None),
            "layers": [
                { "data": range_ref(0, Some(already)) },
                { "data": range_ref(99, None) },
                { "data": { "sheetIndex": 3, "sheetId": "", "startRow": 0 } }
            ],
            "transform": [ { "type": "lookup", "from": range_ref(2, None) } ],
            "concat": { "charts": [ { "data": range_ref(0, None) } ] }
        });
        assert!(stamp_chart_spec_sheet_ids(&mut v, &ids));
        assert_eq!(v["data"]["sheetId"], ids[1].to_string());
        assert_eq!(v["layers"][0]["data"]["sheetId"], already.to_string(), "stamped ref untouched");
        assert_eq!(
            v["layers"][1]["data"]["sheetId"],
            UNRESOLVABLE_SHEET_ID.to_string(),
            "no sheet at index 99: stamped with the id no sheet answers, never left to be \
             bound by position on the subscriber"
        );
        assert_eq!(v["layers"][1]["data"]["sheetIndex"], 99, "the index itself is not rewritten");
        assert_eq!(v["layers"][2]["data"]["sheetId"], ids[3].to_string(), "empty id is unstamped");
        assert_eq!(v["transform"][0]["from"]["sheetId"], ids[2].to_string());
        assert_eq!(v["concat"]["charts"][0]["data"]["sheetId"], ids[0].to_string());
        // Indices are never rewritten by a stamp.
        assert_eq!(v["data"]["sheetIndex"], 1);
    }

    #[test]
    fn stamp_reports_no_change_when_nothing_changed() {
        let a = sid();
        let ids = vec![sid()];
        let stamped = envelope(json!({ "data": range_ref(0, Some(a)) }));
        let mut v = stamped.clone();
        assert!(!stamp_chart_spec_sheet_ids(&mut v, &ids));
        assert_eq!(v, stamped);
        assert!(!stamp_chart_spec_sheet_ids(&mut json!({ "kind": "bar" }), &ids));
        assert!(!stamp_chart_spec_sheet_ids(&mut json!({ "data": "Sheet1!A1:B2" }), &ids));
        // A ref that already carries the unresolvable id is STAMPED: a second
        // publish leaves it alone.
        let mut unresolvable = json!({ "data": range_ref(5, Some(UNRESOLVABLE_SHEET_ID)) });
        assert!(!stamp_chart_spec_sheet_ids(&mut unresolvable, &ids));
    }

    /// An index-only ref that no publisher sheet answers must not ship
    /// unstamped: the subscriber's load migration would stamp it from ITS
    /// sheet at that index, and a chart that errored for its publisher would
    /// silently chart somebody else's sheet. It leaves carrying an id no sheet
    /// has, which both sides read as naming no sheet.
    ///
    /// SABOTAGE: restore the early `return false` for an index no sheet
    /// answers -- the ref ships id-less and the first assertion fails.
    #[test]
    fn an_index_no_sheet_answers_leaves_with_an_unresolvable_id() {
        let ids = vec![sid(), sid()];
        for spec in [
            json!({ "data": range_ref(5, None) }),
            json!({ "data": { "sheetIndex": 7, "sheetId": "", "startRow": 0 } }),
            json!({ "data": { "startRow": 0, "startCol": 0 } }),
        ] {
            let mut v = spec.clone();
            assert!(
                stamp_chart_spec_sheet_ids(&mut v, &ids),
                "an unanswerable ref must be stamped: {spec}"
            );
            assert_eq!(v["data"]["sheetId"], UNRESOLVABLE_SHEET_ID.to_string(), "{spec}");
            // Read back, it names a sheet by id -- one no workbook carries.
            assert_eq!(
                chart_spec_source_sheets(&v),
                vec![ChartSourceSheet::Id(UNRESOLVABLE_SHEET_ID)]
            );
            assert!(!ids.contains(&UNRESOLVABLE_SHEET_ID));
        }
        // Distinct from the nil id, which is `SheetId`'s Default ("unassigned").
        assert_ne!(UNRESOLVABLE_SHEET_ID, SheetId::ZERO);
        assert_ne!(UNRESOLVABLE_SHEET_ID, SheetId::default());
    }

    /// A pivot chart's source is a PIVOT, which the walk reports so the publish
    /// selection can bring the pivot's two sheets along.
    ///
    /// SABOTAGE: drop the `type == "pivot"` arm from `chart_spec_sources` --
    /// the ids come back empty.
    #[test]
    fn pivot_sources_are_reported_in_all_four_places() {
        let (p1, p2, p3) = (
            EntityId::from_bytes(identity::generate_uuid_v7()),
            EntityId::from_bytes(identity::generate_uuid_v7()),
            EntityId::from_bytes(identity::generate_uuid_v7()),
        );
        let spec = envelope(json!({
            "data": { "type": "pivot", "pivotId": p1.to_string(), "includeSubtotals": true },
            "layers": [ { "data": { "type": "pivot", "pivotId": p2.to_string() } } ],
            "transform": [ { "type": "lookup", "from": { "type": "pivot", "pivotId": p1.to_string() } } ],
            "concat": { "charts": [
                { "data": { "type": "pivot", "pivotId": p3.to_string() } },
                { "data": { "type": "pivot", "pivotId": "not-a-uuid" } },
                { "data": { "type": "pivot", "pivotId": "" } },
                { "data": { "type": "designQuery", "query": "x" } }
            ] }
        }));
        assert_eq!(chart_spec_pivot_ids(&spec), vec![p1, p2, p3], "deduplicated, walk order");
        assert!(
            chart_spec_sources(&spec).contains(&ChartSource::Pivot("not-a-uuid".to_string())),
            "the raw id is kept for the warning, even one that names no pivot"
        );
        assert!(chart_spec_source_sheets(&spec).is_empty(), "a pivot source names no sheet");
        assert!(chart_spec_pivot_ids(&Value::String("not json".to_string())).is_empty());
    }

    /// A spec that is not an object -- an unparseable spec kept as a STRING
    /// value, or any other wrong shape -- names nothing and is never rewritten.
    #[test]
    fn a_non_object_spec_never_panics() {
        let mut map = HashMap::new();
        map.insert(sid(), (sid(), 0));
        for bad in [
            Value::String(String::new()),
            Value::String("{".to_string()),
            Value::String("not json".to_string()),
            json!(42),
            Value::Null,
            json!([]),
            json!([1, 2]),
            json!("Sheet1!A1"),
            json!({ "spec": 7 }),
        ] {
            assert!(chart_spec_source_sheets(&bad).is_empty(), "{bad}");
            assert!(chart_spec_sources(&bad).is_empty(), "{bad}");
            let mut v = bad.clone();
            assert!(!remap_chart_spec_sheet_ids(&mut v, &map), "{bad}");
            assert!(!stamp_chart_spec_sheet_ids(&mut v, &[sid()]), "{bad}");
            assert_eq!(v, bad, "a non-object spec is never rewritten");
        }
        // Wrong shapes in the right places are skipped, not fatal.
        let odd = json!({
            "data": 17,
            "layers": { "not": "an array" },
            "transform": [ 3, { "type": "lookup" }, { "type": "lookup", "from": null } ],
            "concat": { "charts": "nope" }
        });
        assert!(chart_spec_source_sheets(&odd).is_empty());
        assert!(!stamp_chart_spec_sheet_ids(&mut odd.clone(), &[sid()]));
    }

    /// BUG-0151: a pull that renames "My Sheet" on arrival renames the chart
    /// string sources that name it -- in all four places -- and nothing else.
    #[test]
    fn a_rename_reaches_every_string_source_and_only_those() {
        let (a, c, d) = (sid(), sid(), sid());
        let mut spec = four_path_spec(a, c, d);
        spec["layers"][1]["data"] = Value::String("'my sheet'!B1:B3".to_string());
        spec["concat"]["charts"][0]["data"] = Value::String("My Sheet!C1".to_string());
        spec["concat"]["charts"][1]["concat"]["charts"][0]["layers"] =
            json!([{ "data": "Other!A1:A2" }, { "data": "A1:A2" }]);
        let renames = crate::sheet_renames::SheetRenames::new([("My Sheet", "My Sheet (2)")]);

        let mut out = envelope(spec);
        assert!(
            rename_chart_spec_sheet_names(&mut out, &renames),
            "three string sources name the renamed sheet"
        );
        let sources = chart_spec_source_sheets(&out);
        let names: Vec<&ChartSourceSheet> = sources
            .iter()
            .filter(|s| matches!(s, ChartSourceSheet::Name(_)))
            .collect();
        assert_eq!(
            names,
            vec![
                &ChartSourceSheet::Name("My Sheet (2)".to_string()),
                &ChartSourceSheet::Name("Other".to_string()),
            ],
            "the lookup `from`, the layer and the concat child all moved (deduplicated), \
             and the grandchild's unrelated source did not"
        );
        // The DataRangeRefs are untouched, and so is the unqualified string.
        assert!(sources.contains(&ChartSourceSheet::Id(a)));
        assert!(sources.contains(&ChartSourceSheet::Index(3)));
        let text = out.to_string();
        assert!(!text.contains("My Sheet!") && !text.contains("my sheet"));
        assert!(text.contains("\"A1:A2\""));

        // Nothing to rename: the spec is left exactly as it was.
        let original = envelope(four_path_spec(a, c, d));
        let mut untouched = original.clone();
        assert!(!rename_chart_spec_sheet_names(
            &mut untouched,
            &crate::sheet_renames::SheetRenames::new([("Nope", "Nope (2)")])
        ));
        assert_eq!(untouched, original);
        assert!(!rename_chart_spec_sheet_names(&mut Value::String("not json".to_string()), &renames));
    }

    #[test]
    fn concat_nesting_is_capped_at_the_ts_depth() {
        // Depth 0 is the root; a spec at depth 16 is visited, depth 17 is not --
        // the same bound chartSheetRefs.ts applies.
        fn nested(levels: usize, leaf: Value) -> Value {
            let mut spec = json!({ "data": leaf });
            for _ in 0..levels {
                spec = json!({ "concat": { "charts": [ spec ] } });
            }
            spec
        }
        let (a, b) = (sid(), sid());
        let visited = nested(16, range_ref(0, Some(a)));
        assert_eq!(chart_spec_source_sheets(&visited), vec![ChartSourceSheet::Id(a)]);
        let mut too_deep = nested(17, range_ref(0, Some(b)));
        assert!(chart_spec_source_sheets(&too_deep).is_empty());
        let mut map = HashMap::new();
        map.insert(b, (sid(), 1));
        assert!(!remap_chart_spec_sheet_ids(&mut too_deep, &map));
        // A pathological depth neither overflows the stack nor panics: the walk
        // stops at the cap and names no sheet.
        let mut abyss = nested(300, range_ref(0, Some(a)));
        assert!(chart_spec_source_sheets(&abyss).is_empty());
        assert!(!stamp_chart_spec_sheet_ids(&mut abyss, &[sid()]));
        // serde_json's recursive Drop of a 300-deep value is fine; the walk is
        // what is capped.
    }

    /// The version diff's view of a chart: key order and the SPELLING of a
    /// source's sheet prefix are not edits (a checkout rename and the push's
    /// undo of it can change an untouched spec's prefix spelling), while a
    /// different source, sheet or property still is.
    #[test]
    fn a_re_spelled_spec_is_the_same_chart_and_an_edit_is_not() {
        let parse = |s: &str| -> Value { serde_json::from_str(s).unwrap() };
        let ts_order = parse(r#"{"chartId":1,"name":"Sales","spec":{"mark":"bar","data":"Data!A1:B5","layers":[{"data":"'My Data'!$a$1:$b$5"}]}}"#);
        let sorted = parse(r#"{"chartId":1,"name":"Sales","spec":{"data":"'DATA'!A1:B5","layers":[{"data":"'my data'!$A$1:$B$5"}],"mark":"bar"}}"#);
        assert_eq!(comparable_chart_spec(&ts_order), comparable_chart_spec(&sorted));
        for edited in [
            r#"{"chartId":1,"name":"Sales","spec":{"mark":"bar","data":"Data!A1:B6","layers":[{"data":"'My Data'!$a$1:$b$5"}]}}"#,
            r#"{"chartId":1,"name":"Sales","spec":{"mark":"bar","data":"Other!A1:B5","layers":[{"data":"'My Data'!$a$1:$b$5"}]}}"#,
            r#"{"chartId":1,"name":"Sales 2026","spec":{"mark":"bar","data":"Data!A1:B5","layers":[{"data":"'My Data'!$a$1:$b$5"}]}}"#,
        ] {
            assert_ne!(comparable_chart_spec(&ts_order), comparable_chart_spec(&parse(edited)), "{edited}");
        }
        // A spec kept as a string compares as that string.
        let raw = Value::String("not json".to_string());
        assert_eq!(comparable_chart_spec(&raw), raw);
    }

    /// `comparable_chart_spec` is blind to object KEY ORDER at every depth --
    /// two specs whose keys were inserted in different orders compare equal,
    /// and the comparable form does not alter the caller's value.
    ///
    /// SABOTAGE: compare `to_string()` of a `preserve_order` map (or the raw
    /// text the old API compared) and the first assertion fails.
    #[test]
    fn comparable_chart_spec_is_key_order_blind() {
        let a: Value = serde_json::from_str(
            r#"{"name":"S","spec":{"mark":"bar","data":"Data!A1:B5","yAxis":{"title":"t","showGrid":true}}}"#,
        )
        .unwrap();
        let b: Value = serde_json::from_str(
            r#"{"spec":{"yAxis":{"showGrid":true,"title":"t"},"data":"Data!A1:B5","mark":"bar"},"name":"S"}"#,
        )
        .unwrap();
        assert_eq!(comparable_chart_spec(&a), comparable_chart_spec(&b));
        let before = a.clone();
        let _ = comparable_chart_spec(&a);
        assert_eq!(a, before, "the comparable form is a copy");
        // And a real edit deep inside still differs.
        let mut c = b.clone();
        c["spec"]["yAxis"]["showGrid"] = Value::Bool(false);
        assert_ne!(comparable_chart_spec(&a), comparable_chart_spec(&c));
    }
}
