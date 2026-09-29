//! FILENAME: app/src-tauri/src/chart_commands.rs
//! Tauri commands for chart persistence.
//! Charts are stored as opaque JSON blobs (ChartEntry) in AppState.
//! All mutations record obj_chart undo snapshots (BUG-0001: chart lifecycle
//! used to bypass the undo system entirely).

use crate::api_types::{ChartEntry, ChartSheetIdStamp};
use crate::document_effect::{CleanReason, DocumentEffect};
use crate::persistence::FileState;
use crate::AppState;
use tauri::State;

// CHARTS ARE PERSISTED (`workbook.charts`), so all three mutators dirty the document.
// They already recorded undo entries -- an unambiguous declaration that the change is
// user-meaningful and must survive -- while marking nothing dirty, so inserting a chart
// and closing lost it with no prompt.
//
// Each effect is constructed after the `editObjects` protection gate AND after the
// "not found" checks, so a refused or no-op call leaves the document clean.

/// Get all chart entries.
#[tauri::command]
pub fn get_charts(state: State<AppState>) -> Vec<ChartEntry> {
    state.charts.read().unwrap().clone()
}

/// Save (create) a new chart entry.
#[tauri::command]
pub fn save_chart(
    state: State<AppState>,
    file_state: State<FileState>,
    entry: ChartEntry,
) -> Result<(), String> {
    // allowEditObjects option gate, same as update_chart/delete_chart — this is
    // an UPSERT, so without it "save" was a full bypass of the other two gates.
    crate::protection::check_sheet_action(
        &state, entry.sheet_index, "editObjects", "edit objects",
    )?;
    // Gate passed; an upsert always commits.
    let effect = DocumentEffect::mutates(&file_state);
    let previous = {
        let mut charts = state.charts.write(&effect).map_err(|e| e.to_string())?;
        let previous = charts.iter().find(|c| c.id == entry.id).cloned();
        // Replace if already exists (upsert), otherwise push
        if let Some(existing) = charts.iter_mut().find(|c| c.id == entry.id) {
            *existing = entry.clone();
        } else {
            charts.push(entry.clone());
        }
        previous
    };
    let description = if previous.is_some() { "Edit chart" } else { "Insert chart" };
    crate::undo_commands::record_chart_undo(&state, entry.id, previous, description);
    Ok(())
}

/// Update an existing chart entry.
///
/// `sheet_id_stamp`: the write carries NOTHING but source-sheet ids, and says
/// which step of the chart store it completes (see
/// [`record_chart_sheet_id_stamp`]). It is verified to be exactly a stamp, and
/// is then recorded without an undo step.
#[tauri::command]
pub fn update_chart(
    state: State<AppState>,
    file_state: State<FileState>,
    entry: ChartEntry,
    sheet_id_stamp: Option<ChartSheetIdStamp>,
) -> Result<(), String> {
    update_chart_core(&state, &file_state, entry, sheet_id_stamp)
}

/// [`update_chart`] over borrowed state, so the whole path -- protection gate,
/// the stamp verification, the dirty flag and the undo entry -- is testable
/// with `create_app_state()`.
pub(crate) fn update_chart_core(
    state: &AppState,
    file_state: &FileState,
    entry: ChartEntry,
    sheet_id_stamp: Option<ChartSheetIdStamp>,
) -> Result<(), String> {
    // allowEditObjects option gate — charts are the "objects" the flag names.
    crate::protection::check_sheet_action(
        state, entry.sheet_index, "editObjects", "edit objects",
    )?;
    if let Some(origin) = sheet_id_stamp {
        return record_chart_sheet_id_stamp(state, file_state, entry, origin);
    }
    // RESOLVE FIRST, THEN DECIDE, THEN MUTATE.
    // `DocumentEffect::mutates` sets the dirty flag in its constructor, and
    // `Persisted::write` will not hand out a mutable guard without one -- so the
    // "does this chart exist?" question has to be answered under a READ guard, before
    // the decision. That ordering is the point: a missing id returns Err having
    // touched nothing and having left the document exactly as clean as it was.
    let previous = {
        let charts = state.charts.read().map_err(|e| e.to_string())?;
        charts
            .iter()
            .find(|c| c.id == entry.id)
            .cloned()
            .ok_or_else(|| format!("Chart with id {} not found", entry.id))?
    };
    let effect = DocumentEffect::mutates(file_state);
    {
        let mut charts = state.charts.write(&effect).map_err(|e| e.to_string())?;
        if let Some(existing) = charts.iter_mut().find(|c| c.id == entry.id) {
            *existing = entry.clone();
        }
    }
    crate::undo_commands::record_chart_undo(state, entry.id, Some(previous), "Edit chart");
    Ok(())
}

