//! FILENAME: app/src-tauri/src/timeline_slicer/commands.rs
//! PURPOSE: Tauri commands for timeline slicer CRUD and data retrieval.
//! CONTEXT: Manages timeline slicer state, generates timeline periods from
//!          pivot field date values, and bridges selection to pivot filters.

use crate::pivot::PivotState;
use crate::timeline_slicer::types::*;
use pivot_engine::{PivotId, VALUE_ID_EMPTY};
use std::collections::HashSet;
use tauri::State;

use crate::log_debug;

// ============================================================================
// CRUD COMMANDS
// ============================================================================

/// Create a new timeline slicer.
#[tauri::command]
pub fn create_timeline_slicer(
    timeline_state: State<TimelineSlicerState>,
    params: CreateTimelineParams,
) -> Result<TimelineSlicer, String> {
    let mut next_id = timeline_state.next_id.lock().unwrap();
    let id = *next_id;
    *next_id += 1;

    let timeline = TimelineSlicer {
        id,
        name: params.name,
        header_text: None,
        sheet_index: params.sheet_index,
        x: params.x,
        y: params.y,
        width: params.width.unwrap_or(350.0),
        height: params.height.unwrap_or(100.0),
        source_type: TimelineSourceType::Pivot,
        source_id: params.source_id,
        field_name: params.field_name,
        level: params.level.unwrap_or_default(),
        selection_start: None,
        selection_end: None,
        show_header: true,
        show_level_selector: true,
        show_scrollbar: true,
        style_preset: params
            .style_preset
            .unwrap_or_else(|| "TimelineStyleLight1".to_string()),
        scroll_position: 0.0,
        connected_pivot_ids: vec![],
    };

    log_debug!(
        "TIMELINE",
        "create_timeline_slicer id={} name={} source=pivot:{}",
        id,
        timeline.name,
        timeline.source_id
    );

    let result = timeline.clone();
    timeline_state
        .timelines
        .lock()
        .unwrap()
        .insert(id, timeline);

    Ok(result)
}

/// Delete a timeline slicer.
#[tauri::command]
pub fn delete_timeline_slicer(
    timeline_state: State<TimelineSlicerState>,
    timeline_id: u64,
) -> Result<(), String> {
    log_debug!("TIMELINE", "delete_timeline_slicer id={}", timeline_id);

    let mut timelines = timeline_state.timelines.lock().unwrap();
    timelines
        .remove(&timeline_id)
        .ok_or_else(|| format!("Timeline slicer {} not found", timeline_id))?;

    Ok(())
}

/// Update timeline slicer properties.
#[tauri::command]
pub fn update_timeline_slicer(
    timeline_state: State<TimelineSlicerState>,
    timeline_id: u64,
    params: UpdateTimelineParams,
) -> Result<TimelineSlicer, String> {
    log_debug!("TIMELINE", "update_timeline_slicer id={}", timeline_id);

    let mut timelines = timeline_state.timelines.lock().unwrap();
    let tl = timelines
        .get_mut(&timeline_id)
        .ok_or_else(|| format!("Timeline slicer {} not found", timeline_id))?;

    if let Some(name) = params.name {
        tl.name = name;
    }
    if let Some(header_text) = params.header_text {
        tl.header_text = header_text;
    }
    if let Some(show_header) = params.show_header {
        tl.show_header = show_header;
    }
    if let Some(show_level_selector) = params.show_level_selector {
        tl.show_level_selector = show_level_selector;
    }
    if let Some(show_scrollbar) = params.show_scrollbar {
        tl.show_scrollbar = show_scrollbar;
    }
    if let Some(level) = params.level {
        tl.level = level;
    }
    if let Some(style_preset) = params.style_preset {
        tl.style_preset = style_preset;
    }

    Ok(tl.clone())
}

/// Update timeline slicer position and size.
#[tauri::command]
pub fn update_timeline_position(
    timeline_state: State<TimelineSlicerState>,
    timeline_id: u64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let mut timelines = timeline_state.timelines.lock().unwrap();
    let tl = timelines
        .get_mut(&timeline_id)
        .ok_or_else(|| format!("Timeline slicer {} not found", timeline_id))?;

    tl.x = x;
    tl.y = y;
    tl.width = width;
    tl.height = height;
    Ok(())
}

