//! FILENAME: core/calp/src/chart_refs.rs
//! PURPOSE: Find, stamp and remap the sheets a chart's data sources name, and
//! re-bind and key the BI connections its design-query sources name (BUG-0588).
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

/// The two keys a design-query source binds its model by. `connectionId` is
/// the LIVE connection's uuid, a per-session value; `packageDataSourceId` is
/// the application data-source id, the stable one. Spelled once here because
/// the TS type (`DesignQueryDataSource` in `Charts/types.ts`) and its closed
/// schema carry the same two names.
const DESIGN_QUERY_CONNECTION_KEY: &str = "connectionId";
const DESIGN_QUERY_PACKAGE_KEY: &str = "packageDataSourceId";

/// Re-point every DESIGN-QUERY source (`{type: "designQuery", dslText,
/// connectionId, packageDataSourceId?}`) of `spec` at the live BI connection
/// `resolve` names for it, in the four places the module header lists
/// (BUG-0588).
///
/// A design-query chart binds its model by `connectionId`, a per-SESSION uuid:
/// an application's embedded data source is minted a fresh connection on every
/// pull and on every open (the host's `load_embedded_data_sources`), so a
/// pulled chart that kept the publisher's uuid found no model at all -- while
/// BI pivots re-bound through their data-source id and slicers healed
/// themselves. The STABLE key is `packageDataSourceId`, the application's
/// data-source id, which at publish time IS the publisher's connection uuid.
///
/// `resolve(key)` answers a candidate key with the live connection id as its
/// uuid string, or `None`. A source is tried on its `packageDataSourceId`
/// FIRST (on a reload the uuid in `connectionId` is the previous session's and
/// matches nothing), then on its `connectionId` string -- the slicer remap's
/// rule. On a hit BOTH fields are written: `connectionId` becomes the live
/// uuid and `packageDataSourceId` the key that WORKED, so the next reload
/// re-binds by it too (self-heal; a stale package key that no longer resolves
/// is replaced by the connection key that did). A source neither key resolves
/// is left exactly as it is: an unknown id stays the honest "connection not
/// loaded" rather than some other model's numbers. Range, string and pivot
/// sources are never touched, whatever `resolve` would answer for them.
///
/// Edits `spec` in place; returns `false` when nothing changed -- a spec that
/// is not an object, no design-query source, or every source already bound to
/// the live connection with its key recorded -- so a second run is a no-op and
/// an untouched chart serialises to the same bytes.
pub fn remap_chart_spec_connection_ids(
    spec: &mut Value,
    resolve: &dyn Fn(&str) -> Option<String>,
) -> bool {
    for_each_source_mut(spec_root_mut(spec), 0, &mut |source| {
        let Some(m) = source.as_object_mut() else {
            return false;
        };
        if m.get("type").and_then(Value::as_str) != Some("designQuery") {
            return false;
        }
        let key_of = |name: &str| -> Option<String> {
            m.get(name)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let package_key = key_of(DESIGN_QUERY_PACKAGE_KEY);
        let connection_key = key_of(DESIGN_QUERY_CONNECTION_KEY);
        // The key that works and the live connection it names: the stable
        // package key first, the old uuid string second.
        let hit = [package_key.as_deref(), connection_key.as_deref()]
            .into_iter()
            .flatten()
            .find_map(|key| resolve(key).map(|live| (key.to_string(), live)));
        let Some((worked, live)) = hit else {
            return false;
        };
        let mut touched = false;
        if connection_key.as_deref() != Some(live.as_str()) {
            m.insert(DESIGN_QUERY_CONNECTION_KEY.to_string(), Value::String(live));
            touched = true;
        }
        if package_key.as_deref() != Some(worked.as_str()) {
            m.insert(DESIGN_QUERY_PACKAGE_KEY.to_string(), Value::String(worked));
            touched = true;
        }
        touched
    })
}

/// What a SAVE knows about the live BI connection a design-query source's
/// `connectionId` names -- the answer [`stamp_chart_spec_package_keys`] asks
/// its lookup for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveConnectionKey {
    /// An APPLICATION connection (one a pull or an open minted for an
    /// application's embedded data source): the data-source id it represents.
    /// An empty id is no id, and is treated as [`LiveConnectionKey::Local`].
    Application(String),
    /// A connection authored in this workbook: it has no package key.
    Local,
}