/// Record the chart store's SHEET-ID STAMP: a chart written before ranges named
/// their sheet by id (or written by a script, by index) gets the id of the sheet
/// its `sheetIndex` names, once, when the store loads it -- or right after the
/// store creates it, when the sheet list was not to hand (chartStore.ts,
/// `migrateSheetIds`). Through the ordinary update that stamp dirtied the
/// document and recorded an "Edit chart" undo step -- so every workbook holding
/// such a chart opened (and reloaded) with unsaved changes the user never made,
/// and the first Ctrl+Z quietly undid the migration.
///
/// TWO ORIGINS, TWO EFFECTS ([`ChartSheetIdStamp`]); neither records an undo
/// step, and both pass the same verification.
///
/// - `AfterLoad` is CLEAN, as `LoadingFromDisk`. The stamp is the last step of
///   loading the charts -- the frontend's half of the load path, issued once
///   the store has read what `open_file` / `new_file` / a reload installed. It
///   states, in a second spelling, exactly what the loaded index already says,
///   and the next open re-derives it from the same file. A close without
///   saving loses nothing, so it must not arm the close prompt or AutoRecover
///   -- the reason `LoadingFromDisk` exists (document_effect.rs names this
///   step under that variant).
/// - `AfterCreate` DIRTIES, as the create it finishes. A chart created while
///   the sheet list was cold went out by index, and this stamp completes that
///   create; nothing is being loaded, so `LoadingFromDisk` would be a false
///   audit row. It adds no undo step either: the create's "Insert chart" step
///   restores "no chart" and so already covers it, where a second "Edit chart"
///   step would make the first Ctrl+Z after an insert undo only the stamp.
///
/// WHY IT CANNOT HIDE AN EDIT. The renderer is not trusted to call a write
/// clean, so the write is VERIFIED here, against the stored entry, inside the
/// one critical section that then replaces it: the placement is unchanged, and
/// the new JSON differs from the stored JSON only by `sheetId` members added
/// to objects that carry an integer `sheetIndex`, each naming the sheet at that
/// index NOW ([`count_sheet_id_stamps`]). Anything else is refused and changes
/// nothing; the store then logs it and the chart keeps resolving by index. A
/// renderer that mislabels a create as a load gains nothing but a wrong label
/// on a write that could only restate the chart's own index.
fn record_chart_sheet_id_stamp(
    state: &AppState,
    file_state: &FileState,
    entry: ChartEntry,
    origin: ChartSheetIdStamp,
) -> Result<(), String> {
    let next: serde_json::Value = serde_json::from_str(&entry.spec_json)
        .map_err(|e| format!("A sheet-id stamp must be a JSON chart record: {}", e))?;
    // The sheet ids, COPIED and released before the chart lock: nothing here
    // nests the two stores' locks.
    let sheet_ids: Vec<String> = state
        .sheet_ids
        .read()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|id| id.to_string())
        .collect();
    // Verify and replace in ONE critical section: a newer edit that landed
    // since the frontend read the entry makes this a mismatch, never an
    // overwrite.
    let pending = state.charts.lock_pending().map_err(|e| e.to_string())?;
    let slot = pending
        .iter()
        .position(|c| c.id == entry.id)
        .ok_or_else(|| format!("Chart with id {} not found", entry.id))?;
    if pending[slot].sheet_index != entry.sheet_index {
        return Err("A sheet-id stamp cannot move a chart to another sheet.".to_string());
    }
    let stored: serde_json::Value = serde_json::from_str(&pending[slot].spec_json)
        .map_err(|e| format!("The stored chart is not a JSON record: {}", e))?;
    let stamps = count_sheet_id_stamps(&stored, &next, &|index| sheet_ids.get(index).cloned())?;
    if stamps == 0 {
        // Nothing the stored entry lacks: leave it exactly as it is.
        return Ok(());
    }
    // Every gate has passed and the write changes the entry: decide now.
    let effect = match origin {
        ChartSheetIdStamp::AfterLoad => DocumentEffect::deliberately_clean(CleanReason::LoadingFromDisk),
        ChartSheetIdStamp::AfterCreate => DocumentEffect::mutates(file_state),
    };
    let mut charts = pending.authorize(&effect);
    charts[slot].spec_json = entry.spec_json;
    // No undo entry: the stamp is not an edit, and undoing it would only put the
    // chart back on following an index.
    Ok(())
}

