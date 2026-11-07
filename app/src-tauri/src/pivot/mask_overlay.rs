//! FILENAME: app/src-tauri/src/pivot/mask_overlay.rs
//! BUG-0108: the numbers a host-side (level-1) filter mask gets wrong in a BI
//! pivot, evaluated again by the model engine over the members the mask leaves
//! VISIBLE, and laid over the rendered view.
//!
//! # Why a mask gets numbers wrong
//!
//! A BI pivot's records are the engine's answer grouped by every pivot surface
//! (axis, filter area, slicer columns) with NO filter: an ordinary slicer
//! click, a header filter or a filter-area selection hides records host-side
//! (`hidden_items` -> `PivotCache::filter_mask`) and re-queries nothing. The
//! roll-up of the visible records is exact for an additive measure and wrong
//! for two classes (`mask_safety::MaskBehaviour`):
//! - a measure whose VALUE depends on rows the mask hides -- a share of the
//!   visible total (`DIVIDE(SUM(x), SUM(x, ALLSELECTED()))`, `CLEAR_INNER`), a
//!   window, `ISFILTERED` -- was evaluated over a context with no filter in it,
//!   so its denominator still counted the hidden rows. Power BI shows 1.0 for
//!   the only product a slicer leaves; the mask showed that product's share of
//!   ALL products;
//! - a measure whose TOTAL is not the sum of its leaves (a ratio, an average):
//!   the engine's own totals (`totals.rs`) describe the UNFILTERED set, so a
//!   masked pivot summed its visible ratios.
//!
//! # What this does
//!
//! For a pivot holding such a measure, while a mask is active: one engine
//! query per total grain -- and for the leaf grain, when a leaf can be wrong --
//! carrying the pivot's own pins AND the mask, as IN-lists of the members it
//! leaves visible at `LEVEL_SLICER`. Level 1 is inside bare `CLEAR` /
//! `RESET`'s range and outside `ALLSELECTED`'s, which is Power BI's split: an
//! `ALLSELECTED` total keeps the slicer, an `ALL` total removes it. The answer
//! is a `pivot_engine::MaskOverlay` installed on the cache, keyed by exactly
//! that mask and field layout, which the pivot engine splices over the masked
//! roll-up for that state only. The records are never touched, so an unfilter,
//! an undo or a redo can never show a stale number: a different mask finds no
//! overlay (or its own), and the cache keeps the newest `MAX_MASK_OVERLAYS`
//! states, so a slicer clicked back -- or the reconcile after an undo -- finds
//! its overlay again without asking. Only the measures a mask gets wrong are
//! asked for; an additive value field keeps its roll-up.
//!
//! # What it never does
//!
//! It never sends the mask into the pivot's OWN query -- the withdrawn BUG-0108
//! routing (`mask_safety.rs`): the cache keeps the full value domain and
//! `hidden_items` stays where filtering lives, so the slicer's list, the header
//! dropdown and undo keep working as they did. And it never makes a filter
//! worse than before: an engine refusal (a compound `RESET` share is a typed
//! refusal under a request filter its clear would have to remove --
//! `reset_with_slicer_on_cleared_table_fails_closed` -- and the mask already
//! answers it correctly), an unsupported layout, or a lost connection leaves
//! the masked values standing, never an error. A refused grain is retried one
//! measure at a time, so one refusing measure cannot cost the others their
//! answer, and a refused state is remembered (an overlay with no cells) so the
//! next click on it does not ask again.
//!
//! A pivot whose measures are all additive pays nothing: [`plan`] reads the
//! cache's `mask_sensitivity` and returns before computing anything.

use std::collections::HashSet;
use std::time::Instant;

use arrow::record_batch::RecordBatch;
use pivot_engine::{
    FieldGrouping, MaskOverlay, PivotCache, PivotDefinition, TotalOverride, ValueField, ValueId, VALUE_ID_EMPTY,
};

use crate::bi::types::{BiState, ConnectionId};
use crate::log_info;
use crate::pivot::totals::{enumerate_grains, overrides_from_grain_result, BiTotalsPlan, GrainField, MAX_TOTAL_GRAINS};
use crate::pivot::types::BiPivotMetadata;

