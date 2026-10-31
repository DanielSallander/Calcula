//! FILENAME: core/calp/src/dev_mode.rs
//! PURPOSE: Dev subscription mode — points at a local .cala file and follows HEAD.
//! CONTEXT: Authors need a fast iteration loop. A dev subscription points at a
//! working .cala file via local path. It refreshes on demand (or on file change)
//! without requiring version bumps.
//!
//! Dev subscriptions are stored alongside normal subscriptions but flagged with
//! `dev: true`. They resolve by reading the source .cala directly instead of
//! going through the workspace.

use std::collections::HashMap;
use std::path::Path;

use identity::SheetId;
use persistence::Sheet;

use crate::error::CalpError;
use crate::manifest::{Subscription, SubscribedSheet};

/// A dev subscription entry. Stored in SubscriptionManifest with `dev: true`.
/// Points at a local .cala file instead of a workspace application.

/// Read a source .cala workbook and extract sheets for dev subscription.
pub fn pull_dev(
    source_path: &Path,
    sheet_names: &[String],
) -> Result<DevPullResult, CalpError> {
    if !source_path.exists() {
        return Err(CalpError::Workspace(format!(
            "Dev source not found: {}", source_path.display()
        )));
    }

    let workbook = calcula_format::load_calcula(source_path)
        .map_err(|e| CalpError::Format(format!("Failed to load dev source: {}", e)))?;

    let mut pulled_sheets = Vec::new();

    if sheet_names.is_empty() {
        // Pull all sheets
        for sheet in &workbook.sheets {
            pulled_sheets.push(DevPulledSheet {
                source_sheet_id: sheet.id,
                name: sheet.name.clone(),
                sheet: sheet.clone(),
            });
        }
    } else {
        // Pull selected sheets by name
        for name in sheet_names {
            let sheet = workbook.sheets.iter()
                .find(|s| identity::sheet_names_equal(&s.name, name))
                .ok_or_else(|| CalpError::SheetNotFound(name.clone()))?;
            if pulled_sheets.iter().any(|p: &DevPulledSheet| p.source_sheet_id == sheet.id) {
                continue; // named twice (a refresh re-requests every tracked sheet)
            }
            pulled_sheets.push(DevPulledSheet {
                source_sheet_id: sheet.id,
                name: sheet.name.clone(),
                sheet: sheet.clone(),
            });
        }
    }

    // FLOATING RANGES TRAVEL AS A PAIR: the object row, and the OBJECT sheet that
    // holds its cells. A dev pull used to carry the sheets and not the rows, so a
    // source with a floating range left the author an invisible object sheet no
    // row claimed -- and a pull by sheet NAME could never ask for a backing sheet
    // at all (it has no tab to name).
    //
    // So: the backing sheet of every floating range whose HOST is pulled joins
    // the pull, the rows are carried when BOTH of their sheets are here and the
    // row is structurally sound (the rule a real pull applies,
    // `pull::floating_range_row_is_well_formed`), and an object sheet no carried
    // row claims is left behind rather than appended as an orphan.
    let source_sheet = |id: SheetId| workbook.sheets.iter().find(|s| s.id == id);
    for fr in &workbook.floating_ranges {
        let host_pulled = pulled_sheets.iter().any(|p| p.source_sheet_id == fr.host_sheet_id);
        let backing_pulled = pulled_sheets.iter().any(|p| p.source_sheet_id == fr.backing_sheet_id);
        if host_pulled && !backing_pulled {
            if let Some(backing) = source_sheet(fr.backing_sheet_id) {
                pulled_sheets.push(DevPulledSheet {
                    source_sheet_id: backing.id,
                    name: backing.name.clone(),
                    sheet: backing.clone(),
                });
            }
        }
    }
    let visibility_of: HashMap<SheetId, &str> = pulled_sheets
        .iter()
        .map(|p| (p.source_sheet_id, p.sheet.visibility.as_str()))
        .collect();
    let floating_ranges: Vec<persistence::SavedFloatingRange> = workbook
        .floating_ranges
        .iter()
        .filter(|fr| crate::pull::floating_range_row_is_well_formed(fr, &visibility_of))
        .cloned()
        .collect();
    pulled_sheets.retain(|p| {
        p.sheet.visibility != crate::pull::OBJECT_SHEET_VISIBILITY
            || floating_ranges.iter().any(|fr| fr.backing_sheet_id == p.source_sheet_id)
    });

    // THE OBJECT PROPERTY BINDINGS of what this pull carries (BUG-0471). A
    // control property that follows a formula is a `bindings.json` row beside
    // the control's own literal (empty after the migration, or whatever it was
    // when the binding was set), so a dev pull that carried the controls and
    // not the rows previewed a caption that LOOKED live and never moved.
    let object_bindings = dev_pulled_object_bindings(&workbook, &pulled_sheets, &floating_ranges);

    Ok(DevPullResult {
        sheets: pulled_sheets,
        tables: workbook.tables,
        named_ranges: workbook.named_ranges,
        controls: workbook.controls,
        media: workbook.media,
        floating_ranges,
        object_bindings,
    })
}