/// Deepest JSON nesting [`count_sheet_id_stamps`] walks (serde_json's own parse limit).
const MAX_STAMP_JSON_DEPTH: usize = 128;

/// Bound on `concat` nesting for [`stamp_chart_record_sheet_ids`] -- the same
/// bound as chartSheetRefs.ts `MAX_STAMP_DEPTH`.
const MAX_CONCAT_STAMP_DEPTH: usize = 16;

/// THE LOAD-TIME SHEET-ID STAMP, done by the backend while the sheet list is
/// the FILE's own (BUG-0204).
///
/// A chart range written before ranges named their sheet by id says only
/// `sheetIndex`, and an index is right only against the sheet list it was
/// written for. The chart store used to stamp the id ~300 ms after a load
/// (chartStore.ts, `migrateSheetIds`) against whatever the sheet list was BY
/// THEN: a sheet added, deleted or moved in that window got the stamp refused
/// -- and the reload that follows every sheet-list change then stamped the old
/// index against the NEW list, pinning the chart to another sheet for good.
/// Stamped here, inside `open_file`'s restore, nothing can come between the
/// file's indices and the file's sheets.
///
/// THE SAME WALK AS chartSheetRefs.ts (`stampStoredChartJson`): a ref lives in
/// `spec.data`, `spec.layers[].data`, a `lookup` transform's `from`, and
/// `spec.concat.charts[]` recursively; a ref is an object with `startRow`
/// whose `sheetId` is missing or empty and whose integer `sheetIndex` names a
/// sheet. Both walks are pinned to ONE fixture
/// (`extensions/Charts/lib/__tests__/fixtures/chartSheetIdStamp.json`), so an
/// edit to either that the other does not make fails a test.
///
/// Returns the stamped record, or `None` when nothing needed a stamp (the
/// stored text is then left byte-identical) or the text is not a JSON record.
pub(crate) fn stamp_chart_record_sheet_ids(
    spec_json: &str,
    sheet_id_at: &dyn Fn(usize) -> Option<String>,
) -> Option<String> {
    use serde_json::Value;

    fn stamp_source(source: Option<&mut Value>, sheet_id_at: &dyn Fn(usize) -> Option<String>) -> bool {
        let Some(Value::Object(range)) = source else { return false };
        if !range.contains_key("startRow") {
            return false;
        }
        if matches!(range.get("sheetId"), Some(Value::String(id)) if !id.is_empty()) {
            return false;
        }
        let Some(index) = range.get("sheetIndex").and_then(Value::as_u64).and_then(|i| usize::try_from(i).ok()) else {
            return false;
        };
        match sheet_id_at(index).filter(|id| !id.is_empty()) {
            Some(id) => {
                range.insert("sheetId".to_string(), Value::String(id));
                true
            }
            None => false,
        }
    }

    fn stamp_spec(spec: &mut Value, sheet_id_at: &dyn Fn(usize) -> Option<String>, depth: usize) -> bool {
        let Value::Object(spec) = spec else { return false };
        let mut changed = stamp_source(spec.get_mut("data"), sheet_id_at);
        if let Some(Value::Array(layers)) = spec.get_mut("layers") {
            for layer in layers.iter_mut() {
                if let Value::Object(layer) = layer {
                    changed |= stamp_source(layer.get_mut("data"), sheet_id_at);
                }
            }
        }
        if let Some(Value::Array(transforms)) = spec.get_mut("transform") {
            for t in transforms.iter_mut() {
                if let Value::Object(t) = t {
                    if t.get("type").and_then(Value::as_str) == Some("lookup") {
                        changed |= stamp_source(t.get_mut("from"), sheet_id_at);
                    }
                }
            }
        }
        if depth < MAX_CONCAT_STAMP_DEPTH {
            if let Some(Value::Object(concat)) = spec.get_mut("concat") {
                if let Some(Value::Array(children)) = concat.get_mut("charts") {
                    for child in children.iter_mut() {
                        changed |= stamp_spec(child, sheet_id_at, depth + 1);
                    }
                }
            }
        }
        changed
    }

    let mut record: Value = serde_json::from_str(spec_json).ok()?;
    let Value::Object(fields) = &mut record else { return None };
    // chartSpecNormalize.ts `storedSpecOf`: a record whose `spec` is not an
    // object but that has a string `mark` IS the spec (a raw `save_chart`).
    let bare = !matches!(fields.get("spec"), Some(Value::Object(_)))
        && matches!(fields.get("mark"), Some(Value::String(_)));
    let changed = if bare {
        stamp_spec(&mut record, sheet_id_at, 0)
    } else {
        match fields.get_mut("spec") {
            Some(spec @ Value::Object(_)) => stamp_spec(spec, sheet_id_at, 0),
            _ => false,
        }
    };
    if changed {
        serde_json::to_string(&record).ok()
    } else {
        None
    }
}