/// One column the mask filters, as the overlay query filters it.
pub(crate) struct MaskedColumn {
    pub table: String,
    pub column: String,
    /// The member KEYS the mask leaves visible ("" is the blank member).
    pub visible_keys: Vec<String>,
}

/// Everything one overlay evaluation needs, read under the pivot lock by
/// [`plan`] so that [`run`] can query with no lock held.
pub(crate) struct OverlayJob {
    pub connection_id: ConnectionId,
    /// The records this was planned on (`PivotCache::build_id`): [`install`]
    /// drops the answer when the pivot holds other records by then.
    pub build_id: u64,
    /// The grain fields, the measures to ask for, every value field's key and
    /// the pivot's PINS (its level-2+ engine filters).
    pub plan: BiTotalsPlan,
    /// The mask, as the members it leaves visible.
    pub masked: Vec<MaskedColumn>,
    /// Whether the full-depth (leaf) grain is asked for too.
    pub include_leaf: bool,
    /// A values-only pivot's synthetic "Total" row (its cache column): the
    /// grand-total grain's answer is ALSO that row's one leaf.
    pub synthetic_total: Option<usize>,
    /// The key the answer is installed under; its `overrides` are empty.
    pub overlay: MaskOverlay,
}

/// One grain's raw answer. Converted to overrides against the LIVE cache by
/// [`install`], under the lock, so [`run`] needs no copy of the records.
pub(crate) struct GrainAnswer {
    pub row_depth: usize,
    pub col_depth: usize,
    pub batches: Vec<RecordBatch>,
    pub result_columns: Vec<bi_engine::ResultColumn>,
}

/// The measure a BI value field shows: its name without the outer `[...]`
/// (`expand_bi_value_fields` writes "[Revenue]").
fn measure_of(field: &ValueField) -> String {
    let name = field.name.trim();
    name.strip_prefix('[').and_then(|n| n.strip_suffix(']')).unwrap_or(name).to_string()
}

/// A member key as the engine's IN-list matches it on a column of
/// `data_type`: the headless design query's spelling (a Float64 key
/// re-spelled "2024.0", the blank member `(blank)`), and a Boolean key in the
/// engine's own lower case (the pivot's member key is "TRUE").
fn in_list_spelling(data_type: Option<&bi_engine::DataType>, key: &str) -> String {
    if matches!(data_type, Some(bi_engine::DataType::Boolean))
        && (key.eq_ignore_ascii_case("true") || key.eq_ignore_ascii_case("false"))
    {
        return key.to_ascii_lowercase();
    }
    crate::pivot::headless::engine_spelling(data_type, key)
}

/// The grains an overlay asks for: every total grain, plus the leaf when
/// `include_leaf`, coarse to fine (a key collision resolves for the finer
/// grain). Beyond `MAX_TOTAL_GRAINS` only the grand total and the leaf: a
/// subtotal in between then keeps the roll-up of its corrected leaves.
fn overlay_grains(rows: usize, cols: usize, include_leaf: bool) -> Vec<(usize, usize)> {
    let grains = enumerate_grains(rows, cols, include_leaf);
    if grains.len() <= MAX_TOTAL_GRAINS {
        return grains;
    }
    let mut kept = vec![(0, 0)];
    if include_leaf && (rows, cols) != (0, 0) {
        kept.push((rows, cols));
    }
    kept
}

