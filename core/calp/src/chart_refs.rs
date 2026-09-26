//! FILENAME: core/calp/src/chart_refs.rs
//! PURPOSE: Find, stamp and remap the sheets a chart's data sources name.
//! CONTEXT: A chart's `spec_json` is the whole serialized ChartDefinition
//! envelope (`{chartId, name, sheetIndex, x, y, ..., spec: ChartSpec}`) or, for
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
//! only the host may rewrite a spec. The pulled `spec_json` is the publisher's
//! bytes, verbatim.
//!
//! WHY `None` WHEN NOTHING CHANGED. `serde_json` is built without
//! `preserve_order` here, so re-serializing a spec reorders its keys. Returning
//! `None` for an untouched spec keeps its bytes identical, which is what keeps
//! a chart nobody edited out of a version diff.

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
/// does not parse names no pivot and is skipped. Malformed JSON yields nothing.
pub fn chart_spec_pivot_ids(spec_json: &str) -> Vec<EntityId> {
    let mut out: Vec<EntityId> = Vec::new();
    for source in chart_spec_sources(spec_json) {
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
/// sources name no sheet and contribute nothing. Malformed JSON yields nothing.
pub fn chart_spec_source_sheets(spec_json: &str) -> Vec<ChartSourceSheet> {
    let mut out: Vec<ChartSourceSheet> = Vec::new();
    for source in chart_spec_sources(spec_json) {
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
pub(crate) fn chart_spec_sources(spec_json: &str) -> Vec<ChartSource> {
    let Ok(value) = serde_json::from_str::<Value>(spec_json) else {
        return Vec::new();
    };
    let mut raw: Vec<&Value> = Vec::new();
    collect_sources(spec_root(&value), 0, &mut raw);

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
/// Returns `None` when nothing changed (including malformed JSON and an empty
/// map), so the caller keeps the original bytes. A map entry that sends an id to
/// itself AND to the index the ref already carries changes nothing; an identity
/// id with a DIFFERENT index still rewrites the index.
pub fn remap_chart_spec_sheet_ids(
    spec_json: &str,
    map: &HashMap<SheetId, (SheetId, usize)>,
) -> Option<String> {
    if map.is_empty() {
        return None;
    }
    let mut value: Value = serde_json::from_str(spec_json).ok()?;
    let changed = for_each_range_ref_mut(spec_root_mut(&mut value), 0, &mut |r| {
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
    });
    if changed {
        serde_json::to_string(&value).ok()
    } else {
        None
    }
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
/// sheet sits at that index there. Returns `None` when nothing changed.
pub fn stamp_chart_spec_sheet_ids(spec_json: &str, sheet_ids: &[SheetId]) -> Option<String> {
    let mut value: Value = serde_json::from_str(spec_json).ok()?;
    let changed = for_each_range_ref_mut(spec_root_mut(&mut value), 0, &mut |r| {
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
    });
    if changed {
        serde_json::to_string(&value).ok()
    } else {
        None
    }
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

    fn envelope(spec: Value) -> String {
        json!({
            "chartId": 7, "name": "Sales", "sheetIndex": 5, "x": 10, "y": 20,
            "spec": spec
        })
        .to_string()
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
        assert_eq!(
            chart_spec_source_sheets(&spec.to_string()),
            chart_spec_source_sheets(&envelope(spec))
        );
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
        })
        .to_string();
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
        })
        .to_string();
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
        })
        .to_string();
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
        let out = remap_chart_spec_sheet_ids(&envelope(four_path_spec(a, c, d)), &map)
            .expect("mapped ids must rewrite");
        let v: Value = serde_json::from_str(&out).unwrap();
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
        let spec = json!({
            "layers": [ { "data": range_ref(0, Some(a)) } ],
            "transform": [ { "type": "lookup", "from": range_ref(1, Some(b)) } ]
        })
        .to_string();
        let mut map = HashMap::new();
        map.insert(a, (la, 4));
        map.insert(b, (lb, 5));
        let v: Value =
            serde_json::from_str(&remap_chart_spec_sheet_ids(&spec, &map).unwrap()).unwrap();
        assert_eq!(v["layers"][0]["data"]["sheetId"], la.to_string());
        assert_eq!(v["layers"][0]["data"]["sheetIndex"], 4);
        assert_eq!(v["transform"][0]["from"]["sheetId"], lb.to_string());
        assert_eq!(v["transform"][0]["from"]["sheetIndex"], 5);
    }

    #[test]
    fn remap_leaves_unmapped_ids_alone() {
        let (a, stranger) = (sid(), sid());
        let la = sid();
        let spec = json!({
            "data": range_ref(0, Some(a)),
            "layers": [ { "data": range_ref(8, Some(stranger)) } ]
        })
        .to_string();
        let mut map = HashMap::new();
        map.insert(a, (la, 2));
        let v: Value =
            serde_json::from_str(&remap_chart_spec_sheet_ids(&spec, &map).unwrap()).unwrap();
        assert_eq!(v["data"]["sheetId"], la.to_string());
        assert_eq!(
            v["layers"][0]["data"]["sheetId"],
            stranger.to_string(),
            "an id the map does not know keeps pointing where it pointed"
        );
        assert_eq!(v["layers"][0]["data"]["sheetIndex"], 8);
    }

    #[test]
    fn remap_returns_none_when_nothing_changed() {
        let a = sid();
        let spec = envelope(json!({ "data": range_ref(3, Some(a)), "mark": "bar" }));
        // An empty map.
        assert_eq!(remap_chart_spec_sheet_ids(&spec, &HashMap::new()), None);
        // A map that knows none of the spec's ids.
        let mut other = HashMap::new();
        other.insert(sid(), (sid(), 0));
        assert_eq!(remap_chart_spec_sheet_ids(&spec, &other), None);
        // The identity at the index the ref already carries (a checkout laid out
        // like the publisher's workbook).
        let mut identity = HashMap::new();
        identity.insert(a, (a, 3));
        assert_eq!(remap_chart_spec_sheet_ids(&spec, &identity), None);
        // ...but the identity at ANOTHER index still moves the index.
        let mut moved = HashMap::new();
        moved.insert(a, (a, 6));
        let v: Value =
            serde_json::from_str(&remap_chart_spec_sheet_ids(&spec, &moved).unwrap()).unwrap();
        assert_eq!(v["spec"]["data"]["sheetId"], a.to_string());
        assert_eq!(v["spec"]["data"]["sheetIndex"], 6);
        // A spec with no ref at all.
        let mut map = HashMap::new();
        map.insert(a, (sid(), 1));
        assert_eq!(remap_chart_spec_sheet_ids("{\"kind\":\"bar\"}", &map), None);
    }

    #[test]
    fn stamp_fills_only_unstamped_refs_from_the_index() {
        let ids = vec![sid(), sid(), sid(), sid()];
        let already = sid();
        let spec = json!({
            "data": range_ref(1, None),
            "layers": [
                { "data": range_ref(0, Some(already)) },
                { "data": range_ref(99, None) },
                { "data": { "sheetIndex": 3, "sheetId": "", "startRow": 0 } }
            ],
            "transform": [ { "type": "lookup", "from": range_ref(2, None) } ],
            "concat": { "charts": [ { "data": range_ref(0, None) } ] }
        })
        .to_string();
        let v: Value =
            serde_json::from_str(&stamp_chart_spec_sheet_ids(&spec, &ids).unwrap()).unwrap();
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
    fn stamp_returns_none_when_nothing_changed() {
        let a = sid();
        let ids = vec![sid()];
        let stamped = envelope(json!({ "data": range_ref(0, Some(a)) }));
        assert_eq!(stamp_chart_spec_sheet_ids(&stamped, &ids), None);
        assert_eq!(stamp_chart_spec_sheet_ids("{\"kind\":\"bar\"}", &ids), None);
        assert_eq!(stamp_chart_spec_sheet_ids("{\"data\":\"Sheet1!A1:B2\"}", &ids), None);
        // A ref that already carries the unresolvable id is STAMPED: a second
        // publish leaves it (and its bytes) alone.
        let unresolvable = json!({ "data": range_ref(5, Some(UNRESOLVABLE_SHEET_ID)) }).to_string();
        assert_eq!(stamp_chart_spec_sheet_ids(&unresolvable, &ids), None);
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
            let out = stamp_chart_spec_sheet_ids(&spec.to_string(), &ids)
                .unwrap_or_else(|| panic!("an unanswerable ref must be stamped: {spec}"));
            let v: Value = serde_json::from_str(&out).unwrap();
            assert_eq!(v["data"]["sheetId"], UNRESOLVABLE_SHEET_ID.to_string(), "{spec}");
            // Read back, it names a sheet by id -- one no workbook carries.
            assert_eq!(
                chart_spec_source_sheets(&out),
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
        assert!(chart_spec_pivot_ids("not json").is_empty());
    }

    #[test]
    fn malformed_json_never_panics() {
        let mut map = HashMap::new();
        map.insert(sid(), (sid(), 0));
        for bad in ["", "{", "not json", "[1,2", "42", "null", "[]", "\"Sheet1!A1\"", "{\"spec\":7}"] {
            assert!(chart_spec_source_sheets(bad).is_empty(), "{bad}");
            assert!(chart_spec_sources(bad).is_empty(), "{bad}");
            assert_eq!(remap_chart_spec_sheet_ids(bad, &map), None, "{bad}");
            assert_eq!(stamp_chart_spec_sheet_ids(bad, &[sid()]), None, "{bad}");
        }
        // Wrong shapes in the right places are skipped, not fatal.
        let odd = json!({
            "data": 17,
            "layers": { "not": "an array" },
            "transform": [ 3, { "type": "lookup" }, { "type": "lookup", "from": null } ],
            "concat": { "charts": "nope" }
        })
        .to_string();
        assert!(chart_spec_source_sheets(&odd).is_empty());
        assert_eq!(stamp_chart_spec_sheet_ids(&odd, &[sid()]), None);
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
        let visited = nested(16, range_ref(0, Some(a))).to_string();
        assert_eq!(chart_spec_source_sheets(&visited), vec![ChartSourceSheet::Id(a)]);
        let too_deep = nested(17, range_ref(0, Some(b))).to_string();
        assert!(chart_spec_source_sheets(&too_deep).is_empty());
        let mut map = HashMap::new();
        map.insert(b, (sid(), 1));
        assert_eq!(remap_chart_spec_sheet_ids(&too_deep, &map), None);
        // A pathological depth (beyond serde_json's own parse recursion limit)
        // neither overflows the stack nor panics: it simply names no sheet.
        let abyss = nested(300, range_ref(0, Some(a)));
        let text = serde_json::to_string(&abyss).unwrap_or_default();
        assert!(chart_spec_source_sheets(&text).is_empty());
        assert_eq!(stamp_chart_spec_sheet_ids(&text, &[sid()]), None);
    }
}