/// How many `sheetId` stamps `next` adds to `stored` -- or why `next` is NOT a
/// pure stamp of `stored`.
///
/// The one difference allowed: an object that carries an integer `sheetIndex`
/// and no `sheetId` gains a `sheetId` that is the id of the sheet at that index
/// (`sheet_id_at`). Any other difference -- a value changed, a member removed or
/// added, an array resized, a stamp naming another sheet or an index no sheet
/// has -- is an `Err` naming it.
///
/// GENERIC JSON ON PURPOSE. Where a chart spec keeps its ranges (`data`,
/// `layers[].data`, a lookup's `from`, `concat` children) is the frontend's
/// knowledge (chartSheetRefs.ts). A copy of that walk here would drift from it;
/// this checks only that nothing but a range's sheet-id spelling changed.
pub(crate) fn count_sheet_id_stamps(
    stored: &serde_json::Value,
    next: &serde_json::Value,
    sheet_id_at: &dyn Fn(usize) -> Option<String>,
) -> Result<usize, String> {
    fn walk(
        stored: &serde_json::Value,
        next: &serde_json::Value,
        sheet_id_at: &dyn Fn(usize) -> Option<String>,
        depth: usize,
    ) -> Result<usize, String> {
        use serde_json::Value;
        if depth > MAX_STAMP_JSON_DEPTH {
            return Err("The chart record is nested too deeply to verify.".to_string());
        }
        match (stored, next) {
            (Value::Object(s), Value::Object(n)) => {
                let mut stamps = 0usize;
                for (key, sv) in s {
                    let nv = n
                        .get(key)
                        .ok_or_else(|| format!("A sheet-id stamp may not remove '{}'.", key))?;
                    stamps += walk(sv, nv, sheet_id_at, depth + 1)?;
                }
                for (key, nv) in n {
                    if s.contains_key(key) {
                        continue;
                    }
                    if key != "sheetId" {
                        return Err(format!("A sheet-id stamp may not add '{}'.", key));
                    }
                    let id = nv
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or("A sheet-id stamp must be a non-empty string.")?;
                    let index = s
                        .get("sheetIndex")
                        .and_then(|v| v.as_u64())
                        .and_then(|v| usize::try_from(v).ok())
                        .ok_or("A sheet id may only be stamped on a range that names its sheet by index.")?;
                    let actual = sheet_id_at(index)
                        .ok_or_else(|| format!("Sheet index {} names no sheet.", index))?;
                    if actual != id {
                        return Err(format!(
                            "The stamp names sheet {} but sheet index {} is sheet {}.",
                            id, index, actual
                        ));
                    }
                    stamps += 1;
                }
                Ok(stamps)
            }
            (Value::Array(s), Value::Array(n)) => {
                if s.len() != n.len() {
                    return Err("A sheet-id stamp may not resize a list.".to_string());
                }
                let mut stamps = 0usize;
                for (sv, nv) in s.iter().zip(n.iter()) {
                    stamps += walk(sv, nv, sheet_id_at, depth + 1)?;
                }
                Ok(stamps)
            }
            // A number that went through JSON.parse/stringify may change its
            // spelling (1.0 -> 1) and nothing else.
            (Value::Number(s), Value::Number(n)) if s == n || s.as_f64() == n.as_f64() => Ok(0),
            (s, n) if s == n => Ok(0),
            _ => Err("A sheet-id stamp may not change a value.".to_string()),
        }
    }
    walk(stored, next, sheet_id_at, 0)
}

