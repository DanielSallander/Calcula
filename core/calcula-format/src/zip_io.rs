//! FILENAME: core/calcula-format/src/zip_io.rs
//! ZIP archive read/write for the .cala format.
//!
//! Writes and reads the structured ZIP containing manifest, sheets, styles, and features.

use crate::error::FormatError;
use crate::features::tables::TableDef;
use crate::features::slicers::SlicerDef;
use crate::features::ribbon_filters::RibbonFilterDef;
use crate::features::pane_controls::PaneControlDef;
use crate::features::scripts::ScriptDef;
use crate::features::notebooks::NotebookDef;
use crate::features::pivot_layouts::PivotLayoutDef;
use crate::features::scheduled_jobs::{
    SCHEDULED_JOBS_FEATURE, SCHEDULED_JOBS_FILE, SCHEDULED_JOBS_MIN_FORMAT_VERSION,
};
// No `*_MIN_FORMAT_VERSION` import here, and there is none to import: the
// authoring transcript takes a feature id and no link in the version chain.
use crate::features::script_authoring::{SCRIPT_AUTHORING_FEATURE, SCRIPT_AUTHORING_FILE};
use crate::manifest::{
    stamp_feature_format_version, Manifest, CALA_BASE_FORMAT_VERSION, PINNED_FILTER_MIN_FORMAT_VERSION,
    CANVAS_INTERACTIONS_FEATURE, CANVAS_OBJECTS_LOCKED_FEATURE, CANVAS_SHEET_MIN_FORMAT_VERSION,
    CANVAS_WALLPAPER_FEATURE, RIBBON_FILTER_VISUAL_TARGETS_FEATURE,
    CHART_SPEC_OBJECT_MIN_FORMAT_VERSION, FLOATING_GRID_HIDDEN_LINES_MIN_FORMAT_VERSION,
    OBJECT_BINDINGS_FEATURE, OBJECT_BINDINGS_MIN_FORMAT_VERSION, PAGE_NAVIGATOR_FEATURE, PIVOT_STYLE_FEATURE, VISUAL_CONTAINER_FEATURE,
    PENDING_RECALC_MIN_FORMAT_VERSION, SHEET_DISPLAY_FLAGS_MIN_FORMAT_VERSION,
    SHEET_VIEW_MIN_FORMAT_VERSION,
    SPILL_EXTENT_MIN_FORMAT_VERSION,
    USER_HIDDEN_MIN_FORMAT_VERSION,
    CALA_MAX_SUPPORTED_FORMAT_VERSION,
};
use crate::sheet_data::{cells_to_sheet_data, sheet_data_to_cells, SheetData};
use crate::sheet_layout::SheetLayout;
use crate::sheet_styles::{
    apply_sheet_styles, cells_to_sheet_styles,
    serialize_style_registry, SheetStyles,
};

use engine::theme::ThemeDefinition;
use identity::SheetId;
use crate::features::object_scripts::ObjectScriptDef;
use persistence::{SavedChart, SavedNotebook, SavedObjectScript, SavedPaneControl, SavedPivotLayout, SavedRibbonFilter, SavedScript, SavedSlicer, SavedSparkline, SavedTable, Workbook, WorkbookProperties};
use std::io::{Read, Write};
use zip::write::FileOptions;
use zip::CompressionMethod;

/// Does any object in `workbook` carry a VISUAL CONTAINER (D-FORMAT)? A
/// slicer / timeline / floating grid with `container`; a pivot definition
/// (opaque JSON) with a non-null `canvas_frame.container`; a chart whose spec
/// (the ChartDefinition envelope, `{"spec": {...}}`) has a non-null
/// `spec.container`; a control with a NON-EMPTY `container*` property (an
/// empty value is the family default, so an older reader loses nothing --
/// and a default text box, whose create recipe uses only ordinary keys,
/// declares nothing).
fn workbook_carries_a_visual_container(workbook: &Workbook) -> bool {
    let non_null = |v: Option<&serde_json::Value>| v.is_some_and(|v| !v.is_null());
    workbook.slicers.iter().any(|s| s.container.is_some())
        || workbook.timeline_slicers.iter().any(|t| t.container.is_some())
        || workbook.floating_ranges.iter().any(|f| f.container.is_some())
        || workbook
            .pivot_definitions
            .iter()
            .any(|d| non_null(d.definition.pointer("/canvas_frame/container")))
        || workbook.charts.iter().any(|c| non_null(c.spec.pointer("/spec/container")))
        || workbook.controls.iter().any(|sheet| {
            sheet.controls.as_array().is_some_and(|entries| {
                entries.iter().any(|c| {
                    c.get("properties").and_then(|p| p.as_object()).is_some_and(|props| {
                        props.iter().any(|(key, prop)| {
                            visual_format::CONTROL_CONTAINER_PROPERTY_KEYS.contains(&key.as_str())
                                && prop.get("value").and_then(|v| v.as_str()).is_some_and(|v| !v.is_empty())
                        })
                    })
                })
            })
        })
}

/// Build the complete `.cala` ZIP into a byte buffer (no file I/O). The host
/// wraps this — optionally encrypting it — and writes it atomically.
pub fn write_calcula_bytes(workbook: &Workbook) -> Result<Vec<u8>, FormatError> {
    let mut buf = Vec::new();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
    let options = FileOptions::<()>::default().compression_method(CompressionMethod::Deflated);

    // Build manifest with sheet IDs
    let sheet_names: Vec<String> = workbook.sheets.iter().map(|s| s.name.clone()).collect();
    let sheet_ids: Vec<SheetId> = workbook.sheets.iter().map(|s| s.id).collect();
    let mut manifest = Manifest::from_sheets(&sheet_names, &sheet_ids, workbook.active_sheet);

    // Track which features are present
    if !workbook.tables.is_empty() {
        manifest.features.push("tables".to_string());
    }
    if !workbook.slicers.is_empty() {
        manifest.features.push("slicers".to_string());
    }
    if !workbook.ribbon_filters.is_empty() {
        manifest.features.push("ribbon_filters".to_string());
    }
    if !workbook.pane_controls.is_empty() {
        manifest.features.push("pane_controls".to_string());
    }
    if !workbook.scripts.is_empty() {
        manifest.features.push("scripts".to_string());
    }
    if !workbook.notebooks.is_empty() {
        manifest.features.push("notebooks".to_string());
    }
    if !workbook.charts.is_empty() {
        manifest.features.push("charts".to_string());
    }
    // Feature id only — see the floating_ranges.json write. (The rows' hidden
    // line sets alone take a version link, stamped in the block before the
    // manifest is written.)
    if !workbook.floating_ranges.is_empty() {
        manifest.features.push("floating_ranges".to_string());
    }
    // Feature id only, no version link. An older reader DROPS an unknown section
    // rather than misreading it -- `Manifest.features` is a bare `Vec<String>` with
    // no whitelist, nothing in the tree uses `deny_unknown_fields`, and unknown ZIP
    // entries are never enumerated. Losing a timeline loses a filter CONTROL, which
    // is visible loss, not a document that comes back looking calculated -- so it
    // takes a feature id, exactly as embedded media does.
    if !workbook.timeline_slicers.is_empty() {
        manifest.features.push("timeline_slicers".to_string());
    }
    if !workbook.pivot_layouts.is_empty() {
        manifest.features.push("pivot_layouts".to_string());
    }
    if !workbook.pivot_definitions.is_empty() {
        manifest.features.push("pivot_definitions".to_string());
    }
    if !workbook.bi_pivot_metadata.is_empty() {
        manifest.features.push("bi_pivot_metadata".to_string());
    }
    if !workbook.object_scripts.is_empty() {
        manifest.features.push("object_scripts".to_string());
    }
    if !workbook.bi_connection_roles.is_empty() {
        manifest.features.push("bi_connection_roles".to_string());
    }
    if !workbook.bi_connections.is_empty() {
        manifest.features.push("bi_connections".to_string());
    }
    if !workbook.bi_connection_caches.is_empty() {
        manifest.features.push("bi_connection_caches".to_string());
    }
    if !workbook.extension_data.is_empty() {
        manifest.features.push("extension_data".to_string());
    }
    if !workbook.user_files.is_empty() {
        manifest.features.push("files".to_string());
    }
    // Content-addressed binary media (pictures). A manifest FEATURE ID, and
    // DELIBERATELY NO LINK IN THE FORMAT-VERSION CHAIN.
    //
    // The chain's own test (manifest.rs, "why a feature ever gets a link"):
    // a link exists when an older reader would MISHANDLE the document, not
    // merely lose state. Weigh `media/` against the three sections that hold
    // links today. `pending_recalc` turns a knowingly-stale workbook into one
    // that silently claims to be calculated; `user_hidden` resurrects rows the
    // author hid to keep data out of a report; `sheet_display_flags` hands back
    // values where the author left formulas. Every one of them makes the
    // document LIE, invisibly.
    //
    // A dropped picture does none of that. The reader loses `media/`, the
    // control's `src` handle resolves to nothing, and a picture that is simply
    // NOT THERE is the loudest possible signal — nobody mistakes a missing logo
    // for a correct document. Visible loss, not silent corruption. Stamping v7
    // would instead make every workbook containing one image unopenable by an
    // older build, which is a strictly worse trade for the same information.
    //
    // The feature id still earns its keep: it lets `read_calcula_manifest`
    // answer "does this document carry embedded binary?" without materializing
    // the workbook, exactly as `scheduled_jobs` answers "does opening this run
    // code on a timer?". The READ below is nevertheless unconditional (the
    // named_ranges/sparklines precedent), so bytes written by a build that
    // forgot to push the id are still recovered rather than silently dropped.
    if !workbook.media.is_empty() {
        manifest.features.push("media".to_string());
    }
    // The prompts the author typed. A manifest FEATURE ID and DELIBERATELY NO
    // LINK IN THE FORMAT-VERSION CHAIN, for the reason the `media` block above
    // spells out: an older reader that drops this loses a LOG, it is not made
    // to lie. The id still earns its keep exactly as media's does — it lets
    // `read_calcula_manifest` answer "does this workbook carry the prompts its
    // author typed?" without materializing the workbook, which is a privacy
    // question someone should be able to answer before emailing a .cala.
    if workbook.user_files.contains_key(SCRIPT_AUTHORING_FILE) {
        manifest.features.push(SCRIPT_AUTHORING_FEATURE.to_string());
    }
    // Scheduled jobs ride in user_files (see features::scheduled_jobs for why
    // that home is the .calp firewall), but they get their OWN manifest feature
    // id and their own link in the format-version chain: "this document runs
    // code on a timer" must be answerable from the manifest alone, and a reader
    // that would silently drop the section has to fail the open instead.
    if workbook.user_files.contains_key(SCHEDULED_JOBS_FILE) {
        manifest.features.push(SCHEDULED_JOBS_FEATURE.to_string());
        stamp_feature_format_version(&mut manifest, SCHEDULED_JOBS_MIN_FORMAT_VERSION);
    }
    // The staleness marker gets a manifest feature id AND a version link for
    // the same reason the scheduler did: a reader that silently dropped it
    // would turn a knowingly-stale workbook into one that looks calculated.
    if workbook.pending_recalc.as_ref().is_some_and(|p| !p.cells.is_empty()) {
        manifest.features.push("pending_recalc".to_string());
        stamp_feature_format_version(&mut manifest, PENDING_RECALC_MIN_FORMAT_VERSION);
    }
    // User-hidden rows/columns: an authority that lives nowhere else, so an
    // older reader would not merely ignore it — it would rebuild the effective
    // hidden set from filter+outline on its next save and bring the user's
    // hidden rows back VISIBLE. Stamped only when a sheet actually carries one,
    // so ordinary workbooks stay openable by older builds.
    if workbook
        .sheets
        .iter()
        .any(|s| !s.user_hidden_rows.is_empty() || !s.user_hidden_cols.is_empty())
    {
        manifest.features.push("user_hidden".to_string());
        stamp_feature_format_version(&mut manifest, USER_HIDDEN_MIN_FORMAT_VERSION);
    }
    // Per-sheet zoom / split: same argument as the user-hidden sets. These
    // live nowhere but metadata.json, so an older reader would drop them on
    // its next save and hand the user back a 100%, single-pane workbook with
    // no error. Stamped only when a sheet actually carries one.
    if workbook.sheets.iter().any(|s| {
        (s.zoom - persistence::DEFAULT_SHEET_ZOOM_PERCENT).abs() >= 1e-9
            || s.split_row.is_some()
            || s.split_col.is_some()
    }) {
        manifest.features.push("sheet_view".to_string());
        stamp_feature_format_version(&mut manifest, SHEET_VIEW_MIN_FORMAT_VERSION);
    }
    // Per-sheet display flags: same argument again. Before v6 these four lived only in
    // the frontend reducer, so they were lost on every save; an older reader that
    // ignored them would drop them on its next save and silently hand back a sheet
    // showing values where the author left formulas. Stamped only when a sheet
    // actually carries a non-default flag, so ordinary workbooks stay v1-v5.
    if workbook.sheets.iter().any(|s| {
        !s.display_zeros
            || s.show_formulas
            || s.view_mode != persistence::DEFAULT_SHEET_VIEW_MODE
            || !s.display_headings
    }) {
        manifest.features.push("sheet_display_flags".to_string());
        stamp_feature_format_version(&mut manifest, SHEET_DISPLAY_FLAGS_MIN_FORMAT_VERSION);
    }
    // Dynamic-array spill extents. The strongest case in the chain: an older
    // reader drops `sp`, re-saves the spilled VALUES as ordinary literals, and
    // hands back a workbook whose arrays look right, are owned by nothing, and
    // collapse on the next re-evaluation of the origin (see
    // SPILL_EXTENT_MIN_FORMAT_VERSION). Stamped only when a cell actually
    // carries one, so a workbook with no dynamic array stays v1-v6.
    if workbook
        .sheets
        .iter()
        .any(|s| s.cells.values().any(|c| c.spill.is_some()))
    {
        manifest.features.push("spill_extents".to_string());
        stamp_feature_format_version(&mut manifest, SPILL_EXTENT_MIN_FORMAT_VERSION);
    }
    // Pinned filter levels. A pin exists so measures using CLEAR/RESET keep
    // respecting the filter; an older reader drops the level (and the pivot's
    // engine filter) on its next save, so those measures silently start
    // stripping it and the pivot comes back UNFILTERED on the pinned field —
    // wrong numbers with no error anywhere (see
    // PINNED_FILTER_MIN_FORMAT_VERSION). Stamped only when something is
    // actually pinned, so ordinary workbooks stay v1-v7.
    //
    // The `engine_filters` probe below is a synonym for "a pin exists" ONLY
    // while level-1 routing stays off (BUG-0108 in docs/design/open-items.md).
    // Enabling it would stamp v8 for ordinary BI workbooks — which would be
    // correct rather than incidental, since an older reader drops the engine
    // filter and the pivot comes back UNFILTERED with no error anywhere,
    // whatever level the filter sat on — but this sentence would need saying
    // differently.
    if workbook.slicers.iter().any(|s| s.filter_level > 1)
        || workbook.ribbon_filters.iter().any(|f| f.filter_level > 1)
        || workbook.pivot_definitions.iter().any(|d| {
            // The definition is opaque JSON here (persistence stays
            // decoupled from pivot-engine); probe the field directly.
            d.definition
                .get("engine_filters")
                .and_then(|v| v.as_array())
                .is_some_and(|a| !a.is_empty())
        })
    {
        manifest.features.push("pinned_filters".to_string());
        stamp_feature_format_version(&mut manifest, PINNED_FILTER_MIN_FORMAT_VERSION);
    }
    // Canvas sheets. An older reader ignores the unknown `kind` and presents
    // the canvas as an EDITABLE worksheet with its objects over an empty grid,
    // then drops the kind on its next save (see
    // CANVAS_SHEET_MIN_FORMAT_VERSION). Stamped only when a sheet actually is
    // a canvas, so ordinary workbooks stay v1-v8.
    if workbook.sheets.iter().any(|s| s.kind.is_canvas()) {
        manifest.features.push("canvas_sheets".to_string());
        stamp_feature_format_version(&mut manifest, CANVAS_SHEET_MIN_FORMAT_VERSION);
    }
    // A canvas's WALLPAPER and LOCK OBJECTS (CONTRACT-CANVAS 4.7): feature ids
    // and DELIBERATELY NO version link -- an older reader that drops them
    // loses a colour around the page or a drag lock, visible losses, never a
    // lie (see CANVAS_WALLPAPER_FEATURE). Each is declared only when some
    // canvas actually carries it. Both ride the sheet's own metadata.json, so
    // the read needs no id and is unconditional.
    let layouts = || workbook.sheets.iter().filter_map(|s| s.kind.canvas_layout());
    if layouts().any(|l| !l.wallpaper.is_empty()) {
        manifest.features.push(CANVAS_WALLPAPER_FEATURE.to_string());
    }
    if layouts().any(|l| l.objects_locked) {
        manifest.features.push(CANVAS_OBJECTS_LOCKED_FEATURE.to_string());
    }
    // VISUAL INTERACTIONS (P4) and a ribbon filter's "Selected visuals" list:
    // feature ids and, as decided, NO version link (see
    // CANVAS_INTERACTIONS_FEATURE for the recorded owner question). Each is
    // declared only when present; both ride records that are read
    // unconditionally (the sheet's metadata.json, the filter's own json).
    if layouts().any(|l| !l.interactions.is_default()) {
        manifest.features.push(CANVAS_INTERACTIONS_FEATURE.to_string());
    }
    if workbook.ribbon_filters.iter().any(|f| !f.connected_visuals.is_empty()) {
        manifest.features.push(RIBBON_FILTER_VISUAL_TARGETS_FEATURE.to_string());
    }
    // A PAGE NAVIGATOR control (D-NAV): a feature id and DELIBERATELY NO
    // version link -- an older reader paints the unknown control type as a
    // grey button that does nothing, a visible loss, never a lie (see
    // PAGE_NAVIGATOR_FEATURE). Declared only when some control actually is
    // one; controls.json is read unconditionally either way.
    if workbook.controls.iter().any(|s| {
        s.controls.as_array().is_some_and(|entries| {
            entries.iter().any(|c| {
                c.get("controlType").and_then(|t| t.as_str())
                    == Some(crate::page_navigator::PAGE_NAVIGATOR_CONTROL_TYPE)
            })
        })
    }) {
        manifest.features.push(PAGE_NAVIGATOR_FEATURE.to_string());
    }
    // The VISUAL CONTAINER (D-FORMAT) and the persisted PIVOT STYLE: feature
    // ids and DELIBERATELY NO version link -- an older reader drops a border,
    // a title, a shadow or a gallery style, a visible cosmetic loss, never a
    // lie (see VISUAL_CONTAINER_FEATURE). Each is declared only when some
    // object actually carries one; every field rides its own record, so the
    // read is unconditional.
    if workbook_carries_a_visual_container(workbook) {
        manifest.features.push(VISUAL_CONTAINER_FEATURE.to_string());
    }
    if workbook
        .pivot_definitions
        .iter()
        .any(|d| d.definition.get("style").is_some_and(|v| !v.is_null()))
    {
        manifest.features.push(PIVOT_STYLE_FEATURE.to_string());
    }
    // Object property BINDINGS (D-BIND): a feature id AND a version link. The
    // literal stays on each object's own record, so an older reader that
    // dropped bindings.json would paint the FROZEN literal of a property that
    // looks live -- the lie class (see OBJECT_BINDINGS_MIN_FORMAT_VERSION).
    // Stamped only when some binding exists.
    if !workbook.object_bindings.is_empty() {
        manifest.features.push(OBJECT_BINDINGS_FEATURE.to_string());
        stamp_feature_format_version(&mut manifest, OBJECT_BINDINGS_MIN_FORMAT_VERSION);
    }
    // charts.json rows embed the spec as a JSON OBJECT since v10. An older
    // reader cannot parse such a row at all (it requires the `specJson`
    // string), so the version link turns a raw serde failure into the clean
    // "newer version" refusal (see CHART_SPEC_OBJECT_MIN_FORMAT_VERSION). No
    // feature id: the shape change is not an optional feature.
    if !workbook.charts.is_empty() {
        stamp_feature_format_version(&mut manifest, CHART_SPEC_OBJECT_MIN_FORMAT_VERSION);
    }
    // Hidden lines on a floating grid (P3): a version link. An older reader
    // drops `hiddenRows`/`hiddenCols` and shows the rows the author HID -- the
    // lie class (see FLOATING_GRID_HIDDEN_LINES_MIN_FORMAT_VERSION). Stamped
    // only when some floating range carries a non-empty set. It MUST stay in
    // this block, before manifest.json is written below: the
    // floating_ranges.json write further down runs after the manifest has been
    // flushed into the ZIP, so a stamp placed there would change a manifest
    // nobody reads and the file would go out as the older version
    // (pinned by `a_hidden_line_stamp_reaches_the_written_manifest`).
    if workbook
        .floating_ranges
        .iter()
        .any(|f| !f.hidden_rows.is_empty() || !f.hidden_cols.is_empty())
    {
        stamp_feature_format_version(&mut manifest, FLOATING_GRID_HIDDEN_LINES_MIN_FORMAT_VERSION);
    }
    manifest.features.push("theme".to_string());

    // Store default dimensions in manifest
    manifest.default_row_height = workbook.default_row_height;
    manifest.default_column_width = workbook.default_column_width;

    // Write manifest.json
    let manifest_json = serde_json::to_string_pretty(&manifest)?;
    zip.start_file("manifest.json", options.clone())?;
    zip.write_all(manifest_json.as_bytes())?;

    // Write theme.json (document theme)
    let theme_json = serde_json::to_string_pretty(&workbook.theme)?;
    zip.start_file("theme.json", options.clone())?;
    zip.write_all(theme_json.as_bytes())?;

    // Write styles/registry.json (use first sheet's styles as the shared registry)
    if let Some(sheet) = workbook.sheets.first() {
        let registry_json = serialize_style_registry(&sheet.styles)?;
        zip.start_file("styles/registry.json", options.clone())?;
        zip.write_all(registry_json.as_bytes())?;
    }

    // Write each sheet
    for (i, sheet) in workbook.sheets.iter().enumerate() {
        let folder = &manifest.sheets[i].folder;
        let base_path = format!("sheets/{}", folder);

        // data.json — sparse cell values and formulas
        let sheet_data = cells_to_sheet_data(&sheet.cells);
        let data_json = serde_json::to_string_pretty(&sheet_data)?;
        zip.start_file(format!("{}/data.json", base_path), options.clone())?;
        zip.write_all(data_json.as_bytes())?;

        // styles.json — cell style index assignments
        let sheet_styles = cells_to_sheet_styles(&sheet.cells);
        if !sheet_styles.cells.is_empty() {
            let styles_json = serde_json::to_string_pretty(&sheet_styles)?;
            zip.start_file(format!("{}/styles.json", base_path), options.clone())?;
            zip.write_all(styles_json.as_bytes())?;
        }

        // layout.json — column widths, row heights, row/column style tiers
        let layout = SheetLayout::from_dimensions_and_styles(
            &sheet.column_widths,
            &sheet.row_heights,
            &sheet.row_styles,
            &sheet.column_styles,
        );
        if !layout.column_widths.is_empty()
            || !layout.row_heights.is_empty()
            || !layout.row_styles.is_empty()
            || !layout.column_styles.is_empty()
        {
            let layout_json = serde_json::to_string_pretty(&layout)?;
            zip.start_file(format!("{}/layout.json", base_path), options.clone())?;
            zip.write_all(layout_json.as_bytes())?;
        }

        // metadata.json — merges, freeze panes, hidden rows/cols, tab color,
        // visibility, notes, hyperlinks, page setup, gridlines. Without this
        // file the format silently dropped all of these (BUG-0018 etc.).
        let metadata = crate::sheet_metadata::SheetMetadata::from_sheet(sheet);
        if !metadata.is_default() {
            let metadata_json = serde_json::to_string_pretty(&metadata)?;
            zip.start_file(format!("{}/metadata.json", base_path), options.clone())?;
            zip.write_all(metadata_json.as_bytes())?;
        }
    }

    // Write tables
    for table in &workbook.tables {
        let table_def = TableDef::from(table);
        let table_json = serde_json::to_string_pretty(&table_def)?;
        zip.start_file(
            format!("tables/table_{}.json", table.id),
            options.clone(),
        )?;
        zip.write_all(table_json.as_bytes())?;
    }

    // Write slicers
    for slicer in &workbook.slicers {
        let slicer_def = SlicerDef::from(slicer);
        let slicer_json = serde_json::to_string_pretty(&slicer_def)?;
        zip.start_file(
            format!("slicers/slicer_{}.json", slicer.id),
            options.clone(),
        )?;
        zip.write_all(slicer_json.as_bytes())?;
    }

    // Write pivot layouts
    for layout in &workbook.pivot_layouts {
        let layout_def = PivotLayoutDef::from(layout);
        let layout_json = serde_json::to_string_pretty(&layout_def)?;
        zip.start_file(
            format!("pivot_layouts/layout_{}.json", layout.id),
            options.clone(),
        )?;
        zip.write_all(layout_json.as_bytes())?;
    }

    // Write full pivot definitions (PivotDefinition as JSON)
    for pivot_def in &workbook.pivot_definitions {
        let json = serde_json::to_string_pretty(pivot_def)?;
        zip.start_file(
            format!("pivot_definitions/def_{}.json", pivot_def.id),
            options.clone(),
        )?;
        zip.write_all(json.as_bytes())?;
    }

    // Write BI pivot metadata
    for (i, bi_meta) in workbook.bi_pivot_metadata.iter().enumerate() {
        let json = serde_json::to_string_pretty(bi_meta)?;
        zip.start_file(
            format!("bi_pivot_metadata/meta_{}.json", i),
            options.clone(),
        )?;
        zip.write_all(json.as_bytes())?;
    }

    // Write ribbon filters
    for ribbon_filter in &workbook.ribbon_filters {
        let filter_def = RibbonFilterDef::from(ribbon_filter);
        let filter_json = serde_json::to_string_pretty(&filter_def)?;
        zip.start_file(
            format!("ribbon_filters/filter_{}.json", ribbon_filter.id),
            options.clone(),
        )?;
        zip.write_all(filter_json.as_bytes())?;
    }

    // Write pane controls (Controls Pane)
    for pane_control in &workbook.pane_controls {
        let control_def = PaneControlDef::from(pane_control);
        let control_json = serde_json::to_string_pretty(&control_def)?;
        zip.start_file(
            format!("pane_controls/control_{}.json", pane_control.id),
            options.clone(),
        )?;
        zip.write_all(control_json.as_bytes())?;
    }

    // Write object scripts (scriptable objects)
    for obj_script in &workbook.object_scripts {
        let obj_script_def = ObjectScriptDef::from(obj_script);
        let obj_script_json = serde_json::to_string_pretty(&obj_script_def)?;
        zip.start_file(
            format!("object_scripts/script_{}.json", obj_script.id),
            options.clone(),
        )?;
        zip.write_all(obj_script_json.as_bytes())?;
    }

    // Write BI connection RLS roles (subscriber "view as" selections)
    if !workbook.bi_connection_roles.is_empty() {
        let roles_json = serde_json::to_string_pretty(&workbook.bi_connection_roles)?;
        zip.start_file("bi_connection_roles.json", options.clone())?;
        zip.write_all(roles_json.as_bytes())?;
    }

    // Write locally-authored BI connections (embedded model + spec + bindings).
    // One file each — embedded models can be large.
    for (i, conn) in workbook.bi_connections.iter().enumerate() {
        let conn_json = serde_json::to_string_pretty(conn)?;
        zip.start_file(format!("bi_connections/conn_{}.json", i), options.clone())?;
        zip.write_all(conn_json.as_bytes())?;
    }

    // Write embedded BI cache blobs as raw binary entries under
    // bi_cache/{connId}/{relfile} (connId is a UUID, relfile is an engine-
    // sanitized cache file name — neither contains path separators).
    for (conn_id, files) in &workbook.bi_connection_caches {
        for (rel, bytes) in files {
            zip.start_file(format!("bi_cache/{}/{}", conn_id, rel), options.clone())?;
            zip.write_all(bytes)?;
        }
    }

    // Write content-addressed media blobs as raw binary entries under
    // media/{sha256}. Modelled on bi_cache/{connId}/{relfile} above: raw bytes,
    // no JSON envelope, recovered by a prefix scan.
    //
    // STORED, not Deflated, and this is not a micro-optimisation: every format
    // the validator admits (PNG/JPEG/GIF/WebP) is ALREADY entropy-coded, so
    // deflating it burns CPU proportional to the image on every single save and
    // typically grows the entry. The archive is written on the user's Ctrl+S
    // path, so that cost is paid in front of them.
    //
    // The key is the SHA-256 the writer of the map computed, so the file NAME is
    // the integrity check: a reader can re-hash the bytes and compare with no
    // side table. It is also hex, so it is inert as a path component — no
    // separators, no traversal, nothing to sanitize.
    {
        let stored = FileOptions::<()>::default().compression_method(CompressionMethod::Stored);
        // Deterministic entry order across saves — a HashMap iteration order
        // would churn the archive bytes for identical content.
        let mut hashes: Vec<&String> = workbook.media.keys().collect();
        hashes.sort();
        for hash in hashes {
            let bytes = &workbook.media[hash];
            zip.start_file(format!("media/{}", hash), stored.clone())?;
            zip.write_all(bytes)?;
        }
    }

    // Write scripts
    for script in &workbook.scripts {
        let script_def = ScriptDef::from(script);
        let script_json = serde_json::to_string_pretty(&script_def)?;
        zip.start_file(
            format!("scripts/script_{}.json", script.id),
            options.clone(),
        )?;
        zip.write_all(script_json.as_bytes())?;
    }

    // Write notebooks
    for notebook in &workbook.notebooks {
        let notebook_def = NotebookDef::from(notebook);
        let notebook_json = serde_json::to_string_pretty(&notebook_def)?;
        zip.start_file(
            format!("notebooks/notebook_{}.json", notebook.id),
            options.clone(),
        )?;
        zip.write_all(notebook_json.as_bytes())?;
    }

    // Write charts as a single charts.json array
    if !workbook.charts.is_empty() {
        let charts_json = serde_json::to_string_pretty(&workbook.charts)?;
        zip.start_file("charts.json", options.clone())?;
        zip.write_all(charts_json.as_bytes())?;
    }

    // Object property bindings (v10; feature id + version link above). Written
    // sorted by (object, path) so an unchanged store is byte-stable whatever
    // order the host collected it in. Read unconditionally below.
    if !workbook.object_bindings.is_empty() {
        let mut bindings: Vec<&persistence::SavedObjectBinding> =
            workbook.object_bindings.iter().collect();
        bindings.sort_by(|a, b| (&a.object, &a.path).cmp(&(&b.object, &b.path)));
        let json = serde_json::to_string_pretty(&bindings)?;
        zip.start_file("bindings.json", options.clone())?;
        zip.write_all(json.as_bytes())?;
    }

    // Floating range object rows. A manifest FEATURE ID with NO format-version
    // link of its own (the media precedent): an older reader drops the rows and
    // the backing sheets load as non-visible sheets with intact values — visible
    // LOSS, not misinterpretation. The one exception, the rows' hidden line
    // sets, is stamped BEFORE manifest.json is written (never here: the
    // manifest is already in the ZIP by now). The read below is unconditional
    // (named_ranges/sparklines precedent) so bytes written by a build that
    // forgot the id are still recovered.
    if !workbook.floating_ranges.is_empty() {
        let json = serde_json::to_string_pretty(&workbook.floating_ranges)?;
        zip.start_file("floating_ranges.json", options.clone())?;
        zip.write_all(json.as_bytes())?;
    }

    // Timeline slicers. Feature id above, section here, unconditional read below.
    if !workbook.timeline_slicers.is_empty() {
        let json = serde_json::to_string_pretty(&workbook.timeline_slicers)?;
        zip.start_file("timeline_slicers.json", options.clone())?;
        zip.write_all(json.as_bytes())?;
    }

    // Write named ranges (defined names) as a single named_ranges.json array.
    // Read unconditionally on load (like sparklines), so no manifest feature flag
    // is needed and older files without the artifact load as an empty set.
    if !workbook.named_ranges.is_empty() {
        let named_ranges_json = serde_json::to_string_pretty(&workbook.named_ranges)?;
        zip.start_file("named_ranges.json", options.clone())?;
        zip.write_all(named_ranges_json.as_bytes())?;
    }

    // Write conditional formats + data validations (per-sheet, opaque payloads).
    // Same unconditional-read pattern as named_ranges/sparklines.
    if !workbook.conditional_formats.is_empty() {
        let cf_json = serde_json::to_string_pretty(&workbook.conditional_formats)?;
        zip.start_file("conditional_formats.json", options.clone())?;
        zip.write_all(cf_json.as_bytes())?;
    }
    if !workbook.data_validations.is_empty() {
        let dv_json = serde_json::to_string_pretty(&workbook.data_validations)?;
        zip.start_file("data_validations.json", options.clone())?;
        zip.write_all(dv_json.as_bytes())?;
    }
    // The staleness marker left by a cancelled recalculation. Written ONLY when
    // non-empty, so a fully-calculated workbook carries no entry at all and the
    // absence of the file is itself the "this workbook is calculated" statement.
    if let Some(pending) = workbook.pending_recalc.as_ref().filter(|p| !p.cells.is_empty()) {
        let pending_json = serde_json::to_string_pretty(pending)?;
        zip.start_file("pending_recalc.json", options.clone())?;
        zip.write_all(pending_json.as_bytes())?;
    }
    if !workbook.sheet_protections.is_empty() {
        let prot_json = serde_json::to_string_pretty(&workbook.sheet_protections)?;
        zip.start_file("sheet_protections.json", options.clone())?;
        zip.write_all(prot_json.as_bytes())?;
    }
    if let Some(ref wb_prot) = workbook.workbook_protection {
        let wb_prot_json = serde_json::to_string_pretty(wb_prot)?;
        zip.start_file("workbook_protection.json", options.clone())?;
        zip.write_all(wb_prot_json.as_bytes())?;
    }
    if !workbook.controls.is_empty() {
        let controls_json = serde_json::to_string_pretty(&workbook.controls)?;
        zip.start_file("controls.json", options.clone())?;
        zip.write_all(controls_json.as_bytes())?;
    }
    if !workbook.cell_types.is_empty() {
        let cell_types_json = serde_json::to_string_pretty(&workbook.cell_types)?;
        zip.start_file("cell_types.json", options.clone())?;
        zip.write_all(cell_types_json.as_bytes())?;
    }
    if !workbook.cell_behaviors.is_empty() {
        let cell_behaviors_json = serde_json::to_string_pretty(&workbook.cell_behaviors)?;
        zip.start_file("cell_behaviors.json", options.clone())?;
        zip.write_all(cell_behaviors_json.as_bytes())?;
    }
    if !workbook.comments.is_empty() {
        let comments_json = serde_json::to_string_pretty(&workbook.comments)?;
        zip.start_file("comments.json", options.clone())?;
        zip.write_all(comments_json.as_bytes())?;
    }
    if !workbook.scenarios.is_empty() {
        let scenarios_json = serde_json::to_string_pretty(&workbook.scenarios)?;
        zip.start_file("scenarios.json", options.clone())?;
        zip.write_all(scenarios_json.as_bytes())?;
    }
    if !workbook.outlines.is_empty() {
        let outlines_json = serde_json::to_string_pretty(&workbook.outlines)?;
        zip.start_file("outlines.json", options.clone())?;
        zip.write_all(outlines_json.as_bytes())?;
    }

    // Write generic per-extension state as a single extension-data.json object
    if !workbook.extension_data.is_empty() {
        let extension_data_json = serde_json::to_string_pretty(&workbook.extension_data)?;
        zip.start_file("extension-data.json", options.clone())?;
        zip.write_all(extension_data_json.as_bytes())?;
    }

    // Write sparklines as a single sparklines.json array
    if !workbook.sparklines.is_empty() {
        let sparklines_json = serde_json::to_string_pretty(&workbook.sparklines)?;
        zip.start_file("sparklines.json", options.clone())?;
        zip.write_all(sparklines_json.as_bytes())?;
    }

    // Write workbook properties (properties.json)
    let props_json = serde_json::to_string_pretty(&workbook.properties)?;
    zip.start_file("properties.json", options.clone())?;
    zip.write_all(props_json.as_bytes())?;

    // Write user files (stored under files/ prefix)
    for (path, content) in &workbook.user_files {
        zip.start_file(format!("files/{}", path), options.clone())?;
        zip.write_all(content)?;
    }

    zip.finish()?; // consumes `zip`, releasing the &mut borrow of `buf`
    Ok(buf)
}

