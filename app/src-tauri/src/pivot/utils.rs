//! FILENAME: app/src-tauri/src/pivot/utils.rs
use crate::api_types::MemberRef;
use crate::commands::styles::parse_number_format;
use crate::pivot::types::*;
use engine::{format_number, LocaleSettings, MemberSource};
use pivot_engine::{
    AggregationType, CacheValue, DateGroupLevel, FieldGrouping, FilterCondition, ManualGroup,
    PivotCache, PivotDefinition, PivotField, PivotFilter, PivotLayout, PivotView, ReportLayout,
    ShowValuesAs, SortOrder, SubtotalLocation, ValueField, ValueId, ValuesPosition, VALUE_ID_EMPTY,
};

// ============================================================================
// ERROR VALUE CELLS
// ============================================================================

/// The grid error a pivot view's `PivotCellValue::Error(code)` stands for.
///
/// [LIVE] Excel 16 (lane bie probe 1): a PivotTable value cell that holds an
/// error -- a calculated field `=Amount/0`, a Sum over a source `#DIV/0!` --
/// is an ERROR VALUE: `ISERROR` is TRUE, `ERROR.TYPE` is 2, `ISTEXT` FALSE.
/// The writer put the TEXT "#DIV/0!" in the grid, so `ISERROR` answered FALSE.
///
/// The code arrives in two spellings: a calculated field's bare code
/// (`"DIV/0!"`, `"NUM!"`, `"VALUE!"`; `CalcValue::Error`) and a source cell's
/// variant name (`"Div0"`, `"NA"`; `CacheValue::Error` is written with
/// `{:?}`). Both map to their error; anything else is `#VALUE!`.
pub(crate) fn pivot_error_value(code: &str) -> engine::CellError {
    use engine::CellError;
    let bare = code.trim().trim_start_matches('#');
    let literal = format!("#{bare}");
    let by_literal = CellError::from_literal(&literal);
    if by_literal.as_literal().eq_ignore_ascii_case(&literal) {
        return by_literal;
    }
    match bare {
        "Div0" => CellError::Div0,
        "Ref" => CellError::Ref,
        "Name" => CellError::Name,
        "NA" => CellError::NA,
        "Null" => CellError::Null,
        "Num" => CellError::Num,
        "Spill" => CellError::Spill,
        "Circular" => CellError::Circular,
        "Conflict" => CellError::Conflict,
        "Blocked" => CellError::Blocked,
        "Limit" => CellError::Limit,
        _ => CellError::Value,
    }
}

// ============================================================================
// MEMBERS (P2: THE member shape, app locale everywhere)
// ============================================================================

/// The app locale a pivot or slicer command writes its display text in:
/// `state.locale`, a LEAF lock -- taken, cloned and dropped here, so call it
/// at the top of a command before any other guard and pass the clone down.
pub(crate) fn display_locale_of(state: &crate::AppState) -> LocaleSettings {
    state
        .locale
        .lock()
        .map(|l| l.clone())
        .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
}

/// THE app-crate member KEY of `value_id` in field `field_index` (base or
/// virtual) of `cache`: `FieldCache::member_key`, the invariant canonical
/// text every selection, filter, page filter and cross-filter tuple matches
/// on. For a BI cache it is the spelling `bi_get_column_values` returns as
/// key (`arrow_value_to_string`); the blank member is "" (ruling Q8).
/// `PivotCellData.member.key` agrees with it byte for byte (P4 relies on it).
pub(crate) fn member_key_of(cache: &PivotCache, field_index: usize, value_id: ValueId) -> Option<String> {
    cache.get_field(field_index).map(|f| f.member_key(value_id))
}

/// Fill `resp.group_members` (P4): for every `(field_index, value_id)` in
/// the RETURNED cells' `group_path`s whose field is one of `field_keys`
/// (`(cache field index, "Table.Column")`), the member key
/// [`member_key_of`] gives it -- deduped, sorted by value id, one entry per
/// field in field-index order, and only for fields that occur. A windowed
/// response covers its window only, never the rows it did not send.
pub(crate) fn fill_group_members(resp: &mut PivotViewResponse, field_keys: &[(usize, String)], cache: &PivotCache) {
    use std::collections::{BTreeMap, BTreeSet};
    let mut seen: BTreeMap<usize, BTreeSet<u32>> = BTreeMap::new();
    for cell in resp.rows.iter().flat_map(|r| r.cells.iter()) {
        for (field_index, value_id) in &cell.group_path {
            if field_keys.iter().any(|(fi, _)| fi == field_index) {
                seen.entry(*field_index).or_default().insert(*value_id);
            }
        }
    }
    resp.group_members = seen
        .into_iter()
        .filter_map(|(field_index, ids)| {
            let field_key = field_keys.iter().find(|(fi, _)| *fi == field_index)?.1.clone();
            let members: Vec<(u32, String)> = ids
                .into_iter()
                .filter_map(|vid| member_key_of(cache, field_index, vid).map(|key| (vid, key)))
                .collect();
            (!members.is_empty()).then_some(PivotGroupMembers { field_index, field_key, members })
        })
        .collect();
}

/// The `(cache field index, "Table.Column")` of every placed ROW, COLUMN and
/// FILTER field of `definition` that `is_model_column` accepts by name,
/// deduped by index -- the `field_keys` [`fill_group_members`] takes. A
/// design-query view and a BI pivot both name each placed model column
/// "Table.Column"; the predicate keeps out what is not one (a BI pivot's
/// calculation-group dimension, its synthetic "Total" row).
pub(crate) fn placed_field_keys(
    definition: &PivotDefinition,
    is_model_column: impl Fn(&str) -> bool,
) -> Vec<(usize, String)> {
    let mut out: Vec<(usize, String)> = Vec::new();
    let placed = definition
        .row_fields
        .iter()
        .chain(definition.column_fields.iter())
        .chain(definition.filter_fields.iter().map(|f| &f.field));
    for field in placed {
        if is_model_column(&field.name) && !out.iter().any(|(i, _)| *i == field.source_index) {
            out.push((field.source_index, field.name.clone()));
        }
    }
    out
}

/// [`placed_field_keys`] for a BI pivot: a field counts when its name is
/// "Table.Column" of a column the pivot's model snapshot lists.
pub(crate) fn bi_placed_field_keys(definition: &PivotDefinition, meta: &BiPivotMetadata) -> Vec<(usize, String)> {
    placed_field_keys(definition, |name| {
        meta.model_tables.iter().any(|t| {
            name.strip_prefix(t.name.as_str())
                .and_then(|rest| rest.strip_prefix('.'))
                .is_some_and(|column| t.columns.iter().any(|c| c.name == column))
        })
    })
}

/// The name `update_bi_pivot_fields` gives the synthetic row dimension of a
/// values-only BI pivot (`use_synthetic_dim`): its cache field 0 and its one
/// row field are both called this.
const SYNTHETIC_TOTAL_ROW: &str = "Total";

/// THE synthetic "Total" row field of a values-only BI pivot, MARKED as such
/// (`PivotField::is_synthetic_total`): what `update_bi_pivot_fields` places as
/// the one row field when no dimension is placed. The marker, not the name, is
/// what [`is_synthetic_total_row`] reads.
pub(crate) fn synthetic_total_row_field() -> PivotField {
    let mut field = PivotField::new(0, SYNTHETIC_TOTAL_ROW.to_string());
    field.is_synthetic_total = true;
    field
}

/// Whether cache field `field_index` of a BI pivot is the SYNTHETIC "Total"
/// row -- the placeholder dimension a values-only pivot (measures, perhaps a
/// filter-area field, no row or column field) is given so it has one row to
/// show its totals on. It is not a model column and it pins every record, so it
/// is padding, never a partial path: a drill skips it (`drill_through.rs`'s
/// group-path loop) and a refresh's request leaves it out
/// (`bi_request_from_definition`; `update_bi_pivot_fields` re-injects it).
///
/// True when a ROW field placed at `field_index` CARRIES the synthetic marker
/// ([`synthetic_total_row_field`]; review RB3: a model that merely HAS a
/// calculation group named "Total" made the name rule misread a values-only
/// pivot's row as that group) -- or, for a field saved before the marker, is
/// named "Total" while no calculation group of the model is (a group of that
/// name placed alone on rows ALSO sits at cache index 0 under that name, and is a
/// real dimension whose item must not be dropped) -- and `field_index` is not a
/// placed model column ([`bi_placed_field_keys`]). THE one copy of this test,
/// so the drill and the refresh cannot drift apart on what "synthetic" means.
pub(crate) fn is_synthetic_total_row(
    definition: &PivotDefinition,
    meta: &BiPivotMetadata,
    field_index: usize,
) -> bool {
    // A FIELD saved before the marker existed falls back to the name rule:
    // named "Total" while no calculation group of the model is (such a group
    // placed alone on rows also sits at index 0 under that name).
    let named_like_it_before_the_marker = |f: &PivotField| {
        f.name == SYNTHETIC_TOTAL_ROW && !meta.calculation_groups.iter().any(|g| g.name == SYNTHETIC_TOTAL_ROW)
    };
    definition
        .row_fields
        .iter()
        .any(|f| f.source_index == field_index && (f.is_synthetic_total || named_like_it_before_the_marker(f)))
        && !bi_placed_field_keys(definition, meta).iter().any(|(i, _)| *i == field_index)
}