/// Delete a chart entry by ID.
///
/// §3bn: a pane-control slider or dropdown can be BOUND to a chart parameter
/// (`chartParamTarget`), and the binding used to outlive the chart — every drag
/// then drove a chart id that resolved to nothing. The control SURVIVES with its
/// name, its value and its place in the strip (every `GET.CONTROLVALUE` reading
/// it keeps working); only the dead binding goes. Deleting a chart must not
/// delete the slider.
#[tauri::command]
pub fn delete_chart(
    state: State<AppState>,
    file_state: State<FileState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    id: identity::EntityId,
) -> Result<(), String> {
    // allowEditObjects option gate. The sheet comes from the chart itself, so
    // this is resolved before any mutation.
    {
        let sheet = state.charts.read().map_err(|e| e.to_string())?
            .iter().find(|c| c.id == id).map(|c| c.sheet_index);
        if let Some(sheet_index) = sheet {
            crate::protection::check_sheet_action(&state, sheet_index, "editObjects", "delete objects")?;
        }
    }
    // Resolve under a read guard first (see `update_chart`): "no such chart" must not
    // dirty the document.
    let previous = {
        let charts = state.charts.read().map_err(|e| e.to_string())?;
        charts
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| format!("Chart with id {} not found", id))?
    };
    let effect = DocumentEffect::mutates(&file_state);
    {
        let mut charts = state.charts.write(&effect).map_err(|e| e.to_string())?;
        charts.retain(|c| c.id != id);
    }
    // §3bn: pane controls bound to this chart's parameters. Computed before the
    // transaction opens because it takes the pane-control lock.
    let pruned_controls =
        crate::object_deps::cascade_deleted_charts(&pane_control_state, &[id]);
    // ONE transaction for the chart and everything the delete unbound.
    // `record_chart_undo` joins an already-open transaction rather than opening
    // its own, so the cascade entries recorded first restore LAST — after the
    // chart is back for them to point at.
    //
    // The `opened` flag is not ceremony: `begin_transaction` is a NO-OP when one
    // is already open, but `commit_transaction` is not — an unconditional pair
    // called from inside a script batch would commit the CALLER's transaction
    // early and split one undo step into two. Same guard `create_table` uses.
    let opened_transaction = {
        let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
        let opened = !undo_stack.has_open_transaction();
        if opened {
            undo_stack.begin_transaction("Delete chart".to_string());
        }
        opened
    };
    crate::object_deps::record_pane_control_prune_undo(
        &state,
        &pruned_controls,
        "Restore chart binding",
    );
    crate::undo_commands::record_chart_undo(&state, id, Some(previous), "Delete chart");
    if opened_transaction {
        let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
        undo_stack.commit_transaction();
    }
    // C10: a deleted chart must not leave its object script mounted/persisted.
    crate::scripting::object_script_commands::prune_scripts_for_instance(&state, &effect, &id.to_string());
    Ok(())
}

#[cfg(test)]
mod sheet_id_stamp_tests {
    //! The chart store's load-time SHEET-ID STAMP (chartStore.ts, `migrateSheetIds`)
    //! used to go through the ordinary `update_chart`: every workbook holding a chart
    //! written before ranges named their sheet by id (or by a script, by index) was
    //! DIRTY the moment its charts loaded -- a reopen, a page reload -- and had an
    //! "Edit chart" undo step nobody made. Journey
    //! `dirty-flag.spec.ts` "PERSISTENCE ... survive save, new_file and reopen" read
    //! `is_file_modified` TRUE after a reload for exactly this.
    use super::{count_sheet_id_stamps, update_chart_core};
    use crate::api_types::{ChartEntry, ChartSheetIdStamp};
    use crate::document_effect::test_seed_effect;
    use serde_json::json;

    /// A chart stored the way a raw `save_chart` stores it: a BARE spec whose
    /// range names its sheet by index only.
    fn bare_chart(sheet_index: usize) -> ChartEntry {
        ChartEntry {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            sheet_index: 0,
            spec_json: serde_json::to_string(&json!({
                "mark": "bar",
                "data": { "sheetIndex": sheet_index, "startRow": 5, "startCol": 30, "endRow": 8, "endCol": 31 },
                "series": [{ "sourceIndex": 1, "name": "Sales", "color": "#4472C4" }],
                "title": "Dirty Flag Chart"
            }))
            .unwrap(),
        }
    }

    /// The same record with its range stamped `sheet_id` (and `title` optionally changed).
    fn stamped(entry: &ChartEntry, sheet_id: &str, title: &str) -> ChartEntry {
        let mut v: serde_json::Value = serde_json::from_str(&entry.spec_json).unwrap();
        v["data"]["sheetId"] = json!(sheet_id);
        v["title"] = json!(title);
        ChartEntry { id: entry.id, sheet_index: entry.sheet_index, spec_json: serde_json::to_string(&v).unwrap() }
    }