/// The overlay `definition`'s CURRENT filter state needs, or `None` when it
/// needs none -- the all-additive pivot, an unfiltered pivot with its own
/// engine totals, a state evaluated before, or a layout the overlay does not
/// describe. Cheap when there is nothing to do: it returns before computing
/// anything for a cache with no mask-sensitive value field. Leaves
/// `cache.filter_mask` as a render of `definition` would (a render recomputes
/// it anyway).
pub(crate) fn plan(
    definition: &PivotDefinition,
    cache: &mut PivotCache,
    meta: Option<&BiPivotMetadata>,
) -> Option<OverlayJob> {
    let meta = meta?;
    let sensitivity = cache.mask_sensitivity.clone()?;
    if cache.records.is_empty() || cache.build_id == 0 {
        return None;
    }
    let sensitive: Vec<&ValueField> = definition
        .value_fields
        .iter()
        .filter(|v| sensitivity.total_fields.contains(&v.source_index))
        .collect();
    if sensitive.is_empty() {
        return None;
    }

    // A values-only pivot's synthetic "Total" row (placed when no dimension
    // is): ONE member every record holds, so its one leaf IS the grand total,
    // which the grand-total grain answers.
    let is_synthetic = |f: &pivot_engine::PivotField| {
        f.is_synthetic_total || crate::pivot::utils::is_synthetic_total_row(definition, meta, f.source_index)
    };
    let synthetic_total: Option<usize> = match definition.row_fields.as_slice() {
        [only] if definition.column_fields.is_empty() && is_synthetic(only) => Some(only.source_index),
        _ => None,
    };

    // Layouts the overlay does not describe keep the masked roll-up, as
    // before: a calculation group (its totals are hidden anyway), a GROUPED
    // field (a date level, a number bin or a manual group is a virtual field
    // no model column carries), a synthetic Total row beside other fields.
    let is_calc_group = |name: &str| meta.calculation_groups.iter().any(|g| g.name == name);
    if definition.value_fields.iter().any(|v| v.calc_item.is_some()) {
        return None;
    }
    let axis = || definition.row_fields.iter().chain(definition.column_fields.iter());
    if axis().any(|f| {
        !matches!(f.grouping, FieldGrouping::None)
            || is_calc_group(&f.name)
            || (synthetic_total != Some(f.source_index) && is_synthetic(f))
    }) {
        return None;
    }
    if definition.filter_fields.iter().any(|f| is_calc_group(&f.field.name)) {
        return None;
    }

    // The mask a render of `definition` aggregates over.
    pivot_engine::apply_definition_filters(definition, cache);
    let visible = cache.filter_mask.iter().filter(|&&included| included).count();
    if visible == 0 {
        // Nothing on screen to correct.
        return None;
    }
    let all_visible = visible == cache.filter_mask.len();
    if all_visible && !cache.total_overrides.is_empty() {
        // Unfiltered: the cache's own engine totals apply. Only a cache that
        // was queried while filtered has none, and gets them here.
        return None;
    }

    let row_fields: Vec<usize> =
        definition.row_fields.iter().filter(|f| !f.is_attribute).map(|f| f.source_index).collect();
    let col_fields: Vec<usize> =
        definition.column_fields.iter().filter(|f| !f.is_attribute).map(|f| f.source_index).collect();
    let value_fields: Vec<usize> = definition.value_fields.iter().map(|v| v.source_index).collect();
    if cache.mask_overlay_for(&row_fields, &col_fields, &value_fields).is_some() {
        // Evaluated before: it applies at render.
        return None;
    }

    // Every cache column of a BI pivot is stamped with its model column
    // ("Table.Column", `FieldCache::model_key`): the one authority for which
    // table a filter is on -- a bare cache name can belong to two tables.
    let table_names: Vec<&str> = meta.model_tables.iter().map(|t| t.name.as_str()).collect();
    let model_column = |idx: usize| -> Option<(String, String)> {
        let key = cache.fields.get(idx)?.model_key.as_deref()?;
        let (table, column) = crate::pivot::commands::split_bi_field_key(key, table_names.iter().copied());
        (!table.is_empty() && !column.is_empty()).then_some((table, column))
    };
    let grain = |idx: usize| model_column(idx).map(|(table, column)| GrainField { table, column, cache_idx: idx });
    // The synthetic Total row is no model column: nothing to group by.
    let row_grains: Vec<GrainField> = row_fields
        .iter()
        .filter(|&&i| synthetic_total != Some(i))
        .map(|&i| grain(i))
        .collect::<Option<_>>()?;
    let col_grains: Vec<GrainField> = col_fields.iter().map(|&i| grain(i)).collect::<Option<_>>()?;

    // The measures asked for: the sensitive ones, each once. Every value
    // field keeps a key, so an additive one finds no column in the answer and
    // keeps its roll-up.
    let mut measures: Vec<String> = Vec::new();
    for v in &sensitive {
        let m = measure_of(v);
        if !measures.contains(&m) {
            measures.push(m);
        }
    }
    let vf_keys: Vec<(String, Option<String>)> =
        definition.value_fields.iter().map(|v| (measure_of(v), None)).collect();

    // The pivot's PINS, exactly as its own query carries them.
    let pins: Vec<bi_engine::ScopedInFilter> = definition
        .engine_filters
        .iter()
        .map(|ef| bi_engine::ScopedInFilter {
            table: Some(ef.table.clone()),
            filter: bi_engine::InFilter::new(
                ef.column.clone(),
                ef.selected_items.iter().map(|k| crate::bi::member::engine_in_value(k)),
            ),
            level: ef.level,
        })
        .collect();

    let masked = if all_visible { Vec::new() } else { masked_columns(definition, cache, &model_column)? };

    // The leaf grain: when a measure's leaf value itself depends on what the
    // mask hides, or when a visible leaf cell is a roll-up of several records
    // -- they are split by a column the axis does not show (a slicer's, the
    // filter area's, or one a cleared filter left in the query), so a ratio's
    // leaf is a sum of its parts there too.
    // (With no grain field at all -- the synthetic Total row -- the one grain
    // is the "leaf" of a layout of none, and is always asked for.)
    let leaf_sensitive = sensitive.iter().any(|v| sensitivity.leaf_fields.contains(&v.source_index));
    let include_leaf = synthetic_total.is_some()
        || (!all_visible && leaf_sensitive)
        || leaves_are_rollups(cache, &row_fields, &col_fields);

    Some(OverlayJob {
        connection_id: meta.connection_id,
        build_id: cache.build_id,
        plan: BiTotalsPlan {
            row_fields: row_grains,
            col_fields: col_grains,
            measures,
            vf_keys,
            scoped_in_filters: pins,
        },
        masked,
        include_leaf,
        synthetic_total,
        overlay: MaskOverlay {
            mask: pivot_engine::pack_filter_mask(&cache.filter_mask),
            record_count: cache.filter_mask.len(),
            row_fields,
            col_fields,
            value_fields,
            overrides: Vec::new(),
            answered: Vec::new(),
        },
    })
}