/// The member `{ key, label }` of `value_id` in field `field_index`, its
/// label written for `locale` from the locale-free `FieldCache::member_source`.
pub(crate) fn member_ref(
    cache: &PivotCache,
    field_index: usize,
    value_id: ValueId,
    locale: &LocaleSettings,
) -> Option<MemberRef> {
    let field = cache.get_field(field_index)?;
    let key = field.member_key(value_id);
    Some(MemberRef::from_source(key, &field.member_source(value_id), locale))
}

/// Whether base field `idx` of `cache` has a BLANK member: NULL records, or
/// an empty-string item -- ONE member under ruling Q8.
pub(crate) fn has_blank_member(cache: &PivotCache, idx: usize) -> bool {
    if idx >= cache.fields.len() {
        return false;
    }
    let field = &cache.fields[idx];
    cache.has_blank_values(idx)
        || (0..field.unique_count() as ValueId)
            .any(|id| matches!(field.get_value(id), Some(CacheValue::Text(s)) if s.is_empty()))
}

/// The members a pivot's OWN list offers for base field `field_index` (its
/// header and filter-cell dropdowns): every interned value in the cache's
/// sorted order, keyed by `FieldCache::member_key` and labelled for
/// `locale`, then the BLANK member LAST (key "", label "(Blank)") when the
/// column has one -- NULL records or an empty-string item, which are ONE
/// member (ruling Q8) and so are never listed twice.
pub(crate) fn field_members(cache: &mut PivotCache, field_index: usize, locale: &LocaleSettings) -> Vec<MemberRef> {
    let has_blank = has_blank_member(cache, field_index);
    let Some(field_cache) = cache.fields.get_mut(field_index) else { return Vec::new() };
    let sorted_ids = field_cache.sorted_ids().to_vec();
    let mut members: Vec<MemberRef> = sorted_ids
        .iter()
        .filter(|&&id| id != VALUE_ID_EMPTY)
        .filter(|&&id| !matches!(field_cache.get_value(id), Some(CacheValue::Text(s)) if s.is_empty()))
        .map(|&id| MemberRef::from_source(field_cache.member_key(id), &field_cache.member_source(id), locale))
        .collect();
    if has_blank {
        members.push(MemberRef::blank());
    }
    members
}

/// Whether `hidden` (a field's hidden items, in any spelling a writer used)
/// hides the member `key`: by its exact key, and the blank member by either
/// of its spellings ("" or "(blank)" in any case).
pub(crate) fn hidden_names_member(hidden: &[String], key: &str) -> bool {
    hidden.iter().any(|h| {
        h == key || (pivot_engine::is_blank_member_key(key) && pivot_engine::is_blank_member_key(h))
    })
}

/// The member a header (or filter-item) view cell shows, or `None` when the
/// engine attached no source (data, total and value cells, and any header
/// whose text is not one member's own).
///
/// The KEY is the cell's value-as-text, which IS `member_key_of` of its last
/// `group_path` entry -- both come from `FieldCache::member_key`, and the
/// engine attaches a source only where the shown text is that member's own
/// header text -- EXCEPT for the blank member, whose header text reads
/// "(blank)" while its key is "" (ruling Q8). The source says which.
pub(crate) fn view_cell_member(cell: &pivot_engine::PivotViewCell, locale: &LocaleSettings) -> Option<MemberRef> {
    let source = cell.member_source.as_ref()?;
    let key = match source {
        MemberSource::Blank => pivot_engine::BLANK_MEMBER_KEY.to_string(),
        _ => match &cell.value {
            pivot_engine::PivotCellValue::Text(s) => s.clone(),
            pivot_engine::PivotCellValue::Number(n) => format!("{}", n),
            pivot_engine::PivotCellValue::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
            pivot_engine::PivotCellValue::Error(e) => format!("#{}", e),
            pivot_engine::PivotCellValue::Empty => String::new(),
        },
    };
    Some(MemberRef::from_source(key, source, locale))
}

// ============================================================================
// PARSING & STRING UTILS
// ============================================================================

/// Strips the sheet name prefix from a cell reference or range.
/// "Sheet1!A1" -> "A1", "A1" -> "A1", "'Sheet Name'!B2" -> "B2"
pub(crate) fn strip_sheet_prefix(reference: &str) -> &str {
    if let Some(pos) = reference.rfind('!') {
        &reference[pos + 1..]
    } else {
        reference
    }
}

/// Excel-compatible max row count (1-indexed).
const MAX_ROWS: u32 = 1_048_576;

/// Drops the absolute-reference markers of Excel's `$A$1` / `$A1` / `A$1`
/// forms: at most one `$` before the column letters and one before the row
/// digits. Any other `$` is left in place, so the parse below refuses it.
fn strip_absolute_markers(reference: &str) -> String {
    let rest = reference.strip_prefix('$').unwrap_or(reference);
    let letters = rest.chars().take_while(|c| c.is_ascii_alphabetic()).count();
    let (col, tail) = rest.split_at(letters);
    let tail = if letters > 0 { tail.strip_prefix('$').unwrap_or(tail) } else { tail };
    format!("{}{}", col, tail)
}

/// Parses a cell reference like "A1" into (row, col) 0-indexed coordinates.
/// Also handles references with sheet prefixes like "Sheet1!A1", and the
/// absolute forms "$A$1", "$A1" and "A$1" -- what Excel writes for a picked
/// range. Without them `Sheet2!$A$1:$D$9` was refused ("no column letters")
/// at every pivot door but the canvas dialog, which strips `$` itself.
pub(crate) fn parse_cell_ref(cell_ref: &str) -> Result<(u32, u32), String> {
    // Strip any sheet prefix first
    let cell_ref = strip_sheet_prefix(cell_ref);
    let cell_ref = strip_absolute_markers(&cell_ref.trim().to_uppercase());

    let col_end = cell_ref
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .count();

    if col_end == 0 {
        return Err(format!("Invalid cell reference: no column letters in '{}'", cell_ref));
    }

    let col_str = &cell_ref[..col_end];
    let row_str = &cell_ref[col_end..];

    if row_str.is_empty() {
        return Err(format!("Invalid cell reference: no row number in '{}'", cell_ref));
    }

    let row: u32 = row_str
        .parse()
        .map_err(|_| format!("Invalid row number in '{}'", cell_ref))?;

    if row == 0 {
        return Err("Row number must be >= 1".to_string());
    }

    let col = col_letter_to_index(col_str);

    Ok((row - 1, col)) // Convert to 0-indexed
}

/// Tries to parse a column-only reference like "A" (or absolute "$A") into a
/// 0-indexed column index. Returns None if the string contains other
/// non-alphabetic characters.
fn try_parse_col_only(s: &str) -> Option<u32> {
    let s = s.trim();
    let s = s.strip_prefix('$').unwrap_or(s);
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    Some(col_letter_to_index(&s.to_uppercase()))
}

/// Parses a range like "A1:D10", "Sheet1!A1:D10", or column-only "A:D"
/// into ((start_row, start_col), (end_row, end_col)).
/// Column-only references expand to the full row range (0 to MAX_ROWS-1).
pub(crate) fn parse_range(range: &str) -> Result<((u32, u32), (u32, u32)), String> {
    // Strip any sheet prefix from the entire range first
    let range = strip_sheet_prefix(range);

    let parts: Vec<&str> = range.split(':').collect();

    if parts.len() != 2 {
        return Err(format!("Invalid range format: '{}'. Expected 'A1:B2' or 'A:D'", range));
    }

    // Check if both parts are column-only references (e.g. "A:D")
    if let (Some(start_col), Some(end_col)) = (try_parse_col_only(parts[0]), try_parse_col_only(parts[1])) {
        let min_col = start_col.min(end_col);
        let max_col = start_col.max(end_col);
        return Ok(((0, min_col), (MAX_ROWS - 1, max_col)));
    }

    let start = parse_cell_ref(parts[0])?;
    let end = parse_cell_ref(parts[1])?;

    // Normalize so start <= end
    let start_row = start.0.min(end.0);
    let end_row = start.0.max(end.0);
    let start_col = start.1.min(end.1);
    let end_col = start.1.max(end.1);

    Ok(((start_row, start_col), (end_row, end_col)))
}