/// The source's `bindings.json` rows a dev pull carries: what a PUBLISH of the
/// pulled sheets would carry (`publish::published_object_bindings`, the one
/// rule -- a control by `uid` in a pulled sheet's `controls.json` entry, a
/// pulled sheet that is a canvas page), narrowed to the object families a dev
/// pull actually brings:
///
/// - `control` and `canvasPage`: as the publish rule says;
/// - `floatingRange`: a row of `floating_ranges` (the rows this pull carries:
///   host and backing both here, structurally sound).
///
/// A dev pull brings no charts, slicers, timelines or pivots, so their rows stay
/// home -- landed, they would name an object this pull did not bring. Ids are
/// the SOURCE's, which a dev pull keeps as the local ids; the host still lands
/// a row only on an object it actually placed on a pulled sheet.
fn dev_pulled_object_bindings(
    workbook: &persistence::Workbook,
    sheets: &[DevPulledSheet],
    floating_ranges: &[persistence::SavedFloatingRange],
) -> Vec<persistence::SavedObjectBinding> {
    if workbook.object_bindings.is_empty() {
        return Vec::new();
    }
    let sheet_indices: Vec<usize> = workbook
        .sheets
        .iter()
        .enumerate()
        .filter(|(_, s)| sheets.iter().any(|p| p.source_sheet_id == s.id))
        .map(|(idx, _)| idx)
        .collect();
    let carried_ranges: std::collections::HashSet<String> =
        floating_ranges.iter().map(|fr| fr.id.to_string()).collect();
    crate::publish::published_object_bindings(workbook, &sheet_indices)
        .into_iter()
        .filter(|row| match row.object.kind.as_str() {
            "control" | "canvasPage" => true,
            "floatingRange" => carried_ranges.contains(&row.object.id),
            _ => false,
        })
        .collect()
}

/// Result of a dev pull.
#[derive(Default)]
pub struct DevPullResult {
    pub sheets: Vec<DevPulledSheet>,
    pub tables: Vec<persistence::SavedTable>,
    pub named_ranges: Vec<persistence::SavedNamedRange>,
    /// Cell-anchored controls per sheet (keyed by SOURCE sheet id), so the
    /// dev preview matches what a real subscriber would receive.
    pub controls: Vec<persistence::SavedSheetControls>,
    /// Content-addressed binary media the source document holds: sha256 hex ->
    /// raw bytes. Carried for the same reason the controls are — a dev pull
    /// exists to show the author what a subscriber gets, and without the bytes
    /// every picture in the preview resolves to nothing and paints "Image
    /// Unavailable". Re-validated host-side like any other foreign media.
    ///
    /// The WHOLE source store travels, not just what the pulled sheets
    /// reference: a real publish filters, but a dev pull has no manifest to be
    /// unreachable from, and the host's save-time sweep drops whatever the
    /// document ends up not pointing at.
    pub media: HashMap<String, Vec<u8>>,
    /// Floating-range object rows whose host AND backing sheet are both in
    /// `sheets`, keyed by SOURCE sheet ids (which a dev pull keeps as the local
    /// ids). Structurally checked the way a real pull checks them.
    pub floating_ranges: Vec<persistence::SavedFloatingRange>,
    /// The source's object property BINDINGS (`bindings.json` rows) of the
    /// objects this pull carries -- the controls of the pulled sheets, the
    /// carried floating ranges and the pulled canvas pages
    /// (`dev_pulled_object_bindings`), with SOURCE ids, which a dev pull keeps
    /// as the local ids. The host lands them through the same
    /// `object_bindings::carriage` a real pull uses (BUG-0471).
    pub object_bindings: Vec<persistence::SavedObjectBinding>,
}

/// A sheet pulled from a dev source.
pub struct DevPulledSheet {
    pub source_sheet_id: SheetId,
    pub name: String,
    pub sheet: Sheet,
}