/// Update the selected date range on a timeline slicer.
#[tauri::command]
pub fn update_timeline_selection(
    timeline_state: State<TimelineSlicerState>,
    params: UpdateTimelineSelectionParams,
) -> Result<(), String> {
    log_debug!(
        "TIMELINE",
        "update_timeline_selection id={} start={:?} end={:?}",
        params.timeline_id,
        params.selection_start,
        params.selection_end
    );

    let mut timelines = timeline_state.timelines.lock().unwrap();
    let tl = timelines
        .get_mut(&params.timeline_id)
        .ok_or_else(|| format!("Timeline slicer {} not found", params.timeline_id))?;

    tl.selection_start = params.selection_start;
    tl.selection_end = params.selection_end;
    Ok(())
}

/// Update the scroll position of a timeline slicer.
#[tauri::command]
pub fn update_timeline_scroll(
    timeline_state: State<TimelineSlicerState>,
    timeline_id: u64,
    scroll_position: f64,
) -> Result<(), String> {
    let mut timelines = timeline_state.timelines.lock().unwrap();
    let tl = timelines
        .get_mut(&timeline_id)
        .ok_or_else(|| format!("Timeline slicer {} not found", timeline_id))?;

    tl.scroll_position = scroll_position.max(0.0);
    Ok(())
}

/// Update report connections for a timeline slicer.
#[tauri::command]
pub fn update_timeline_connections(
    timeline_state: State<TimelineSlicerState>,
    params: UpdateTimelineConnectionsParams,
) -> Result<(), String> {
    log_debug!(
        "TIMELINE",
        "update_timeline_connections id={} pivots={:?}",
        params.timeline_id,
        params.connected_pivot_ids
    );

    let mut timelines = timeline_state.timelines.lock().unwrap();
    let tl = timelines
        .get_mut(&params.timeline_id)
        .ok_or_else(|| format!("Timeline slicer {} not found", params.timeline_id))?;

    tl.connected_pivot_ids = params.connected_pivot_ids;
    Ok(())
}

// ============================================================================
// QUERY COMMANDS
// ============================================================================

/// Get all timeline slicers.
#[tauri::command]
pub fn get_all_timeline_slicers(
    timeline_state: State<TimelineSlicerState>,
) -> Vec<TimelineSlicer> {
    timeline_state
        .timelines
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect()
}

/// Get timeline slicers for a specific sheet.
#[tauri::command]
pub fn get_timeline_slicers_for_sheet(
    timeline_state: State<TimelineSlicerState>,
    sheet_index: usize,
) -> Vec<TimelineSlicer> {
    timeline_state
        .timelines
        .lock()
        .unwrap()
        .values()
        .filter(|t| t.sheet_index == sheet_index)
        .cloned()
        .collect()
}

/// Get timeline data: date range and periods at the current level.
/// Returns periods with has_data and is_selected flags.
#[tauri::command]
pub fn get_timeline_data(
    pivot_state: State<'_, PivotState>,
    timeline_state: State<TimelineSlicerState>,
    timeline_id: u64,
) -> Result<TimelineDataResponse, String> {
    let timelines = timeline_state.timelines.lock().unwrap();
    let tl = timelines
        .get(&timeline_id)
        .ok_or_else(|| format!("Timeline slicer {} not found", timeline_id))?;

    let pivot_id = tl.source_id as PivotId;
    let level = tl.level;
    let sel_start = tl.selection_start.clone();
    let sel_end = tl.selection_end.clone();

    // Get date values from pivot cache
    let dates = get_pivot_date_values(&pivot_state, pivot_id, &tl.field_name)?;

    if dates.is_empty() {
        return Ok(TimelineDataResponse {
            min_date: String::new(),
            max_date: String::new(),
            periods: vec![],
            level,
            total_periods: 0,
        });
    }

    let min_date = dates.iter().min().unwrap().clone();
    let max_date = dates.iter().max().unwrap().clone();

    let dates_set: HashSet<DateTuple> = dates.into_iter().collect();

    let periods = generate_periods(level, &min_date, &max_date, &dates_set, &sel_start, &sel_end);
    let total_periods = periods.len();

    Ok(TimelineDataResponse {
        min_date: format!("{:04}-{:02}-{:02}", min_date.0, min_date.1, min_date.2),
        max_date: format!("{:04}-{:02}-{:02}", max_date.0, max_date.1, max_date.2),
        periods,
        level,
        total_periods,
    })
}