/// Converts column letters to 0-indexed column number
pub(crate) fn col_letter_to_index(col: &str) -> u32 {
    let mut result: u32 = 0;
    for c in col.chars() {
        let val = (c.to_ascii_uppercase() as u32) - ('A' as u32) + 1;
        result = result * 26 + val;
    }
    result.saturating_sub(1)
}

/// Converts 0-indexed column to letters
pub(crate) fn col_index_to_letter(col: u32) -> String {
    let mut result = String::new();
    let mut n = col + 1;
    while n > 0 {
        let rem = ((n - 1) % 26) as u8;
        result.insert(0, (b'A' + rem) as char);
        n = (n - 1) / 26;
    }
    result
}

// ============================================================================
// COLLAPSE STATE PRESERVATION
// ============================================================================

/// The field `new_field` WAS before a rebuild: the old field of the same NAME
/// and the same KIND. The synthetic values-only "Total" row
/// (`PivotField::is_synthetic_total`, [`synthetic_total_row_field`]) is never
/// the namesake of a calculation group called "Total", nor the reverse (review
/// RB3): matched by name alone, a group dragged onto a measure-only pivot took
/// the synthetic row's Ascending sort over its own declaration order, and kept
/// it on every later edit as if the user had chosen it.
///
/// THE one matcher [`preserve_collapse_state`] and [`preserve_field_settings`]
/// both ask, so the two cannot drift apart on what "the same field" means --
/// that drift between two readers of one fact is the RB3 failure itself. A
/// field saved before the marker reads `false`, so such a file's synthetic row
/// counts as an ordinary field named "Total": a calculation group of that name
/// placed over it still inherits from it (the RB3 blind spot, kept only for a
/// file saved before the marker), and the marked row a rebuild places does not.
fn previous_namesake<'a>(old_fields: &'a [PivotField], new_field: &PivotField) -> Option<&'a PivotField> {
    old_fields
        .iter()
        .find(|o| o.name == new_field.name && o.is_synthetic_total == new_field.is_synthetic_total)
}

/// Carry over collapse state (collapsed flag + per-item collapsed_items) from
/// old fields to new fields that match by name and kind
/// ([`previous_namesake`]). Fields that were removed or added keep the default
/// (expanded) state.
pub(crate) fn preserve_collapse_state(new_fields: &mut [PivotField], old_fields: &[PivotField]) {
    for new_field in new_fields.iter_mut() {
        if let Some(old) = previous_namesake(old_fields, new_field) {
            new_field.collapsed = old.collapsed;
            new_field.collapsed_items = old.collapsed_items.clone();
        }
    }
}

/// Carry each field's own SETTINGS -- sort order (by label or by value),
/// subtotals, show-all-items and grouping -- from the field of the same NAME and kind
/// ([`previous_namesake`]) the pivot held before a rebuild, found in ANY zone
/// (a field dragged from Rows to Columns is still the same field and keeps its
/// settings, as in Excel).
///
/// A BI pivot's field-list edit rebuilds every field from `PivotField::new`
/// over the NEW cache, whose column indices change -- so a sort, a grouping or
/// a subtotal setting the user applied was reset by the next edit of the
/// layout (wave B, A3: the BUG-0184 class on BI pivots). What the request
/// itself carries (hidden items, lookup-ness, the sort-by column, the model's
/// number format) and the collapse state ([`preserve_collapse_state`]) are
/// left alone.
pub(crate) fn preserve_field_settings(new_fields: &mut [PivotField], old_fields: &[PivotField]) {
    for new_field in new_fields.iter_mut() {
        if let Some(old) = previous_namesake(old_fields, new_field) {
            new_field.sort_order = old.sort_order;
            new_field.value_sort = old.value_sort.clone();
            new_field.show_subtotals = old.show_subtotals;
            new_field.show_all_items = old.show_all_items;
            new_field.grouping = old.grouping.clone();
        }
    }
}

// ============================================================================
// CONFIG CONVERTERS
// ============================================================================

/// The zone a field config is sent to.
#[derive(Clone, Copy)]
enum FieldZone {
    Rows,
    Columns,
    Filters,
}

/// Apply an `update_pivot_fields` request's row, column and filter zones to
/// `definition`. A zone the request leaves out is kept as it is; a zone it
/// sends is REPLACED by the fields it lists, in their order.
///
/// Each listed field starts from what the pivot holds for that field NOW --
/// found by its source column, in the zone it is sent to first and then in the
/// others (a field dragged from Rows to Columns is still the same field, and
/// keeps its settings, as in Excel) -- and only the settings the config SENDS
/// change it ([`merge_pivot_field_config`]). This rebuilt every field it was
/// sent from `PivotField::new` (BUG-0184): any field-list edit on a range
/// pivot reset the sort order, grouping, subtotals and show-all-items of every
/// field it listed, and read an absent hidden-items list as "hide nothing", so
/// a filter set elsewhere within one round trip of a field-list edit was
/// reverted.
pub(crate) fn apply_zone_field_configs(
    definition: &mut pivot_engine::PivotDefinition,
    request: &crate::pivot::types::UpdatePivotFieldsRequest,
) {
    let old_rows = definition.row_fields.clone();
    let old_columns = definition.column_fields.clone();
    let old_filters = definition.filter_fields.clone();
    let existing = |zone: FieldZone, source_index: usize| -> Option<&PivotField> {
        let in_rows = || old_rows.iter().find(|f| f.source_index == source_index);
        let in_columns = || old_columns.iter().find(|f| f.source_index == source_index);
        let in_filters = || old_filters.iter().map(|pf| &pf.field).find(|f| f.source_index == source_index);
        match zone {
            FieldZone::Rows => in_rows().or_else(in_columns).or_else(in_filters),
            FieldZone::Columns => in_columns().or_else(in_rows).or_else(in_filters),
            FieldZone::Filters => in_filters().or_else(in_rows).or_else(in_columns),
        }
    };

    if let Some(ref row_configs) = request.row_fields {
        definition.row_fields = row_configs
            .iter()
            .map(|c| merge_pivot_field_config(c, existing(FieldZone::Rows, c.source_index)))
            .collect();
    }
    if let Some(ref col_configs) = request.column_fields {
        definition.column_fields = col_configs
            .iter()
            .map(|c| merge_pivot_field_config(c, existing(FieldZone::Columns, c.source_index)))
            .collect();
    }
    if let Some(ref filter_configs) = request.filter_fields {
        definition.filter_fields = filter_configs
            .iter()
            .map(|c| {
                // A report filter that stays one keeps its condition too.
                let condition = old_filters
                    .iter()
                    .find(|pf| pf.field.source_index == c.source_index)
                    .map(|pf| pf.condition.clone())
                    .unwrap_or_else(|| FilterCondition::ValueList(Vec::new()));
                PivotFilter {
                    field: merge_pivot_field_config(c, existing(FieldZone::Filters, c.source_index)),
                    condition,
                }
            })
            .collect();
    }
}

/// The engine field for `config`: `existing` (what the pivot holds for this
/// source column now) with only the settings the config SENDS applied, or a
/// fresh field when the column is new to the pivot. Every setting is
/// tri-state on the wire -- absent keeps, a value sets -- and so is the item
/// filter, exactly like `BiFieldRef::hidden_items`: absent keeps, a list sets,
/// `[]` clears. The name is always the config's (the Field Settings dialog
/// renames a field through it).
///
/// Collapse state belongs to the expand/collapse commands: a field already in
/// the pivot keeps its own whatever the config says (callers such as the
/// script API's `createFieldConfig` send `collapsed: false` by default), as it
/// always did; a new field takes the config's.
pub(crate) fn merge_pivot_field_config(config: &PivotFieldConfig, existing: Option<&PivotField>) -> PivotField {
    let mut field = match existing {
        Some(old) => {
            let mut field = old.clone();
            field.source_index = config.source_index;
            field.name = config.name.clone();
            field
        }
        None => {
            let mut field = PivotField::new(config.source_index, config.name.clone());
            if let Some(collapsed) = config.collapsed {
                field.collapsed = collapsed;
            }
            if let Some(ref collapsed_items) = config.collapsed_items {
                field.collapsed_items = collapsed_items.clone();
            }
            field
        }
    };

    if let Some(ref sort) = config.sort_order {
        field.sort_order = match sort.to_lowercase().as_str() {
            "desc" | "descending" => SortOrder::Descending,
            "manual" => SortOrder::Manual,
            "source" | "datasource" => SortOrder::DataSourceOrder,
            _ => SortOrder::Ascending,
        };
    }
    if let Some(subtotals) = config.show_subtotals {
        field.show_subtotals = subtotals;
    }
    if let Some(ref hidden) = config.hidden_items {
        field.hidden_items = hidden.clone();
    }
    if let Some(show_all) = config.show_all_items {
        field.show_all_items = show_all;
    }
    if let Some(ref grouping_config) = config.grouping {
        field.grouping = api_grouping_config_to_engine(grouping_config);
    }

    field
}