    /// An app state with TWO sheets, and the id of each.
    fn two_sheets() -> (crate::AppState, Vec<String>) {
        let state = crate::create_app_state();
        state
            .sheet_ids
            .write(&test_seed_effect())
            .unwrap()
            .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        let ids = state.sheet_ids.read().unwrap().iter().map(|id| id.to_string()).collect();
        (state, ids)
    }

    fn stored_json(state: &crate::AppState) -> serde_json::Value {
        serde_json::from_str(&state.charts.read().unwrap()[0].spec_json).unwrap()
    }

    #[test]
    fn a_stamp_only_write_is_recorded_without_dirtying_the_document_or_an_undo_step() {
        let (state, ids) = two_sheets();
        let fs = crate::persistence::FileState::default();
        let chart = bare_chart(1);
        state.charts.write(&test_seed_effect()).unwrap().push(chart.clone());
        assert!(!fs.is_dirty(), "fixture: the document starts clean");

        update_chart_core(&state, &fs, stamped(&chart, &ids[1], "Dirty Flag Chart"), Some(ChartSheetIdStamp::AfterLoad))
            .expect("a pure stamp is accepted");

        assert_eq!(
            stored_json(&state)["data"]["sheetId"],
            json!(ids[1]),
            "the stamp is recorded in the stored entry"
        );
        assert!(
            !fs.is_dirty(),
            "loading a chart's sheet id is not an edit: the document must stay clean"
        );
        assert!(
            !state.undo_stack.lock().unwrap().can_undo(),
            "the stamp must not become an undo step"
        );

        // POSITIVE CONTROL: the SAME bytes through the ordinary update do dirty and do
        // record an undo step -- so the two assertions above are about the stamp path,
        // not about a harness in which nothing can dirty.
        let other = bare_chart(0);
        state.charts.write(&test_seed_effect()).unwrap().push(other.clone());
        update_chart_core(&state, &fs, stamped(&other, &ids[0], "Dirty Flag Chart"), None).unwrap();
        assert!(fs.is_dirty());
        assert!(state.undo_stack.lock().unwrap().can_undo());
    }

    #[test]
    fn a_stamp_that_finishes_a_create_dirties_like_the_create_and_adds_no_undo_step() {
        // A chart created while the store's sheet list was cold went out by index;
        // the stamp that follows FINISHES that create. Nothing is being loaded, so
        // recording it as `LoadingFromDisk` would be a false audit row: it must
        // dirty like the create it completes. Started from a CLEAN document so the
        // dirty assertion can fail (after a real create the flag is already set).
        let (state, ids) = two_sheets();
        let fs = crate::persistence::FileState::default();
        let chart = bare_chart(1);
        state.charts.write(&test_seed_effect()).unwrap().push(chart.clone());
        assert!(!fs.is_dirty(), "fixture: the document starts clean");

        update_chart_core(&state, &fs, stamped(&chart, &ids[1], "Dirty Flag Chart"), Some(ChartSheetIdStamp::AfterCreate))
            .expect("a pure stamp is accepted");

        assert_eq!(stored_json(&state)["data"]["sheetId"], json!(ids[1]), "the stamp is recorded");
        assert!(fs.is_dirty(), "a stamp that finishes a create must dirty the document like the create");
        assert!(
            !state.undo_stack.lock().unwrap().can_undo(),
            "the create's own undo step covers the stamp; a second one would make Ctrl+Z undo only the stamp"
        );

        // The same verification binds it: an edit riding on a create-stamp is refused.
        let fs = crate::persistence::FileState::default();
        let before = state.charts.read().unwrap()[0].spec_json.clone();
        let mut restamped: serde_json::Value = serde_json::from_str(&before).unwrap();
        restamped["title"] = json!("Renamed");
        let entry = ChartEntry { id: chart.id, sheet_index: chart.sheet_index, spec_json: restamped.to_string() };
        assert!(update_chart_core(&state, &fs, entry, Some(ChartSheetIdStamp::AfterCreate)).is_err());
        assert_eq!(state.charts.read().unwrap()[0].spec_json, before, "a refused create-stamp changes nothing");
        assert!(!fs.is_dirty(), "a refused create-stamp must not dirty the document");
    }