/// Get the list of date values that fall within the timeline's selected range.
/// Used by the filter bridge to determine which items to pass to the pivot filter.
#[tauri::command]
pub fn get_timeline_selected_items(
    pivot_state: State<'_, PivotState>,
    timeline_state: State<TimelineSlicerState>,
    timeline_id: u64,
) -> Result<Option<Vec<String>>, String> {
    let timelines = timeline_state.timelines.lock().unwrap();
    let tl = timelines
        .get(&timeline_id)
        .ok_or_else(|| format!("Timeline slicer {} not found", timeline_id))?;

    // No selection = no filter (all items visible)
    let (sel_start_str, sel_end_str) = match (&tl.selection_start, &tl.selection_end) {
        (Some(s), Some(e)) => (s.clone(), e.clone()),
        _ => return Ok(None),
    };

    let sel_start = parse_iso_date(&sel_start_str)
        .ok_or_else(|| format!("Invalid selection_start: {}", sel_start_str))?;
    let sel_end = parse_iso_date(&sel_end_str)
        .ok_or_else(|| format!("Invalid selection_end: {}", sel_end_str))?;

    let pivot_id = tl.source_id as PivotId;

    // Get the raw string representations of date values from the pivot cache
    let selected = get_pivot_date_value_strings_in_range(
        &pivot_state,
        pivot_id,
        &tl.field_name,
        &sel_start,
        &sel_end,
    )?;

    Ok(Some(selected))
}