/// Whether some leaf cell -- one combination of the row and column fields'
/// members -- rolls up more than one VISIBLE record. Read from the records,
/// not the definition: a cleared slicer leaves the definition but its column
/// stays in the records until the next query.
fn leaves_are_rollups(cache: &PivotCache, row_fields: &[usize], col_fields: &[usize]) -> bool {
    let mut seen: HashSet<Vec<ValueId>> = HashSet::new();
    for (i, record) in cache.records.iter().enumerate() {
        if !cache.filter_mask.get(i).copied().unwrap_or(false) {
            continue;
        }
        let key: Vec<ValueId> = row_fields
            .iter()
            .chain(col_fields.iter())
            .map(|&f| record.values.get(f).copied().unwrap_or(VALUE_ID_EMPTY))
            .collect();
        if !seen.insert(key) {
            return true;
        }
    }
    false
}

/// Every hidden-items list of `definition` -- the row, column and filter-area
/// fields' and the slicer filters' -- as the MEMBERS IT LEAVES VISIBLE: each
/// list resolved exactly as the pivot engine resolves it
/// (`pivot_engine::hidden_member_ids`), taken from the members the records
/// actually hold, and spelled as member keys. `None` when a list that hides
/// something sits on a column no model column can be named for: the engine
/// cannot be told about that mask, so no overlay is evaluated at all.
fn masked_columns(
    definition: &PivotDefinition,
    cache: &PivotCache,
    model_column: &dyn Fn(usize) -> Option<(String, String)>,
) -> Option<Vec<MaskedColumn>> {
    let lists = definition
        .row_fields
        .iter()
        .chain(definition.column_fields.iter())
        .chain(definition.filter_fields.iter().map(|f| &f.field))
        .filter(|f| !f.hidden_items.is_empty())
        .map(|f| (f.source_index, &f.hidden_items))
        .chain(
            definition
                .slicer_filters
                .iter()
                .filter(|s| !s.hidden_items.is_empty())
                .map(|s| (s.source_index, &s.hidden_items)),
        );
    let mut out = Vec::new();
    for (idx, items) in lists {
        let field_cache = cache.fields.get(idx)?;
        let hidden = pivot_engine::hidden_member_ids(field_cache, items);
        if hidden.is_empty() {
            // Names no member: hides nothing.
            continue;
        }
        let (table, column) = model_column(idx)?;
        let present: HashSet<ValueId> = cache
            .records
            .iter()
            .map(|r| r.values.get(idx).copied().unwrap_or(VALUE_ID_EMPTY))
            .collect();
        let mut ids: Vec<ValueId> = present.into_iter().filter(|id| !hidden.contains(id)).collect();
        ids.sort_unstable();
        let mut visible_keys: Vec<String> = Vec::with_capacity(ids.len());
        for id in ids {
            // A NULL and an empty text are ONE member, keyed "" (ruling Q8).
            let key = field_cache.member_key(id);
            if !visible_keys.contains(&key) {
                visible_keys.push(key);
            }
        }
        out.push(MaskedColumn { table, column, visible_keys });
    }
    Some(out)
}