/// Stamp every DESIGN-QUERY source of `spec` (in the four places the module
/// header lists) with the stable key of the live connection its
/// `connectionId` names -- the save-time half of BUG-0588's re-bind.
///
/// [`remap_chart_spec_connection_ids`] re-binds a chart on a pull, a refresh
/// and an open by its `packageDataSourceId` FIRST, because every open re-mints
/// an application's connections and the uuid in `connectionId` is then the
/// previous session's. Two kinds of chart defeated it, and both because some
/// writer had to remember the key:
/// - a chart that never carried one -- a drill-through's result chart, one
///   made in the Insert Chart dialog, by a script or by the AI, or one whose
///   spec a full replace rebuilt -- kept only the per-session uuid, matched
///   nothing on the next open and lost its model for good;
/// - a chart RE-POINTED from an application connection to a local one kept the
///   OLD key beside the new uuid (the chart store deep-merges `data`), and the
///   remap, preferring the key, silently undid the user's choice on the next
///   open.
///
/// Stamping at the one boundary every writer crosses -- the save, AutoRecover
/// and the `.calp` publish/push all serialise charts through the host's
/// `collect_charts_for_save` -- covers every writer, present and future. The
/// HOST decides what `Application(key)` holds for each: the data-source id a
/// connection was minted from for the `.cala` save, and the id its data source
/// is filed under in the package for the `.calp` carrier (they differ after a
/// checkout, which mints its connections from the previous version).
///
/// `lookup(connectionId)` answers:
/// - `Some(Application(key))`: `packageDataSourceId` becomes `key`;
/// - `Some(Local)`: `packageDataSourceId` is REMOVED -- a local connection has
///   no package key, and a stale one would re-bind the chart elsewhere;
/// - `None` (the uuid names no live connection: a chart whose model is not
///   loaded this session): the source is left exactly as it is, so a key that
///   would still heal it on the next open is kept.
///
/// A source with no usable `connectionId` (absent, not a string, empty) is
/// never looked up. `connectionId` itself is never rewritten -- binding is the
/// remap's job, and the live uuid is the right one for this session. Range,
/// string and pivot sources are never touched.
///
/// Edits `spec` in place; returns `false` when nothing changed, so a second
/// stamp is a no-op and an already-stamped chart serialises to the same bytes.
/// The host applies it to the SAVED copy of a chart only, never to its live
/// chart store, whose spec the Charts extension owns.
pub fn stamp_chart_spec_package_keys(
    spec: &mut Value,
    lookup: &dyn Fn(&str) -> Option<LiveConnectionKey>,
) -> bool {
    for_each_source_mut(spec_root_mut(spec), 0, &mut |source| {
        let Some(m) = source.as_object_mut() else {
            return false;
        };
        if m.get("type").and_then(Value::as_str) != Some("designQuery") {
            return false;
        }
        let Some(connection) = m
            .get(DESIGN_QUERY_CONNECTION_KEY)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
        else {
            return false;
        };
        match lookup(&connection) {
            // Not a live connection: keep whatever key may still heal it.
            None => false,
            Some(LiveConnectionKey::Application(key)) if !key.is_empty() => {
                if m.get(DESIGN_QUERY_PACKAGE_KEY).and_then(Value::as_str) == Some(key.as_str()) {
                    false
                } else {
                    m.insert(DESIGN_QUERY_PACKAGE_KEY.to_string(), Value::String(key));
                    true
                }
            }
            // A local connection (or an application one with no id): no key.
            Some(_) => m.remove(DESIGN_QUERY_PACKAGE_KEY).is_some(),
        }
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

    // -----------------------------------------------------------------------
    // BUG-0588 -- design-query sources follow their connection
    // -----------------------------------------------------------------------

    fn uuid() -> String {
        EntityId::from_bytes(identity::generate_uuid_v7()).to_string()
    }

    /// A design-query source as the Charts extension writes it, with an
    /// optional stable package key beside the live uuid.
    fn design_query(connection: &str, package: Option<&str>) -> Value {
        let mut v = json!({
            "type": "designQuery",
            "dslText": "ROWS: [Product.Category]\nVALUES: [Revenue]",
            "connectionId": connection
        });
        if let Some(p) = package {
            v["packageDataSourceId"] = Value::String(p.to_string());
        }
        v
    }

    /// A resolver over a (key -> live uuid) table.
    fn resolver(table: &HashMap<String, String>) -> impl Fn(&str) -> Option<String> + '_ {
        move |key: &str| table.get(key).cloned()
    }

    /// Every design-query source in the four places moves to its live
    /// connection and records the package key; the range ref, the string
    /// source, the pivot source and the NON-lookup transform's `from` are
    /// untouched, and so is the envelope.
    ///
    /// SABOTAGE: walk only `data` (drop the layers / transform / concat arms
    /// from `for_each_source_mut`) -- the layer and concat assertions fail.
    #[test]
    fn a_connection_remap_reaches_every_design_query_source_and_only_those() {
        let (p1, p2) = (uuid(), uuid());
        let (l1, l2) = (uuid(), uuid());
        let table: HashMap<String, String> =
            [(p1.clone(), l1.clone()), (p2.clone(), l2.clone())].into_iter().collect();
        let sheet = sid();
        let mut v = envelope(json!({
            "mark": "bar",
            "data": design_query(&p1, None),
            "layers": [
                { "mark": "line", "data": design_query(&p2, None) },
                { "mark": "point", "data": range_ref(3, Some(sheet)) },
                { "mark": "area", "data": "Sheet1!A1:B5" },
                { "mark": "pie", "data": { "type": "pivot", "pivotId": "p1" } },
                "not-an-object"
            ],
            "transform": [
                { "type": "lookup", "from": design_query(&p1, None) },
                { "type": "filter", "from": design_query(&p1, None) }
            ],
            "concat": {
                "charts": [
                    { "data": design_query(&p2, None) },
                    { "data": range_ref(1, Some(sheet)),
                      "concat": { "charts": [ { "data": design_query(&p1, None) } ] } }
                ]
            }
        }));
        let before = v.clone();
        assert!(remap_chart_spec_connection_ids(&mut v, &resolver(&table)), "five sources moved");
        let spec = &v["spec"];
        for (source, live, package) in [
            (&spec["data"], &l1, &p1),
            (&spec["layers"][0]["data"], &l2, &p2),
            (&spec["transform"][0]["from"], &l1, &p1),
            (&spec["concat"]["charts"][0]["data"], &l2, &p2),
            (&spec["concat"]["charts"][1]["concat"]["charts"][0]["data"], &l1, &p1),
        ] {
            assert_eq!(source["connectionId"], *live, "{source}");
            assert_eq!(source["packageDataSourceId"], *package, "{source}");
            assert_eq!(source["dslText"], before["spec"]["data"]["dslText"], "the query is not touched");
        }
        // The filter transform's `from` is not a data source.
        assert_eq!(spec["transform"][1]["from"], before["spec"]["transform"][1]["from"]);
        // Range, string and pivot sources are exactly as they were.
        assert_eq!(spec["layers"][1]["data"], before["spec"]["layers"][1]["data"]);
        assert_eq!(spec["layers"][2]["data"], before["spec"]["layers"][2]["data"]);
        assert_eq!(spec["layers"][3]["data"], before["spec"]["layers"][3]["data"]);
        assert_eq!(spec["concat"]["charts"][1]["data"], before["spec"]["concat"]["charts"][1]["data"]);
        // The envelope's own fields are not sources.
        assert_eq!(v["chartId"], 7);
        assert_eq!(v["name"], "Sales");
        assert_eq!(v["sheetIndex"], 5);
        // And a bare spec walks the same as the envelope.
        let mut bare = before["spec"].clone();
        assert!(remap_chart_spec_connection_ids(&mut bare, &resolver(&table)));
        assert_eq!(bare, v["spec"]);
    }

    /// A miss -- an empty table, a table that knows none of the spec's keys, a
    /// spec with no design-query source at all -- leaves the spec BYTE-identical
    /// and reports no change; a resolver that would answer anything never
    /// touches a range, string or pivot source; a non-object spec never panics.
    ///
    /// SABOTAGE: insert `packageDataSourceId` on a miss too -- the byte
    /// comparison fails.
    #[test]
    fn a_connection_remap_miss_leaves_the_spec_byte_identical() {
        let p = uuid();
        let spec = envelope(json!({
            "mark": "bar",
            "data": design_query(&p, None),
            "layers": [ { "data": range_ref(0, Some(sid())) }, { "data": "Data!A1:B2" } ]
        }));
        let text = spec.to_string();
        let nothing: HashMap<String, String> = HashMap::new();
        let mut v = spec.clone();
        assert!(!remap_chart_spec_connection_ids(&mut v, &resolver(&nothing)));
        assert_eq!(v.to_string(), text, "an empty table changes nothing");
        let strangers: HashMap<String, String> = [(uuid(), uuid())].into_iter().collect();
        assert!(!remap_chart_spec_connection_ids(&mut v, &resolver(&strangers)));
        assert_eq!(v.to_string(), text, "a table that knows none of the keys changes nothing");
        // A greedy resolver still never touches a source that is not a design query.
        let greedy = |_: &str| Some("live".to_string());
        let mut ranges = envelope(json!({
            "data": range_ref(0, Some(sid())),
            "layers": [ { "data": "Data!A1:B2" }, { "data": { "type": "pivot", "pivotId": "p1" } } ]
        }));
        let range_text = ranges.to_string();
        assert!(!remap_chart_spec_connection_ids(&mut ranges, &greedy));
        assert_eq!(ranges.to_string(), range_text);
        // Wrong shapes are skipped, not fatal.
        for bad in [
            Value::String("not json".to_string()),
            json!(42),
            Value::Null,
            json!([1, 2]),
            json!({ "spec": 7 }),
            json!({ "data": 17, "layers": { "not": "an array" }, "concat": { "charts": "nope" } }),
            json!({ "data": { "type": "designQuery", "connectionId": 5 } }),
            json!({ "data": { "type": "designQuery", "connectionId": "" } }),
        ] {
            let mut v = bad.clone();
            assert!(!remap_chart_spec_connection_ids(&mut v, &greedy), "{bad}");
            assert_eq!(v, bad, "{bad}");
        }
    }

    /// The package key WINS and is kept; a source with only a uuid heals by
    /// recording the key that worked; a stale package key is REPLACED by the
    /// connection key that did resolve; and a second run is a no-op.
    ///
    /// SABOTAGE: try the connection key first -- case (d) binds to `l2`.
    #[test]
    fn a_connection_remap_binds_by_the_package_key_first_and_heals_the_key_that_worked() {
        let (p, q, stale_session, stale_package) = (uuid(), uuid(), uuid(), uuid());
        let (l1, l2) = (uuid(), uuid());
        let table: HashMap<String, String> =
            [(p.clone(), l1.clone()), (q.clone(), l2.clone())].into_iter().collect();
        let resolve = resolver(&table);

        // (a) The reload: the uuid is last session's, the package key is known.
        let mut a = json!({ "data": design_query(&stale_session, Some(&p)) });
        assert!(remap_chart_spec_connection_ids(&mut a, &resolve));
        assert_eq!(a["data"]["connectionId"], l1);
        assert_eq!(a["data"]["packageDataSourceId"], p);

        // (b) The first pull: the publisher's uuid IS the package key -- heal.
        let mut b = json!({ "data": design_query(&p, None) });
        assert!(remap_chart_spec_connection_ids(&mut b, &resolve));
        assert_eq!(b["data"]["connectionId"], l1);
        assert_eq!(b["data"]["packageDataSourceId"], p, "the key that worked is recorded");

        // (c) A working-copy push re-keyed the data source by its own uuid: the
        //     carried package key is stale, the uuid string resolves.
        let mut c = json!({ "data": design_query(&q, Some(&stale_package)) });
        assert!(remap_chart_spec_connection_ids(&mut c, &resolve));
        assert_eq!(c["data"]["connectionId"], l2);
        assert_eq!(c["data"]["packageDataSourceId"], q, "the stale key is replaced by the one that worked");

        // (d) Both keys resolve, to DIFFERENT connections: the package key wins.
        let mut d = json!({ "data": design_query(&q, Some(&p)) });
        assert!(remap_chart_spec_connection_ids(&mut d, &resolve));
        assert_eq!(d["data"]["connectionId"], l1);
        assert_eq!(d["data"]["packageDataSourceId"], p);

        // (e) Already bound, key recorded: nothing to do, same bytes.
        for bound in [&mut a, &mut b, &mut c, &mut d] {
            let text = bound.to_string();
            assert!(!remap_chart_spec_connection_ids(bound, &resolve), "{text}");
            assert_eq!(bound.to_string(), text);
        }
        // A source bound to the live connection but MISSING its key is healed
        // (the key recorded) without the uuid changing.
        let mut e = json!({ "data": design_query(&l1, None) });
        let heal: HashMap<String, String> = [(l1.clone(), l1.clone())].into_iter().collect();
        assert!(remap_chart_spec_connection_ids(&mut e, &resolver(&heal)));
        assert_eq!(e["data"]["connectionId"], l1);
        assert_eq!(e["data"]["packageDataSourceId"], l1);
    }

    // -----------------------------------------------------------------------
    // The save-time package-key stamp (drill-through fix round, 2026-10-23)
    // -----------------------------------------------------------------------

    /// A lookup over a (live connection uuid -> what the save knows) table.
    fn live(table: &HashMap<String, LiveConnectionKey>) -> impl Fn(&str) -> Option<LiveConnectionKey> + '_ {
        move |connection: &str| table.get(connection).cloned()
    }

    /// Every design-query source in the four places gets the application key
    /// of the live connection it names; the uuid is never rewritten; the range
    /// ref, the string source, the pivot source and the NON-lookup transform's
    /// `from` are untouched, and so is the envelope.
    ///
    /// SABOTAGE: walk only `data` (drop the layers / transform / concat arms of
    /// `for_each_source_mut`) -- the layer, lookup and concat assertions fail.
    #[test]
    fn a_package_stamp_reaches_every_design_query_source_and_only_those() {
        let (a1, a2) = (uuid(), uuid());
        let table: HashMap<String, LiveConnectionKey> = [
            (a1.clone(), LiveConnectionKey::Application("ds-A".to_string())),
            (a2.clone(), LiveConnectionKey::Application("ds-B".to_string())),
        ]
        .into_iter()
        .collect();
        let sheet = sid();
        let mut v = envelope(json!({
            "mark": "bar",
            "data": design_query(&a1, None),
            "layers": [
                { "mark": "line", "data": design_query(&a2, None) },
                { "mark": "point", "data": range_ref(3, Some(sheet)) },
                { "mark": "area", "data": "Sheet1!A1:B5" },
                { "mark": "pie", "data": { "type": "pivot", "pivotId": "p1" } },
                "not-an-object"
            ],
            "transform": [
                { "type": "lookup", "from": design_query(&a1, None) },
                { "type": "filter", "from": design_query(&a1, None) }
            ],
            "concat": {
                "charts": [
                    { "data": design_query(&a2, None) },
                    { "data": range_ref(1, Some(sheet)),
                      "concat": { "charts": [ { "data": design_query(&a1, None) } ] } }
                ]
            }
        }));
        let before = v.clone();
        assert!(stamp_chart_spec_package_keys(&mut v, &live(&table)), "five sources stamped");
        let spec = &v["spec"];
        for (source, connection, key) in [
            (&spec["data"], &a1, "ds-A"),
            (&spec["layers"][0]["data"], &a2, "ds-B"),
            (&spec["transform"][0]["from"], &a1, "ds-A"),
            (&spec["concat"]["charts"][0]["data"], &a2, "ds-B"),
            (&spec["concat"]["charts"][1]["concat"]["charts"][0]["data"], &a1, "ds-A"),
        ] {
            assert_eq!(source["packageDataSourceId"], key, "{source}");
            assert_eq!(source["connectionId"], *connection, "the uuid is never rewritten: {source}");
            assert_eq!(source["dslText"], before["spec"]["data"]["dslText"], "the query is not touched");
        }
        // The filter transform's `from` is not a data source.
        assert_eq!(spec["transform"][1]["from"], before["spec"]["transform"][1]["from"]);
        // Range, string and pivot sources are exactly as they were.
        for i in 1..=3 {
            assert_eq!(spec["layers"][i]["data"], before["spec"]["layers"][i]["data"], "layer {i}");
        }
        assert_eq!(spec["concat"]["charts"][1]["data"], before["spec"]["concat"]["charts"][1]["data"]);
        // The envelope's own fields are not sources.
        assert_eq!(v["chartId"], 7);
        assert_eq!(v["name"], "Sales");
        assert_eq!(v["sheetIndex"], 5);
        // A bare spec stamps the same as the envelope.
        let mut bare = before["spec"].clone();
        assert!(stamp_chart_spec_package_keys(&mut bare, &live(&table)));
        assert_eq!(bare, v["spec"]);
    }

    /// The three answers: an application connection SETS its key (replacing a
    /// stale one), a local connection REMOVES the key (and an empty application
    /// id counts as none), and a uuid that names no live connection leaves the
    /// source BYTE-identical -- its key may still heal it on the next open.
    ///
    /// SABOTAGE: treat "not live" (`None`) like a local connection -- case (c)
    /// loses its key and the byte comparison fails.
    #[test]
    fn a_package_stamp_sets_removes_or_leaves_the_key_by_what_the_connection_is() {
        let (app, local, dead, blank) = (uuid(), uuid(), uuid(), uuid());
        let table: HashMap<String, LiveConnectionKey> = [
            (app.clone(), LiveConnectionKey::Application("ds-A".to_string())),
            (local.clone(), LiveConnectionKey::Local),
            (blank.clone(), LiveConnectionKey::Application(String::new())),
        ]
        .into_iter()
        .collect();
        let lookup = live(&table);

        // (a) An application connection: the key is written, a stale one replaced.
        let mut a = json!({ "data": design_query(&app, None) });
        assert!(stamp_chart_spec_package_keys(&mut a, &lookup));
        assert_eq!(a["data"]["packageDataSourceId"], "ds-A");
        let mut stale = json!({ "data": design_query(&app, Some("ds-OLD")) });
        assert!(stamp_chart_spec_package_keys(&mut stale, &lookup));
        assert_eq!(stale["data"]["packageDataSourceId"], "ds-A", "the live connection's key wins");

        // (b) A local connection: a key carried over from an application
        //     connection is removed -- absent, not null or "".
        let mut b = json!({ "data": design_query(&local, Some("ds-A")) });
        assert!(stamp_chart_spec_package_keys(&mut b, &lookup));
        assert!(b["data"].get("packageDataSourceId").is_none(), "{b}");
        assert_eq!(b["data"]["connectionId"], local);
        let mut keyless = json!({ "data": design_query(&local, None) });
        let text = keyless.to_string();
        assert!(!stamp_chart_spec_package_keys(&mut keyless, &lookup), "nothing to remove");
        assert_eq!(keyless.to_string(), text);
        // An application connection with an EMPTY id has no key either.
        let mut e = json!({ "data": design_query(&blank, Some("ds-A")) });
        assert!(stamp_chart_spec_package_keys(&mut e, &lookup));
        assert!(e["data"].get("packageDataSourceId").is_none(), "{e}");

        // (c) A uuid no live connection answers to: left exactly as it is.
        let mut c = json!({ "data": design_query(&dead, Some("ds-A")) });
        let text = c.to_string();
        assert!(!stamp_chart_spec_package_keys(&mut c, &lookup));
        assert_eq!(c.to_string(), text, "the key that would heal it on the next open is kept");
    }

    /// A source with no usable `connectionId` is never looked up; a spec with
    /// no design-query source, or of the wrong shape, changes nothing and
    /// never panics; and a second stamp is a no-op.
    ///
    /// SABOTAGE: drop the `.filter(|s| !s.is_empty())` on the connection id --
    /// the lookup is asked for "" and the recording assertion fails.
    #[test]
    fn a_package_stamp_never_looks_up_a_missing_id_and_is_idempotent() {
        let asked = std::cell::RefCell::new(Vec::<String>::new());
        let greedy = |connection: &str| {
            asked.borrow_mut().push(connection.to_string());
            Some(LiveConnectionKey::Application("ds-A".to_string()))
        };
        for bad in [
            Value::String("not json".to_string()),
            json!(42),
            Value::Null,
            json!([1, 2]),
            json!({ "spec": 7 }),
            json!({ "data": 17, "layers": { "not": "an array" }, "concat": { "charts": "nope" } }),
            json!({ "data": { "type": "designQuery", "dslText": "VALUES: [Revenue]" } }),
            json!({ "data": { "type": "designQuery", "connectionId": 5 } }),
            json!({ "data": { "type": "designQuery", "connectionId": "" } }),
            json!({ "data": range_ref(0, Some(sid())), "layers": [ { "data": "Data!A1:B2" } ] }),
            json!({ "data": { "type": "pivot", "pivotId": "p1", "connectionId": "x" } }),
        ] {
            let mut v = bad.clone();
            assert!(!stamp_chart_spec_package_keys(&mut v, &greedy), "{bad}");
            assert_eq!(v, bad, "{bad}");
        }
        assert!(asked.borrow().is_empty(), "looked up: {:?}", asked.borrow());

        let mut once = envelope(json!({ "data": design_query(&uuid(), None) }));
        assert!(stamp_chart_spec_package_keys(&mut once, &greedy));
        let text = once.to_string();
        assert!(!stamp_chart_spec_package_keys(&mut once, &greedy), "a second stamp changes nothing");
        assert_eq!(once.to_string(), text);
    }

    /// THE POINT OF THE STAMP: a chart saved with its live connection's key
    /// re-binds on the next open, when every application connection has been
    /// re-minted and the saved uuid names nothing -- while the SAME chart saved
    /// without the stamp stays bound to the dead uuid. And a chart re-pointed
    /// to a local connection keeps the user's choice: with the stale key
    /// removed, the open's remap has nothing to pull it back by.
    ///
    /// SABOTAGE: return `false` from `stamp_chart_spec_package_keys` without
    /// editing -- the re-bind assertion fails.
    #[test]
    fn a_stamped_chart_re_binds_on_the_next_open_and_a_re_pointed_one_stays_local() {
        let (session_one, reopened, local) = (uuid(), uuid(), uuid());
        let saving: HashMap<String, LiveConnectionKey> = [
            (session_one.clone(), LiveConnectionKey::Application("ds-A".to_string())),
            (local.clone(), LiveConnectionKey::Local),
        ]
        .into_iter()
        .collect();
        // The next open: the application's data source ds-A got a FRESH uuid.
        let open: HashMap<String, String> = [("ds-A".to_string(), reopened.clone())].into_iter().collect();

        // A drill chart written with only the session's uuid.
        let unstamped = json!({ "data": design_query(&session_one, None) });
        let mut saved = unstamped.clone();
        assert!(stamp_chart_spec_package_keys(&mut saved, &live(&saving)));
        assert!(remap_chart_spec_connection_ids(&mut saved, &resolver(&open)), "the saved chart re-binds");
        assert_eq!(saved["data"]["connectionId"], reopened);
        let mut not_saved_that_way = unstamped;
        assert!(
            !remap_chart_spec_connection_ids(&mut not_saved_that_way, &resolver(&open)),
            "the premise: without the key the next open cannot re-bind it"
        );

        // A chart re-pointed from ds-A's connection to a local one, the stale
        // key kept by the store's deep merge.
        let mut re_pointed = json!({ "data": design_query(&local, Some("ds-A")) });
        assert!(stamp_chart_spec_package_keys(&mut re_pointed, &live(&saving)));
        assert!(!remap_chart_spec_connection_ids(&mut re_pointed, &resolver(&open)), "nothing pulls it back");
        assert_eq!(re_pointed["data"]["connectionId"], local, "the user's choice survives the reopen");
    }
}