/// Converts ValueFieldConfig to engine ValueField
pub(crate) fn config_to_value_field(config: &ValueFieldConfig) -> ValueField {
    let aggregation = match config.aggregation.to_lowercase().as_str() {
        "count" => AggregationType::Count,
        "average" | "avg" => AggregationType::Average,
        "min" => AggregationType::Min,
        "max" => AggregationType::Max,
        "countnumbers" | "count_numbers" => AggregationType::CountNumbers,
        "stddev" | "stdev" => AggregationType::StdDev,
        "stddevp" | "stdevp" => AggregationType::StdDevP,
        "var" => AggregationType::Var,
        "varp" => AggregationType::VarP,
        "product" => AggregationType::Product,
        _ => AggregationType::Sum,
    };
    
    let mut field = ValueField::new(config.source_index, config.name.clone(), aggregation);
    field.number_format = config.number_format.clone();
    field.custom_name = config.custom_name.clone();
    
    if let Some(ref show_as) = config.show_values_as {
        field.show_values_as = match show_as.to_lowercase().as_str() {
            "percent_of_total" | "percentoftotal" => ShowValuesAs::PercentOfGrandTotal,
            "percent_of_row" | "percentofrow" => ShowValuesAs::PercentOfRowTotal,
            "percent_of_column" | "percentofcolumn" => ShowValuesAs::PercentOfColumnTotal,
            "percent_of_parent_row" => ShowValuesAs::PercentOfParentRow,
            "percent_of_parent_column" => ShowValuesAs::PercentOfParentColumn,
            "difference" => ShowValuesAs::Difference,
            "percent_difference" => ShowValuesAs::PercentDifference,
            "running_total" => ShowValuesAs::RunningTotal,
            "percent_of_running_total" => ShowValuesAs::PercentOfRunningTotal,
            "rank_ascending" | "rank_asc" => ShowValuesAs::RankAscending,
            "rank_descending" | "rank_desc" => ShowValuesAs::RankDescending,
            "index" => ShowValuesAs::Index,
            _ => ShowValuesAs::Normal,
        };
    }

    // Handle ShowAsRule (from Excel-compatible API) which includes base_field/base_item
    if let Some(ref rule) = config.show_as {
        field.show_values_as = match rule.calculation {
            crate::pivot::types::ShowAsCalculation::None => ShowValuesAs::Normal,
            crate::pivot::types::ShowAsCalculation::PercentOfGrandTotal => ShowValuesAs::PercentOfGrandTotal,
            crate::pivot::types::ShowAsCalculation::PercentOfRowTotal => ShowValuesAs::PercentOfRowTotal,
            crate::pivot::types::ShowAsCalculation::PercentOfColumnTotal => ShowValuesAs::PercentOfColumnTotal,
            crate::pivot::types::ShowAsCalculation::PercentOfParentRowTotal => ShowValuesAs::PercentOfParentRow,
            crate::pivot::types::ShowAsCalculation::PercentOfParentColumnTotal => ShowValuesAs::PercentOfParentColumn,
            crate::pivot::types::ShowAsCalculation::DifferenceFrom => ShowValuesAs::Difference,
            crate::pivot::types::ShowAsCalculation::PercentDifferenceFrom => ShowValuesAs::PercentDifference,
            crate::pivot::types::ShowAsCalculation::RunningTotal => ShowValuesAs::RunningTotal,
            crate::pivot::types::ShowAsCalculation::PercentOfRunningTotal => ShowValuesAs::PercentOfRunningTotal,
            crate::pivot::types::ShowAsCalculation::RankAscending => ShowValuesAs::RankAscending,
            crate::pivot::types::ShowAsCalculation::RankDescending => ShowValuesAs::RankDescending,
            crate::pivot::types::ShowAsCalculation::Index => ShowValuesAs::Index,
        };
        field.base_item = rule.base_item.clone();
        // base_field is a name string - we need to resolve it to a FieldIndex
        // This is handled by the caller who has access to field definitions
    }

    field
}

/// Applies layout config to PivotLayout
pub(crate) fn apply_layout_config(layout: &mut PivotLayout, config: &LayoutConfig) {
    if let Some(v) = config.show_row_grand_totals {
        layout.show_row_grand_totals = v;
    }
    if let Some(v) = config.show_column_grand_totals {
        layout.show_column_grand_totals = v;
    }
    if let Some(ref v) = config.report_layout {
        layout.report_layout = match v.to_lowercase().as_str() {
            "outline" => ReportLayout::Outline,
            "tabular" => ReportLayout::Tabular,
            _ => ReportLayout::Compact,
        };
    }
    if let Some(v) = config.repeat_row_labels {
        layout.repeat_row_labels = v;
    }
    if let Some(v) = config.show_empty_rows {
        layout.show_empty_rows = v;
    }
    if let Some(v) = config.show_empty_cols {
        layout.show_empty_cols = v;
    }
    if let Some(ref v) = config.values_position {
        layout.values_position = match v.to_lowercase().as_str() {
            "rows" => ValuesPosition::Rows,
            _ => ValuesPosition::Columns,
        };
    }
    if let Some(v) = config.auto_fit_column_widths {
        layout.auto_fit_column_widths = v;
    }
}

/// Converts API SubtotalLocationType to engine SubtotalLocation.
pub(crate) fn api_subtotal_location_to_engine(loc: &SubtotalLocationType) -> SubtotalLocation {
    match loc {
        SubtotalLocationType::AtTop => SubtotalLocation::AtTop,
        SubtotalLocationType::AtBottom => SubtotalLocation::AtBottom,
        SubtotalLocationType::Off => SubtotalLocation::Off,
    }
}

/// Converts engine SubtotalLocation to API SubtotalLocationType.
#[allow(dead_code)]
pub(crate) fn engine_subtotal_location_to_api(loc: SubtotalLocation) -> SubtotalLocationType {
    match loc {
        SubtotalLocation::AtTop => SubtotalLocationType::AtTop,
        SubtotalLocation::AtBottom | SubtotalLocation::Off => SubtotalLocationType::AtBottom,
    }
}

// ============================================================================
// REVERSE CONVERTERS (engine types to strings)
// ============================================================================

/// Converts AggregationType to string
pub(crate) fn aggregation_to_string(agg: AggregationType) -> String {
    match agg {
        AggregationType::Sum => "sum".to_string(),
        AggregationType::Count => "count".to_string(),
        AggregationType::Average => "average".to_string(),
        AggregationType::Min => "min".to_string(),
        AggregationType::Max => "max".to_string(),
        AggregationType::CountNumbers => "countnumbers".to_string(),
        AggregationType::StdDev => "stddev".to_string(),
        AggregationType::StdDevP => "stddevp".to_string(),
        AggregationType::Var => "var".to_string(),
        AggregationType::VarP => "varp".to_string(),
        AggregationType::Product => "product".to_string(),
    }
}

/// Converts ReportLayout to string
pub(crate) fn report_layout_to_string(layout: ReportLayout) -> String {
    match layout {
        ReportLayout::Compact => "compact".to_string(),
        ReportLayout::Outline => "outline".to_string(),
        ReportLayout::Tabular => "tabular".to_string(),
    }
}

/// Converts ValuesPosition to string
pub(crate) fn values_position_to_string(pos: ValuesPosition) -> String {
    match pos {
        ValuesPosition::Columns => "columns".to_string(),
        ValuesPosition::Rows => "rows".to_string(),
    }
}