/// Runs `job`'s queries, with the connection's "View as" role applied. `None`
/// when they could not run at all (no connection, no model loaded) or a query
/// failed for a reason that may pass (a connector error, a cancellation,
/// [`is_transient`]): nothing is installed, so a later filter asks again --
/// an empty overlay would have kept that state's masked values for good. A
/// refused grain is retried one measure at a time; a grain that still fails
/// keeps the masked roll-up. A measure the engine REFUSED at one grain is
/// asked ALONE at each remaining grain of this run (one query, never the
/// batch-then-one-by-one fan-out again: wave 1 pivotmask verifier), because a
/// refusal can depend on the grain -- skipping it for the rest of the run
/// left the masked roll-up at grains the engine would have answered (wave 3
/// verifier). Only a measure the model does not have
/// (`QueryError::MeasureNotFound`, the same at every grain) is dropped.
pub(crate) async fn run(bi_state: &BiState, job: &OverlayJob) -> Option<Vec<GrainAnswer>> {
    let started = Instant::now();
    let engine_arc = {
        let connections = bi_state.connections.lock().ok()?;
        connections.get(&job.connection_id)?.engine.clone()?
    };
    let mut engine = engine_arc.lock().await;
    crate::bi::commands::apply_connection_role(&mut engine, bi_state, job.connection_id);

    // The mask as level-1 IN-lists, each key spelled for its column's type.
    let mut scoped = job.plan.scoped_in_filters.clone();
    for m in &job.masked {
        let data_type = engine
            .model()
            .table(&m.table)
            .ok()
            .and_then(|t| t.column(&m.column).ok())
            .map(|c| c.data_type().clone());
        let mut keys: Vec<String> = Vec::with_capacity(m.visible_keys.len());
        for key in &m.visible_keys {
            let spelled = in_list_spelling(data_type.as_ref(), key);
            if !keys.contains(&spelled) {
                keys.push(spelled);
            }
        }
        scoped.push(bi_engine::ScopedInFilter {
            table: Some(m.table.clone()),
            filter: bi_engine::InFilter::new(m.column.clone(), keys),
            level: bi_engine::LEVEL_SLICER,
        });
    }

    let grains = overlay_grains(job.plan.row_fields.len(), job.plan.col_fields.len(), job.include_leaf);
    let mut answers = Vec::with_capacity(grains.len());
    let mut asked = 0usize;
    // Refused once: asked alone from then on. Unknown: never asked again.
    let mut refused: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut unknown: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (d, e) in grains {
        let measures: Vec<String> = job
            .plan
            .measures
            .iter()
            .filter(|m| !refused.contains(*m) && !unknown.contains(*m))
            .cloned()
            .collect();
        let alone: Vec<String> = job
            .plan
            .measures
            .iter()
            .filter(|m| refused.contains(*m) && !unknown.contains(*m))
            .cloned()
            .collect();
        if measures.is_empty() && alone.is_empty() {
            break;
        }
        let group_by: Vec<bi_engine::ColumnRef> = job.plan.row_fields[..d]
            .iter()
            .chain(job.plan.col_fields[..e].iter())
            .map(|gf| bi_engine::ColumnRef::new(&gf.table, &gf.column))
            .collect();
        let request = |measures: Vec<String>| bi_engine::QueryRequest {
            measures,
            group_by: group_by.clone(),
            scoped_in_filters: scoped.clone(),
            ..Default::default()
        };
        // The measures refused at an earlier grain, one query each.
        for measure in &alone {
            asked += 1;
            note_query();
            match engine.query_with_meta(request(vec![measure.clone()])).await {
                Ok((batches, result_columns)) => {
                    answers.push(GrainAnswer { row_depth: d, col_depth: e, batches, result_columns });
                }
                Err(err) if is_transient(&err) => {
                    log_info!("PIVOT", "mask overlay {} failed ({}); nothing installed, asked again later", measure, err);
                    return None;
                }
                Err(err) => {
                    if matches!(err, bi_engine::QueryError::MeasureNotFound(_)) {
                        unknown.insert(measure.clone());
                    }
                    log_info!("PIVOT", "mask overlay grain ({},{}) for {} refused -- its masked value stands: {}", d, e, measure, err);
                }
            }
        }
        if measures.is_empty() {
            continue;
        }
        asked += 1;
        note_query();
        match engine.query_with_meta(request(measures.clone())).await {
            Ok((batches, result_columns)) => {
                answers.push(GrainAnswer { row_depth: d, col_depth: e, batches, result_columns });
            }
            Err(err) if is_transient(&err) => {
                log_info!("PIVOT", "mask overlay grain ({},{}) failed ({}); nothing installed, asked again later", d, e, err);
                return None;
            }
            Err(err) if measures.len() > 1 => {
                log_info!(
                    "PIVOT",
                    "mask overlay grain ({},{}) refused ({}); asking one measure at a time",
                    d,
                    e,
                    err
                );
                for measure in &measures {
                    asked += 1;
                    note_query();
                    match engine.query_with_meta(request(vec![measure.clone()])).await {
                        Ok((batches, result_columns)) => {
                            answers.push(GrainAnswer { row_depth: d, col_depth: e, batches, result_columns });
                        }
                        Err(err) if is_transient(&err) => {
                            log_info!("PIVOT", "mask overlay {} failed ({}); nothing installed, asked again later", measure, err);
                            return None;
                        }
                        Err(err) => {
                            log_info!(
                                "PIVOT",
                                "mask overlay grain ({},{}) for {} refused -- its masked value stands: {}",
                                d,
                                e,
                                measure,
                                err
                            );
                            if matches!(err, bi_engine::QueryError::MeasureNotFound(_)) {
                                unknown.insert(measure.clone());
                            }
                            refused.insert(measure.clone());
                        }
                    }
                }
            }
            Err(err) => {
                log_info!(
                    "PIVOT",
                    "mask overlay grain ({},{}) refused -- its masked values stand: {}",
                    d,
                    e,
                    err
                );
                if matches!(err, bi_engine::QueryError::MeasureNotFound(_)) {
                    unknown.extend(measures.iter().cloned());
                }
                refused.extend(measures.iter().cloned());
            }
        }
    }
    log_info!(
        "PIVOT",
        "mask overlay: {} engine queries, {} answered, in {:.1}ms",
        asked,
        answers.len(),
        started.elapsed().as_secs_f64() * 1000.0
    );
    Some(answers)
}