    #[test]
    fn the_stamp_origin_is_spelled_in_camel_case_on_the_wire() {
        // chartStore.ts sends `sheetIdStamp: "afterLoad" | "afterCreate"`.
        assert_eq!(serde_json::from_value::<ChartSheetIdStamp>(json!("afterLoad")).unwrap(), ChartSheetIdStamp::AfterLoad);
        assert_eq!(serde_json::from_value::<ChartSheetIdStamp>(json!("afterCreate")).unwrap(), ChartSheetIdStamp::AfterCreate);
        assert!(serde_json::from_value::<ChartSheetIdStamp>(json!(true)).is_err(), "the old boolean flag is gone");
    }

    #[test]
    fn a_stamp_only_write_that_is_not_a_pure_stamp_is_refused_and_changes_nothing() {
        let (state, ids) = two_sheets();
        let fs = crate::persistence::FileState::default();
        let chart = bare_chart(1);
        state.charts.write(&test_seed_effect()).unwrap().push(chart.clone());
        let before = state.charts.read().unwrap()[0].spec_json.clone();

        let mut moved = stamped(&chart, &ids[1], "Dirty Flag Chart");
        moved.sheet_index = 1;
        let refusals: Vec<(&str, ChartEntry)> = vec![
            // A stamp that also edits something the user sees.
            ("an edit riding on the stamp", stamped(&chart, &ids[1], "Renamed")),
            // A stamp naming the OTHER sheet: that would re-point the chart's data.
            ("a stamp naming another sheet", stamped(&chart, &ids[0], "Dirty Flag Chart")),
            // A stamp naming no sheet at all.
            ("a stamp naming no sheet", stamped(&chart, "not-a-sheet", "Dirty Flag Chart")),
            // A placement move is never a stamp.
            ("a placement move", moved),
        ];
        for (what, entry) in refusals {
            let result = update_chart_core(&state, &fs, entry, Some(ChartSheetIdStamp::AfterLoad));
            assert!(result.is_err(), "{what} must be refused as a stamp");
            assert_eq!(state.charts.read().unwrap()[0].spec_json, before, "{what} changed the stored chart");
            assert!(!fs.is_dirty(), "{what} dirtied the document");
            assert!(!state.undo_stack.lock().unwrap().can_undo(), "{what} recorded an undo step");
        }
    }

    #[test]
    fn the_verifier_accepts_only_added_sheet_ids_that_name_the_indexed_sheet() {
        let ids = ["s0".to_string(), "s1".to_string()];
        let at = |i: usize| ids.get(i).cloned();
        let stored = json!({
            "chartId": "c", "spec": {
                "data": { "sheetIndex": 0, "startRow": 0 },
                "layers": [{ "data": { "sheetIndex": 1, "startRow": 0 } }],
                "transform": [{ "type": "lookup", "from": { "sheetIndex": 1, "startRow": 2 } }],
                "width": 1.0
            }
        });
        let mut next = stored.clone();
        next["spec"]["data"]["sheetId"] = json!("s0");
        next["spec"]["layers"][0]["data"]["sheetId"] = json!("s1");
        next["spec"]["transform"][0]["from"]["sheetId"] = json!("s1");
        next["spec"]["width"] = json!(1);
        assert_eq!(count_sheet_id_stamps(&stored, &next, &at), Ok(3));
        assert_eq!(count_sheet_id_stamps(&stored, &stored, &at), Ok(0), "no change is no stamp");

        let mut changed_stamp = next.clone();
        changed_stamp["spec"]["layers"][0]["data"]["sheetId"] = json!("s0");
        assert!(count_sheet_id_stamps(&stored, &changed_stamp, &at).is_err());

        let mut no_index = stored.clone();
        no_index["spec"]["sheetId"] = json!("s0");
        assert!(count_sheet_id_stamps(&stored, &no_index, &at).is_err(), "a stamp needs a sheetIndex beside it");

        let mut removed = next.clone();
        removed["spec"].as_object_mut().unwrap().remove("transform");
        assert!(count_sheet_id_stamps(&stored, &removed, &at).is_err());

        let mut restamp = stored.clone();
        restamp["spec"]["data"]["sheetId"] = json!("s0");
        let mut changed_existing = restamp.clone();
        changed_existing["spec"]["data"]["sheetId"] = json!("s1");
        assert!(
            count_sheet_id_stamps(&restamp, &changed_existing, &at).is_err(),
            "an EXISTING sheet id is a value, and may not change"
        );
    }