/// Convert a CacheValue to a display string
pub(crate) fn cache_value_to_string(value: &CacheValue) -> String {
    match value {
        CacheValue::Empty => "(Blank)".to_string(),
        CacheValue::Number(n) => {
            let f = n.as_f64();
            if f.fract() == 0.0 {
                format!("{}", f as i64)
            } else {
                format!("{}", f)
            }
        }
        CacheValue::Text(s) => s.clone(),
        CacheValue::Boolean(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
        CacheValue::Error(e) => format!("#{}", e),
    }
}

/// Converts an API FieldGroupingConfig to the engine FieldGrouping type.
pub(crate) fn api_grouping_config_to_engine(config: &FieldGroupingConfig) -> FieldGrouping {
    match config {
        FieldGroupingConfig::None => FieldGrouping::None,
        FieldGroupingConfig::DateGrouping { levels } => {
            let engine_levels: Vec<DateGroupLevel> = levels
                .iter()
                .filter_map(|s| match s.to_lowercase().as_str() {
                    "year" => Some(DateGroupLevel::Year),
                    "quarter" => Some(DateGroupLevel::Quarter),
                    "month" => Some(DateGroupLevel::Month),
                    "week" => Some(DateGroupLevel::Week),
                    "day" => Some(DateGroupLevel::Day),
                    _ => None,
                })
                .collect();
            FieldGrouping::DateGrouping { levels: engine_levels }
        }
        FieldGroupingConfig::NumberBinning { start, end, interval } => {
            FieldGrouping::NumberBinning {
                start: *start,
                end: *end,
                interval: *interval,
            }
        }
        FieldGroupingConfig::ManualGrouping { groups, ungrouped_name } => {
            let engine_groups: Vec<ManualGroup> = groups
                .iter()
                .map(|g| ManualGroup {
                    name: g.name.clone(),
                    members: g.members.clone(),
                })
                .collect();
            FieldGrouping::ManualGrouping {
                groups: engine_groups,
                ungrouped_name: ungrouped_name
                    .clone()
                    .unwrap_or_else(|| "Other".to_string()),
            }
        }
    }
}

/// Converts engine PivotView to response format, including filter row data with unique values
/// Maximum number of rows before auto-windowing kicks in.
const WINDOW_THRESHOLD: usize = 500;
/// Number of rows in the initial cell window for large pivots.
const INITIAL_WINDOW_SIZE: usize = 200;

///
/// `locale` is the app locale the DISPLAY text is written in (formatted
/// values, member labels, width samples); it is a parameter, never a global,
/// so the caller clones `state.locale` at its top and tests pass their own.
pub(crate) fn view_to_response(
    view: &PivotView,
    definition: &PivotDefinition,
    cache: &mut PivotCache,
    locale: &LocaleSettings,
) -> PivotViewResponse {
    // Filter to only visible rows (fast-path toggle keeps hidden rows in the view
    // for re-expansion, but the frontend should only receive visible rows).
    let visible_indices: Vec<usize> = view.rows.iter().enumerate()
        .filter(|(_, r)| r.visible)
        .map(|(i, _)| i)
        .collect();
    let total_rows = visible_indices.len();
    let use_windowing = total_rows > WINDOW_THRESHOLD;
    let window_end = if use_windowing { INITIAL_WINDOW_SIZE.min(total_rows) } else { total_rows };

    // What a cell's `value_field_index` points into, set on BOTH response
    // literals below (the windowed one and the ordinary one).
    let value_field_names: Vec<String> = definition.value_fields.iter().map(|v| v.name.clone()).collect();

    // Helper: convert engine cells to response cells
    let convert_cells = |cells: &[pivot_engine::PivotViewCell]| -> Vec<PivotCellData> {
        cells.iter().map(|c| pivot_cell_to_data(c, locale)).collect()
    };

    // Only build full PivotRowData (with cells) for the window; rest get empty cells.
    // For windowed pivots this avoids cloning cell data for 98K+ rows when only ~200 are sent.
    // Only visible rows are included (invisible rows from fast-path toggle are excluded).
    let all_rows: Vec<PivotRowData> = visible_indices
        .iter()
        .enumerate()
        .map(|(visible_idx, &orig_idx)| {
            let descriptor = &view.rows[orig_idx];
            let cells = &view.cells[orig_idx];
            PivotRowData {
                view_row: descriptor.view_row,
                row_type: descriptor.row_type,
                depth: descriptor.depth,
                visible: true,
                cells: if visible_idx < window_end { convert_cells(cells) } else { Vec::new() },
            }
        })
        .collect();

    // Compute max_content_sample per column: the longest display string
    // (with indent padding) so the frontend can measure width from a single
    // string instead of scanning all cells.
    let num_cols = view.columns.len();
    let mut max_samples: Vec<String> = vec![String::new(); num_cols];
    let mut max_lengths: Vec<usize> = vec![0; num_cols];
    for row_cells in &view.cells {
        for (j, cell) in row_cells.iter().enumerate() {
            if j >= num_cols { break; }
            // A header measures the member LABEL it shows; a number with a
            // code measures its app-locale formatting.
            let display = if let Some(member) = view_cell_member(cell, locale) {
                member.label
            } else if let Some(ref fmt) = cell.number_format {
                if !fmt.is_empty() {
                    if let pivot_engine::PivotCellValue::Number(n) = &cell.value {
                        format_number(*n, &parse_number_format(fmt), locale)
                    } else {
                        cell.formatted_value.clone()
                    }
                } else {
                    cell.formatted_value.clone()
                }
            } else {
                cell.formatted_value.clone()
            };
            // Approximate effective length: indent adds 2 chars per level,
            // expandable icon adds 2 chars.
            let extra = (cell.indent_level as usize) * 2
                + if cell.is_expandable { 2 } else { 0 };
            let effective_len = display.len() + extra;
            if effective_len > max_lengths[j] {
                max_lengths[j] = effective_len;
                // Prepend spaces to represent indent + icon padding
                if extra > 0 {
                    let mut padded = " ".repeat(extra);
                    padded.push_str(&display);
                    max_samples[j] = padded;
                } else {
                    max_samples[j] = display;
                }
            }
        }
    }

    let columns: Vec<PivotColumnData> = view
        .columns
        .iter()
        .enumerate()
        .map(|(i, col)| PivotColumnData {
            view_col: col.view_col,
            col_type: col.col_type,
            depth: col.depth,
            width_hint: col.width_hint,
            max_content_sample: max_samples.get(i).cloned().unwrap_or_default(),
        })
        .collect();

    // Build filter rows with unique values from the cache
    let filter_rows: Vec<FilterRowData> = definition
        .filter_fields
        .iter()
        .enumerate()
        .map(|(idx, filter)| {
            let field_index = filter.field.source_index;
            let field_name = filter.field.name.clone();

            // The field's members from the cache -- and the BLANK member last
            // when the column has one (wave B, A2: Excel lists it, and without
            // it the filter cell could not show or hide blank rows). Key "",
            // label "(Blank)": NULL and "" are ONE member (ruling Q8).
            let members = field_members(cache, field_index, locale);

            // Selected KEYS (every member minus the hidden ones; the blank
            // member is hidden by either of its spellings).
            let hidden_items = &filter.field.hidden_items;
            let kept: Vec<&MemberRef> =
                members.iter().filter(|m| !hidden_names_member(hidden_items, &m.key)).collect();
            let selected_values: Vec<String> = kept.iter().map(|m| m.key.clone()).collect();

            // The filter cell's text: a single kept member shows its LABEL.
            let display_value = if hidden_items.is_empty() {
                "(All)".to_string()
            } else if kept.len() == 1 {
                kept[0].label.clone()
            } else if kept.is_empty() {
                "(None)".to_string()
            } else {
                "(Multiple Items)".to_string()
            };

            FilterRowData {
                field_index,
                field_name,
                selected_values,
                members,
                display_value,
                view_row: idx,
            }
        })
        .collect();

    // Build row/column field summaries for header filter dropdowns
    let row_field_summaries: Vec<HeaderFieldSummaryData> = view
        .row_field_summaries
        .iter()
        .map(|s| HeaderFieldSummaryData {
            field_index: s.field_index,
            field_name: s.field_name.clone(),
            has_active_filter: s.has_active_filter,
        })
        .collect();

    let column_field_summaries: Vec<HeaderFieldSummaryData> = view
        .column_field_summaries
        .iter()
        .map(|s| HeaderFieldSummaryData {
            field_index: s.field_index,
            field_name: s.field_name.clone(),
            has_active_filter: s.has_active_filter,
        })
        .collect();

    if use_windowing {
        // Large pivot: send row descriptors for ALL rows + cells for first window only.
        // Cell data beyond window_end is already empty (skipped during construction above).
        let row_descriptors: Vec<PivotRowDescriptorData> = all_rows
            .iter()
            .map(|r| PivotRowDescriptorData {
                view_row: r.view_row,
                row_type: r.row_type,
                depth: r.depth,
                visible: r.visible,
            })
            .collect();

        let windowed_rows: Vec<PivotRowData> = all_rows.into_iter().take(window_end).collect();

        PivotViewResponse {
            pivot_id: view.pivot_id,
            version: view.version,
            row_count: view.row_count,
            col_count: view.col_count,
            row_label_col_count: view.row_label_col_count,
            column_header_row_count: view.column_header_row_count,
            filter_row_count: view.filter_row_count,
            filter_rows,
            row_field_summaries,
            column_field_summaries,
            rows: windowed_rows,
            columns,
            is_windowed: true,
            total_row_count: Some(total_rows),
            window_start_row: Some(0),
            row_descriptors,
            overwritten_cell_count: 0,
            overwrite_token: None,
            // Filled after the fact by the producer that has something to say,
            // exactly as `overwritten_cell_count` is.
            notices: Vec::new(),
            value_field_names,
            group_members: Vec::new(),
        }
    } else {
        // Small pivot: send everything (no windowing)
        PivotViewResponse {
            pivot_id: view.pivot_id,
            version: view.version,
            row_count: view.row_count,
            col_count: view.col_count,
            row_label_col_count: view.row_label_col_count,
            column_header_row_count: view.column_header_row_count,
            filter_row_count: view.filter_row_count,
            filter_rows,
            row_field_summaries,
            column_field_summaries,
            rows: all_rows,
            columns,
            is_windowed: false,
            total_row_count: None,
            window_start_row: None,
            row_descriptors: Vec::new(),
            overwritten_cell_count: 0,
            overwrite_token: None,
            notices: Vec::new(),
            value_field_names,
            group_members: Vec::new(),
        }
    }
}

/// THE conversion of one engine view cell into the wire's `PivotCellData`.
/// Every producer of response cells -- the full view (`view_to_response`) and
/// the scroll-triggered window (`extract_cell_window`) -- goes through this
/// one function; they were two hand-copied closures, and a field added to one
/// would have reached the frontend on small pivots only, or past row 200 only.
///
/// `locale` writes the DISPLAY text: `formatted_value` and the member label.
/// `member` is set exactly where the engine attached a locale-free
/// `member_source` (headers and filter items), never on data cells.
pub(crate) fn pivot_cell_to_data(cell: &pivot_engine::PivotViewCell, locale: &LocaleSettings) -> PivotCellData {
    PivotCellData {
        cell_type: cell.cell_type,
        value: match &cell.value {
            pivot_engine::PivotCellValue::Empty => PivotCellValueData::Empty,
            // A non-finite number (a measure's 1/0, -1/0, 0/0) is #NUM!, as
            // Excel's data-model PivotTable shows it [LIVE]; `non_finite`
            // below says which. (JSON would carry it as `null`: empty.)
            pivot_engine::PivotCellValue::Number(n) if !n.is_finite() => {
                PivotCellValueData::Text("#NUM!".to_string())
            }
            pivot_engine::PivotCellValue::Number(n) => PivotCellValueData::Number(*n),
            pivot_engine::PivotCellValue::Text(s) => PivotCellValueData::Text(s.clone()),
            pivot_engine::PivotCellValue::Boolean(b) => PivotCellValueData::Boolean(*b),
            // The error's Excel literal, the text the grid cell displays
            // (`pivot_error_value`): a source error's variant name ("Div0")
            // showed as "#Div0".
            pivot_engine::PivotCellValue::Error(e) => {
                PivotCellValueData::Text(pivot_error_value(e).as_literal().to_string())
            }
        },
        formatted_value: match (&cell.value, &cell.number_format) {
            (pivot_engine::PivotCellValue::Number(n), Some(fmt)) if !fmt.is_empty() && n.is_finite() => {
                format_number(*n, &parse_number_format(fmt), locale)
            }
            _ => String::new(),
        },
        non_finite: match &cell.value {
            pivot_engine::PivotCellValue::Number(n) => crate::pivot::types::NonFiniteNumber::of(*n),
            _ => None,
        },
        indent_level: cell.indent_level,
        is_bold: cell.is_bold,
        is_expandable: cell.is_expandable,
        is_collapsed: cell.is_collapsed,
        background_style: cell.background_style,
        number_format: cell.number_format.clone(),
        filter_field_index: cell.filter_field_index,
        col_span: cell.col_span,
        group_path: match cell.cell_type {
            pivot_engine::PivotCellType::RowHeader
            | pivot_engine::PivotCellType::ColumnHeader
            | pivot_engine::PivotCellType::RowSubtotal
            | pivot_engine::PivotCellType::ColumnSubtotal
            | pivot_engine::PivotCellType::GrandTotalRow
            | pivot_engine::PivotCellType::GrandTotalColumn
            | pivot_engine::PivotCellType::GrandTotal
            // Data cells need their path too: double-click drill-through
            // filters by it, and an omitted path drills the whole table.
            | pivot_engine::PivotCellType::Data => cell
                .group_path
                .iter()
                .map(|(fi, vid)| (*fi, *vid))
                .collect(),
            _ => Vec::new(),
        },
        value_field_index: cell.value_field_index,
        member: view_cell_member(cell, locale),
    }
}

/// Extract a cell window from a stored PivotView for scroll-triggered fetching.
/// `locale`: as [`view_to_response`] (the stored view is locale-free).
pub(crate) fn extract_cell_window(
    view: &PivotView,
    start_row: usize,
    row_count: usize,
    locale: &LocaleSettings,
) -> Vec<PivotRowData> {
    let end_row = (start_row + row_count).min(view.rows.len());
    view.cells[start_row..end_row]
        .iter()
        .zip(view.rows[start_row..end_row].iter())
        .map(|(cells, descriptor)| {
            let cell_data: Vec<PivotCellData> = cells.iter().map(|c| pivot_cell_to_data(c, locale)).collect();

            PivotRowData {
                view_row: descriptor.view_row,
                row_type: descriptor.row_type,
                depth: descriptor.depth,
                visible: descriptor.visible,
                cells: cell_data,
            }
        })
        .collect()
}

/// Returns true if the BI update request differs from the current definition
/// only in cosmetic ways (custom_name on value fields, layout) — meaning the
/// underlying BI query doesn't need to be re-executed.
pub(crate) fn is_bi_cosmetic_only_change(
    definition: &PivotDefinition,
    request: &UpdateBiPivotFieldsRequest,
) -> bool {
    // Row fields must match
    if definition.row_fields.len() != request.row_fields.len() {
        return false;
    }
    for (def_f, req_f) in definition.row_fields.iter().zip(request.row_fields.iter()) {
        let expected_name = format!("{}.{}", req_f.table, req_f.column);
        if def_f.name != expected_name || def_f.is_attribute != req_f.is_lookup {
            return false;
        }
    }

    // Column fields must match
    if definition.column_fields.len() != request.column_fields.len() {
        return false;
    }
    for (def_f, req_f) in definition.column_fields.iter().zip(request.column_fields.iter()) {
        let expected_name = format!("{}.{}", req_f.table, req_f.column);
        if def_f.name != expected_name || def_f.is_attribute != req_f.is_lookup {
            return false;
        }
    }

    // Value fields: same measures (ignoring custom_name)
    if definition.value_fields.len() != request.value_fields.len() {
        return false;
    }
    for (def_vf, req_vf) in definition.value_fields.iter().zip(request.value_fields.iter()) {
        let expected_name = format!("[{}]", req_vf.measure_name);
        if def_vf.name != expected_name {
            return false;
        }
    }

    // Filter fields must match
    if definition.filter_fields.len() != request.filter_fields.len() {
        return false;
    }
    for (def_f, req_f) in definition.filter_fields.iter().zip(request.filter_fields.iter()) {
        let expected_name = format!("{}.{}", req_f.table, req_f.column);
        if def_f.field.name != expected_name {
            return false;
        }
    }

    // Calculated fields must not have changed
    if request.calculated_fields.is_some() {
        let req_calcs = request.calculated_fields.as_ref().unwrap();
        if req_calcs.len() != definition.calculated_fields.len() {
            return false;
        }
        for (dc, rc) in definition.calculated_fields.iter().zip(req_calcs.iter()) {
            if dc.name != rc.name || dc.formula != rc.formula {
                return false;
            }
        }
    }

    // Value column order must not have changed
    if request.value_column_order.is_some() {
        let req_order = request.value_column_order.as_ref().unwrap();
        if req_order.len() != definition.value_column_order.len() {
            return false;
        }
        for (d, r) in definition.value_column_order.iter().zip(req_order.iter()) {
            let matches = match (d, r) {
                (pivot_engine::ValueColumnRef::Value(a), ValueColumnRefDef::Value { index }) => *a == *index,
                (pivot_engine::ValueColumnRef::Calculated(a), ValueColumnRefDef::Calculated { index }) => *a == *index,
                _ => false,
            };
            if !matches {
                return false;
            }
        }
    }

    // Hidden items travel in the request on every zone now: a request whose
    // only change is a zone field's hidden-item subset is a FILTER change, and
    // the cosmetic path (which only renames and re-lays out) would drop it.
    // ABSENT means "keep"; a sent list -- an EMPTY one is an explicit clear --
    // counts whenever it differs from what the field hides now.
    let hidden_changed = |def_f: &pivot_engine::PivotField, req_f: &BiFieldRef| match &req_f.hidden_items {
        Some(hidden) => &def_f.hidden_items != hidden,
        None => false,
    };
    if definition.row_fields.iter().zip(request.row_fields.iter()).any(|(d, r)| hidden_changed(d, r))
        || definition.column_fields.iter().zip(request.column_fields.iter()).any(|(d, r)| hidden_changed(d, r))
        || definition.filter_fields.iter().zip(request.filter_fields.iter()).any(|(d, r)| hidden_changed(&d.field, r))
    {
        return false;
    }

    // Slicer fields: an explicit non-empty list asks to add/update slicer
    // GROUP BY columns, and an explicit EMPTY list clears the pivot's slicer
    // filters -- both need a full BI query unless there is nothing to clear.
    // `None` keeps what the pivot carries, which a cosmetic change does.
    match &request.slicer_fields {
        Some(list) if !list.is_empty() => return false,
        Some(_) if !definition.slicer_filters.is_empty() => return false,
        _ => {}
    }

    // Hierarchy fields: if the request has hierarchies but the definition doesn't
    // (or vice versa), it's a structural change requiring a full BI query.
    let req_row_h_count = request.row_hierarchies.len();
    let req_col_h_count = request.column_hierarchies.len();
    let def_row_h_count = definition.hierarchy_configs.iter().filter(|h| h.is_row).count();
    let def_col_h_count = definition.hierarchy_configs.iter().filter(|h| !h.is_row).count();
    if req_row_h_count != def_row_h_count || req_col_h_count != def_col_h_count {
        return false;
    }

    true
}

#[cfg(test)]
mod non_finite_cell_tests {
    use super::*;
    use crate::pivot::types::NonFiniteNumber;

    /// NEW-bi-nonfinite-cells: a model measure's 1/0, -1/0 and 0/0 reach a
    /// BI pivot's view as non-finite numbers, which JSON writes as `null` --
    /// the pivot showed an EMPTY cell. [LIVE] Excel 16's data-model
    /// PivotTable shows #NUM! for each; the canvas visuals need to know which
    /// one to write Power BI's word for it.
    #[test]
    fn a_non_finite_value_cell_is_num_on_the_wire_and_says_which() {
        let locale = LocaleSettings::invariant();
        for (n, kind) in [
            (f64::INFINITY, NonFiniteNumber::Infinity),
            (f64::NEG_INFINITY, NonFiniteNumber::NegativeInfinity),
            (f64::NAN, NonFiniteNumber::Nan),
        ] {
            let mut cell = pivot_engine::PivotViewCell::data(n);
            cell.number_format = Some("#,##0.00".to_string());
            let data = pivot_cell_to_data(&cell, &locale);
            let json = serde_json::to_value(&data).unwrap();
            assert_eq!(json["value"], serde_json::json!("#NUM!"), "{n}");
            assert_eq!(data.non_finite, Some(kind), "{n}");
            assert!(json.get("formattedValue").is_none(), "{n}: no formatted text for #NUM!");
        }
        let data = pivot_cell_to_data(&pivot_engine::PivotViewCell::data(2.5), &locale);
        let json = serde_json::to_value(&data).unwrap();
        assert_eq!(json["value"], serde_json::json!(2.5));
        assert!(json.get("nonFinite").is_none(), "a finite cell carries no marker");
        let json = serde_json::to_value(&pivot_cell_to_data(&pivot_engine::PivotViewCell::data(f64::NEG_INFINITY), &locale)).unwrap();
        assert_eq!(json["nonFinite"], serde_json::json!("negativeInfinity"), "camelCase on the wire");
    }
}

#[cfg(test)]
mod synthetic_total_row_tests {
    //! THE one test of what the synthetic values-only "Total" row is
    //! ([`is_synthetic_total_row`]): the drill-through's group-path loop skips
    //! it (a measure-only pivot must drill), `bi_request_from_definition` leaves
    //! it out of a refresh -- and neither may drop a calculation group that
    //! happens to be called "Total".
    use super::*;

    /// A model snapshot with these calculation groups and these tables
    /// (name, columns). Built through serde so a field the types gain later
    /// (with a default) does not break the fixture.
    fn meta(calc_groups: &[&str], tables: &[(&str, &[&str])]) -> BiPivotMetadata {
        BiPivotMetadata {
            connection_id: identity::EntityId::ZERO,
            data_source_id: None,
            model_tables: tables
                .iter()
                .map(|(name, columns)| {
                    serde_json::from_value(serde_json::json!({
                        "name": name,
                        "columns": columns
                            .iter()
                            .map(|c| serde_json::json!({ "name": c, "dataType": "string", "isNumeric": false }))
                            .collect::<Vec<_>>(),
                    }))
                    .expect("fixture: a model table")
                })
                .collect(),
            measures: vec![],
            hierarchies: vec![],
            calculation_groups: calc_groups
                .iter()
                .map(|g| serde_json::from_value(serde_json::json!({ "name": g, "items": [] })).expect("fixture: a group"))
                .collect(),
            data_as_of: None,
            last_query: None,
            lookup_columns: std::collections::HashSet::new(),
            drill_through: None,
            perspectives: vec![],
            selected_perspective: None,
            cultures: vec![],
        }
    }

    /// What `update_bi_pivot_fields` builds for VALUES only: the synthetic
    /// "Total" dimension as the one row field, at cache index 0, MARKED.
    fn values_only() -> PivotDefinition {
        let mut def = PivotDefinition::new(identity::EntityId::ZERO, (0, 0), (0, 0));
        def.row_fields.push(synthetic_total_row_field());
        def
    }

    /// The same pivot as a file saved before the marker holds it: an unmarked
    /// row field named "Total" -- also exactly what a calculation group named
    /// "Total", placed alone on rows, looks like.
    fn unmarked_total_row() -> PivotDefinition {
        let mut def = PivotDefinition::new(identity::EntityId::ZERO, (0, 0), (0, 0));
        def.row_fields.push(PivotField::new(0, "Total".to_string()));
        def
    }

    #[test]
    fn the_values_only_total_row_is_synthetic_and_no_other_index_is() {
        let def = values_only();
        let m = meta(&[], &[("Sales", &["Region", "Amount"])]);
        assert!(is_synthetic_total_row(&def, &m, 0), "the measure-only pivot's row is padding");
        assert!(!is_synthetic_total_row(&def, &m, 1), "no row field sits at index 1");
    }

    /// SABOTAGE: drop the calculation-group clause of the fallback -- a group
    /// named "Total" placed alone on rows (an UNMARKED field at index 0, also
    /// named "Total") reads as synthetic, and a drill on one of its items would
    /// silently widen.
    #[test]
    fn a_calculation_group_named_total_is_a_real_dimension() {
        assert!(!is_synthetic_total_row(&unmarked_total_row(), &meta(&["Total"], &[]), 0));
        // Another group's name changes nothing.
        assert!(is_synthetic_total_row(&unmarked_total_row(), &meta(&["Time Intelligence"], &[]), 0));
    }

    /// Review RB3: a model that merely HAS a calculation group named "Total"
    /// (not placed) made the name rule read a values-only pivot's synthetic row
    /// as that group -- the refresh asked for the group, the drill refused the
    /// coordinate, and the pane listed a Total chip that the next edit turned into
    /// the group. The MARKER decides.
    ///
    /// SABOTAGE: drop `f.is_synthetic_total ||` from the predicate -- the first
    /// assertion fails.
    #[test]
    fn the_marked_row_is_synthetic_even_when_the_model_has_a_group_named_total() {
        assert!(is_synthetic_total_row(&values_only(), &meta(&["Total"], &[]), 0));
        assert!(is_synthetic_total_row(&values_only(), &meta(&[], &[]), 0));
        // A file saved before the marker keeps the name rule, with its known
        // blind spot (the group of the same name wins).
        assert!(is_synthetic_total_row(&unmarked_total_row(), &meta(&[], &[]), 0));
        assert!(!is_synthetic_total_row(&unmarked_total_row(), &meta(&["Total"], &[]), 0));
    }

    /// The marker is written only when true and reads false when absent, so a
    /// definition saved before it parses unchanged and an ordinary field adds
    /// nothing to the file.
    #[test]
    fn the_marker_is_written_only_when_true_and_absent_reads_false() {
        let marked = serde_json::to_value(synthetic_total_row_field()).unwrap();
        assert_eq!(marked["is_synthetic_total"], serde_json::json!(true));
        let plain = serde_json::to_value(PivotField::new(3, "Region".to_string())).unwrap();
        assert!(plain.get("is_synthetic_total").is_none(), "an ordinary field writes no marker: {plain}");
        let mut old = marked.clone();
        old.as_object_mut().unwrap().remove("is_synthetic_total");
        let parsed: PivotField = serde_json::from_value(old).unwrap();
        assert!(!parsed.is_synthetic_total, "absent reads false");
    }

    /// Only a ROW field named exactly "Total" at that index is the synthetic
    /// row: a column or filter field of that name is not, a row field of
    /// another name is not, and an index a placed MODEL column holds never is.
    ///
    /// SABOTAGE: drop the `bi_placed_field_keys` clause -- the last assertion
    /// fails.
    #[test]
    fn only_a_row_field_named_total_that_is_no_model_column_counts() {
        let m = meta(&[], &[("Sales", &["Region", "Amount"])]);

        let mut on_columns = PivotDefinition::new(identity::EntityId::ZERO, (0, 0), (0, 0));
        on_columns.column_fields.push(PivotField::new(0, "Total".to_string()));
        assert!(!is_synthetic_total_row(&on_columns, &m, 0), "a COLUMN field named Total");

        let mut renamed = PivotDefinition::new(identity::EntityId::ZERO, (0, 0), (0, 0));
        renamed.row_fields.push(PivotField::new(0, "Totals".to_string()));
        assert!(!is_synthetic_total_row(&renamed, &m, 0), "another name");

        let mut model_column = values_only();
        model_column.column_fields.push(PivotField::new(0, "Sales.Region".to_string()));
        assert!(
            !is_synthetic_total_row(&model_column, &m, 0),
            "an index a placed model column names is a model coordinate, whatever else claims it"
        );
    }
}

#[cfg(test)]
mod previous_namesake_tests {
    //! What a BI pivot's rebuild carries from an old field to a new one
    //! ([`preserve_collapse_state`], [`preserve_field_settings`]): only from the
    //! field of the same name AND the same kind ([`previous_namesake`]), so the
    //! synthetic values-only "Total" row and a calculation group called "Total"
    //! never hand each other their settings (review RB3, round-3 finding F1).
    use super::*;

    /// A calculation group called "Total" placed on an axis, as
    /// `update_bi_pivot_fields_unrecorded` builds it (`make_calc_group_field`):
    /// an ordinary, UNMARKED field over the reshaped item column whose items
    /// show in DECLARATION order, as Power BI shows them.
    fn calc_group_named_total() -> PivotField {
        let mut field = PivotField::new(0, "Total".to_string());
        field.sort_order = SortOrder::DataSourceOrder;
        field
    }

    /// The scenario: a measure-only pivot's one row is the MARKED synthetic
    /// "Total", and the user drags a calculation group that is also called
    /// "Total" (items declared Actual, Prior Year, Growth) onto Rows. Matched by
    /// name alone, the group took the synthetic row's Ascending sort over its
    /// declaration order -- Actual, Growth, Prior Year -- and every later edit
    /// kept that as if it were the user's own setting. Nothing of the synthetic
    /// row may carry over: no setting and no collapse state.
    ///
    /// SABOTAGE: match by name alone in `previous_namesake` (drop its
    /// `is_synthetic_total` clause) -- the sort-order assertion fails.
    /// SABOTAGE: let `preserve_collapse_state` find by name alone again (the two
    /// helpers drift apart) -- the collapse assertion fails.
    #[test]
    fn a_calculation_group_named_total_never_inherits_the_synthetic_rows_settings() {
        let mut synthetic = synthetic_total_row_field();
        synthetic.collapsed = true;
        synthetic.collapsed_items = vec!["Total".to_string()];
        let old = vec![synthetic];

        let mut placed = vec![calc_group_named_total()];
        placed[0].show_all_items = true;
        placed[0].show_subtotals = false;
        preserve_collapse_state(&mut placed, &old);
        preserve_field_settings(&mut placed, &old);

        let group = &placed[0];
        assert_eq!(
            group.sort_order,
            SortOrder::DataSourceOrder,
            "the group took the synthetic row's sort: its items no longer show in declaration order"
        );
        assert!(
            group.show_all_items && !group.show_subtotals,
            "another setting of the synthetic row carried over to the group"
        );
        assert!(
            !group.collapsed && group.collapsed_items.is_empty(),
            "the synthetic row's collapse state carried over to the group"
        );
        assert!(!group.is_synthetic_total, "the group must stay a real dimension");
    }

    /// The reverse: a pivot that showed a calculation group called "Total" (the
    /// user sorted it Descending, turned its subtotals off and collapsed an item)
    /// loses its last dimension, so the rebuild places the synthetic row. That is
    /// a different field that happens to share the name, and it keeps its own
    /// defaults.
    ///
    /// SABOTAGE: match by name alone in `previous_namesake` -- the sort-order
    /// assertion fails.
    #[test]
    fn the_synthetic_row_never_inherits_a_calculation_group_named_total() {
        let mut group = calc_group_named_total();
        group.sort_order = SortOrder::Descending;
        group.show_subtotals = false;
        group.collapsed_items = vec!["Actual".to_string()];
        let old = vec![group];

        let mut placed = vec![synthetic_total_row_field()];
        preserve_collapse_state(&mut placed, &old);
        preserve_field_settings(&mut placed, &old);

        let row = &placed[0];
        assert_eq!(row.sort_order, SortOrder::Ascending, "the synthetic row took the group's sort");
        assert!(row.show_subtotals, "the synthetic row took the group's subtotals setting");
        assert!(row.collapsed_items.is_empty(), "the synthetic row took the group's collapse state");
        assert!(row.is_synthetic_total, "the synthetic row must stay marked");
    }

    /// POSITIVE CONTROL: the kind check stops only the mix-up, never a field's
    /// own settings. A calculation group called "Total" keeps the sort and the
    /// collapse state the user gave it through a rebuild -- also when the old
    /// fields hold the synthetic row FIRST under the same name (the group sat in
    /// the filter area of a measure-only pivot, and rows are searched before
    /// filters, so a name-only match found the synthetic row) -- and the
    /// synthetic row keeps its own from one measure-only rebuild to the next.
    ///
    /// SABOTAGE: make `previous_namesake` match nothing -- the first assertion
    /// fails. (A name-only match fails it too: it finds the synthetic row.)
    #[test]
    fn a_field_still_keeps_its_own_settings_through_a_rebuild() {
        let mut sorted = calc_group_named_total();
        sorted.sort_order = SortOrder::Descending;
        sorted.collapsed_items = vec!["Actual".to_string()];
        let old = vec![synthetic_total_row_field(), sorted];

        let mut placed = vec![calc_group_named_total()];
        preserve_collapse_state(&mut placed, &old);
        preserve_field_settings(&mut placed, &old);
        assert_eq!(placed[0].sort_order, SortOrder::Descending, "the user's sort of the group was lost");
        assert_eq!(
            placed[0].collapsed_items,
            vec!["Actual".to_string()],
            "the group's collapse state was lost"
        );

        let mut old_row = synthetic_total_row_field();
        old_row.show_subtotals = false;
        old_row.collapsed = true;
        let mut placed = vec![synthetic_total_row_field()];
        preserve_collapse_state(&mut placed, std::slice::from_ref(&old_row));
        preserve_field_settings(&mut placed, std::slice::from_ref(&old_row));
        assert!(
            !placed[0].show_subtotals && placed[0].collapsed,
            "the synthetic row lost its own settings from one rebuild to the next"
        );
    }
}