/// Read ONLY `manifest.json` out of plain `.cala` ZIP bytes.
///
/// Cheap enough to answer questions about a file without materializing the
/// workbook — including the transparency question this exists for: "does this
/// document declare the `scheduled_jobs` feature, i.e. does opening it arm code
/// on a timer?" Does no version gating on purpose; the caller decides whether an
/// unsupported version is fatal, and a version this build cannot open is exactly
/// when reading the manifest is most useful.
pub fn read_calcula_manifest(bytes: &[u8]) -> Result<Manifest, FormatError> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    let mut entry = archive
        .by_name("manifest.json")
        .map_err(|_| FormatError::MissingEntry("manifest.json".to_string()))?;
    let mut contents = String::new();
    entry.read_to_string(&mut contents)?;
    Ok(serde_json::from_str(&contents)?)
}

/// Parse a Workbook from `.cala` ZIP bytes (no file I/O). The host reads the
/// file, decrypts if needed, then calls this on the plain ZIP bytes.
pub fn read_calcula_bytes(bytes: &[u8]) -> Result<Workbook, FormatError> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;

    // Read manifest.json
    let manifest: Manifest = {
        let mut entry = archive
            .by_name("manifest.json")
            .map_err(|_| FormatError::MissingEntry("manifest.json".to_string()))?;
        let mut contents = String::new();
        entry.read_to_string(&mut contents)?;
        serde_json::from_str(&contents)?
    };

    // Read forward within the chain, refuse beyond it. A file stamped above
    // what this build understands may contain a section we would drop on the
    // next save (see the manifest's format-version chain notes); failing the
    // open is the only outcome that cannot silently destroy the user's data.
    if manifest.format_version < CALA_BASE_FORMAT_VERSION
        || manifest.format_version > CALA_MAX_SUPPORTED_FORMAT_VERSION
    {
        return Err(FormatError::InvalidFormat(format!(
            "Unsupported format version: {} (this build reads {}..={})",
            manifest.format_version,
            CALA_BASE_FORMAT_VERSION,
            CALA_MAX_SUPPORTED_FORMAT_VERSION
        )));
    }

    // Read theme.json (document theme)
    let theme = read_optional_json::<ThemeDefinition>(&mut archive, "theme.json")?
        .unwrap_or_default();

    // Read styles/registry.json
    let style_list = read_optional_json::<Vec<engine::style::CellStyle>>(
        &mut archive,
        "styles/registry.json",
    )?
    .unwrap_or_else(|| vec![engine::style::CellStyle::new()]);

    // Read each sheet
    let mut sheets = Vec::new();
    for sheet_entry in &manifest.sheets {
        let base_path = format!("sheets/{}", sheet_entry.folder);

        // data.json
        let sheet_data = read_optional_json::<SheetData>(&mut archive, &format!("{}/data.json", base_path))?
            .unwrap_or(SheetData {
                cells: std::collections::BTreeMap::new(),
            });
        let mut cells = sheet_data_to_cells(&sheet_data);

        // styles.json
        if let Some(sheet_styles) =
            read_optional_json::<SheetStyles>(&mut archive, &format!("{}/styles.json", base_path))?
        {
            apply_sheet_styles(&mut cells, &sheet_styles);
        }

        // layout.json
        let layout = read_optional_json::<SheetLayout>(
            &mut archive,
            &format!("{}/layout.json", base_path),
        )?
        .unwrap_or(SheetLayout {
            column_widths: std::collections::BTreeMap::new(),
            row_heights: std::collections::BTreeMap::new(),
            row_styles: std::collections::BTreeMap::new(),
            column_styles: std::collections::BTreeMap::new(),
        });
        let (col_widths, row_heights) = layout.to_dimensions();
        let (sheet_row_styles, sheet_column_styles) = layout.to_style_tiers();

        // Use stored sheet_id or mint a fresh one for old .cala files
        let sheet_id = sheet_entry.sheet_id.unwrap_or_else(|| {
            SheetId::from_bytes(identity::generate_uuid_v7())
        });

        let mut sheet = persistence::Sheet {
            id: sheet_id,
            name: sheet_entry.name.clone(),
            cells,
            row_styles: sheet_row_styles,
            column_styles: sheet_column_styles,
            column_widths: col_widths,
            row_heights: row_heights,
            styles: style_list.clone(),
            merged_regions: Vec::new(),
            freeze_row: None,
            freeze_col: None,
            hidden_rows: std::collections::HashSet::new(),
            hidden_cols: std::collections::HashSet::new(),
            user_hidden_rows: std::collections::HashSet::new(),
            user_hidden_cols: std::collections::HashSet::new(),
            tab_color: String::new(),
            visibility: "visible".to_string(),
            notes: Vec::new(),
            hyperlinks: Vec::new(),
            page_setup: None,
            show_gridlines: true,
            // Overwritten below by metadata.json when the sheet carries any.
            zoom: persistence::DEFAULT_SHEET_ZOOM_PERCENT,
            // Defaults here; the real values arrive from metadata.json below via
            // SheetMetadata::apply_to_sheet, exactly like zoom and the split bars.
            display_zeros: true,
            show_formulas: false,
            view_mode: persistence::DEFAULT_SHEET_VIEW_MODE.to_string(),
            display_headings: true,
            split_row: None,
            split_col: None,
            kind: persistence::SheetKind::Worksheet,
        };

        // metadata.json — merges, freeze, split, zoom, hidden rows/cols, tab
        // color, visibility, notes, hyperlinks, page setup, gridlines
        if let Some(metadata) = read_optional_json::<crate::sheet_metadata::SheetMetadata>(
            &mut archive,
            &format!("{}/metadata.json", base_path),
        )? {
            metadata.apply_to_sheet(&mut sheet);
        }

        sheets.push(sheet);
    }

    // Read tables
    let mut tables: Vec<SavedTable> = Vec::new();
    if manifest.features.contains(&"tables".to_string()) {
        // Scan for table files
        let table_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("tables/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for table_name in table_names {
            if let Some(table_def) = read_optional_json::<TableDef>(&mut archive, &table_name)? {
                tables.push(SavedTable::from(&table_def));
            }
        }
    }

    // Read slicers
    let mut slicers: Vec<SavedSlicer> = Vec::new();
    if manifest.features.contains(&"slicers".to_string()) {
        let slicer_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("slicers/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for slicer_name in slicer_names {
            if let Some(slicer_def) = read_optional_json::<SlicerDef>(&mut archive, &slicer_name)? {
                slicers.push(SavedSlicer::from(&slicer_def));
            }
        }
    }

    // Read pivot layouts
    let mut pivot_layouts: Vec<SavedPivotLayout> = Vec::new();
    if manifest.features.contains(&"pivot_layouts".to_string()) {
        let layout_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("pivot_layouts/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for layout_name in layout_names {
            if let Some(layout_def) = read_optional_json::<PivotLayoutDef>(&mut archive, &layout_name)? {
                pivot_layouts.push(SavedPivotLayout::from(&layout_def));
            }
        }
    }

    // Read full pivot definitions
    let mut pivot_definitions: Vec<persistence::SavedPivotDefinition> = Vec::new();
    if manifest.features.contains(&"pivot_definitions".to_string()) {
        let def_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("pivot_definitions/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for def_name in def_names {
            if let Some(def) = read_optional_json::<persistence::SavedPivotDefinition>(&mut archive, &def_name)? {
                pivot_definitions.push(def);
            }
        }
    }

    // Read BI pivot metadata
    let mut bi_pivot_metadata: Vec<serde_json::Value> = Vec::new();
    if manifest.features.contains(&"bi_pivot_metadata".to_string()) {
        let meta_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("bi_pivot_metadata/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for meta_name in meta_names {
            if let Some(meta) = read_optional_json::<serde_json::Value>(&mut archive, &meta_name)? {
                bi_pivot_metadata.push(meta);
            }
        }
    }

    // Read object scripts (scriptable objects)
    let mut object_scripts: Vec<SavedObjectScript> = Vec::new();
    if manifest.features.contains(&"object_scripts".to_string()) {
        let obj_script_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("object_scripts/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for obj_script_name in obj_script_names {
            if let Some(obj_script_def) = read_optional_json::<ObjectScriptDef>(&mut archive, &obj_script_name)? {
                object_scripts.push(SavedObjectScript::from(&obj_script_def));
            }
        }
    }

    // Read BI connection RLS roles
    let mut bi_connection_roles: Vec<persistence::SavedBiConnectionRole> = Vec::new();
    if manifest.features.contains(&"bi_connection_roles".to_string()) {
        if let Some(roles) = read_optional_json::<Vec<persistence::SavedBiConnectionRole>>(
            &mut archive,
            "bi_connection_roles.json",
        )? {
            bi_connection_roles = roles;
        }
    }

    // Read locally-authored BI connections (embedded models)
    let mut bi_connections: Vec<persistence::SavedBiConnection> = Vec::new();
    if manifest.features.contains(&"bi_connections".to_string()) {
        let conn_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("bi_connections/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();
        for conn_name in conn_names {
            if let Some(conn) =
                read_optional_json::<persistence::SavedBiConnection>(&mut archive, &conn_name)?
            {
                bi_connections.push(conn);
            }
        }
    }

    // Read embedded BI cache blobs: bi_cache/{connId}/{relfile} -> raw bytes
    let mut bi_connection_caches: std::collections::HashMap<String, std::collections::HashMap<String, Vec<u8>>> = std::collections::HashMap::new();
    if manifest.features.contains(&"bi_connection_caches".to_string()) {
        let cache_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("bi_cache/") && !name.ends_with('/') {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();
        for name in cache_names {
            // bi_cache/{connId}/{rel}
            let rest = &name["bi_cache/".len()..];
            let Some(slash) = rest.find('/') else { continue };
            let conn_id = rest[..slash].to_string();
            let rel = rest[slash + 1..].to_string();
            if conn_id.is_empty() || rel.is_empty() {
                continue;
            }
            let mut entry = archive.by_name(&name).map_err(FormatError::Zip)?;
            let mut content = Vec::new();
            entry.read_to_end(&mut content)?;
            bi_connection_caches.entry(conn_id).or_default().insert(rel, content);
        }
    }

    // Read content-addressed media blobs: media/{sha256} -> raw bytes.
    //
    // UNCONDITIONAL — no `manifest.features` gate — following the
    // named_ranges/sparklines precedent rather than the bi_cache one. The
    // feature id is written for the manifest-only question ("does this document
    // carry embedded binary?"), but gating the read on it would mean a single
    // missed `features.push` silently discards the user's pictures on the next
    // save. An archive with no media/ entries simply loads an empty map, which
    // is exactly what every pre-media `.cala` produces.
    //
    // The entry NAME is the content hash the writer computed. It is NOT
    // re-verified here: `.cala` integrity is the archive's problem (and, when
    // encrypted, the AEAD tag's), and a mismatch would leave us choosing between
    // discarding the user's picture and failing their open. The `.calp` path,
    // where the bytes crossed a trust boundary, DOES verify — that is what
    // `verify_version_artifacts` is for.
    let mut media: std::collections::HashMap<String, Vec<u8>> = std::collections::HashMap::new();
    {
        let media_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("media/") && !name.ends_with('/') {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();
        for name in media_names {
            let key = name["media/".len()..].to_string();
            // Sub-paths under media/ are not part of the layout; a flat hash is
            // the only shape written. Skip anything else rather than inventing
            // a meaning for it.
            if key.is_empty() || key.contains('/') {
                continue;
            }
            let mut entry = archive.by_name(&name).map_err(FormatError::Zip)?;
            let mut content = Vec::new();
            entry.read_to_end(&mut content)?;
            media.insert(key, content);
        }
    }

    // Read ribbon filters
    let mut ribbon_filters: Vec<SavedRibbonFilter> = Vec::new();
    if manifest.features.contains(&"ribbon_filters".to_string()) {
        let filter_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("ribbon_filters/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for filter_name in filter_names {
            if let Some(filter_def) = read_optional_json::<RibbonFilterDef>(&mut archive, &filter_name)? {
                ribbon_filters.push(SavedRibbonFilter::from(&filter_def));
            }
        }
    }

    // Read pane controls (Controls Pane). Old files without the feature flag
    // load as an empty list.
    let mut pane_controls: Vec<SavedPaneControl> = Vec::new();
    if manifest.features.contains(&"pane_controls".to_string()) {
        let control_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("pane_controls/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for control_name in control_names {
            if let Some(control_def) = read_optional_json::<PaneControlDef>(&mut archive, &control_name)? {
                pane_controls.push(SavedPaneControl::from(&control_def));
            }
        }
    }

    // Read scripts
    let mut scripts: Vec<SavedScript> = Vec::new();
    if manifest.features.contains(&"scripts".to_string()) {
        let script_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("scripts/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for script_name in script_names {
            if let Some(script_def) = read_optional_json::<ScriptDef>(&mut archive, &script_name)? {
                scripts.push(SavedScript::from(&script_def));
            }
        }
    }

    // Read notebooks
    let mut notebooks: Vec<SavedNotebook> = Vec::new();
    if manifest.features.contains(&"notebooks".to_string()) {
        let notebook_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("notebooks/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for notebook_name in notebook_names {
            if let Some(notebook_def) = read_optional_json::<NotebookDef>(&mut archive, &notebook_name)? {
                notebooks.push(SavedNotebook::from(&notebook_def));
            }
        }
    }

    // Read charts (rows whose `spec` is an embedded object since v10; a
    // pre-v10 row's `specJson` string is upgraded in place -- read_saved_charts).
    let charts: Vec<SavedChart> = if manifest.features.contains(&"charts".to_string()) {
        read_saved_charts(&mut archive)?
    } else {
        Vec::new()
    };

    // Object property bindings (v10) -- UNCONDITIONALLY, the named_ranges
    // precedent: a build that wrote the section but forgot the feature id
    // still gets its bindings back.
    let object_bindings: Vec<persistence::SavedObjectBinding> =
        read_optional_json(&mut archive, "bindings.json")?.unwrap_or_default();

    // Read floating range rows — UNCONDITIONALLY (the named_ranges/sparklines
    // precedent): a build that wrote the section but forgot the feature id
    // still gets its objects back.
    let floating_ranges: Vec<persistence::SavedFloatingRange> =
        read_optional_json(&mut archive, "floating_ranges.json")?.unwrap_or_default();

    // Timeline slicers -- UNCONDITIONALLY, same precedent: a build that wrote the
    // section but forgot the feature id still gets its timelines back.
    let timeline_slicers: Vec<persistence::SavedTimelineSlicer> =
        read_optional_json(&mut archive, "timeline_slicers.json")?.unwrap_or_default();

    // Read sparklines
    let sparklines: Vec<SavedSparkline> =
        read_optional_json::<Vec<SavedSparkline>>(&mut archive, "sparklines.json")?
            .unwrap_or_default();

    // Read named ranges (defined names)
    let named_ranges: Vec<persistence::SavedNamedRange> =
        read_optional_json::<Vec<persistence::SavedNamedRange>>(&mut archive, "named_ranges.json")?
            .unwrap_or_default();

    // Read conditional formats + data validations (per-sheet, opaque payloads)
    let conditional_formats: Vec<persistence::SavedSheetConditionalFormats> =
        read_optional_json::<Vec<persistence::SavedSheetConditionalFormats>>(&mut archive, "conditional_formats.json")?
            .unwrap_or_default();
    let data_validations: Vec<persistence::SavedSheetDataValidations> =
        read_optional_json::<Vec<persistence::SavedSheetDataValidations>>(&mut archive, "data_validations.json")?
            .unwrap_or_default();

    // Absent for any workbook that was fully calculated when it was saved.
    let pending_recalc: Option<persistence::SavedPendingRecalc> =
        read_optional_json::<persistence::SavedPendingRecalc>(&mut archive, "pending_recalc.json")?;
    let controls: Vec<persistence::SavedSheetControls> =
        read_optional_json::<Vec<persistence::SavedSheetControls>>(&mut archive, "controls.json")?
            .unwrap_or_default();
    let cell_types: Vec<persistence::SavedSheetCellTypes> =
        read_optional_json::<Vec<persistence::SavedSheetCellTypes>>(&mut archive, "cell_types.json")?
            .unwrap_or_default();
    let cell_behaviors: Vec<persistence::SavedCellBehavior> =
        read_optional_json::<Vec<persistence::SavedCellBehavior>>(&mut archive, "cell_behaviors.json")?
            .unwrap_or_default();
    let comments: Vec<persistence::SavedSheetComments> =
        read_optional_json::<Vec<persistence::SavedSheetComments>>(&mut archive, "comments.json")?
            .unwrap_or_default();
    let scenarios: Vec<persistence::SavedSheetScenarios> =
        read_optional_json::<Vec<persistence::SavedSheetScenarios>>(&mut archive, "scenarios.json")?
            .unwrap_or_default();
    let outlines: Vec<persistence::SavedSheetOutline> =
        read_optional_json::<Vec<persistence::SavedSheetOutline>>(&mut archive, "outlines.json")?
            .unwrap_or_default();
    let sheet_protections: Vec<persistence::SavedSheetProtection> =
        read_optional_json::<Vec<persistence::SavedSheetProtection>>(
            &mut archive,
            "sheet_protections.json",
        )?
        .unwrap_or_default();
    let workbook_protection: Option<serde_json::Value> =
        read_optional_json::<serde_json::Value>(&mut archive, "workbook_protection.json")?;

    // Read user files (files/ prefix)
    let mut user_files = std::collections::HashMap::new();
    if manifest.features.contains(&"files".to_string()) {
        let file_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("files/") && name.len() > 6 && !name.ends_with('/') {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for file_name in file_names {
            let mut entry = archive.by_name(&file_name)
                .map_err(|e| FormatError::Zip(e))?;
            let mut content = Vec::new();
            entry.read_to_end(&mut content)?;
            // Strip the "files/" prefix
            let relative_path = file_name[6..].to_string();
            user_files.insert(relative_path, content);
        }
    }

    // Read workbook properties
    let properties = read_optional_json::<WorkbookProperties>(&mut archive, "properties.json")?
        .unwrap_or_default();

    // Read generic per-extension persisted state (opaque per-extension JSON blobs).
    let extension_data = read_optional_json::<std::collections::HashMap<String, serde_json::Value>>(
        &mut archive,
        "extension-data.json",
    )?
    .unwrap_or_default();

    Ok(Workbook {
        sheets,
        active_sheet: manifest.active_sheet,
        tables,
        slicers,
        timeline_slicers,
        ribbon_filters,
        pane_controls,
        user_files,
        theme,
        scripts,
        notebooks,
        default_row_height: manifest.default_row_height,
        default_column_width: manifest.default_column_width,
        properties,
        charts,
        sparklines,
        floating_ranges,
        named_ranges,
        pivot_layouts,
        pivot_definitions,
        bi_pivot_metadata,
        object_scripts,
        bi_connection_roles,
        bi_connections,
        bi_connection_caches,
        media,
        extension_data,
        conditional_formats,
        data_validations,
        controls,
        cell_types,
        cell_behaviors,
        comments,
        scenarios,
        outlines,
        sheet_protections,
        workbook_protection,
        pending_recalc,
        // The version this file WAS written at, carried inbound so the host's
        // load path can run a one-time recovery for anything a pre-feature
        // writer could not record. Never read by the writer.
        format_version: manifest.format_version,
        object_bindings,
    })
}

/// The sentence every `charts.json` read failure starts with. Never the bare
/// serde text: a user opening a workbook must learn WHICH part of the file
/// could not be read.
const CHARTS_JSON_UNREADABLE: &str = "charts.json in this file could not be read";

/// Read `charts.json` (absent -> empty). Reads the rows as plain JSON values
/// first and upgrades any pre-v10 row in place ([`upgrade_saved_chart_rows`])
/// before the typed deserialise, so a workbook saved before the spec became an
/// embedded object still opens. Any failure is reported as
/// "charts.json in this file could not be read: <reason>".
fn read_saved_charts(
    archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>,
) -> Result<Vec<SavedChart>, FormatError> {
    let rows: Option<Vec<serde_json::Value>> = match read_optional_json(archive, "charts.json") {
        Ok(rows) => rows,
        Err(FormatError::Json(e)) => {
            return Err(FormatError::InvalidFormat(format!("{CHARTS_JSON_UNREADABLE}: {e}")));
        }
        Err(other) => return Err(other),
    };
    match rows {
        None => Ok(Vec::new()),
        Some(rows) => upgrade_saved_chart_rows(rows).map_err(FormatError::InvalidFormat),
    }
}

/// Pure: turn raw `charts.json` rows into `SavedChart`s. A row that carries
/// the pre-v10 `specJson` STRING and no `spec` is upgraded in place: `spec`
/// becomes the parsed JSON, or -- when the string is not JSON -- a
/// `Value::String` of the raw text (logged, never dropped). Any row that still
/// fails the typed deserialise yields the "charts.json in this file could not
/// be read: <reason>" sentence (the `Err` text, ready for `InvalidFormat`).
pub(crate) fn upgrade_saved_chart_rows(
    rows: Vec<serde_json::Value>,
) -> Result<Vec<SavedChart>, String> {
    rows.into_iter()
        .enumerate()
        .map(|(index, mut row)| {
            if let Some(obj) = row.as_object_mut() {
                if !obj.contains_key("spec") {
                    if let Some(serde_json::Value::String(raw)) = obj.remove("specJson") {
                        let spec = serde_json::from_str::<serde_json::Value>(&raw)
                            .unwrap_or_else(|e| {
                                eprintln!(
                                    "[WARN] charts.json row {index}: specJson is not JSON ({e}); \
                                     kept as a string"
                                );
                                serde_json::Value::String(raw)
                            });
                        obj.insert("spec".to_string(), spec);
                    }
                }
            }
            serde_json::from_value::<SavedChart>(row)
                .map_err(|e| format!("{CHARTS_JSON_UNREADABLE}: chart {}: {e}", index + 1))
        })
        .collect()
}

/// Read an optional JSON file from the archive. Returns None if the file doesn't exist.
fn read_optional_json<T: serde::de::DeserializeOwned>(
    archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>,
    name: &str,
) -> Result<Option<T>, FormatError> {
    match archive.by_name(name) {
        Ok(mut entry) => {
            let mut contents = String::new();
            entry.read_to_string(&mut contents)?;
            let value = serde_json::from_str(&contents)?;
            Ok(Some(value))
        }
        Err(zip::result::ZipError::FileNotFound) => Ok(None),
        Err(e) => Err(FormatError::Zip(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use persistence::{SavedCell, SavedCellValue};
    use std::collections::HashMap;

    // Test shims: the public file API moved to the crate root (save_calcula /
    // load_calcula), and zip_io is now bytes-first. These keep the existing
    // round-trip tests writing/reading a real temp file via the bytes API.
    fn write_calcula(workbook: &Workbook, path: &std::path::Path) -> Result<(), FormatError> {
        std::fs::write(path, write_calcula_bytes(workbook)?)?;
        Ok(())
    }
    fn read_calcula(path: &std::path::Path) -> Result<Workbook, FormatError> {
        read_calcula_bytes(&std::fs::read(path)?)
    }

    fn make_test_workbook() -> Workbook {
        let mut cells = HashMap::new();
        cells.insert(
            (0, 0),
            SavedCell {
                value: SavedCellValue::Text("Name".to_string()),
                formula: None,
                style_index: 1,
                rich_text: None,
                spill: None,
            },
        );
        cells.insert(
            (0, 1),
            SavedCell {
                value: SavedCellValue::Text("Value".to_string()),
                formula: None,
                style_index: 1,
                rich_text: None,
                spill: None,
            },
        );
        cells.insert(
            (1, 0),
            SavedCell {
                value: SavedCellValue::Text("Revenue".to_string()),
                formula: None,
                style_index: 0,
                rich_text: None,
                spill: None,
            },
        );
        cells.insert(
            (1, 1),
            SavedCell {
                value: SavedCellValue::Number(42500.0),
                formula: Some("=SUM(C2:C100)".to_string()),
                style_index: 2,
                rich_text: None,
                spill: None,
            },
        );
        cells.insert(
            (2, 0),
            SavedCell {
                value: SavedCellValue::Boolean(true),
                formula: None,
                style_index: 0,
                rich_text: None,
                spill: None,
            },
        );

        let styles = vec![
            engine::style::CellStyle::new(),
            engine::style::CellStyle::new().with_bold(true),
            engine::style::CellStyle::new()
                .with_number_format(engine::style::NumberFormat::Currency {
                    decimal_places: 2,
                    symbol: "$".to_string(),
                    symbol_position: engine::style::CurrencyPosition::Before,
                    negative_style: engine::style::NegativeStyle::default(),
                }),
        ];

        let mut col_widths = HashMap::new();
        col_widths.insert(0, 150.0);
        col_widths.insert(1, 120.0);

        let mut row_heights = HashMap::new();
        row_heights.insert(0, 25.0);

        let sheet = persistence::Sheet {
            id: SheetId::from_bytes(identity::generate_uuid_v7()),
            name: "Sales Data".to_string(),
            cells,
            row_styles: std::collections::HashMap::new(),
            column_styles: std::collections::HashMap::new(),
            column_widths: col_widths,
            row_heights: row_heights,
            styles,
            merged_regions: Vec::new(),
            freeze_row: None,
            freeze_col: None,
            hidden_rows: std::collections::HashSet::new(),
            hidden_cols: std::collections::HashSet::new(),
            user_hidden_rows: std::collections::HashSet::new(),
            user_hidden_cols: std::collections::HashSet::new(),
            tab_color: String::new(),
            visibility: "visible".to_string(),
            notes: Vec::new(),
            hyperlinks: Vec::new(),
            page_setup: None,
            show_gridlines: true,
            zoom: persistence::DEFAULT_SHEET_ZOOM_PERCENT,
            split_row: None,
            split_col: None,
            display_zeros: true,
            show_formulas: false,
            view_mode: persistence::DEFAULT_SHEET_VIEW_MODE.to_string(),
            display_headings: true,
            kind: persistence::SheetKind::Worksheet,
        };

        Workbook {
            sheets: vec![sheet],
            active_sheet: 0,
            tables: vec![],
            slicers: vec![],
            timeline_slicers: vec![],
            ribbon_filters: vec![],
            pane_controls: vec![],
            user_files: HashMap::new(),
            theme: ThemeDefinition::default(),
            scripts: Vec::new(),
            notebooks: Vec::new(),
            default_row_height: persistence::DEFAULT_ROW_HEIGHT_PX,
            default_column_width: persistence::DEFAULT_COLUMN_WIDTH_PX,
            properties: WorkbookProperties::default(),
            charts: Vec::new(),
            sparklines: Vec::new(),
            named_ranges: Vec::new(),
            pivot_layouts: Vec::new(),
            pivot_definitions: Vec::new(),
            bi_pivot_metadata: Vec::new(),
            object_scripts: Vec::new(),
            bi_connection_roles: Vec::new(),
            bi_connections: Vec::new(),
            bi_connection_caches: std::collections::HashMap::new(),
            media: std::collections::HashMap::new(),
            extension_data: Default::default(),
            conditional_formats: Vec::new(),
            data_validations: Vec::new(),
            controls: Vec::new(),
            cell_types: Vec::new(),
            cell_behaviors: Vec::new(),
            comments: Vec::new(),
            scenarios: Vec::new(),
            outlines: Vec::new(),
            sheet_protections: Vec::new(),
            workbook_protection: None,
            pending_recalc: None,
            floating_ranges: Vec::new(),
            format_version: 0,
            object_bindings: Vec::new(),
        }
    }

    #[test]
    fn test_roundtrip_basic() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.cala");

        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.sheets.len(), 1);
        assert_eq!(loaded.sheets[0].name, "Sales Data");
        assert_eq!(loaded.active_sheet, 0);

        // Sheet ID should survive the roundtrip
        assert_eq!(loaded.sheets[0].id, workbook.sheets[0].id);

        // Check cells
        let cells = &loaded.sheets[0].cells;
        assert!(cells.len() >= 4); // At least the non-empty cells

        // Check A1 = "Name" with style 1
        let a1 = &cells[&(0, 0)];
        assert!(matches!(&a1.value, SavedCellValue::Text(s) if s == "Name"));
        assert_eq!(a1.style_index, 1);

        // Check B2 = 42500.0 with formula
        let b2 = &cells[&(1, 1)];
        assert!(matches!(&b2.value, SavedCellValue::Number(n) if *n == 42500.0));
        assert_eq!(b2.formula, Some("=SUM(C2:C100)".to_string()));
        assert_eq!(b2.style_index, 2);

        // Check A3 = true
        let a3 = &cells[&(2, 0)];
        assert!(matches!(&a3.value, SavedCellValue::Boolean(true)));

        // Check layout
        assert_eq!(loaded.sheets[0].column_widths[&0], 150.0);
        assert_eq!(loaded.sheets[0].column_widths[&1], 120.0);
        assert_eq!(loaded.sheets[0].row_heights[&0], 25.0);

        // Check styles
        assert_eq!(loaded.sheets[0].styles.len(), 3);
        assert!(loaded.sheets[0].styles[1].font.bold);
    }

    // -----------------------------------------------------------------------
    // media/{sha256} — content-addressed binary section
    // -----------------------------------------------------------------------

    /// A byte-exact PNG header. Real bytes, so the archive carries a real
    /// binary rather than a string that happens to be opaque.
    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let mut v: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend_from_slice(&13u32.to_be_bytes());
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&width.to_be_bytes());
        v.extend_from_slice(&height.to_be_bytes());
        v.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        v
    }

    #[test]
    fn media_blobs_round_trip_byte_for_byte() {
        let mut workbook = make_test_workbook();
        let logo = png_bytes(64, 64);
        let banner = png_bytes(1200, 200);
        workbook.media.insert("a".repeat(64), logo.clone());
        workbook.media.insert("b".repeat(64), banner.clone());

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("media.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.media.len(), 2);
        assert_eq!(loaded.media.get(&"a".repeat(64)), Some(&logo));
        assert_eq!(loaded.media.get(&"b".repeat(64)), Some(&banner));
    }

    #[test]
    fn a_workbook_with_no_media_declares_no_feature_and_loads_an_empty_map() {
        // The pre-media corpus: every .cala already on the user's disk. It must
        // load with an empty map, not fail and not invent one.
        let workbook = make_test_workbook();
        assert!(workbook.media.is_empty());
        let bytes = write_calcula_bytes(&workbook).unwrap();
        let manifest = read_calcula_manifest(&bytes).unwrap();
        assert!(!manifest.features.contains(&"media".to_string()));
        let loaded = read_calcula_bytes(&bytes).unwrap();
        assert!(loaded.media.is_empty());
    }

    #[test]
    fn media_declares_a_feature_id_but_never_raises_the_format_version() {
        // The decision recorded at the write site: losing a picture is VISIBLE
        // loss, not silent corruption, so it fails the format-version chain's
        // own test (manifest.rs). Stamping v7 would make every workbook holding
        // one image unopenable by an older build for no protective gain.
        //
        // This is the assertion that will fail if someone "tidies up" by adding
        // a stamp, so the reasoning has to be revisited rather than lost.
        let mut workbook = make_test_workbook();
        workbook.media.insert("c".repeat(64), png_bytes(10, 10));
        let bytes = write_calcula_bytes(&workbook).unwrap();
        let manifest = read_calcula_manifest(&bytes).unwrap();
        assert!(
            manifest.features.contains(&"media".to_string()),
            "the manifest must be able to answer 'does this carry embedded binary?' alone"
        );
        assert_eq!(
            manifest.format_version, CALA_BASE_FORMAT_VERSION,
            "media must not take a link in the format-version chain"
        );
    }

    #[test]
    fn a_collect_from_choice_never_raises_the_format_version() {
        // Writeback > Collect From (2026-10-22) rides inside the working-copy
        // link, a user file. The lie-vs-loss test: an older build ignores the
        // field (and round-trips it through the link's `extra`), so its
        // Collected Responses shows every stream with each row labelled by its
        // stream -- visible, not misleading -- and it has no author BI tables
        // at all, so no model table can claim a choice it does not honour.
        // No link in the format-version chain; this fails if one is added in
        // passing.
        let link = |choice: &str| {
            format!(
                "{{\"formatVersion\":1,\"registryUrl\":\"C:/ws\",\"packageName\":\"app\",\
                 \"baseVersion\":\"1.0.0\",\"checkedOutAt\":\"t\"{choice}}}"
            )
            .into_bytes()
        };
        let mut plain = make_test_workbook();
        plain.user_files.insert("working_copy_link.json".to_string(), link(""));
        let mut chosen = make_test_workbook();
        chosen
            .user_files
            .insert("working_copy_link.json".to_string(), link(",\"collectStreams\":{\"only\":[\"\",\"prod\"]}"));
        let plain_v = read_calcula_manifest(&write_calcula_bytes(&plain).unwrap()).unwrap().format_version;
        let chosen_v = read_calcula_manifest(&write_calcula_bytes(&chosen).unwrap()).unwrap().format_version;
        assert_eq!(chosen_v, plain_v);
        assert_eq!(chosen_v, CALA_BASE_FORMAT_VERSION);
    }

    #[test]
    fn script_authoring_declares_a_feature_id_but_never_raises_the_format_version() {
        // Modeled on the media test above, and for the same reason: an older
        // reader that drops `script_authoring.json` loses a LOG. It is not made
        // to lie -- no schedule is disarmed, no stale workbook comes back
        // looking calculated, no hidden row comes back visible. Stamping a
        // version would instead make every workbook that ever carried an AI
        // authoring transcript unopenable by an older build, for no protective
        // gain at all.
        //
        // The id itself is load-bearing for a PRIVACY question: "does this
        // .cala carry the prompts its author typed?" must be answerable from
        // the manifest alone, before anyone emails the file.
        //
        // A future edit that adds a version link fails HERE and has to argue
        // for it rather than land in passing.
        use crate::features::script_authoring::{
            AuthoringRun, ScriptAuthoringFile, ScriptAuthoringLog, SCRIPT_AUTHORING_FILE,
        };

        let baseline = write_calcula_bytes(&make_test_workbook()).unwrap();
        let baseline_version = read_calcula_manifest(&baseline).unwrap().format_version;

        let mut workbook = make_test_workbook();
        let mut log = ScriptAuthoringLog::new();
        log.insert(
            "obj-1".to_string(),
            vec![AuthoringRun {
                run_id: "r1".to_string(),
                kind: "edit".to_string(),
                outcome: "unchanged".to_string(),
                decision: Some("rejected".to_string()),
                decided_at: Some("2026-08-26T10:00:05Z".to_string()),
                started_at: "2026-08-26T10:00:00Z".to_string(),
                elapsed_ms: 5_000,
                instruction: "colour the negatives red".to_string(),
                object_type: "button".to_string(),
                provider_id: "ollama".to_string(),
                model: "qwen3:8b".to_string(),
                tier: "restricted".to_string(),
                surface_tokens: 3_200,
                surface_truncated: false,
                summary: "returned unchanged".to_string(),
                attempts: Vec::new(),
                notices: Vec::new(),
                changed_nothing: true,
                unexercised_hooks: Vec::new(),
                elided: None,
            }],
        );
        workbook.user_files.insert(
            SCRIPT_AUTHORING_FILE.to_string(),
            ScriptAuthoringFile::new(log).to_json_bytes().unwrap(),
        );

        let bytes = write_calcula_bytes(&workbook).unwrap();
        let manifest = read_calcula_manifest(&bytes).unwrap();
        assert!(
            manifest.features.contains(&"script_authoring".to_string()),
            "the manifest must answer 'does this carry the prompts its author typed?' alone"
        );
        assert_eq!(
            manifest.format_version, baseline_version,
            "script_authoring must not take a link in the format-version chain"
        );

        // And the section survives the round trip under the existing `files` id.
        let loaded = read_calcula_bytes(&bytes).unwrap();
        let back = ScriptAuthoringFile::from_json_bytes(
            loaded.user_files.get(SCRIPT_AUTHORING_FILE).unwrap(),
        )
        .unwrap();
        assert_eq!(back.runs["obj-1"][0].instruction, "colour the negatives red");
    }

    #[test]
    fn identical_bytes_stored_twice_are_one_entry() {
        // Content addressing is the dedup: the same logo on twenty sheets is
        // one key, so it is written once no matter how many controls point at it.
        let mut workbook = make_test_workbook();
        let logo = png_bytes(64, 64);
        let hash = "d".repeat(64);
        workbook.media.insert(hash.clone(), logo.clone());
        workbook.media.insert(hash.clone(), logo.clone());
        assert_eq!(workbook.media.len(), 1);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dedup.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();
        assert_eq!(loaded.media.len(), 1);
        assert_eq!(loaded.media.get(&hash), Some(&logo));
    }

    #[test]
    fn media_entries_are_stored_uncompressed_and_in_a_deterministic_order() {
        // STORED: re-deflating already-compressed image data burns CPU on the
        // user's Ctrl+S path for no gain. Deterministic order: a HashMap
        // iteration order would churn the archive bytes for identical content,
        // which is what makes .calp checksums and diffs stable.
        let mut workbook = make_test_workbook();
        for tag in ['9', '1', '5'] {
            workbook
                .media
                .insert(std::iter::repeat(tag).take(64).collect(), png_bytes(8, 8));
        }
        let bytes = write_calcula_bytes(&workbook).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        let mut seen = Vec::new();
        for i in 0..archive.len() {
            let entry = archive.by_index(i).unwrap();
            if entry.name().starts_with("media/") {
                assert_eq!(
                    entry.compression(),
                    CompressionMethod::Stored,
                    "media must not be deflated"
                );
                seen.push(entry.name().to_string());
            }
        }
        let mut sorted = seen.clone();
        sorted.sort();
        assert_eq!(seen, sorted, "media entries must be written in hash order");
        assert_eq!(seen.len(), 3);

        // Byte-identical archives for identical content.
        let again = write_calcula_bytes(&workbook).unwrap();
        let media_of = |b: &[u8]| {
            let mut a = zip::ZipArchive::new(std::io::Cursor::new(b.to_vec())).unwrap();
            (0..a.len())
                .map(|i| a.by_index(i).unwrap().name().to_string())
                .filter(|n| n.starts_with("media/"))
                .collect::<Vec<_>>()
        };
        assert_eq!(media_of(&bytes), media_of(&again));
    }

    #[test]
    fn test_roundtrip_named_ranges() {
        // Regression: named ranges (defined names) were silently dropped on every
        // .cala save (writer had no branch; reader hardcoded Vec::new()).
        let mut workbook = make_test_workbook();
        let sheet_id = workbook.sheets[0].id;
        workbook.named_ranges = vec![
            persistence::SavedNamedRange {
                name: "TaxRate".to_string(),
                refers_to: "=0.25".to_string(),
                sheet_id: None, // workbook-scoped
                comment: Some("VAT".to_string()),
                folder: Some("Finance".to_string()),
            },
            persistence::SavedNamedRange {
                name: "SalesData".to_string(),
                refers_to: "Sales Data!$A$1:$B$10".to_string(),
                sheet_id: Some(sheet_id), // sheet-scoped
                comment: None,
                folder: None,
            },
        ];

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nr.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.named_ranges.len(), 2, "named ranges must survive the .cala round-trip");
        let tax = loaded.named_ranges.iter().find(|nr| nr.name == "TaxRate").expect("TaxRate present");
        assert_eq!(tax.refers_to, "=0.25");
        assert_eq!(tax.sheet_id, None);
        assert_eq!(tax.comment.as_deref(), Some("VAT"));
        assert_eq!(tax.folder.as_deref(), Some("Finance"));
        let sales = loaded.named_ranges.iter().find(|nr| nr.name == "SalesData").expect("SalesData present");
        assert_eq!(sales.sheet_id, Some(sheet_id), "sheet-scoped SheetId must round-trip");
    }

    #[test]
    fn test_roundtrip_slicer_biconnection_report_connection() {
        // Regression: a slicer Report-Connection to a BI connection deserialized
        // back to Table (the connected_sources match had no "biConnection" arm).
        let mut workbook = make_test_workbook();
        let sheet_id = workbook.sheets[0].id;
        let conn_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        workbook.slicers.push(persistence::SavedSlicer {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: "Region".to_string(),
            header_text: None,
            sheet_id,
            x: 0.0, y: 0.0, width: 200.0, height: 150.0,
            source_type: persistence::SavedSlicerSourceType::BiConnection,
            cache_source_id: conn_id,
            field_name: "Region".to_string(),
            selected_items: None,
            show_header: true,
            columns: 1,
            style_preset: "default".to_string(),
            selection_mode: Default::default(),
            hide_no_data: false,
            indicate_no_data: true,
            sort_no_data_last: true,
            force_selection: false,
            show_select_all: false,
            arrangement: Default::default(),
            rows: 0,
            item_gap: 4.0,
            autogrid: true,
            item_padding: 0.0,
            button_radius: 4.0,
            computed_properties: Vec::new(),
            connected_sources: vec![persistence::SavedSlicerConnection {
                source_type: persistence::SavedSlicerSourceType::BiConnection,
                source_id: conn_id,
            }],
            // Pinned: exercises both the filterLevel round-trip and the
            // conditional v8 stamp (asserted below).
            filter_level: 2,
            data_source_id: None,
            container: None,
        });

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("slicer.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.slicers.len(), 1);
        assert_eq!(
            loaded.slicers[0].filter_level, 2,
            "a pinned slicer's filter level must round-trip — dropping it \
             silently un-pins the filter and changes CLEAR-measure values"
        );
        // ...and the pin takes its link in the format-version chain: an older
        // reader would drop the level on its next save, silently un-pinning
        // the filter (wrong numbers, no error). Refusing the open is the
        // honest failure.
        let manifest = read_calcula_manifest(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(manifest.format_version, PINNED_FILTER_MIN_FORMAT_VERSION);
        assert!(manifest.features.iter().any(|f| f == "pinned_filters"));
        let cs = &loaded.slicers[0].connected_sources;
        assert_eq!(cs.len(), 1, "the BI connected-source must survive");
        assert!(
            matches!(cs[0].source_type, persistence::SavedSlicerSourceType::BiConnection),
            "slicer Report-Connection to a BI connection must round-trip (regression: downgraded to Table)"
        );
    }

    #[test]
    fn test_roundtrip_ribbon_filter_advanced_filter() {
        // Regression: a Filter-Pane advanced (operator/value/logic) condition was
        // dropped by the .cala RibbonFilterDef mirror (no field; reverse forced None).
        let mut workbook = make_test_workbook();
        workbook.ribbon_filters.push(persistence::SavedRibbonFilter {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: "Sales".to_string(),
            connection_id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            data_source_id: None,
            field_name: "Sales.Amount".to_string(),
            field_data_type: "number".to_string(),
            connection_mode: Default::default(),
            connected_pivots: Vec::new(),
            connected_sheets: Vec::new(),
            connected_visuals: Vec::new(),
            display_mode: Default::default(),
            selected_items: None,
            dependent_filters: Vec::new(),
            dependent_slicers: Vec::new(),
            advanced_filter: Some(persistence::SavedAdvancedFilter {
                condition1: persistence::SavedAdvancedFilterCondition {
                    operator: "greaterThan".to_string(),
                    value: "100".to_string(),
                },
                condition2: Some(persistence::SavedAdvancedFilterCondition {
                    operator: "lessThan".to_string(),
                    value: "500".to_string(),
                }),
                logic: "and".to_string(),
            }),
            hide_no_data: false,
            indicate_no_data: true,
            sort_no_data_last: true,
            show_select_all: false,
            single_select: false,
            order: 0,
            button_columns: 2,
            button_rows: 0,
            filter_level: 1,
        });

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ribbon.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.ribbon_filters.len(), 1);
        let af = loaded.ribbon_filters[0]
            .advanced_filter
            .as_ref()
            .expect("ribbon-filter advanced_filter must survive reload (regression: dropped by the .cala mirror)");
        assert_eq!(af.condition1.operator, "greaterThan");
        assert_eq!(af.condition1.value, "100");
        assert_eq!(af.condition2.as_ref().expect("condition2").operator, "lessThan");
        assert_eq!(af.logic, "and");
    }

    #[test]
    fn test_roundtrip_pane_controls() {
        // Pane controls (Controls Pane) persist one file per control under
        // pane_controls/control_{id}.json. `config`/`value` are opaque JSON and
        // must round-trip byte-identical (structurally).
        let mut workbook = make_test_workbook();
        let slider_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        let button_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        workbook.pane_controls.push(persistence::SavedPaneControl {
            id: slider_id,
            name: "Growth".to_string(),
            control_type: "slider".to_string(),
            config: serde_json::json!({
                "type": "slider", "min": 0.0, "max": 1.0, "step": 0.05, "showValue": true
            }),
            value: serde_json::json!({ "type": "number", "value": 0.25 }),
            order: 3,
        });
        workbook.pane_controls.push(persistence::SavedPaneControl {
            id: button_id,
            name: "Refresh".to_string(),
            control_type: "button".to_string(),
            config: serde_json::json!({ "type": "button", "label": "Refresh data" }),
            value: serde_json::Value::Null, // value-less control
            order: 7,
        });

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pane_controls.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.pane_controls.len(), 2, "pane controls must survive the .cala round-trip");
        let slider = loaded.pane_controls.iter().find(|c| c.id == slider_id).expect("slider present");
        assert_eq!(slider.name, "Growth");
        assert_eq!(slider.control_type, "slider");
        assert_eq!(slider.config, workbook.pane_controls[0].config);
        assert_eq!(slider.value, workbook.pane_controls[0].value);
        assert_eq!(slider.order, 3);
        let button = loaded.pane_controls.iter().find(|c| c.id == button_id).expect("button present");
        assert_eq!(button.control_type, "button");
        assert!(button.value.is_null(), "value-less control must round-trip as null");
        assert_eq!(button.order, 7);
    }

    #[test]
    fn test_pane_controls_absent_defaults_to_empty() {
        // Old files (written before pane controls existed) have no
        // pane_controls feature flag or entries — they must load as an
        // empty list.
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no_pane_controls.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();
        assert!(loaded.pane_controls.is_empty());
    }

    #[test]
    fn test_roundtrip_conditional_formats_and_data_validations() {
        // Regression: CF + DV were not modeled in the file format at all — lost on
        // every .cala save/reload. The payload is opaque to the format (app-owned
        // JSON), so this asserts the per-sheet payload + SheetId survive write/read.
        let mut workbook = make_test_workbook();
        let sheet_id = workbook.sheets[0].id;
        workbook.conditional_formats = vec![persistence::SavedSheetConditionalFormats {
            sheet_id,
            rules: serde_json::json!([
                { "id": 7, "priority": 1, "rule": { "type": "cellValue" },
                  "ranges": [{ "startRow": 0, "startCol": 0, "endRow": 9, "endCol": 0 }],
                  "stopIfTrue": false, "enabled": true }
            ]),
        }];
        workbook.data_validations = vec![persistence::SavedSheetDataValidations {
            sheet_id,
            ranges: serde_json::json!([
                { "startRow": 0, "startCol": 1, "endRow": 5, "endCol": 1,
                  "validation": { "rule": { "type": "list" } } }
            ]),
        }];

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cfdv.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.conditional_formats.len(), 1, "CF must survive the .cala round-trip");
        assert_eq!(loaded.conditional_formats[0].sheet_id, sheet_id);
        assert_eq!(loaded.conditional_formats[0].rules, workbook.conditional_formats[0].rules);
        assert_eq!(loaded.data_validations.len(), 1, "DV must survive the .cala round-trip");
        assert_eq!(loaded.data_validations[0].sheet_id, sheet_id);
        assert_eq!(loaded.data_validations[0].ranges, workbook.data_validations[0].ranges);
    }

    /// THE SILENT-STALENESS REGRESSION TEST.
    ///
    /// A cancelled recalculation leaves some cells holding pre-recalculation
    /// values, and a stale cell looks exactly like a correct one. While the
    /// session lives, the host's in-memory pending set keeps the status bar
    /// saying "Calculate". Before this section existed the set died at save, so
    /// the workbook reopened claiming to be calculated, with wrong numbers and
    /// nothing anywhere saying so — and `.calp` publish, which refuses to ship a
    /// pending workbook, saw an empty set and shipped it.
    #[test]
    fn test_roundtrip_pending_recalc_staleness_marker() {
        let mut workbook = make_test_workbook();
        let sheet_id = workbook.sheets[0].id;
        workbook.pending_recalc = Some(persistence::SavedPendingRecalc {
            sheet_id,
            cells: vec![
                persistence::SavedPendingCell { row: 4, col: 2 },
                persistence::SavedPendingCell { row: 7, col: 0 },
            ],
        });

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stale.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        let pending = loaded
            .pending_recalc
            .expect("the staleness marker must survive the .cala round-trip");
        assert_eq!(pending.sheet_id, sheet_id, "keyed by SheetId, not by index");
        assert_eq!(pending.cells.len(), 2);
        assert_eq!(pending.cells[0], persistence::SavedPendingCell { row: 4, col: 2 });

        // ...and it takes its link in the format-version chain, so a reader that
        // would silently DROP it fails the open instead of laundering a stale
        // workbook into a trustworthy-looking one.
        let manifest = read_calcula_manifest(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(manifest.format_version, PENDING_RECALC_MIN_FORMAT_VERSION);
        assert!(manifest.features.iter().any(|f| f == "pending_recalc"));
    }

    /// An ORDINARY (level-1) slicer must NOT stamp the pinned-filter version —
    /// only an actual pin warrants demanding a newer reader.
    #[test]
    fn test_an_ordinary_slicer_does_not_stamp_the_pinned_filter_version() {
        let mut workbook = make_test_workbook();
        let sheet_id = workbook.sheets[0].id;
        workbook.slicers.push(persistence::SavedSlicer {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: "Region".to_string(),
            header_text: None,
            sheet_id,
            x: 0.0, y: 0.0, width: 200.0, height: 150.0,
            source_type: persistence::SavedSlicerSourceType::Table,
            cache_source_id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            field_name: "Region".to_string(),
            selected_items: None,
            show_header: true,
            columns: 1,
            style_preset: "default".to_string(),
            selection_mode: Default::default(),
            hide_no_data: false,
            indicate_no_data: true,
            sort_no_data_last: true,
            force_selection: false,
            show_select_all: false,
            arrangement: Default::default(),
            rows: 0,
            item_gap: 4.0,
            autogrid: true,
            item_padding: 0.0,
            button_radius: 4.0,
            computed_properties: Vec::new(),
            connected_sources: Vec::new(),
            filter_level: 1,
            data_source_id: None,
            container: None,
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ordinary-slicer.cala");
        write_calcula(&workbook, &path).unwrap();
        let manifest = read_calcula_manifest(&std::fs::read(&path).unwrap()).unwrap();
        assert!(manifest.format_version < PINNED_FILTER_MIN_FORMAT_VERSION);
        assert!(!manifest.features.iter().any(|f| f == "pinned_filters"));
    }

    /// A fully-calculated workbook must carry NO marker and must NOT be stamped
    /// up the version chain — otherwise every ordinary save would demand a newer
    /// reader for a section it does not contain.
    #[test]
    fn test_a_calculated_workbook_carries_no_staleness_marker() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clean.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();
        assert!(loaded.pending_recalc.is_none());
        let manifest = read_calcula_manifest(&std::fs::read(&path).unwrap()).unwrap();
        assert!(manifest.format_version < PENDING_RECALC_MIN_FORMAT_VERSION);
        assert!(!manifest.features.iter().any(|f| f == "pending_recalc"));
    }

    /// The rows/columns the user hid BY HAND must survive a .cala round-trip,
    /// separately from the derived filter/outline cache — and must take their
    /// link in the format-version chain, because an older reader would rebuild
    /// the derived set from filter+outline alone and bring them back visible.
    #[test]
    fn test_user_hidden_rows_survive_the_cala_roundtrip_and_stamp_v4() {
        let mut workbook = make_test_workbook();
        workbook.sheets[0].user_hidden_rows = [3u32, 9].into_iter().collect();
        workbook.sheets[0].user_hidden_cols = [2u32].into_iter().collect();
        // A filter hid row 5; that lives in the derived cache and must NOT be
        // confused with the user set.
        workbook.sheets[0].hidden_rows = [5u32].into_iter().collect();

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hidden.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        let mut rows: Vec<u32> = loaded.sheets[0].user_hidden_rows.iter().copied().collect();
        rows.sort_unstable();
        assert_eq!(rows, vec![3, 9], "hand-hidden rows must come back hidden");
        let cols: Vec<u32> = loaded.sheets[0].user_hidden_cols.iter().copied().collect();
        assert_eq!(cols, vec![2]);
        assert_eq!(
            loaded.sheets[0].hidden_rows,
            [5u32].into_iter().collect::<std::collections::HashSet<u32>>(),
            "the derived cache stays its own set"
        );

        let manifest = read_calcula_manifest(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(manifest.format_version, USER_HIDDEN_MIN_FORMAT_VERSION);
        assert!(manifest.features.iter().any(|f| f == "user_hidden"));
    }


    /// Zoom and split round-trip the real archive, and stamp the format
    /// version -- they live nowhere else, so an older reader would drop them on
    /// its next save and hand back a 100%, single-pane workbook silently.
    #[test]
    fn test_zoom_and_split_roundtrip_and_stamp_the_version() {
        let mut workbook = make_test_workbook();
        workbook.sheets[0].zoom = 60.0;
        workbook.sheets[0].split_row = Some(11);
        workbook.sheets[0].split_col = Some(2);
        // A freeze on the same sheet must stay a separate setting.
        workbook.sheets[0].freeze_row = Some(1);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("view.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.sheets[0].zoom, 60.0);
        assert_eq!(loaded.sheets[0].split_row, Some(11));
        assert_eq!(loaded.sheets[0].split_col, Some(2));
        assert_eq!(loaded.sheets[0].freeze_row, Some(1));

        let manifest = read_calcula_manifest(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(manifest.format_version, SHEET_VIEW_MIN_FORMAT_VERSION);
        assert!(manifest.features.iter().any(|f| f == "sheet_view"));
    }

    /// A 100%, unsplit workbook must NOT be stamped up the chain -- otherwise
    /// every ordinary save demands a newer reader for nothing.
    #[test]
    fn test_no_zoom_or_split_means_no_version_stamp() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plain-view.cala");
        write_calcula(&workbook, &path).unwrap();
        let manifest = read_calcula_manifest(&std::fs::read(&path).unwrap()).unwrap();
        assert!(manifest.format_version < SHEET_VIEW_MIN_FORMAT_VERSION);
        assert!(!manifest.features.iter().any(|f| f == "sheet_view"));
    }

    /// The four DISPLAY FLAGS round-trip the real archive and stamp v6. Before this
    /// they lived only in the frontend reducer, so they never reached the file at all;
    /// an older reader that ignored them would drop them on its next save and hand back
    /// a sheet showing VALUES where the author left FORMULAS, with no error anywhere.
    #[test]
    fn test_display_flags_roundtrip_and_stamp_the_version() {
        let mut workbook = make_test_workbook();
        workbook.sheets[0].display_zeros = false;
        workbook.sheets[0].show_formulas = true;
        workbook.sheets[0].view_mode = "pageBreakPreview".to_string();
        workbook.sheets[0].display_headings = false;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("display-flags.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert!(!loaded.sheets[0].display_zeros, "displayZeros lost through the archive");
        assert!(loaded.sheets[0].show_formulas, "showFormulas lost through the archive");
        assert_eq!(loaded.sheets[0].view_mode, "pageBreakPreview");
        assert!(!loaded.sheets[0].display_headings, "displayHeadings lost through the archive");

        let manifest = read_calcula_manifest(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(manifest.format_version, SHEET_DISPLAY_FLAGS_MIN_FORMAT_VERSION);
        assert!(manifest.features.iter().any(|f| f == "sheet_display_flags"));
    }

    /// ONE non-default flag is enough to stamp -- the four are a unit, and a partial
    /// rule would silently drop whichever flag was left out of the condition.
    #[test]
    fn test_any_single_display_flag_alone_stamps_the_version() {
        for (label, apply) in [
            ("displayZeros", (|s: &mut persistence::Sheet| s.display_zeros = false) as fn(&mut persistence::Sheet)),
            ("showFormulas", |s: &mut persistence::Sheet| s.show_formulas = true),
            ("viewMode", |s: &mut persistence::Sheet| s.view_mode = "pageLayout".to_string()),
            ("displayHeadings", |s: &mut persistence::Sheet| s.display_headings = false),
        ] {
            let mut workbook = make_test_workbook();
            apply(&mut workbook.sheets[0]);
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("one-flag.cala");
            write_calcula(&workbook, &path).unwrap();
            let manifest = read_calcula_manifest(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(
                manifest.format_version, SHEET_DISPLAY_FLAGS_MIN_FORMAT_VERSION,
                "{label} alone must stamp the display-flags version"
            );
        }
    }

    /// A workbook at the defaults must NOT be stamped up to v6 -- otherwise every
    /// ordinary save demands a newer reader for nothing.
    #[test]
    fn test_default_display_flags_mean_no_version_stamp() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plain-display.cala");
        write_calcula(&workbook, &path).unwrap();
        let manifest = read_calcula_manifest(&std::fs::read(&path).unwrap()).unwrap();
        assert!(manifest.format_version < SHEET_DISPLAY_FLAGS_MIN_FORMAT_VERSION);
        assert!(!manifest.features.iter().any(|f| f == "sheet_display_flags"));
    }

    /// A CANVAS sheet round-trips the real archive with its whole layout and
    /// stamps v9 plus the `canvas_sheets` feature id. An older reader would
    /// otherwise hand the canvas back as an editable worksheet and drop the
    /// kind on its next save.
    #[test]
    fn test_canvas_sheet_roundtrips_and_stamps_the_version() {
        let mut workbook = make_test_workbook();
        let mut layout = persistence::CanvasLayout::default();
        layout.snap_to_grid = false;
        layout.grid_size_px = 25;
        layout.show_grid = false;
        layout.page_preset = persistence::CANVAS_CUSTOM_PAGE_PRESET.to_string();
        layout.page_width = 1500;
        layout.page_height = 900;
        layout.background = "#f0f0f0".to_string();
        layout.z_order = vec![persistence::CanvasObjectRef { kind: "chart".into(), id: "7".into() }];
        layout.locked = vec![persistence::CanvasObjectRef { kind: "slicer".into(), id: "3".into() }];
        workbook.sheets[0].kind = persistence::SheetKind::Canvas(layout.clone());

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("canvas.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(
            loaded.sheets[0].kind,
            persistence::SheetKind::Canvas(layout),
            "the canvas kind and its layout must survive the archive"
        );
        let manifest = read_calcula_manifest(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(manifest.format_version, CANVAS_SHEET_MIN_FORMAT_VERSION);
        assert!(manifest.features.iter().any(|f| f == "canvas_sheets"));
    }

    /// CONTRACT-CANVAS 4.7: the WALLPAPER and LOCK OBJECTS round-trip the real
    /// archive, and each declares a manifest FEATURE ID but takes NO link in
    /// the format-version chain -- an older reader that drops them loses a
    /// colour around the page or a convenience lock, visible losses, never a
    /// document that lies (CLAUDE.md, ".cala Format Versioning"). So a canvas
    /// carrying them stamps exactly what a plain canvas stamps (v9), no more.
    #[test]
    fn canvas_wallpaper_and_lock_declare_feature_ids_but_never_raise_the_version() {
        let mut workbook = make_test_workbook();
        let mut layout = persistence::CanvasLayout::default();
        layout.wallpaper = "#202020".to_string();
        layout.objects_locked = true;
        layout.page_preset = "tooltip".to_string();
        layout.page_width = 320;
        layout.page_height = 240;
        workbook.sheets[0].kind = persistence::SheetKind::Canvas(layout.clone());

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("canvas-wallpaper.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();
        assert_eq!(loaded.sheets[0].kind, persistence::SheetKind::Canvas(layout), "wallpaper, lock and the Tooltip page survive");

        let manifest = read_calcula_manifest(&std::fs::read(&path).unwrap()).unwrap();
        assert!(manifest.features.iter().any(|f| f == CANVAS_WALLPAPER_FEATURE), "{:?}", manifest.features);
        assert!(manifest.features.iter().any(|f| f == CANVAS_OBJECTS_LOCKED_FEATURE), "{:?}", manifest.features);
        assert_eq!(
            manifest.format_version, CANVAS_SHEET_MIN_FORMAT_VERSION,
            "a cosmetic canvas field must not raise the version above the canvas link itself"
        );

        // Each id is declared ONLY by a canvas that actually carries it: a
        // plain canvas -- and a lock without a wallpaper -- declare no more.
        let mut plain = make_test_workbook();
        plain.sheets[0].kind = persistence::SheetKind::new_canvas();
        let path = dir.path().join("canvas-plain.cala");
        write_calcula(&plain, &path).unwrap();
        let manifest = read_calcula_manifest(&std::fs::read(&path).unwrap()).unwrap();
        assert!(!manifest.features.iter().any(|f| f == CANVAS_WALLPAPER_FEATURE));
        assert!(!manifest.features.iter().any(|f| f == CANVAS_OBJECTS_LOCKED_FEATURE));

        let mut lock_only = make_test_workbook();
        lock_only.sheets[0].kind = persistence::SheetKind::Canvas(persistence::CanvasLayout {
            objects_locked: true,
            ..persistence::CanvasLayout::default()
        });
        let path = dir.path().join("canvas-lock-only.cala");
        write_calcula(&lock_only, &path).unwrap();
        let manifest = read_calcula_manifest(&std::fs::read(&path).unwrap()).unwrap();
        assert!(!manifest.features.iter().any(|f| f == CANVAS_WALLPAPER_FEATURE));
        assert!(manifest.features.iter().any(|f| f == CANVAS_OBJECTS_LOCKED_FEATURE));
    }

    /// The READ is unconditional: the fields ride the sheet's own metadata
    /// (`kind`), so a file whose manifest forgot the id still loads them.
    #[test]
    fn canvas_wallpaper_and_lock_load_even_without_their_feature_ids() {
        let mut workbook = make_test_workbook();
        let layout = persistence::CanvasLayout {
            wallpaper: "#abc".to_string(),
            objects_locked: true,
            ..persistence::CanvasLayout::default()
        };
        workbook.sheets[0].kind = persistence::SheetKind::Canvas(layout.clone());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("canvas-noid.cala");
        write_calcula(&workbook, &path).unwrap();

        // Rewrite manifest.json without the two ids.
        let bytes = std::fs::read(&path).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let out_path = dir.path().join("canvas-noid-stripped.cala");
        {
            let mut out = zip::ZipWriter::new(std::fs::File::create(&out_path).unwrap());
            for i in 0..archive.len() {
                let mut entry = archive.by_index(i).unwrap();
                let name = entry.name().to_string();
                let mut data = Vec::new();
                std::io::Read::read_to_end(&mut entry, &mut data).unwrap();
                if name == "manifest.json" {
                    let mut m: serde_json::Value = serde_json::from_slice(&data).unwrap();
                    let features = m["features"].as_array_mut().unwrap();
                    features.retain(|f| f != CANVAS_WALLPAPER_FEATURE && f != CANVAS_OBJECTS_LOCKED_FEATURE);
                    data = serde_json::to_vec(&m).unwrap();
                }
                out.start_file(name, FileOptions::<()>::default()).unwrap();
                std::io::Write::write_all(&mut out, &data).unwrap();
            }
            out.finish().unwrap();
        }
        let loaded = read_calcula(&out_path).unwrap();
        assert_eq!(loaded.sheets[0].kind, persistence::SheetKind::Canvas(layout));
    }

    /// A canvas whose interactions hold one default and two pairs (P4).
    fn canvas_with_interactions() -> persistence::CanvasLayout {
        let r = |kind: &str, id: &str| persistence::CanvasObjectRef { kind: kind.to_string(), id: id.to_string() };
        persistence::CanvasLayout {
            interactions: persistence::CanvasInteractions {
                default_mode: Some(persistence::VisualInteractionMode::Highlight),
                pairs: vec![
                    persistence::CanvasInteraction {
                        source: r("slicer", "s-1"),
                        target: r("pivot", "p-1"),
                        mode: persistence::VisualInteractionMode::None,
                    },
                    persistence::CanvasInteraction {
                        source: r("chart", "7"),
                        target: r("chart", "8"),
                        mode: persistence::VisualInteractionMode::Filter,
                    },
                ],
            },
            ..persistence::CanvasLayout::default()
        }
    }

    /// P4: a canvas's VISUAL INTERACTIONS round-trip the real archive and
    /// declare the manifest FEATURE ID `canvas_interactions`, but take NO link
    /// in the format-version chain (as decided; the slicer -> pivot `none`
    /// owner question is recorded on CANVAS_INTERACTIONS_FEATURE). So a canvas
    /// carrying them stamps exactly what a plain canvas stamps, and a plain
    /// canvas declares no id.
    #[test]
    fn canvas_interactions_declares_a_feature_id_but_never_raises_the_version() {
        let mut plain = make_test_workbook();
        plain.sheets[0].kind = persistence::SheetKind::new_canvas();
        let plain_manifest = manifest_of(&write_calcula_bytes(&plain).unwrap());
        assert!(!plain_manifest.features.iter().any(|f| f == CANVAS_INTERACTIONS_FEATURE), "{:?}", plain_manifest.features);

        let mut workbook = make_test_workbook();
        let layout = canvas_with_interactions();
        workbook.sheets[0].kind = persistence::SheetKind::Canvas(layout.clone());
        let bytes = write_calcula_bytes(&workbook).unwrap();
        let loaded = read_calcula_bytes(&bytes).unwrap();
        assert_eq!(loaded.sheets[0].kind, persistence::SheetKind::Canvas(layout), "the interactions survive the archive");

        let manifest = manifest_of(&bytes);
        assert!(manifest.features.iter().any(|f| f == CANVAS_INTERACTIONS_FEATURE), "{:?}", manifest.features);
        assert_eq!(
            manifest.format_version, plain_manifest.format_version,
            "interactions must not raise the version above what the same canvas without them stamps"
        );

        // A default alone is enough to declare it; nothing at all declares nothing.
        let mut default_only = make_test_workbook();
        default_only.sheets[0].kind = persistence::SheetKind::Canvas(persistence::CanvasLayout {
            interactions: persistence::CanvasInteractions {
                default_mode: Some(persistence::VisualInteractionMode::Filter),
                pairs: Vec::new(),
            },
            ..persistence::CanvasLayout::default()
        });
        let m = manifest_of(&write_calcula_bytes(&default_only).unwrap());
        assert!(m.features.iter().any(|f| f == CANVAS_INTERACTIONS_FEATURE), "{:?}", m.features);
    }

    /// The READ is unconditional: interactions ride the sheet's own metadata
    /// (`kind`), so a manifest that forgot the id still loads them.
    #[test]
    fn canvas_interactions_load_even_without_their_feature_id() {
        let mut workbook = make_test_workbook();
        let layout = canvas_with_interactions();
        workbook.sheets[0].kind = persistence::SheetKind::Canvas(layout.clone());
        let bytes = write_calcula_bytes(&workbook).unwrap();
        let stripped = rewrite_archive(&bytes, |name, content| {
            (name == "manifest.json").then(|| {
                let mut m: Manifest = serde_json::from_slice(content).unwrap();
                assert!(m.features.iter().any(|f| f == CANVAS_INTERACTIONS_FEATURE), "precondition: the id was written");
                m.features.retain(|f| f != CANVAS_INTERACTIONS_FEATURE);
                serde_json::to_vec_pretty(&m).unwrap()
            })
        });
        assert!(!manifest_of(&stripped).features.iter().any(|f| f == CANVAS_INTERACTIONS_FEATURE));
        let loaded = read_calcula_bytes(&stripped).unwrap();
        assert_eq!(loaded.sheets[0].kind, persistence::SheetKind::Canvas(layout));
    }

    /// A ribbon filter with the given "Selected visuals" list (P4 DC-3).
    fn ribbon_filter_with_visuals(visuals: Vec<persistence::CanvasObjectRef>) -> persistence::SavedRibbonFilter {
        persistence::SavedRibbonFilter {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: "Region".to_string(),
            connection_id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            data_source_id: None,
            field_name: "Geo.Region".to_string(),
            field_data_type: "text".to_string(),
            connection_mode: persistence::SavedConnectionMode::Manual,
            connected_pivots: vec![identity::EntityId::from_bytes(identity::generate_uuid_v7())],
            connected_sheets: Vec::new(),
            connected_visuals: visuals,
            display_mode: Default::default(),
            selected_items: Some(vec!["North".to_string()]),
            dependent_filters: Vec::new(),
            dependent_slicers: Vec::new(),
            advanced_filter: None,
            hide_no_data: false,
            indicate_no_data: true,
            sort_no_data_last: true,
            show_select_all: false,
            single_select: false,
            order: 0,
            button_columns: 2,
            button_rows: 0,
            filter_level: 1,
        }
    }

    /// P4: a ribbon filter's "Selected visuals" (`connectedVisuals`) round-trips
    /// the real archive through calcula-format's own `RibbonFilterDef` and
    /// declares the feature id `ribbon_filter_visual_targets` -- only when the
    /// list is non-empty -- with NO version link.
    #[test]
    fn ribbon_filter_visual_targets_declares_a_feature_id_but_never_raises_the_version() {
        let mut without = make_test_workbook();
        without.ribbon_filters.push(ribbon_filter_with_visuals(Vec::new()));
        let without_bytes = write_calcula_bytes(&without).unwrap();
        let without_manifest = manifest_of(&without_bytes);
        assert!(!without_manifest.features.iter().any(|f| f == RIBBON_FILTER_VISUAL_TARGETS_FEATURE));
        let filter_json = entry_text(&without_bytes, &format!("ribbon_filters/filter_{}.json", without.ribbon_filters[0].id))
            .expect("the filter record is written");
        assert!(!filter_json.contains("connectedVisuals"), "an empty list stays off the wire: {filter_json}");

        let visuals = vec![
            persistence::CanvasObjectRef { kind: "chart".to_string(), id: "12".to_string() },
            persistence::CanvasObjectRef { kind: "chart".to_string(), id: "13".to_string() },
        ];
        let mut with = make_test_workbook();
        with.ribbon_filters.push(ribbon_filter_with_visuals(visuals.clone()));
        let bytes = write_calcula_bytes(&with).unwrap();
        let manifest = manifest_of(&bytes);
        assert!(manifest.features.iter().any(|f| f == RIBBON_FILTER_VISUAL_TARGETS_FEATURE), "{:?}", manifest.features);
        assert_eq!(manifest.format_version, without_manifest.format_version, "the list must not raise the version");
        let filter_json = entry_text(&bytes, &format!("ribbon_filters/filter_{}.json", with.ribbon_filters[0].id)).unwrap();
        assert!(filter_json.contains("\"connectedVisuals\""), "camelCase key on disk: {filter_json}");

        let loaded = read_calcula_bytes(&bytes).unwrap();
        assert_eq!(loaded.ribbon_filters.len(), 1);
        assert_eq!(loaded.ribbon_filters[0].connected_visuals, visuals, "the visuals survive save and load");
        assert_eq!(loaded.ribbon_filters[0].connected_pivots, with.ribbon_filters[0].connected_pivots, "pivots stay in their own list");

        // Read unconditionally with the record: a manifest that forgot the id
        // still gets the list back.
        let stripped = rewrite_archive(&bytes, |name, content| {
            (name == "manifest.json").then(|| {
                let mut m: Manifest = serde_json::from_slice(content).unwrap();
                m.features.retain(|f| f != RIBBON_FILTER_VISUAL_TARGETS_FEATURE);
                serde_json::to_vec_pretty(&m).unwrap()
            })
        });
        assert_eq!(read_calcula_bytes(&stripped).unwrap().ribbon_filters[0].connected_visuals, visuals);
    }

    /// One sheet's controls payload holding a single control of `control_type`.
    fn controls_with(sheet: SheetId, control_type: &str) -> persistence::SavedSheetControls {
        persistence::SavedSheetControls {
            sheet_id: sheet,
            controls: serde_json::json!([{
                "row": 2, "col": 1, "controlType": control_type,
                "properties": {
                    "pinToGrid": { "valueType": "static", "value": "false" },
                    "pageOverrides": { "valueType": "static", "value": "[]" }
                }
            }]),
        }
    }

    /// D-NAV: a PAGE NAVIGATOR declares a manifest FEATURE ID and takes NO link
    /// in the format-version chain -- an older reader paints it as a dead grey
    /// button, a visible loss, never a lie. A canvas carrying one stamps exactly
    /// what a plain canvas stamps (v9); a plain button declares no id.
    ///
    /// SABOTAGE: stamp CANVAS_SHEET_MIN_FORMAT_VERSION + 1 beside the push, or
    /// drop the push.
    #[test]
    fn page_navigator_declares_a_feature_id_but_never_raises_the_version() {
        let mut workbook = make_test_workbook();
        workbook.sheets[0].kind = persistence::SheetKind::new_canvas();
        let sheet = workbook.sheets[0].id;
        workbook.controls = vec![controls_with(sheet, crate::page_navigator::PAGE_NAVIGATOR_CONTROL_TYPE)];
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("navigator.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();
        assert_eq!(loaded.controls.len(), 1);
        assert_eq!(loaded.controls[0].controls[0]["controlType"], "pageNavigator");
        let manifest = read_calcula_manifest(&std::fs::read(&path).unwrap()).unwrap();
        assert!(manifest.features.iter().any(|f| f == PAGE_NAVIGATOR_FEATURE), "{:?}", manifest.features);
        assert_eq!(
            manifest.format_version, CANVAS_SHEET_MIN_FORMAT_VERSION,
            "a navigator must not raise the version above the canvas link itself"
        );

        // An ordinary button on the same canvas declares no id.
        let mut plain = make_test_workbook();
        plain.sheets[0].kind = persistence::SheetKind::new_canvas();
        let sheet = plain.sheets[0].id;
        plain.controls = vec![controls_with(sheet, "button")];
        let path = dir.path().join("button.cala");
        write_calcula(&plain, &path).unwrap();
        let manifest = read_calcula_manifest(&std::fs::read(&path).unwrap()).unwrap();
        assert!(!manifest.features.iter().any(|f| f == PAGE_NAVIGATOR_FEATURE), "{:?}", manifest.features);
        assert_eq!(manifest.format_version, CANVAS_SHEET_MIN_FORMAT_VERSION);
    }

    /// The READ is unconditional: controls.json is opaque per sheet, so a file
    /// whose manifest forgot the id still loads the navigator.
    #[test]
    fn page_navigator_loads_without_its_feature_id() {
        let mut workbook = make_test_workbook();
        let sheet = workbook.sheets[0].id;
        workbook.controls = vec![controls_with(sheet, crate::page_navigator::PAGE_NAVIGATOR_CONTROL_TYPE)];
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("navigator-noid.cala");
        write_calcula(&workbook, &path).unwrap();

        let bytes = std::fs::read(&path).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let out_path = dir.path().join("navigator-noid-stripped.cala");
        {
            let mut out = zip::ZipWriter::new(std::fs::File::create(&out_path).unwrap());
            for i in 0..archive.len() {
                let mut entry = archive.by_index(i).unwrap();
                let name = entry.name().to_string();
                let mut data = Vec::new();
                std::io::Read::read_to_end(&mut entry, &mut data).unwrap();
                if name == "manifest.json" {
                    let mut m: serde_json::Value = serde_json::from_slice(&data).unwrap();
                    let features = m["features"].as_array_mut().unwrap();
                    assert!(features.iter().any(|f| f == PAGE_NAVIGATOR_FEATURE), "precondition: the id was written");
                    features.retain(|f| f != PAGE_NAVIGATOR_FEATURE);
                    data = serde_json::to_vec(&m).unwrap();
                }
                out.start_file(name, FileOptions::<()>::default()).unwrap();
                std::io::Write::write_all(&mut out, &data).unwrap();
            }
            out.finish().unwrap();
        }
        let loaded = read_calcula(&out_path).unwrap();
        assert_eq!(loaded.controls.len(), 1);
        assert_eq!(loaded.controls[0].controls, workbook.controls[0].controls);
    }

    /// A canvas at the DEFAULT layout must still be written: its metadata.json
    /// is never omittable, or the sheet reloads as a worksheet.
    #[test]
    fn test_a_default_layout_canvas_is_still_a_canvas_after_reload() {
        let mut workbook = make_test_workbook();
        workbook.sheets[0].kind = persistence::SheetKind::new_canvas();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("canvas-default.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();
        assert!(loaded.sheets[0].kind.is_canvas(), "a default-layout canvas reloaded as a worksheet");
    }

    /// A workbook of worksheets only must NOT be stamped up to v9 -- ordinary
    /// saves stay openable by older builds.
    #[test]
    fn test_worksheets_only_mean_no_canvas_stamp() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no-canvas.cala");
        write_calcula(&workbook, &path).unwrap();
        let manifest = read_calcula_manifest(&std::fs::read(&path).unwrap()).unwrap();
        assert!(manifest.format_version < CANVAS_SHEET_MIN_FORMAT_VERSION);
        assert!(!manifest.features.iter().any(|f| f == "canvas_sheets"));
    }

    /// The bindings link (v10) sits ABOVE every earlier link, so a build whose
    /// ceiling is the previous maximum (v9, canvas) refuses a workbook with a
    /// binding through the reader gate rather than painting frozen literals.
    /// The chart-shape link shares v10: both changed in the same build.
    #[test]
    fn the_bindings_link_is_above_every_earlier_link() {
        assert!(CANVAS_SHEET_MIN_FORMAT_VERSION > PINNED_FILTER_MIN_FORMAT_VERSION);
        assert!(CANVAS_SHEET_MIN_FORMAT_VERSION < OBJECT_BINDINGS_MIN_FORMAT_VERSION);
        assert!(OBJECT_BINDINGS_MIN_FORMAT_VERSION < FLOATING_GRID_HIDDEN_LINES_MIN_FORMAT_VERSION);
        assert!(CHART_SPEC_OBJECT_MIN_FORMAT_VERSION < FLOATING_GRID_HIDDEN_LINES_MIN_FORMAT_VERSION);
        assert_eq!(OBJECT_BINDINGS_MIN_FORMAT_VERSION, CHART_SPEC_OBJECT_MIN_FORMAT_VERSION);
    }

    /// The floating-grid hidden-lines link (v11) sits ABOVE every earlier link
    /// and is the current ceiling, so a v10 build (bindings) refuses a workbook
    /// whose floating grid hides rows instead of showing them.
    #[test]
    fn the_hidden_lines_link_is_above_every_earlier_link() {
        for earlier in [
            PENDING_RECALC_MIN_FORMAT_VERSION,
            USER_HIDDEN_MIN_FORMAT_VERSION,
            SHEET_VIEW_MIN_FORMAT_VERSION,
            SHEET_DISPLAY_FLAGS_MIN_FORMAT_VERSION,
            SPILL_EXTENT_MIN_FORMAT_VERSION,
            PINNED_FILTER_MIN_FORMAT_VERSION,
            CANVAS_SHEET_MIN_FORMAT_VERSION,
            OBJECT_BINDINGS_MIN_FORMAT_VERSION,
            CHART_SPEC_OBJECT_MIN_FORMAT_VERSION,
        ] {
            assert!(earlier < FLOATING_GRID_HIDDEN_LINES_MIN_FORMAT_VERSION, "{earlier}");
        }
        assert_eq!(FLOATING_GRID_HIDDEN_LINES_MIN_FORMAT_VERSION, CALA_MAX_SUPPORTED_FORMAT_VERSION);
    }

    /// A split ALONE stamps it too: the split is as unrecoverable as the zoom.
    #[test]
    fn test_a_split_alone_stamps_the_version() {
        let mut workbook = make_test_workbook();
        workbook.sheets[0].split_col = Some(5);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("split-only.cala");
        write_calcula(&workbook, &path).unwrap();
        let manifest = read_calcula_manifest(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(manifest.format_version, SHEET_VIEW_MIN_FORMAT_VERSION);
    }

    /// A workbook with no hand-hidden rows must NOT be stamped up the chain —
    /// otherwise every ordinary save demands a newer reader for nothing.
    #[test]
    fn test_no_user_hidden_means_no_version_stamp() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plain.cala");
        write_calcula(&workbook, &path).unwrap();
        let manifest = read_calcula_manifest(&std::fs::read(&path).unwrap()).unwrap();
        assert!(manifest.format_version < USER_HIDDEN_MIN_FORMAT_VERSION);
        assert!(!manifest.features.iter().any(|f| f == "user_hidden"));
    }

    /// EVERY cell error must survive a save/reload as ITSELF.
    ///
    /// This was broken for all of them, not just for the new one: the writer
    /// stored `format!("{:?}", e)` (the Rust variant name) and the reader
    /// discarded the string entirely and returned `CellError::Value`. So
    /// `#DIV/0!`, `#N/A`, `#REF!`, `#CIRCULAR!` and `#BLOCKED!` all came back as
    /// `#VALUE!` — five different diagnoses collapsed into one wrong one, and
    /// `#BLOCKED!` (a transparency signal about code the user refused to run)
    /// silently downgraded into a type error.
    #[test]
    fn test_roundtrip_every_cell_error_literal() {
        use engine::cell::CellError;
        let variants = [
            CellError::Div0,
            CellError::Ref,
            CellError::Name,
            CellError::Value,
            CellError::NA,
            CellError::Circular,
            CellError::Conflict,
            CellError::Blocked,
            CellError::Limit,
        ];
        for e in variants {
            let saved = persistence::SavedCellValue::from_value(&engine::CellValue::Error(e.clone()));
            match &saved {
                persistence::SavedCellValue::Error(s) => {
                    assert_eq!(s, e.as_literal(), "the canonical literal is what gets written");
                }
                other => panic!("expected an Error payload, got {other:?}"),
            }
            assert_eq!(
                saved.to_value(),
                engine::CellValue::Error(e.clone()),
                "{} did not survive the save/reload round trip",
                e.as_literal()
            );
        }
        // EVERY variant round-trips now. There used to be one that did not —
        // `CellError::Parse` shared the `#VALUE!` spelling and reloaded as
        // `Value` — and the asymmetry was asserted here so it stayed a decision
        // rather than a surprise. D7 deleted the variant instead: it was never
        // constructed anywhere in the product (an unparseable formula is stored
        // as TEXT by `Cell::new_formula`), so it existed only to be the one
        // error that changed meaning on reload.
    }

    #[test]
    fn test_roundtrip_protection() {
        // Regression: sheet/cell/workbook protection was not modeled in the file
        // format at all — every protected workbook reopened fully unprotected.
        // Payloads are opaque to the format (app-owned JSON); this asserts the
        // per-sheet payloads + SheetId + the workbook-level payload survive.
        let mut workbook = make_test_workbook();
        let sheet_id = workbook.sheets[0].id;
        workbook.sheet_protections = vec![persistence::SavedSheetProtection {
            sheet_id,
            protection: Some(serde_json::json!({
                "protected": true,
                "passwordHash": "abc123",
                "passwordSalt": "salt",
                "options": { "selectLockedCells": true, "formatCells": false },
                "allowEditRanges": []
            })),
            cell_protection: Some(serde_json::json!([
                { "row": 2, "col": 3, "locked": false, "formulaHidden": true }
            ])),
        }];
        workbook.workbook_protection =
            Some(serde_json::json!({ "protected": true, "passwordHash": "wb-hash" }));

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("protection.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.sheet_protections.len(), 1, "sheet protection must survive");
        assert_eq!(loaded.sheet_protections[0].sheet_id, sheet_id);
        assert_eq!(
            loaded.sheet_protections[0].protection,
            workbook.sheet_protections[0].protection
        );
        assert_eq!(
            loaded.sheet_protections[0].cell_protection,
            workbook.sheet_protections[0].cell_protection
        );
        assert_eq!(loaded.workbook_protection, workbook.workbook_protection);
    }

    #[test]
    fn test_roundtrip_comments_scenarios_outlines() {
        // Regression (.calp fidelity Wave B): threaded comments, what-if
        // scenarios, and outline groups lived only in AppState and vanished on
        // every save/reload. All three persist as opaque per-sheet payloads
        // keyed by SheetId, exactly like conditional formats.
        let mut workbook = make_test_workbook();
        let sheet_id = workbook.sheets[0].id;
        workbook.comments = vec![persistence::SavedSheetComments {
            sheet_id,
            comments: serde_json::json!([
                { "id": "c-1", "row": 0, "col": 0, "sheetIndex": 0,
                  "authorEmail": "a@example.com", "authorName": "A",
                  "content": "Check this figure", "resolved": false,
                  "replies": [ { "id": "r-1", "authorEmail": "b@example.com",
                                 "authorName": "B", "content": "Looks right",
                                 "mentions": [], "createdAt": "2026-07-01T00:00:00Z",
                                 "modifiedAt": null } ],
                  "mentions": [], "createdAt": "2026-07-01T00:00:00Z" }
            ]),
        }];
        workbook.scenarios = vec![persistence::SavedSheetScenarios {
            sheet_id,
            scenarios: serde_json::json!([
                { "name": "Best case", "comment": "", "createdBy": "A",
                  "sheetIndex": 0,
                  "changingCells": [ { "row": 1, "col": 1, "value": "42" } ] }
            ]),
        }];
        workbook.outlines = vec![persistence::SavedSheetOutline {
            sheet_id,
            outline: serde_json::json!({
                "rowGroups": [ { "startRow": 2, "endRow": 5, "level": 1, "collapsed": true } ],
                "columnGroups": [],
                "settings": { "summaryRowPosition": "belowRight",
                              "summaryColPosition": "belowRight",
                              "showOutlineSymbols": true, "autoStyles": false },
                "maxRowLevel": 1, "maxColLevel": 0
            }),
        }];

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("comments_scenarios_outlines.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.comments.len(), 1, "comments must survive the .cala round-trip");
        assert_eq!(loaded.comments[0].sheet_id, sheet_id);
        assert_eq!(loaded.comments[0].comments, workbook.comments[0].comments);
        assert_eq!(loaded.scenarios.len(), 1, "scenarios must survive the .cala round-trip");
        assert_eq!(loaded.scenarios[0].sheet_id, sheet_id);
        assert_eq!(loaded.scenarios[0].scenarios, workbook.scenarios[0].scenarios);
        assert_eq!(loaded.outlines.len(), 1, "outlines must survive the .cala round-trip");
        assert_eq!(loaded.outlines[0].sheet_id, sheet_id);
        assert_eq!(loaded.outlines[0].outline, workbook.outlines[0].outline);
    }

    #[test]
    fn test_comments_scenarios_outlines_absent_default_to_empty() {
        // Files written before Wave B have none of the three artifacts —
        // they must load as empty stores, not error.
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no_wave_b.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();
        assert!(loaded.comments.is_empty());
        assert!(loaded.scenarios.is_empty());
        assert!(loaded.outlines.is_empty());
    }

    #[test]
    fn test_roundtrip_controls() {
        // Regression: control metadata (buttons/checkboxes — onSelect scripts,
        // formula-driven properties) lived only in AppState and vanished on every
        // save/reload. The payload is opaque to the format (app-owned JSON), so
        // this asserts the per-sheet payload + SheetId survive write/read.
        let mut workbook = make_test_workbook();
        let sheet_id = workbook.sheets[0].id;
        workbook.controls = vec![persistence::SavedSheetControls {
            sheet_id,
            controls: serde_json::json!([
                { "row": 2, "col": 3, "controlType": "button",
                  "properties": {
                      "text": { "valueType": "static", "value": "Run" },
                      "onSelect": { "valueType": "static", "value": "script-uuid-1" }
                  } }
            ]),
        }];

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.controls.len(), 1, "controls must survive the .cala round-trip");
        assert_eq!(loaded.controls[0].sheet_id, sheet_id);
        assert_eq!(loaded.controls[0].controls, workbook.controls[0].controls);
    }

    #[test]
    fn test_roundtrip_cell_types() {
        // Cell-type assignments (granular bricks: checkbox/progress/button
        // typed cells) persist as an opaque per-sheet payload keyed by SheetId,
        // exactly like controls.
        let mut workbook = make_test_workbook();
        let sheet_id = workbook.sheets[0].id;
        workbook.cell_types = vec![persistence::SavedSheetCellTypes {
            sheet_id,
            cells: serde_json::json!([
                { "row": 1, "col": 0, "typeId": "calcula.checkbox", "params": {} },
                { "row": 4, "col": 2, "typeId": "calcula.progress", "params": { "max": 100 } }
            ]),
        }];

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cell_types.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.cell_types.len(), 1, "cell types must survive the .cala round-trip");
        assert_eq!(loaded.cell_types[0].sheet_id, sheet_id);
        assert_eq!(loaded.cell_types[0].cells, workbook.cell_types[0].cells);
    }

    #[test]
    fn test_cell_types_absent_defaults_to_empty() {
        // Files written before cell types existed have no cell_types.json —
        // they must load as an empty store, not error.
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no_cell_types.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();
        assert!(loaded.cell_types.is_empty());
    }

    #[test]
    fn test_roundtrip_with_tables() {
        let mut workbook = make_test_workbook();
        let sheet_id = workbook.sheets[0].id;
        workbook.tables.push(persistence::SavedTable {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: "SalesTable".to_string(),
            sheet_id,
            start_row: 0,
            start_col: 0,
            end_row: 2,
            end_col: 1,
            columns: vec![
                persistence::SavedTableColumn {
                    id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
                    name: "Name".to_string(),
                    totals_row_function: "none".to_string(),
                    totals_row_formula: None,
                    calculated_formula: None,
                },
                persistence::SavedTableColumn {
                    id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
                    name: "Value".to_string(),
                    totals_row_function: "sum".to_string(),
                    totals_row_formula: None,
                    calculated_formula: None,
                },
            ],
            style_options: persistence::SavedTableStyleOptions {
                banded_rows: true,
                banded_columns: false,
                header_row: true,
                total_row: false,
                first_column: false,
                last_column: false,
                show_filter_button: true,
            },
            style_name: "TableStyleMedium2".to_string(),
        });

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_tables.cala");

        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.tables.len(), 1);
        assert_eq!(loaded.tables[0].name, "SalesTable");
        assert_eq!(loaded.tables[0].sheet_id, sheet_id);
        assert_eq!(loaded.tables[0].columns.len(), 2);
        assert_eq!(loaded.tables[0].style_options.banded_rows, true);
    }

    #[test]
    fn test_roundtrip_with_object_scripts() {
        let mut workbook = make_test_workbook();
        workbook.object_scripts.push(persistence::SavedObjectScript {
            id: "os-1".to_string(),
            name: "Cell Script".to_string(),
            object_type: persistence::ScriptableObjectType::Cell,
            instance_id: None,
            source: "function setup(cell) { cell.onEdit(() => {}); }".to_string(),
            access_level: persistence::ScriptAccessLevel::Restricted,
            description: Some("Test cell script".to_string()),
            provenance: persistence::ScriptProvenance::Local,
            package_name: None,
            package_version: None,
            declared_capabilities: Vec::new(),
        });
        workbook.object_scripts.push(persistence::SavedObjectScript {
            id: "os-2".to_string(),
            name: "Slicer Script".to_string(),
            object_type: persistence::ScriptableObjectType::Slicer,
            instance_id: Some("slicer-42".to_string()),
            source: "function setup(slicer) { slicer.onSelectionChange(() => {}); }".to_string(),
            access_level: persistence::ScriptAccessLevel::Unlocked,
            description: None,
            provenance: persistence::ScriptProvenance::Distributed,
            package_name: Some("test-pkg".to_string()),
            package_version: Some("1.2.0".to_string()),
            declared_capabilities: Vec::new(),
        });

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_object_scripts.cala");

        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.object_scripts.len(), 2);

        // Verify primitive script
        let cell_script = loaded.object_scripts.iter().find(|s| s.id == "os-1").unwrap();
        assert_eq!(cell_script.name, "Cell Script");
        assert_eq!(cell_script.object_type, persistence::ScriptableObjectType::Cell);
        assert!(cell_script.instance_id.is_none());
        assert_eq!(cell_script.access_level, persistence::ScriptAccessLevel::Restricted);
        assert!(cell_script.source.contains("cell.onEdit"));
        assert_eq!(cell_script.description, Some("Test cell script".to_string()));

        // Verify component script
        let slicer_script = loaded.object_scripts.iter().find(|s| s.id == "os-2").unwrap();
        assert_eq!(slicer_script.name, "Slicer Script");
        assert_eq!(slicer_script.object_type, persistence::ScriptableObjectType::Slicer);
        assert_eq!(slicer_script.instance_id, Some("slicer-42".to_string()));
        assert_eq!(slicer_script.access_level, persistence::ScriptAccessLevel::Unlocked);
    }

    #[test]
    fn test_roundtrip_with_bi_connection_roles() {
        let mut workbook = make_test_workbook();
        workbook.bi_connection_roles.push(persistence::SavedBiConnectionRole {
            connection_key: "ds-sales-uuid".to_string(),
            active_role: "WestRegion".to_string(),
        });
        workbook.bi_connection_roles.push(persistence::SavedBiConnectionRole {
            connection_key: "C:/models/local.model".to_string(),
            active_role: "Analyst".to_string(),
        });

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_bi_roles.cala");

        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.bi_connection_roles.len(), 2);
        let pkg = loaded.bi_connection_roles.iter()
            .find(|r| r.connection_key == "ds-sales-uuid").unwrap();
        assert_eq!(pkg.active_role, "WestRegion");
        let local = loaded.bi_connection_roles.iter()
            .find(|r| r.connection_key == "C:/models/local.model").unwrap();
        assert_eq!(local.active_role, "Analyst");
    }

    #[test]
    fn test_roundtrip_without_bi_connection_roles_is_empty() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_no_bi_roles.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();
        assert!(loaded.bi_connection_roles.is_empty());
    }

    #[test]
    fn test_roundtrip_extension_data() {
        let mut workbook = make_test_workbook();
        workbook.extension_data.insert(
            "calcula.my-extension".to_string(),
            serde_json::json!({ "enabled": true, "items": [1, 2, 3], "label": "héllo" }),
        );
        workbook.extension_data.insert(
            "third.party.ext".to_string(),
            serde_json::json!("a bare string value"),
        );

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_extension_data.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.extension_data.len(), 2);
        assert_eq!(loaded.extension_data["calcula.my-extension"]["items"][1], 2);
        assert_eq!(loaded.extension_data["calcula.my-extension"]["label"], "héllo");
        assert_eq!(loaded.extension_data["third.party.ext"], "a bare string value");

        // Empty extension_data must NOT write the part, and still round-trips empty.
        let empty = make_test_workbook();
        let path2 = dir.path().join("test_extension_data_empty.cala");
        write_calcula(&empty, &path2).unwrap();
        let loaded2 = read_calcula(&path2).unwrap();
        assert!(loaded2.extension_data.is_empty());
    }

    #[test]
    fn test_roundtrip_with_bi_connections() {
        let mut workbook = make_test_workbook();
        workbook.bi_connections.push(persistence::SavedBiConnection {
            id: "11111111-1111-1111-1111-111111111111".to_string(),
            name: "Sales DB".to_string(),
            description: "Local sales model".to_string(),
            connection_type: "PostgreSQL".to_string(),
            server: "localhost".to_string(),
            database: "sales".to_string(),
            preferred_auth: "Integrated".to_string(),
            model_path: Some("C:/models/sales.model".to_string()),
            model_json: serde_json::json!({ "tables": [], "measures": [], "formatVersion": 1 }),
            bindings: vec![persistence::SavedBiBinding {
                model_table: "Sales".to_string(),
                schema: "public".to_string(),
                source_table: "sales".to_string(),
                source_query: None,
            }],
            calculated_measures: Vec::new(),
        });

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_bi_connections.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.bi_connections.len(), 1);
        let c = &loaded.bi_connections[0];
        assert_eq!(c.id, "11111111-1111-1111-1111-111111111111");
        assert_eq!(c.name, "Sales DB");
        assert_eq!(c.server, "localhost");
        assert_eq!(c.database, "sales");
        assert_eq!(c.bindings.len(), 1);
        assert_eq!(c.bindings[0].model_table, "Sales");
        assert_eq!(c.model_json["formatVersion"], 1);
        // Credentials are never persisted.
        assert_eq!(loaded.bi_connections[0].model_json.get("connectionString"), None);
    }

    #[test]
    fn test_roundtrip_with_bi_connection_caches() {
        let mut workbook = make_test_workbook();
        let mut files = HashMap::new();
        files.insert("metadata.json".to_string(), b"{\"tables\":[]}".to_vec());
        // Raw binary (incl. non-UTF8 bytes) must round-trip byte-for-byte.
        files.insert("Sales_1a2b3c4d.arrow".to_string(), vec![1u8, 2, 3, 255, 0, 42, 200]);
        workbook.bi_connection_caches.insert("conn-1".to_string(), files);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_bi_cache.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.bi_connection_caches.len(), 1);
        let c = loaded.bi_connection_caches.get("conn-1").unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(c.get("metadata.json").unwrap(), b"{\"tables\":[]}");
        assert_eq!(
            c.get("Sales_1a2b3c4d.arrow").unwrap(),
            &vec![1u8, 2, 3, 255, 0, 42, 200]
        );
    }

    #[test]
    fn test_bi_connection_caches_absent_when_empty() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_no_bi_cache.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();
        assert!(loaded.bi_connection_caches.is_empty());
    }

    #[test]
    fn test_empty_workbook() {
        let workbook = Workbook::new();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.cala");

        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.sheets.len(), 1);
        assert_eq!(loaded.sheets[0].name, "Sheet1");
        assert!(loaded.sheets[0].cells.is_empty());
    }

    /// A timeline slicer survives save -> load, and the section is DECLARED.
    ///
    /// This is the test that fails if the section is written but never read back
    /// — the shape of bug that hides for months, because saving looks fine and
    /// the loss only appears on reopen. It asserts the VALUES, not just the
    /// count: an empty `Vec` with the right length would pass a count check.
    #[test]
    fn timeline_slicers_round_trip_and_declare_their_feature_id() {
        let mut workbook = make_test_workbook();
        let sheet_id = workbook.sheets[0].id;
        let tl_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        let pivot_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        workbook.timeline_slicers = vec![persistence::SavedTimelineSlicer {
            id: tl_id,
            name: "Order Date".to_string(),
            header_text: Some("When".to_string()),
            sheet_id,
            x: 12.5,
            y: 34.5,
            width: 350.0,
            height: 100.0,
            source_type: persistence::SavedTimelineSourceType::Pivot,
            source_id: pivot_id,
            field_name: "OrderDate".to_string(),
            level: persistence::SavedTimelineLevel::Quarters,
            selection_start: Some("2026-01-01".to_string()),
            selection_end: Some("2026-06-30".to_string()),
            show_header: true,
            show_level_selector: false,
            show_scrollbar: true,
            style_preset: "TimelineStyleDark2".to_string(),
            connected_pivot_ids: vec![pivot_id],
            container: None,
        }];

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("timeline.cala");
        crate::save_calcula(&workbook, &path).unwrap();

        let loaded = crate::load_calcula(&path).unwrap();
        assert_eq!(
            loaded.timeline_slicers.len(),
            1,
            "the timeline did not survive save -> load"
        );
        let got = &loaded.timeline_slicers[0];
        assert_eq!(got.id, tl_id);
        assert_eq!(got.name, "Order Date");
        assert_eq!(got.header_text.as_deref(), Some("When"));
        assert_eq!(got.sheet_id, sheet_id, "sheets are referenced by STABLE id");
        assert_eq!(got.source_id, pivot_id);
        assert_eq!(got.field_name, "OrderDate");
        assert_eq!(got.level, persistence::SavedTimelineLevel::Quarters);
        assert_eq!(got.selection_start.as_deref(), Some("2026-01-01"));
        assert_eq!(got.selection_end.as_deref(), Some("2026-06-30"));
        // The three booleans are `default = true`, so a field that failed to
        // serialize would come back TRUE and look correct. Only the `false` one
        // can catch that, which is why the fixture sets it.
        assert!(!got.show_level_selector, "a dropped bool would default to true");
        assert!(got.show_header);
        assert!(got.show_scrollbar);
        assert_eq!(got.style_preset, "TimelineStyleDark2");
        assert_eq!(got.connected_pivot_ids, vec![pivot_id]);

        // ...and the manifest DECLARES the section, which is what lets an older
        // reader know it dropped something.
        let file = std::fs::File::open(&path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let manifest: crate::manifest::Manifest = {
            let mut f = archive.by_name("manifest.json").unwrap();
            let mut buf = String::new();
            std::io::Read::read_to_string(&mut f, &mut buf).unwrap();
            serde_json::from_str(&buf).unwrap()
        };
        assert!(
            manifest.features.iter().any(|f| f == "timeline_slicers"),
            "the timeline section was written without declaring its feature id: {:?}",
            manifest.features
        );
        // A feature id is NOT a version link: an older reader must still be able
        // to open this file and merely lose the timelines.
        assert!(
            manifest.format_version <= CALA_MAX_SUPPORTED_FORMAT_VERSION,
            "a feature id must not raise format_version"
        );
    }

    /// A workbook with no timelines writes no section and declares no id.
    ///
    /// Non-vacuity for the test above: an unconditional write would make that one
    /// pass while every ordinary document grew an empty section and an
    /// undeserved feature id.
    #[test]
    fn a_workbook_without_timelines_declares_nothing() {
        let workbook = make_test_workbook();
        assert!(workbook.timeline_slicers.is_empty(), "fixture precondition");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no_timeline.cala");
        crate::save_calcula(&workbook, &path).unwrap();

        let file = std::fs::File::open(&path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert!(
            archive.by_name("timeline_slicers.json").is_err(),
            "an empty timeline list must not write a section"
        );
        let manifest: crate::manifest::Manifest = {
            let mut f = archive.by_name("manifest.json").unwrap();
            let mut buf = String::new();
            std::io::Read::read_to_string(&mut f, &mut buf).unwrap();
            serde_json::from_str(&buf).unwrap()
        };
        assert!(!manifest.features.iter().any(|f| f == "timeline_slicers"));

        let loaded = crate::load_calcula(&path).unwrap();
        assert!(loaded.timeline_slicers.is_empty());
    }

    #[test]
    fn encrypted_roundtrip() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("enc.cala");
        crate::save_calcula_opt(&workbook, &path, Some(b"hunter2")).unwrap();

        // On disk it's an encrypted container, not a plain ZIP.
        let raw = std::fs::read(&path).unwrap();
        assert!(calcula_crypto::is_encrypted(&raw));
        assert_ne!(&raw[..2], b"PK");

        let loaded = crate::load_calcula_opt(&path, Some(b"hunter2")).unwrap();
        assert_eq!(loaded.sheets.len(), workbook.sheets.len());
    }

    #[test]
    fn encrypted_needs_then_wrong_password() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("enc2.cala");
        crate::save_calcula_opt(&workbook, &path, Some(b"s3cret")).unwrap();

        assert!(matches!(
            crate::load_calcula_opt(&path, None),
            Err(FormatError::NeedsPassword)
        ));
        assert!(matches!(
            crate::load_calcula_opt(&path, Some(b"wrong")),
            Err(FormatError::WrongPassword)
        ));
        // Correct password still works.
        assert!(crate::load_calcula_opt(&path, Some(b"s3cret")).is_ok());
    }

    #[test]
    fn plain_save_is_zip_by_default() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plain.cala");
        crate::save_calcula(&workbook, &path).unwrap();

        let raw = std::fs::read(&path).unwrap();
        assert_eq!(&raw[..2], b"PK", "plain save must remain a ZIP");
        assert!(!calcula_crypto::is_encrypted(&raw));
        let loaded = crate::load_calcula(&path).unwrap();
        assert_eq!(loaded.sheets.len(), workbook.sheets.len());
    }

    // -----------------------------------------------------------------------
    // Scheduled jobs: the section, its manifest feature, and its version stamp
    // -----------------------------------------------------------------------

    /// Read manifest.json straight out of the archive so the test asserts on
    /// what was actually WRITTEN, not on what the reader chose to reconstruct.
    fn read_manifest(path: &std::path::Path) -> Manifest {
        let bytes = std::fs::read(path).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut entry = archive.by_name("manifest.json").unwrap();
        let mut s = String::new();
        entry.read_to_string(&mut s).unwrap();
        serde_json::from_str(&s).unwrap()
    }

    #[test]
    fn a_workbook_without_schedules_stays_at_the_base_format_version() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nojobs.cala");
        write_calcula(&workbook, &path).unwrap();

        let manifest = read_manifest(&path);
        assert_eq!(manifest.format_version, CALA_BASE_FORMAT_VERSION);
        assert!(!manifest.features.iter().any(|f| f == SCHEDULED_JOBS_FEATURE));
    }

    #[test]
    fn scheduled_jobs_declare_a_feature_and_stamp_the_format_version() {
        use crate::features::scheduled_jobs::{ScheduledJobDef, ScheduledJobsFile};

        let mut workbook = make_test_workbook();
        let jobs = ScheduledJobsFile::new(vec![ScheduledJobDef {
            id: "sched-1".to_string(),
            script_id: "obj-1".to_string(),
            script_hash: "deadbeef".to_string(),
            surface: "object-script".to_string(),
            object_type: "shape".to_string(),
            instance_id: None,
            handler: "nightly".to_string(),
            cadence: "dailyAt".to_string(),
            interval_secs: 0,
            minute_of_day: 390,
            next_run_ms: 1_700_000_000_000,
            enabled: true,
            label: Some("Nightly refresh".to_string()),
            last_run_ms: 0,
            last_ok: false,
            last_error: None,
            run_count: 0,
        }]);
        workbook.user_files.insert(
            SCHEDULED_JOBS_FILE.to_string(),
            jobs.to_json_bytes().unwrap(),
        );

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("jobs.cala");
        write_calcula(&workbook, &path).unwrap();

        // The stamp chain: the section's presence RAISES format_version.
        let manifest = read_manifest(&path);
        assert_eq!(manifest.format_version, SCHEDULED_JOBS_MIN_FORMAT_VERSION);
        assert!(manifest.features.iter().any(|f| f == SCHEDULED_JOBS_FEATURE));
        assert!(manifest.features.iter().any(|f| f == "files"));

        // ...and the section itself survives the round trip byte-for-byte.
        let loaded = read_calcula(&path).unwrap();
        let bytes = loaded
            .user_files
            .get(SCHEDULED_JOBS_FILE)
            .expect("the scheduled-jobs section must round-trip");
        let back = ScheduledJobsFile::from_json_bytes(bytes).unwrap();
        assert_eq!(back.jobs.len(), 1);
        assert_eq!(back.jobs[0].script_hash, "deadbeef");
        assert_eq!(back.jobs[0].minute_of_day, 390);
    }

    #[test]
    fn a_format_version_beyond_this_build_is_refused() {
        // Forward-compat guard: a newer writer's archive must fail the open
        // rather than be read partially and re-saved with sections dropped.
        let workbook = make_test_workbook();
        let mut bytes = write_calcula_bytes(&workbook).unwrap();
        {
            // Rewrite manifest.json with an out-of-range version.
            let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes.clone())).unwrap();
            let mut manifest: Manifest = {
                let mut e = archive.by_name("manifest.json").unwrap();
                let mut s = String::new();
                e.read_to_string(&mut s).unwrap();
                serde_json::from_str(&s).unwrap()
            };
            manifest.format_version = CALA_MAX_SUPPORTED_FORMAT_VERSION + 1;

            let mut out = Vec::new();
            {
                let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut out));
                let options =
                    FileOptions::<()>::default().compression_method(CompressionMethod::Deflated);
                for i in 0..archive.len() {
                    let mut entry = archive.by_index(i).unwrap();
                    let name = entry.name().to_string();
                    zip.start_file(name.clone(), options.clone()).unwrap();
                    if name == "manifest.json" {
                        zip.write_all(serde_json::to_string_pretty(&manifest).unwrap().as_bytes())
                            .unwrap();
                    } else {
                        let mut content = Vec::new();
                        entry.read_to_end(&mut content).unwrap();
                        zip.write_all(&content).unwrap();
                    }
                }
                zip.finish().unwrap();
            }
            bytes = out;
        }

        let err = read_calcula_bytes(&bytes).unwrap_err();
        assert!(
            err.to_string().contains("Unsupported format version"),
            "got: {}",
            err
        );
    }

    // -----------------------------------------------------------------------
    // v10: object bindings + the chart spec embedded as a JSON object
    // -----------------------------------------------------------------------

    /// Rebuild an archive, letting `edit` replace (Some) or keep (None) each
    /// entry's bytes. Test-only plumbing for hand-shaping files an older or
    /// newer writer would produce.
    fn rewrite_archive(bytes: &[u8], edit: impl Fn(&str, &[u8]) -> Option<Vec<u8>>) -> Vec<u8> {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec())).unwrap();
        let mut out = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut out));
            let options = FileOptions::<()>::default().compression_method(CompressionMethod::Deflated);
            for i in 0..archive.len() {
                let mut entry = archive.by_index(i).unwrap();
                let name = entry.name().to_string();
                let mut content = Vec::new();
                entry.read_to_end(&mut content).unwrap();
                let content = edit(&name, &content).unwrap_or(content);
                zip.start_file(name, options.clone()).unwrap();
                zip.write_all(&content).unwrap();
            }
            zip.finish().unwrap();
        }
        out
    }

    fn manifest_of(bytes: &[u8]) -> Manifest {
        read_calcula_manifest(bytes).unwrap()
    }

    fn entry_text(bytes: &[u8], name: &str) -> Option<String> {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec())).unwrap();
        let mut entry = archive.by_name(name).ok()?;
        let mut s = String::new();
        entry.read_to_string(&mut s).unwrap();
        Some(s)
    }

    fn binding(kind: &str, id: &str, path: &str, formula: &str) -> persistence::SavedObjectBinding {
        persistence::SavedObjectBinding {
            object: persistence::SavedObjectRef { kind: kind.to_string(), id: id.to_string() },
            path: path.to_string(),
            formula: formula.to_string(),
            model: None,
        }
    }

    fn a_chart(sheet_id: SheetId) -> SavedChart {
        let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        SavedChart {
            id,
            sheet_id,
            spec: serde_json::json!({
                "chartId": id.to_string(),
                "name": "Chart 1",
                "sheetIndex": 0,
                "x": 0, "y": 0, "width": 300, "height": 200,
                "spec": { "mark": "bar", "data": "Sheet1!A1:B3", "title": "Sales" }
            }),
        }
    }

    /// Bindings round-trip exactly (sorted by object then path), declare their
    /// feature id, and stamp v10 -- the lie-class link.
    #[test]
    fn object_bindings_roundtrip_and_stamp_v10() {
        let mut workbook = make_test_workbook();
        // Deliberately unsorted, with a model key on one row.
        let mut measure = binding("chart", "c-2", "/spec/title", "=[Revenue]");
        measure.model = Some("conn-uuid-1".to_string());
        workbook.object_bindings = vec![
            measure.clone(),
            binding("control", "u-1", "/properties/text", "=Sheet1!A1"),
            binding("chart", "c-1", "/spec/title", "=Data!B2&\" units\""),
        ];
        let bytes = write_calcula_bytes(&workbook).unwrap();

        let manifest = manifest_of(&bytes);
        assert_eq!(manifest.format_version, OBJECT_BINDINGS_MIN_FORMAT_VERSION);
        assert!(manifest.features.iter().any(|f| f == OBJECT_BINDINGS_FEATURE));

        let loaded = read_calcula_bytes(&bytes).unwrap();
        assert_eq!(
            loaded.object_bindings,
            vec![
                binding("chart", "c-1", "/spec/title", "=Data!B2&\" units\""),
                measure,
                binding("control", "u-1", "/properties/text", "=Sheet1!A1"),
            ],
            "bindings must round-trip exactly, sorted by (object, path)"
        );
        assert_eq!(loaded.format_version, OBJECT_BINDINGS_MIN_FORMAT_VERSION);

        // The model key is omitted (not null) when absent.
        let text = entry_text(&bytes, "bindings.json").unwrap();
        assert_eq!(text.matches("\"model\"").count(), 1, "bindings.json: {text}");
    }

    /// No binding, no chart: no v10 stamp, no feature id, no bindings.json --
    /// ordinary workbooks stay openable by older builds.
    #[test]
    fn no_bindings_means_no_v10_stamp() {
        let workbook = make_test_workbook();
        let bytes = write_calcula_bytes(&workbook).unwrap();
        let manifest = manifest_of(&bytes);
        assert!(manifest.format_version < OBJECT_BINDINGS_MIN_FORMAT_VERSION);
        assert!(!manifest.features.iter().any(|f| f == OBJECT_BINDINGS_FEATURE));
        assert!(entry_text(&bytes, "bindings.json").is_none());
        assert!(read_calcula_bytes(&bytes).unwrap().object_bindings.is_empty());
    }

    /// The read is UNCONDITIONAL: a manifest that forgot the feature id still
    /// gets its bindings back (the named_ranges precedent).
    #[test]
    fn bindings_load_even_without_their_feature_id() {
        let mut workbook = make_test_workbook();
        workbook.object_bindings = vec![binding("canvasPage", "s-1", "/background", "=A1")];
        let bytes = write_calcula_bytes(&workbook).unwrap();
        let stripped = rewrite_archive(&bytes, |name, content| {
            (name == "manifest.json").then(|| {
                let mut m: Manifest = serde_json::from_slice(content).unwrap();
                m.features.retain(|f| f != OBJECT_BINDINGS_FEATURE);
                serde_json::to_vec_pretty(&m).unwrap()
            })
        });
        assert!(!manifest_of(&stripped).features.iter().any(|f| f == OBJECT_BINDINGS_FEATURE));
        let loaded = read_calcula_bytes(&stripped).unwrap();
        assert_eq!(loaded.object_bindings, workbook.object_bindings);
    }

    /// charts.json carries `spec` as an embedded JSON OBJECT (not a string
    /// holding JSON), and the chart round-trips unchanged.
    #[test]
    fn charts_json_embeds_the_spec_as_an_object() {
        let mut workbook = make_test_workbook();
        let chart = a_chart(workbook.sheets[0].id);
        workbook.charts.push(chart.clone());
        let bytes = write_calcula_bytes(&workbook).unwrap();

        let text = entry_text(&bytes, "charts.json").unwrap();
        let rows: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0]["spec"].is_object(), "spec must be an object: {text}");
        assert!(rows[0].get("specJson").is_none(), "no string spelling may remain: {text}");
        assert_eq!(rows[0]["spec"]["spec"]["mark"], "bar");

        let loaded = read_calcula_bytes(&bytes).unwrap();
        assert_eq!(loaded.charts.len(), 1);
        assert_eq!(loaded.charts[0].id, chart.id);
        assert_eq!(loaded.charts[0].sheet_id, chart.sheet_id);
        assert_eq!(loaded.charts[0].spec, chart.spec);
    }

    /// A spec the host could not parse when saving is kept as a STRING value
    /// and survives the round trip -- never dropped.
    #[test]
    fn an_unparseable_spec_is_kept_as_a_string_value() {
        let mut workbook = make_test_workbook();
        let mut chart = a_chart(workbook.sheets[0].id);
        chart.spec = serde_json::Value::String("{\"chartId\": broken".to_string());
        workbook.charts.push(chart.clone());
        let bytes = write_calcula_bytes(&workbook).unwrap();
        let loaded = read_calcula_bytes(&bytes).unwrap();
        assert_eq!(loaded.charts.len(), 1);
        assert_eq!(loaded.charts[0].spec, chart.spec);
    }

    /// Any chart stamps v10: an older reader cannot parse an object `spec`,
    /// so it must refuse cleanly instead of failing with a serde sentence.
    #[test]
    fn a_workbook_with_a_chart_is_stamped_v10() {
        let mut workbook = make_test_workbook();
        workbook.charts.push(a_chart(workbook.sheets[0].id));
        let bytes = write_calcula_bytes(&workbook).unwrap();
        let manifest = manifest_of(&bytes);
        assert_eq!(manifest.format_version, CHART_SPEC_OBJECT_MIN_FORMAT_VERSION);
        // The shape change is not an optional feature: no bindings id for it.
        assert!(!manifest.features.iter().any(|f| f == OBJECT_BINDINGS_FEATURE));
    }

    #[test]
    fn a_workbook_without_charts_or_bindings_is_not() {
        let workbook = make_test_workbook();
        assert!(workbook.charts.is_empty() && workbook.object_bindings.is_empty());
        let manifest = manifest_of(&write_calcula_bytes(&workbook).unwrap());
        assert!(manifest.format_version < CHART_SPEC_OBJECT_MIN_FORMAT_VERSION);
    }

    /// A pre-v10 charts.json row (`specJson` STRING, no `spec`) opens: the
    /// row is upgraded in place and the spec parsed into an object. An
    /// unparseable old string is kept as a string value.
    #[test]
    fn an_old_shape_charts_json_is_upgraded_on_read() {
        let mut workbook = make_test_workbook();
        let chart = a_chart(workbook.sheets[0].id);
        workbook.charts.push(chart.clone());
        let bytes = write_calcula_bytes(&workbook).unwrap();
        let broken_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        let old_shape = serde_json::to_vec_pretty(&serde_json::json!([
            {
                "id": chart.id,
                "sheetId": chart.sheet_id,
                "specJson": chart.spec.to_string(),
            },
            {
                "id": broken_id,
                "sheetId": chart.sheet_id,
                "specJson": "{not json",
            }
        ]))
        .unwrap();
        let old = rewrite_archive(&bytes, |name, _| (name == "charts.json").then(|| old_shape.clone()));
        let loaded = read_calcula_bytes(&old).unwrap();
        assert_eq!(loaded.charts.len(), 2);
        assert_eq!(loaded.charts[0].id, chart.id);
        assert!(loaded.charts[0].spec.is_object());
        assert_eq!(loaded.charts[0].spec, chart.spec);
        assert_eq!(loaded.charts[1].id, broken_id);
        assert_eq!(loaded.charts[1].spec, serde_json::Value::String("{not json".to_string()));
    }

    /// A charts.json that cannot be read names the FILE, never just the raw
    /// serde message -- both for text that is not JSON and for a row of the
    /// wrong shape.
    #[test]
    fn an_unreadable_charts_json_names_the_file() {
        let mut workbook = make_test_workbook();
        workbook.charts.push(a_chart(workbook.sheets[0].id));
        let bytes = write_calcula_bytes(&workbook).unwrap();
        let bad_inputs: [&[u8]; 2] = [b"{ this is not json", br#"[{"id": 5, "sheetId": "x"}]"#];
        for bad in bad_inputs {
            let broken = rewrite_archive(&bytes, |name, _| (name == "charts.json").then(|| bad.to_vec()));
            match read_calcula_bytes(&broken).unwrap_err() {
                FormatError::InvalidFormat(msg) => assert!(
                    msg.starts_with("charts.json in this file could not be read"),
                    "got: {msg}"
                ),
                other => panic!("expected the named-file sentence, got: {other}"),
            }
        }
    }

    /// The pure upgrade leaves a NEW-shape row alone and reports a row that
    /// fails the typed read with the named-file sentence.
    #[test]
    fn upgrade_saved_chart_rows_is_pure_and_names_the_file() {
        let sheet_id = SheetId::from_bytes(identity::generate_uuid_v7());
        let chart = a_chart(sheet_id);
        let rows = vec![serde_json::to_value(&chart).unwrap()];
        let back = upgrade_saved_chart_rows(rows).unwrap();
        assert_eq!(back[0].spec, chart.spec);
        let err = upgrade_saved_chart_rows(vec![serde_json::json!({ "id": 1 })]).unwrap_err();
        assert!(err.starts_with("charts.json in this file could not be read"), "{err}");
    }

    /// v12 -- one above this build -- is refused through the reader gate,
    /// while a v10 file (a binding) and a v11 file (a floating grid that hides
    /// a row) open.
    #[test]
    fn a_v12_file_is_refused() {
        assert_eq!(CALA_MAX_SUPPORTED_FORMAT_VERSION + 1, 12);
        let workbook = make_test_workbook();
        let bytes = write_calcula_bytes(&workbook).unwrap();
        let v12 = rewrite_archive(&bytes, |name, content| {
            (name == "manifest.json").then(|| {
                let mut m: Manifest = serde_json::from_slice(content).unwrap();
                m.format_version = 12;
                serde_json::to_vec_pretty(&m).unwrap()
            })
        });
        let err = read_calcula_bytes(&v12).unwrap_err();
        assert!(err.to_string().contains("Unsupported format version"), "got: {err}");

        let mut with_binding = make_test_workbook();
        with_binding.object_bindings = vec![binding("chart", "c", "/spec/title", "=A1")];
        assert!(read_calcula_bytes(&write_calcula_bytes(&with_binding).unwrap()).is_ok());

        let bytes = write_calcula_bytes(&with_hidden_lines(vec![1], Vec::new())).unwrap();
        assert_eq!(manifest_of(&bytes).format_version, 11);
        assert!(read_calcula_bytes(&bytes).is_ok());
    }

    // ---- WP-C: the visual container + the persisted pivot style ----

    fn a_container() -> visual_format::VisualContainerFormat {
        serde_json::from_value(serde_json::json!({
            "padding": {"top": 8, "left": 8},
            "title": {"show": true, "bold": true, "align": "left"},
            "background": {"color": "#fff4e5", "transparency": 10},
            "border": {"show": true, "color": "#336699", "width": 2, "radius": 8},
            "shadow": {"show": true, "position": "bottomRight", "blur": 4}
        }))
        .unwrap()
    }

    fn a_slicer(sheet_id: SheetId) -> persistence::SavedSlicer {
        let source = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        persistence::SavedSlicer {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: "Region".to_string(),
            header_text: None,
            sheet_id,
            x: 0.0, y: 0.0, width: 200.0, height: 150.0,
            source_type: persistence::SavedSlicerSourceType::Table,
            cache_source_id: source,
            field_name: "Region".to_string(),
            selected_items: None,
            show_header: true,
            columns: 1,
            style_preset: "default".to_string(),
            selection_mode: Default::default(),
            hide_no_data: false,
            indicate_no_data: true,
            sort_no_data_last: true,
            force_selection: false,
            show_select_all: false,
            arrangement: Default::default(),
            rows: 0,
            item_gap: 4.0,
            autogrid: true,
            item_padding: 0.0,
            button_radius: 4.0,
            computed_properties: Vec::new(),
            connected_sources: Vec::new(),
            filter_level: 1,
            data_source_id: None,
            container: None,
        }
    }

    fn a_timeline(sheet_id: SheetId) -> persistence::SavedTimelineSlicer {
        persistence::SavedTimelineSlicer {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: "Order Date".to_string(),
            header_text: None,
            sheet_id,
            x: 10.0, y: 20.0, width: 350.0, height: 100.0,
            source_type: persistence::SavedTimelineSourceType::Pivot,
            source_id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            field_name: "OrderDate".to_string(),
            level: persistence::SavedTimelineLevel::Months,
            selection_start: None,
            selection_end: None,
            show_header: true,
            show_level_selector: true,
            show_scrollbar: true,
            style_preset: "TimelineStyleLight1".to_string(),
            connected_pivot_ids: Vec::new(),
            container: None,
        }
    }

    fn a_floating_range(host: SheetId, backing: SheetId) -> persistence::SavedFloatingRange {
        persistence::SavedFloatingRange {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            backing_sheet_id: backing,
            host_sheet_id: host,
            x: 40.0,
            y: 60.0,
            rotation: 0.0,
            pin_to_grid: false,
            row_count: 3,
            col_count: 2,
            col_widths: HashMap::new(),
            row_heights: HashMap::new(),
            show_title: true,
            show_column_headers: true,
            show_row_headers: true,
            container: None,
            hidden_rows: Vec::new(),
            hidden_cols: Vec::new(),
        }
    }

    // ---- P3: hidden lines on a floating grid (format v11) ----

    /// One workbook holding one floating grid with the given hidden sets.
    fn with_hidden_lines(rows: Vec<u32>, cols: Vec<u32>) -> Workbook {
        let mut wb = make_test_workbook();
        let sheet = wb.sheets[0].id;
        let mut grid = a_floating_range(sheet, sheet);
        grid.hidden_rows = rows;
        grid.hidden_cols = cols;
        wb.floating_ranges = vec![grid];
        wb
    }

    /// CLAUDE.md "Stamp conditionally": a floating grid that hides nothing
    /// keeps the version below 11; hiding one row (or one column) ALONE
    /// stamps exactly 11.
    #[test]
    fn floating_grid_hidden_lines_stamp_v11_only_when_present() {
        let plain = write_calcula_bytes(&with_hidden_lines(Vec::new(), Vec::new())).unwrap();
        let plain_version = manifest_of(&plain).format_version;
        assert!(
            plain_version < FLOATING_GRID_HIDDEN_LINES_MIN_FORMAT_VERSION,
            "a floating grid that hides nothing must not stamp v11, got {plain_version}"
        );
        assert!(
            !entry_text(&plain, "floating_ranges.json").unwrap().contains("hidden"),
            "empty sets write no key"
        );

        let rows = write_calcula_bytes(&with_hidden_lines(vec![2], Vec::new())).unwrap();
        assert_eq!(manifest_of(&rows).format_version, FLOATING_GRID_HIDDEN_LINES_MIN_FORMAT_VERSION);
        assert_eq!(manifest_of(&rows).format_version, 11);

        let cols = write_calcula_bytes(&with_hidden_lines(Vec::new(), vec![0])).unwrap();
        assert_eq!(manifest_of(&cols).format_version, 11);
    }

    /// The stamp must reach the manifest that is IN THE ZIP. Reads the raw
    /// `manifest.json` entry back out of the written bytes (not an in-memory
    /// `Manifest`), which is what fails when the stamp drifts beside the
    /// `floating_ranges.json` write -- that runs after the manifest has
    /// already been flushed into the archive.
    #[test]
    fn a_hidden_line_stamp_reaches_the_written_manifest() {
        let bytes = write_calcula_bytes(&with_hidden_lines(vec![0, 4], vec![1])).unwrap();
        let raw = entry_text(&bytes, "manifest.json").expect("manifest.json in the archive");
        let manifest: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(manifest["formatVersion"], serde_json::json!(11), "manifest.json: {raw}");
    }

    /// The sets survive the archive, ASCENDING and deduplicated whatever order
    /// the writer held them in (the `col_widths` byte-determinism rule).
    #[test]
    fn floating_grid_hidden_lines_round_trip_ascending() {
        let wb = with_hidden_lines(vec![5, 1, 3, 1], vec![2, 0]);
        let bytes = write_calcula_bytes(&wb).unwrap();
        let json = entry_text(&bytes, "floating_ranges.json").unwrap();
        let rows: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(rows[0]["hiddenRows"], serde_json::json!([1, 3, 5]));
        assert_eq!(rows[0]["hiddenCols"], serde_json::json!([0, 2]));

        let loaded = read_calcula_bytes(&bytes).unwrap();
        assert_eq!(loaded.floating_ranges.len(), 1);
        assert_eq!(loaded.floating_ranges[0].hidden_rows, vec![1, 3, 5]);
        assert_eq!(loaded.floating_ranges[0].hidden_cols, vec![0, 2]);

        // The same sets in another order produce the same bytes for the row.
        let again = write_calcula_bytes(&with_hidden_lines(vec![3, 5, 1], vec![0, 2])).unwrap();
        let again_rows: serde_json::Value =
            serde_json::from_str(&entry_text(&again, "floating_ranges.json").unwrap()).unwrap();
        assert_eq!(again_rows[0]["hiddenRows"], rows[0]["hiddenRows"]);
        assert_eq!(again_rows[0]["hiddenCols"], rows[0]["hiddenCols"]);
    }

    fn a_pivot(frame_container: Option<serde_json::Value>, style: Option<serde_json::Value>) -> persistence::SavedPivotDefinition {
        let mut frame = serde_json::json!({"x": 10.0, "y": 20.0, "width": 400.0, "height": 300.0});
        if let Some(c) = frame_container {
            frame["container"] = c;
        }
        let mut definition = serde_json::json!({"id": "pivot", "canvas_frame": frame});
        if let Some(s) = style {
            definition["style"] = s;
        }
        persistence::SavedPivotDefinition {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            source_type: "grid".to_string(),
            source_sheet_index: Some(0),
            definition,
        }
    }

    fn a_control_sheet(sheet: SheetId, properties: serde_json::Value) -> persistence::SavedSheetControls {
        persistence::SavedSheetControls {
            sheet_id: sheet,
            controls: serde_json::json!([{
                "row": 2, "col": 1, "controlType": "shape", "properties": properties
            }]),
        }
    }

    fn written_manifest(workbook: &Workbook) -> (Manifest, Workbook) {
        let bytes = write_calcula_bytes(workbook).unwrap();
        (read_calcula_manifest(&bytes).unwrap(), read_calcula_bytes(&bytes).unwrap())
    }

    fn declares(manifest: &Manifest, id: &str) -> bool {
        manifest.features.iter().any(|f| f == id)
    }

    /// One workbook per container SOURCE, with (`true`) or without (`false`)
    /// a container on that source and nothing else changed.
    fn with_source(what: &str, on: bool) -> Workbook {
        let container = a_container();
        let container_json = serde_json::to_value(&container).unwrap();
        let mut wb = make_test_workbook();
        let sheet = wb.sheets[0].id;
        match what {
            "slicer" => {
                let mut s = a_slicer(sheet);
                s.container = on.then(|| container.clone());
                wb.slicers = vec![s];
            }
            "timeline" => {
                let mut t = a_timeline(sheet);
                t.container = on.then(|| container.clone());
                wb.timeline_slicers = vec![t];
            }
            "floating grid" => {
                let mut f = a_floating_range(sheet, sheet);
                f.container = on.then(|| container.clone());
                wb.floating_ranges = vec![f];
            }
            "pivot container" => {
                wb.pivot_definitions = vec![a_pivot(on.then(|| container_json.clone()), None)];
            }
            "chart spec key" => {
                let mut chart = a_chart(sheet);
                if on {
                    chart.spec["spec"]["container"] = container_json.clone();
                }
                wb.charts = vec![chart];
            }
            "control container key" => {
                let mut props = serde_json::json!({"fill": {"valueType": "static", "value": "#4472C4"}});
                if on {
                    props["containerBorderRadius"] = serde_json::json!({"valueType": "static", "value": "8"});
                }
                wb.controls = vec![a_control_sheet(sheet, props)];
            }
            other => panic!("unknown source {other}"),
        }
        wb
    }

    /// D-FORMAT (CLAUDE.md ".cala Format Versioning"): the VISUAL CONTAINER and
    /// the persisted PIVOT STYLE each declare a manifest FEATURE ID and take NO
    /// link in the format-version chain -- an older reader drops a border, a
    /// title or a gallery style, a visible cosmetic loss, never a lie. Each
    /// source ALONE declares `visual_container`, at exactly the version the
    /// same workbook without it stamps; every container survives the archive;
    /// a plain workbook and a default text box declare neither id.
    ///
    /// SABOTAGE: stamp a version beside either push, or drop a source from
    /// `workbook_carries_a_visual_container`.
    #[test]
    fn visual_container_and_pivot_style_declare_feature_ids_but_never_raise_the_version() {
        let container = a_container();
        let container_json = serde_json::to_value(&container).unwrap();

        // A plain workbook declares neither.
        let (plain, _) = written_manifest(&make_test_workbook());
        assert!(!declares(&plain, VISUAL_CONTAINER_FEATURE), "{:?}", plain.features);
        assert!(!declares(&plain, PIVOT_STYLE_FEATURE), "{:?}", plain.features);

        for what in ["slicer", "timeline", "floating grid", "pivot container", "chart spec key", "control container key"] {
            let (without, _) = written_manifest(&with_source(what, false));
            let (with, loaded) = written_manifest(&with_source(what, true));
            assert!(!declares(&without, VISUAL_CONTAINER_FEATURE), "{what} without a container: {:?}", without.features);
            assert!(declares(&with, VISUAL_CONTAINER_FEATURE), "{what} alone must declare it: {:?}", with.features);
            assert_eq!(
                with.format_version, without.format_version,
                "{what}: a container must never raise the format version"
            );
            assert!(!declares(&with, PIVOT_STYLE_FEATURE), "{what}");
            // The container survives the archive.
            match what {
                "slicer" => assert_eq!(loaded.slicers[0].container, Some(container.clone())),
                "timeline" => assert_eq!(loaded.timeline_slicers[0].container, Some(container.clone())),
                "floating grid" => assert_eq!(loaded.floating_ranges[0].container, Some(container.clone())),
                "pivot container" => assert_eq!(
                    loaded.pivot_definitions[0].definition.pointer("/canvas_frame/container"),
                    Some(&container_json)
                ),
                "chart spec key" => assert_eq!(loaded.charts[0].spec.pointer("/spec/container"), Some(&container_json)),
                _ => assert_eq!(
                    loaded.controls[0].controls[0]["properties"]["containerBorderRadius"]["value"],
                    "8"
                ),
            }
        }

        // The pivot STYLE declares its own id, alone, with no version link.
        let mut styled = make_test_workbook();
        styled.pivot_definitions = vec![a_pivot(None, Some(serde_json::json!({"style_id": "PivotStyleMedium9"})))];
        let mut unstyled = make_test_workbook();
        unstyled.pivot_definitions = vec![a_pivot(None, None)];
        let (with, loaded) = written_manifest(&styled);
        let (without, _) = written_manifest(&unstyled);
        assert!(declares(&with, PIVOT_STYLE_FEATURE), "{:?}", with.features);
        assert!(!declares(&with, VISUAL_CONTAINER_FEATURE), "{:?}", with.features);
        assert!(!declares(&without, PIVOT_STYLE_FEATURE), "{:?}", without.features);
        assert_eq!(with.format_version, without.format_version);
        assert_eq!(loaded.pivot_definitions[0].definition["style"]["style_id"], "PivotStyleMedium9");

        // A default TEXT BOX (fill/stroke none, dark left text: ordinary keys)
        // declares nothing; nor does a container key left at "" (the default).
        let mut text_box = make_test_workbook();
        let sheet = text_box.sheets[0].id;
        text_box.controls = vec![a_control_sheet(sheet, serde_json::json!({
            "shapeType": {"valueType": "static", "value": "textBox"},
            "fill": {"valueType": "static", "value": "none"},
            "stroke": {"valueType": "static", "value": "none"},
            "strokeWidth": {"valueType": "static", "value": "0"},
            "textColor": {"valueType": "static", "value": "#252423"},
            "textAlign": {"valueType": "static", "value": "left"},
            "containerTitleShow": {"valueType": "static", "value": ""}
        }))];
        let (m, _) = written_manifest(&text_box);
        assert!(!declares(&m, VISUAL_CONTAINER_FEATURE), "{:?}", m.features);
    }
}