    // -----------------------------------------------------------------------
    // BUG-0204: the load-time stamp happens in the BACKEND, at open, against
    // the file's own sheet list.
    // -----------------------------------------------------------------------

    const STAMP_FIXTURE: &str = include_str!("../../extensions/Charts/lib/__tests__/fixtures/chartSheetIdStamp.json");

    /// The backend walk and chartSheetRefs.ts `stampStoredChartJson` agree on
    /// ONE fixture (its TypeScript twin is chartSheetIdStampParity.test.ts).
    #[test]
    fn the_backend_stamp_walk_matches_the_shared_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(STAMP_FIXTURE).expect("the fixture parses");
        let ids: Vec<String> = fixture["sheetIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        let at = |i: usize| ids.get(i).cloned();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 9, "fixture: the cases are all there");
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let got = super::stamp_chart_record_sheet_ids(&case["record"].to_string(), &at)
                .map(|s| serde_json::from_str::<serde_json::Value>(&s).unwrap());
            let want = if case["expected"].is_null() { None } else { Some(case["expected"].clone()) };
            assert_eq!(got, want, "case `{}`", name);
        }
    }

    /// A workbook as `open_file` hands it over: `names` sheets with ids, and one
    /// chart on sheet 0 whose range names sheet `range_sheet` by INDEX only.
    fn file_with_index_only_chart(names: &[&str], range_sheet: usize) -> persistence::Workbook {
        let mut wb = persistence::Workbook::new();
        wb.sheets = names.iter().map(|n| persistence::Sheet::new(n.to_string())).collect();
        wb.charts = vec![persistence::SavedChart {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            sheet_id: wb.sheets[0].id,
            spec_json: serde_json::to_string(&json!({
                "chartId": "c1", "name": "Chart 1", "sheetIndex": 0, "x": 0, "y": 0, "width": 400, "height": 300,
                "spec": { "mark": "bar", "data": { "sheetIndex": range_sheet, "startRow": 0, "startCol": 0, "endRow": 4, "endCol": 1 } }
            }))
            .unwrap(),
        }];
        wb
    }

    #[test]
    fn opening_a_workbook_stamps_each_range_with_the_files_own_sheet() {
        let wb = file_with_index_only_chart(&["Sheet1", "Data", "Other"], 1);
        let data_id = wb.sheets[1].id.to_string();
        let state = crate::create_app_state();
        crate::persistence::restore_charts(&wb.charts, &state, &wb);

        let stored = stored_json(&state);
        assert_eq!(
            stored["spec"]["data"]["sheetId"],
            json!(data_id),
            "the range was not pinned to the file's own sheet at load: {}",
            stored
        );
        // Nothing but the id was added.
        let mut without = stored.clone();
        without["spec"]["data"].as_object_mut().unwrap().remove("sheetId");
        let original: serde_json::Value = serde_json::from_str(&wb.charts[0].spec_json).unwrap();
        assert_eq!(without, original, "the load stamp changed more than the sheet id");
    }

    /// The race itself: once the load has stamped, a sheet MOVE right after the
    /// open (the ~300 ms window the frontend stamp used to leave) changes
    /// nothing about which sheet the chart reads -- the id travels, the index
    /// does not matter any more.
    #[test]
    fn a_sheet_move_right_after_the_open_cannot_repoint_the_chart() {
        let wb = file_with_index_only_chart(&["Sheet1", "Data", "Other"], 1);
        let data_id = wb.sheets[1].id.to_string();
        let state = crate::create_app_state();
        crate::persistence::restore_charts(&wb.charts, &state, &wb);
        // The live sheet list after the open, then "Other" moved in front of "Data".
        *state.sheet_ids.write(&test_seed_effect()).unwrap() = vec![wb.sheets[0].id, wb.sheets[2].id, wb.sheets[1].id];

        // What the chart store's late stamp would now do: nothing is left to stamp.
        let current: Vec<String> = state.sheet_ids.read().unwrap().iter().map(|id| id.to_string()).collect();
        let late = super::stamp_chart_record_sheet_ids(&state.charts.read().unwrap()[0].spec_json, &|i| current.get(i).cloned());
        assert!(late.is_none(), "a late stamp still found an index-only range to pin against the NEW sheet list");
        assert_eq!(stored_json(&state)["spec"]["data"]["sheetId"], json!(data_id));
    }
}