/// Whether a failed overlay query may succeed if asked again: the connector
/// (a source round trip, a dropped connection) or a cancellation, as opposed
/// to the engine refusing the measure in that filter context.
fn is_transient(err: &bi_engine::QueryError) -> bool {
    matches!(err, bi_engine::QueryError::Connector(_) | bi_engine::QueryError::Cancelled)
}

/// Installs `job`'s answer on `cache` -- converted to overrides against these
/// very records -- when the cache still holds the records it was planned on.
/// Returns whether it did; `false` leaves the cache untouched (a concurrent
/// re-query replaced the records, and its own command evaluates its own).
pub(crate) fn install(cache: &mut PivotCache, job: OverlayJob, answers: Vec<GrainAnswer>) -> bool {
    if cache.build_id != job.build_id {
        return false;
    }
    let mut overlay = job.overlay;
    for answer in &answers {
        // The value fields this answer carries a column for: the engine's
        // whole answer for them at this grain, BLANK wherever it is silent.
        let value_fields = crate::pivot::totals::answered_value_fields(&answer.result_columns, &job.plan);
        if !value_fields.is_empty() {
            match overlay
                .answered
                .iter_mut()
                .find(|g| g.row_depth == answer.row_depth && g.col_depth == answer.col_depth)
            {
                Some(g) => {
                    for v in value_fields {
                        if !g.value_fields.contains(&v) {
                            g.value_fields.push(v);
                        }
                    }
                }
                None => overlay.answered.push(pivot_engine::AnsweredGrain {
                    row_depth: answer.row_depth,
                    col_depth: answer.col_depth,
                    value_fields,
                }),
            }
        }
        overlay.overrides.extend(overrides_from_grain_result(
            &answer.batches,
            &answer.result_columns,
            &job.plan,
            answer.row_depth,
            answer.col_depth,
            cache,
        ));
    }
    if let Some(column) = job.synthetic_total {
        // The grand-total grain was asked with no row field; the view keys
        // its one row by the synthetic member, and its grand total by the
        // padding -- the same cell twice.
        let Some(member) = cache.records.first().and_then(|r| r.values.get(column).copied()) else {
            return false;
        };
        overlay.overrides = std::mem::take(&mut overlay.overrides)
            .into_iter()
            .flat_map(|ov| {
                let leaf = TotalOverride { row_key: vec![member], col_key: ov.col_key.clone(), values: ov.values.clone() };
                let total = TotalOverride { row_key: vec![VALUE_ID_EMPTY], ..ov };
                [leaf, total]
            })
            .collect();
    }
    cache.install_mask_overlay(overlay);
    true
}