/// Get date field names from a pivot table (fields that contain date values).
/// Used by the InsertTimelineDialog to show available date fields.
#[tauri::command]
pub fn get_pivot_date_fields(
    pivot_state: State<'_, PivotState>,
    pivot_id: u64,
) -> Result<Vec<String>, String> {
    let pid = pivot_id as PivotId;
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (_def, cache) = pivot_tables
        .get_mut(&pid)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    let mut date_fields = Vec::new();

    for field in &mut cache.fields {
        // Check if at least some values in this field are dates
        let mut date_count = 0;
        let mut total_count = 0;

        let sorted_ids = field.sorted_ids().to_vec();
        for &vid in &sorted_ids {
            if vid == VALUE_ID_EMPTY {
                continue;
            }
            if let Some(value) = field.get_value(vid) {
                total_count += 1;
                if pivot_engine::cache::parse_cache_value_as_date(value).is_some() {
                    date_count += 1;
                }
            }
        }

        // Consider it a date field if >50% of values parse as dates
        if total_count > 0 && date_count * 2 >= total_count {
            date_fields.push(field.name.clone());
        }
    }

    Ok(date_fields)
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/// (year, month, day) tuple for date comparisons.
type DateTuple = (i32, u32, u32);

/// Parse an ISO 8601 date string "YYYY-MM-DD" into a DateTuple.
fn parse_iso_date(s: &str) -> Option<DateTuple> {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let y = parts[0].parse::<i32>().ok()?;
    let m = parts[1].parse::<u32>().ok()?;
    let d = parts[2].parse::<u32>().ok()?;
    if m >= 1 && m <= 12 && d >= 1 && d <= 31 {
        Some((y, m, d))
    } else {
        None
    }
}

/// Get all date values from a pivot field as DateTuples.
fn get_pivot_date_values(
    pivot_state: &State<'_, PivotState>,
    pivot_id: PivotId,
    field_name: &str,
) -> Result<Vec<DateTuple>, String> {
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (_def, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    let field = cache
        .fields
        .iter_mut()
        .find(|f| f.name == field_name)
        .ok_or_else(|| format!("Field '{}' not found in pivot cache", field_name))?;

    let mut dates = Vec::new();
    let sorted_ids = field.sorted_ids().to_vec();

    for &vid in &sorted_ids {
        if vid == VALUE_ID_EMPTY {
            continue;
        }
        if let Some(value) = field.get_value(vid) {
            if let Some(parsed) = pivot_engine::cache::parse_cache_value_as_date(value) {
                dates.push((parsed.year, parsed.month, parsed.day));
            }
        }
    }

    Ok(dates)
}

/// Get the string representations of date values that fall within [start, end].
/// These strings are what the pivot filter needs to match against.
fn get_pivot_date_value_strings_in_range(
    pivot_state: &State<'_, PivotState>,
    pivot_id: PivotId,
    field_name: &str,
    start: &DateTuple,
    end: &DateTuple,
) -> Result<Vec<String>, String> {
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (_def, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    let field = cache
        .fields
        .iter_mut()
        .find(|f| f.name == field_name)
        .ok_or_else(|| format!("Field '{}' not found in pivot cache", field_name))?;

    let mut selected = Vec::new();
    let sorted_ids = field.sorted_ids().to_vec();

    for &vid in &sorted_ids {
        if vid == VALUE_ID_EMPTY {
            continue;
        }
        if let Some(value) = field.get_value(vid) {
            if let Some(parsed) = pivot_engine::cache::parse_cache_value_as_date(value) {
                let d = (parsed.year, parsed.month, parsed.day);
                if d >= *start && d <= *end {
                    // Return the string representation that the slicer filter bridge expects
                    let value_str = match value {
                        pivot_engine::CacheValue::Number(n) => {
                            if n.0.fract() == 0.0 {
                                format!("{}", n.0 as i64)
                            } else {
                                format!("{}", n.0)
                            }
                        }
                        pivot_engine::CacheValue::Text(s) => s.to_string(),
                        _ => continue,
                    };
                    selected.push(value_str);
                }
            }
        }
    }

    Ok(selected)
}

/// Generate timeline periods between min_date and max_date at the given level.
fn generate_periods(
    level: TimelineLevel,
    min_date: &DateTuple,
    max_date: &DateTuple,
    dates_with_data: &HashSet<DateTuple>,
    sel_start: &Option<String>,
    sel_end: &Option<String>,
) -> Vec<TimelinePeriod> {
    let sel_start_date = sel_start.as_ref().and_then(|s| parse_iso_date(s));
    let sel_end_date = sel_end.as_ref().and_then(|s| parse_iso_date(s));

    match level {
        TimelineLevel::Years => generate_year_periods(min_date, max_date, dates_with_data, &sel_start_date, &sel_end_date),
        TimelineLevel::Quarters => generate_quarter_periods(min_date, max_date, dates_with_data, &sel_start_date, &sel_end_date),
        TimelineLevel::Months => generate_month_periods(min_date, max_date, dates_with_data, &sel_start_date, &sel_end_date),
        TimelineLevel::Days => generate_day_periods(min_date, max_date, dates_with_data, &sel_start_date, &sel_end_date),
    }
}

fn generate_year_periods(
    min_date: &DateTuple,
    max_date: &DateTuple,
    dates_with_data: &HashSet<DateTuple>,
    sel_start: &Option<DateTuple>,
    sel_end: &Option<DateTuple>,
) -> Vec<TimelinePeriod> {
    let mut periods = Vec::new();
    for year in min_date.0..=max_date.0 {
        let start = (year, 1, 1);
        let end = (year, 12, 31);
        let has_data = dates_with_data.iter().any(|d| d.0 == year);
        let is_selected = match (sel_start, sel_end) {
            (Some(s), Some(e)) => {
                // Period overlaps selection if period_start <= sel_end && period_end >= sel_start
                end >= *s && start <= *e
            }
            _ => false,
        };

        periods.push(TimelinePeriod {
            label: format!("{}", year),
            group_label: String::new(),
            start_date: format!("{:04}-01-01", year),
            end_date: format!("{:04}-12-31", year),
            has_data,
            is_selected,
            index: periods.len(),
        });
    }
    periods
}

fn generate_quarter_periods(
    min_date: &DateTuple,
    max_date: &DateTuple,
    dates_with_data: &HashSet<DateTuple>,
    sel_start: &Option<DateTuple>,
    sel_end: &Option<DateTuple>,
) -> Vec<TimelinePeriod> {
    let mut periods = Vec::new();
    let start_q = quarter_of(min_date.1);
    let end_q = quarter_of(max_date.1);

    for year in min_date.0..=max_date.0 {
        let q_start = if year == min_date.0 { start_q } else { 1 };
        let q_end = if year == max_date.0 { end_q } else { 4 };

        for q in q_start..=q_end {
            let first_month = (q - 1) * 3 + 1;
            let last_month = q * 3;
            let start = (year, first_month, 1);
            let end = (year, last_month, days_in_month(year, last_month));

            let has_data = dates_with_data.iter().any(|d| {
                d.0 == year && quarter_of(d.1) == q
            });

            let is_selected = match (sel_start, sel_end) {
                (Some(s), Some(e)) => end >= *s && start <= *e,
                _ => false,
            };

            periods.push(TimelinePeriod {
                label: format!("Q{}", q),
                group_label: format!("{}", year),
                start_date: format!("{:04}-{:02}-01", year, first_month),
                end_date: format!("{:04}-{:02}-{:02}", year, last_month, days_in_month(year, last_month)),
                has_data,
                is_selected,
                index: periods.len(),
            });
        }
    }
    periods
}

fn generate_month_periods(
    min_date: &DateTuple,
    max_date: &DateTuple,
    dates_with_data: &HashSet<DateTuple>,
    sel_start: &Option<DateTuple>,
    sel_end: &Option<DateTuple>,
) -> Vec<TimelinePeriod> {
    static MONTH_NAMES: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];

    let mut periods = Vec::new();

    for year in min_date.0..=max_date.0 {
        let m_start = if year == min_date.0 { min_date.1 } else { 1 };
        let m_end = if year == max_date.0 { max_date.1 } else { 12 };

        for month in m_start..=m_end {
            let last_day = days_in_month(year, month);
            let start = (year, month, 1);
            let end = (year, month, last_day);

            let has_data = dates_with_data.iter().any(|d| {
                d.0 == year && d.1 == month
            });

            let is_selected = match (sel_start, sel_end) {
                (Some(s), Some(e)) => end >= *s && start <= *e,
                _ => false,
            };

            periods.push(TimelinePeriod {
                label: MONTH_NAMES[(month - 1) as usize].to_string(),
                group_label: format!("{}", year),
                start_date: format!("{:04}-{:02}-01", year, month),
                end_date: format!("{:04}-{:02}-{:02}", year, month, last_day),
                has_data,
                is_selected,
                index: periods.len(),
            });
        }
    }
    periods
}

fn generate_day_periods(
    min_date: &DateTuple,
    max_date: &DateTuple,
    dates_with_data: &HashSet<DateTuple>,
    sel_start: &Option<DateTuple>,
    sel_end: &Option<DateTuple>,
) -> Vec<TimelinePeriod> {
    static MONTH_NAMES: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];

    let mut periods = Vec::new();
    let mut current = *min_date;

    while current <= *max_date {
        let (y, m, d) = current;
        let date_str = format!("{:04}-{:02}-{:02}", y, m, d);

        let has_data = dates_with_data.contains(&current);
        let is_selected = match (sel_start, sel_end) {
            (Some(s), Some(e)) => current >= *s && current <= *e,
            _ => false,
        };

        periods.push(TimelinePeriod {
            label: format!("{}", d),
            group_label: format!("{} {}", MONTH_NAMES[(m - 1) as usize], y),
            start_date: date_str.clone(),
            end_date: date_str,
            has_data,
            is_selected,
            index: periods.len(),
        });

        // Advance to next day
        current = next_day(current);
    }
    periods
}

// ============================================================================
// DATE MATH HELPERS
// ============================================================================

fn quarter_of(month: u32) -> u32 {
    (month - 1) / 3 + 1
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => if is_leap_year(year) { 29 } else { 28 },
        _ => 30,
    }
}

fn next_day(date: DateTuple) -> DateTuple {
    let (y, m, d) = date;
    let max_d = days_in_month(y, m);
    if d < max_d {
        (y, m, d + 1)
    } else if m < 12 {
        (y, m + 1, 1)
    } else {
        (y + 1, 1, 1)
    }
}
