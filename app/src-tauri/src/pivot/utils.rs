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

/// Carry over collapse state (collapsed flag + per-item collapsed_items) from
/// old fields to new fields that match by name.  Fields that were removed or
/// added keep the default (expanded) state.
pub(crate) fn preserve_collapse_state(new_fields: &mut [PivotField], old_fields: &[PivotField]) {
    for new_field in new_fields.iter_mut() {
        if let Some(old) = old_fields.iter().find(|o| o.name == new_field.name) {
            new_field.collapsed = old.collapsed;
            new_field.collapsed_items = old.collapsed_items.clone();
        }
    }
}

/// Carry each field's own SETTINGS -- sort order, subtotals, show-all-items
/// and grouping -- from the field of the same NAME the pivot held before a
/// rebuild, found in ANY zone (a field dragged from Rows to Columns is still
/// the same field and keeps its settings, as in Excel).
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
        if let Some(old) = old_fields.iter().find(|o| o.name == new_field.name) {
            new_field.sort_order = old.sort_order;
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
            pivot_engine::PivotCellValue::Number(n) => PivotCellValueData::Number(*n),
            pivot_engine::PivotCellValue::Text(s) => PivotCellValueData::Text(s.clone()),
            pivot_engine::PivotCellValue::Boolean(b) => PivotCellValueData::Boolean(*b),
            pivot_engine::PivotCellValue::Error(e) => PivotCellValueData::Text(format!("#{}", e)),
        },
        formatted_value: match (&cell.value, &cell.number_format) {
            (pivot_engine::PivotCellValue::Number(n), Some(fmt)) if !fmt.is_empty() => {
                format_number(*n, &parse_number_format(fmt), locale)
            }
            _ => String::new(),
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