// Counts the overlay's engine queries on this thread, for the tests that
// prove a click on an all-additive pivot asks the engine nothing.
#[cfg(test)]
thread_local! {
    static QUERIES_ISSUED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn note_query() {
    #[cfg(test)]
    QUERIES_ISSUED.with(|q| q.set(q.get() + 1));
}

/// How many overlay engine queries this thread has issued (tests only).
#[cfg(test)]
pub(crate) fn queries_issued_on_this_thread() -> usize {
    QUERIES_ISSUED.with(|q| q.get())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_overlay_asks_for_every_total_grain_and_the_leaf_only_when_a_leaf_can_be_wrong() {
        assert_eq!(overlay_grains(1, 0, false), vec![(0, 0)]);
        assert_eq!(overlay_grains(1, 0, true), vec![(0, 0), (1, 0)]);
        assert_eq!(overlay_grains(2, 1, true).len(), 6);
        // Beyond the cap: the grand total and the leaves.
        assert_eq!(overlay_grains(6, 3, true), vec![(0, 0), (6, 3)]);
        assert_eq!(overlay_grains(6, 3, false), vec![(0, 0)]);
    }

    #[test]
    fn a_key_is_spelled_the_way_the_engines_in_list_matches_it() {
        use bi_engine::DataType;
        assert_eq!(in_list_spelling(Some(&DataType::Float64), "2024"), "2024.0");
        assert_eq!(in_list_spelling(Some(&DataType::Boolean), "TRUE"), "true");
        assert_eq!(in_list_spelling(Some(&DataType::String), "TRUE"), "TRUE");
        assert_eq!(in_list_spelling(Some(&DataType::String), ""), bi_engine::BLANK_MEMBER_LABEL);
        assert_eq!(in_list_spelling(None, "East"), "East");
    }

    #[test]
    fn a_value_fields_measure_is_its_name_without_the_brackets() {
        let field = ValueField::new(3, "[Share of Visible]".to_string(), pivot_engine::AggregationType::Sum);
        assert_eq!(measure_of(&field), "Share of Visible");
        let bare = ValueField::new(3, "Revenue".to_string(), pivot_engine::AggregationType::Sum);
        assert_eq!(measure_of(&bare), "Revenue");
    }
}