/// Build a dev subscription entry.
pub fn make_dev_subscription(
    source_path: &str,
    pulled: &DevPullResult,
    now: &str,
) -> Subscription {
    let sheets: Vec<SubscribedSheet> = pulled.sheets.iter().map(|ps| {
        SubscribedSheet {
            package_sheet_id: ps.source_sheet_id,
            local_sheet_id: ps.sheet.id,
            local_name: ps.name.clone(),
            extra: std::collections::HashMap::new(),
        }
    }).collect();

    Subscription {
        package_name: format!("dev:{}", source_path),
        registry_url: format!("file://{}", source_path),
        version_pin: "dev".to_string(),
        resolved_version: "dev".to_string(),
        resolved_at: now.to_string(),
        sheets,
        // NOT an environment, and the distinction is load-bearing. A dev
        // subscription points at a local `.cala` FILE — there is no workspace,
        // no signed manifest and no promotion log to resolve a name against.
        // The field it replaces carried the literal `"dev"` here, so a
        // mechanical rename would have sent every dev subscription looking for
        // an environment called "dev" in an application called `dev:C:/...`.
        // `is_dev_subscription` short-circuits before any resolution; this
        // keeps that true even if a caller forgets.
        environment: None,
        data_source_configs: Vec::new(),
        objects: Vec::new(),
        detached_sheets: Vec::new(),
        detached_local_sheets: Vec::new(),
        upstream_removed_sheets: Vec::new(),
        extra: std::collections::HashMap::new(),
    }
}

/// Check if a subscription is a dev subscription.
pub fn is_dev_subscription(sub: &Subscription) -> bool {
    sub.version_pin == "dev" || sub.package_name.starts_with("dev:")
}

/// Check if the source file has been modified since the last pull.
pub fn source_modified_since(source_path: &Path, last_pull: &str) -> Result<bool, CalpError> {
    if !source_path.exists() {
        return Ok(false);
    }

    let metadata = std::fs::metadata(source_path)?;
    let modified = metadata.modified()
        .map_err(|e| CalpError::Io(e))?;

    // Parse last_pull as a rough timestamp comparison
    // For simplicity, always return true (force refresh) — accurate timestamp
    // comparison requires chrono which we avoid in this crate
    let _ = modified;
    let _ = last_pull;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use persistence::Workbook;
    use tempfile::TempDir;
    use engine::cell::Cell;

    fn make_test_workbook() -> Workbook {
        let mut sheet1 = Sheet::new("Source1".to_string());
        let cell = Cell::new_number(42.0);
        sheet1.cells.insert((0, 0), persistence::SavedCell::from_cell(&cell));

        let mut sheet2 = Sheet::new("Source2".to_string());
        let cell2 = Cell::new_text("hello".to_string());
        sheet2.cells.insert((0, 0), persistence::SavedCell::from_cell(&cell2));

        let mut wb = Workbook::default();
        wb.sheets = vec![sheet1, sheet2];
        wb
    }

    #[test]
    fn dev_pull_all_sheets() {
        let dir = TempDir::new().unwrap();
        let source_path = dir.path().join("source.cala");

        let wb = make_test_workbook();
        calcula_format::save_calcula(&wb, &source_path).unwrap();

        let result = pull_dev(&source_path, &[]).unwrap();
        assert_eq!(result.sheets.len(), 2);
        assert_eq!(result.sheets[0].name, "Source1");
        assert_eq!(result.sheets[1].name, "Source2");
    }

    #[test]
    fn dev_pull_selected_sheets() {
        let dir = TempDir::new().unwrap();
        let source_path = dir.path().join("source.cala");

        let wb = make_test_workbook();
        calcula_format::save_calcula(&wb, &source_path).unwrap();

        let result = pull_dev(&source_path, &["Source2".to_string()]).unwrap();
        assert_eq!(result.sheets.len(), 1);
        assert_eq!(result.sheets[0].name, "Source2");
    }

    /// A dev pull carries a floating range as the PAIR it is: the object row and
    /// the object sheet holding its cells. Pulling the host by name brings the
    /// backing sheet it cannot name, and an object sheet no row claims (an
    /// orphan) is left behind instead of being appended invisible and unowned.
    ///
    /// SABOTAGE: drop the backing auto-include, or the orphan `retain`.
    #[test]
    fn dev_pull_carries_floating_ranges_with_their_backing_sheets() {
        let dir = TempDir::new().unwrap();
        let source_path = dir.path().join("source.cala");

        let mut wb = make_test_workbook(); // Source1(0), Source2(1)
        let mut backing = Sheet::new("Float1".to_string());
        backing.visibility = crate::pull::OBJECT_SHEET_VISIBILITY.to_string();
        backing.cells.insert((0, 0), persistence::SavedCell::from_cell(&Cell::new_number(7.0)));
        wb.sheets.push(backing); // 2
        let mut orphan = Sheet::new("Float9".to_string());
        orphan.visibility = crate::pull::OBJECT_SHEET_VISIBILITY.to_string();
        wb.sheets.push(orphan); // 3, claimed by no row
        let (host, backing_id) = (wb.sheets[0].id, wb.sheets[2].id);
        let fr_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        wb.floating_ranges = vec![persistence::SavedFloatingRange {
            id: fr_id,
            backing_sheet_id: backing_id,
            host_sheet_id: host,
            x: 10.0,
            y: 20.0,
            rotation: 0.0,
            pin_to_grid: false,
            row_count: 2,
            col_count: 2,
            col_widths: HashMap::new(),
            row_heights: HashMap::new(),
            show_title: true,
            show_column_headers: true,
            show_row_headers: true,
            container: None,
            hidden_rows: Vec::new(),
            hidden_cols: Vec::new(),
        }];
        // ...and a property binding of that range, which travels with its row.
        wb.object_bindings = vec![persistence::SavedObjectBinding {
            object: persistence::SavedObjectRef { kind: "floatingRange".to_string(), id: fr_id.to_string() },
            path: "/showTitle".to_string(),
            formula: "=Source2!A1".to_string(),
            model: None,
        }];
        calcula_format::save_calcula(&wb, &source_path).unwrap();

        let by_name = pull_dev(&source_path, &["Source1".to_string()]).unwrap();
        let names: Vec<&str> = by_name.sheets.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["Source1", "Float1"], "the host's backing sheet joins the pull");
        assert_eq!(by_name.floating_ranges.len(), 1, "and the row that binds them travels");
        assert_eq!(by_name.floating_ranges[0].id, fr_id);
        assert_eq!(by_name.object_bindings.len(), 1, "so does the range's property binding");

        let all = pull_dev(&source_path, &[]).unwrap();
        let names: Vec<&str> = all.sheets.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["Source1", "Source2", "Float1"],
            "the orphan object sheet no row claims is not pulled"
        );
        assert_eq!(all.floating_ranges.len(), 1);

        let without_host = pull_dev(&source_path, &["Source2".to_string()]).unwrap();
        assert!(without_host.floating_ranges.is_empty(), "no host, no row");
        assert_eq!(without_host.sheets.len(), 1, "and no backing sheet either");
        assert!(without_host.object_bindings.is_empty(), "and no binding of a range that stayed home");
    }

    fn binding(kind: &str, id: &str, path: &str, formula: &str) -> persistence::SavedObjectBinding {
        persistence::SavedObjectBinding {
            object: persistence::SavedObjectRef { kind: kind.to_string(), id: id.to_string() },
            path: path.to_string(),
            formula: formula.to_string(),
            model: None,
        }
    }

    fn button(uid: &str) -> serde_json::Value {
        serde_json::json!({
            "row": 2, "col": 2, "controlType": "button", "uid": uid,
            "properties": { "text": { "valueType": "static", "value": "" } }
        })
    }

    /// BUG-0471. A dev pull carried the source's controls and not their
    /// BINDINGS, so a button whose caption follows `=Data!A1` arrived showing
    /// its frozen literal. The pull now carries the rows of exactly the objects
    /// it brings: the controls of the PULLED sheets, the pulled canvas pages and
    /// the carried floating ranges -- never a control of a sheet left behind,
    /// and never a chart (a dev pull brings none).
    ///
    /// SABOTAGE: return `Vec::new()` from `dev_pulled_object_bindings` -- no
    /// row travels and the first assertion fails.
    #[test]
    fn dev_pull_carries_the_bindings_of_the_objects_it_brings() {
        let dir = TempDir::new().unwrap();
        let source_path = dir.path().join("source.cala");

        let mut wb = make_test_workbook(); // Source1(0), Source2(1)
        let mut page = Sheet::new("Page".to_string());
        page.kind = persistence::SheetKind::new_canvas();
        wb.sheets.push(page); // 2
        let (source1, source2, page_id) = (wb.sheets[0].id, wb.sheets[1].id, wb.sheets[2].id);
        let chart = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        wb.charts = vec![persistence::SavedChart {
            id: chart,
            sheet_id: source1,
            spec: serde_json::json!({ "chartId": 1, "name": "Sales", "sheetIndex": 0, "spec": { "mark": "bar" } }),
        }];
        wb.controls = vec![
            persistence::SavedSheetControls { sheet_id: source1, controls: serde_json::json!([button("btn-1")]) },
            persistence::SavedSheetControls { sheet_id: source2, controls: serde_json::json!([button("btn-2")]) },
        ];
        wb.object_bindings = vec![
            binding("control", "btn-1", "/properties/text", "=Source2!A1"),
            binding("control", "btn-2", "/properties/text", "=Source2!A1"),
            binding("canvasPage", &page_id.to_string(), "/background", "=Source1!A1"),
            binding("chart", &chart.to_string(), "/spec/title", "=Source1!A1"),
        ];
        calcula_format::save_calcula(&wb, &source_path).unwrap();

        let objects = |result: &DevPullResult| -> Vec<String> {
            result.object_bindings.iter().map(|b| format!("{}:{}", b.object.kind, b.object.id)).collect()
        };
        let some = pull_dev(&source_path, &["Source1".to_string(), "Page".to_string()]).unwrap();
        assert_eq!(
            objects(&some),
            vec![format!("canvasPage:{page_id}"), "control:btn-1".to_string()],
            "the pulled sheets' button and page travel, the left-behind sheet's button and the chart do not"
        );
        assert_eq!(some.object_bindings[1].formula, "=Source2!A1", "carried as written");

        let all = pull_dev(&source_path, &[]).unwrap();
        assert_eq!(
            objects(&all),
            vec![format!("canvasPage:{page_id}"), "control:btn-1".to_string(), "control:btn-2".to_string()],
            "a chart's row never travels with a dev pull, which brings no chart"
        );

        let none = pull_dev(&source_path, &["Source2".to_string()]).unwrap();
        assert_eq!(objects(&none), vec!["control:btn-2".to_string()]);
    }

    #[test]
    fn dev_pull_nonexistent_sheet_fails() {
        let dir = TempDir::new().unwrap();
        let source_path = dir.path().join("source.cala");

        let wb = make_test_workbook();
        calcula_format::save_calcula(&wb, &source_path).unwrap();

        let result = pull_dev(&source_path, &["NonExistent".to_string()]);
        assert!(matches!(result, Err(CalpError::SheetNotFound(_))));
    }

    #[test]
    fn dev_pull_nonexistent_file_fails() {
        let result = pull_dev(Path::new("/no/such/file.cala"), &[]);
        assert!(result.is_err());
    }

    #[test]
    fn dev_subscription_detection() {
        let sub = Subscription {
            package_name: "dev:/path/to/file.cala".to_string(),
            registry_url: "file:///path/to/file.cala".to_string(),
            version_pin: "dev".to_string(),
            resolved_version: "dev".to_string(),
            resolved_at: String::new(),
            sheets: Vec::new(),
            environment: None,
            data_source_configs: Vec::new(),
        objects: Vec::new(),
        detached_sheets: Vec::new(),
        detached_local_sheets: Vec::new(),
        upstream_removed_sheets: Vec::new(),
            extra: std::collections::HashMap::new(),
        };
        assert!(is_dev_subscription(&sub));

        let normal_sub = Subscription {
            package_name: "sales-report".to_string(),
            registry_url: "file:///registry".to_string(),
            version_pin: "^1.0".to_string(),
            resolved_version: "1.2.0".to_string(),
            resolved_at: String::new(),
            sheets: Vec::new(),
            environment: None,
            data_source_configs: Vec::new(),
        objects: Vec::new(),
        detached_sheets: Vec::new(),
        detached_local_sheets: Vec::new(),
        upstream_removed_sheets: Vec::new(),
            extra: std::collections::HashMap::new(),
        };
        assert!(!is_dev_subscription(&normal_sub));
    }

    #[test]
    fn make_dev_subscription_creates_metadata() {
        let dir = TempDir::new().unwrap();
        let source_path = dir.path().join("source.cala");
        let wb = make_test_workbook();
        calcula_format::save_calcula(&wb, &source_path).unwrap();

        let result = pull_dev(&source_path, &[]).unwrap();
        let sub = make_dev_subscription(
            source_path.to_str().unwrap(),
            &result,
            "2026-01-01T00:00:00Z",
        );

        assert!(is_dev_subscription(&sub));
        assert_eq!(sub.sheets.len(), 2);
    }
}
