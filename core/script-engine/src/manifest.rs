//! FILENAME: core/script-engine/src/manifest.rs
//! PURPOSE: The interpreter's own answer to "what can code on this surface
//! touch?" — an enumerable op/reach manifest for the Rust QuickJS realm, plus
//! the live enumeration that PROVES the manifest matches what actually gets
//! registered.
//! CONTEXT: The transparency panel (app/src/api/codeInventory.ts) tells the user
//! how far a notebook / one-off script / MCP script / writeback validator can
//! reach — for most of them, "grid-only". Until this module existed that claim
//! was ASSERTED by a constant: nothing checked it against the interpreter, so an
//! op module that grew a new privileged reach would have widened what those
//! surfaces can do while the panel kept saying "grid-only". Transparency is a
//! product pillar, so the claim must be DERIVED.
//!
//! The chain of custody is:
//!   1. `enumerate_registered_surface()` boots a real QuickJS runtime through the
//!      same `runtime::execute_script` entry point every one-off run uses, walks
//!      the globals it finds, and returns the actual API surface.
//!   2. `OP_MANIFEST` classifies every path in that surface into a `ReachClass`
//!      (and, for the model class, the capability id the host gate demands).
//!      A test in this file diffs (1) against (2) — a new op fails the build.
//!   3. `SURFACE_PROFILES` records HOW each host surface constructs the realm
//!      (is a `ModelDataProvider` injected? which capabilities can the host hold
//!      for it? are the host globals deleted first?), so `surface_reach()` /
//!      `surface_capability_ids()` derive per-surface reach instead of restating
//!      a blanket constant. A second test proves the injection gate
//!      behaviourally: with no provider, every model op throws.
//!   4. The TypeScript side reads THIS FILE and diffs it against the taxonomy
//!      and the code inventory — see
//!      app/src/api/__tests__/interpreterReachDrift.test.ts.
//!
//! THE PROFILES IN STEP 3 ARE STILL HAND-ASSERTED, and that is this module's one
//! soft spot. `mcp-tool` claimed `model_provider: false` for a whole program
//! while `app/src-tauri/src/mcp/tools.rs` injected a `HostModelProvider`, and
//! because `surface_ops()` filters on that flag, every derivation downstream —
//! including the transparency panel's "grid-only" claim about the one surface
//! that runs AI-authored code — inherited the lie. A derivation is only as
//! honest as the flag it reads. The source-level guard that diffs these flags
//! against the provider-injecting entry points belongs in
//! app/src/api/__tests__/interpreterReachDrift.test.ts, which can read
//! app/src-tauri; core must not depend on the app crate.
//!
//! DO NOT hand-edit `OP_MANIFEST` to make a test pass without understanding what
//! the new op reaches: adding a row is a statement to the user about what their
//! sandboxed code may touch.

/// What a registered op lets sandboxed code touch. Ordered from "the cloned
/// workbook" outwards; only `Model` leaves the cloned grid state at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ReachClass {
    /// Cell values, formulas, ranges, fills and style application inside the
    /// CLONED grid handed to this run. Nothing here escapes the workbook.
    Grid,
    /// Workbook-level structure and settings: sheets, visibility, document
    /// properties, named styles, calculation/iteration settings.
    Workbook,
    /// View/UX state applied by the host after the run (zoom, view mode,
    /// gridlines, status bar, scroll area, navigation).
    View,
    /// Cell and view bookmarks.
    Bookmarks,
    /// Output back to the caller (console lines, structured tables).
    Output,
    /// Read-only application/locale metadata (name, version, separators).
    AppMetadata,
    /// Read-only BI/semantic-model data through the host-injected
    /// `ModelDataProvider`. This is the ONLY class that leaves the cloned
    /// workbook, and every call is capability-gated + audited HOST-side.
    Model,
}

impl ReachClass {
    /// Stable wire name. The TypeScript `InterpreterReachClass` union mirrors
    /// these exact strings, and a drift test pins them.
    pub const fn as_str(self) -> &'static str {
        match self {
            ReachClass::Grid => "grid",
            ReachClass::Workbook => "workbook",
            ReachClass::View => "view",
            ReachClass::Bookmarks => "bookmarks",
            ReachClass::Output => "output",
            ReachClass::AppMetadata => "appMetadata",
            ReachClass::Model => "model",
        }
    }

    /// True when this class requires a host-injected `ModelDataProvider` to do
    /// anything at all (the op is registered regardless; it throws without one).
    pub const fn needs_model_provider(self) -> bool {
        matches!(self, ReachClass::Model)
    }
}

/// Every reach class, for exhaustive iteration in tests and in the TS mirror.
pub const ALL_REACH_CLASSES: &[ReachClass] = &[
    ReachClass::Grid,
    ReachClass::Workbook,
    ReachClass::View,
    ReachClass::Bookmarks,
    ReachClass::Output,
    ReachClass::AppMetadata,
    ReachClass::Model,
];

/// One entry of the interpreter's API surface.
#[derive(Debug, Clone, Copy)]
pub struct OpEntry {
    /// Dotted path exactly as `enumerate_registered_surface()` reports it, e.g.
    /// `Calcula.application.goto`, `Range.setValues`, `__calcula_model_sql`.
    pub path: &'static str,
    /// What this op reaches.
    pub reach: ReachClass,
    /// The capability id the HOST gate demands for this op, when it demands one.
    /// Mirrors app/src/api/scriptHost/capabilityIds.ts. Grid-class ops carry
    /// `None` — they need no capability because they never leave the clone.
    pub capability: Option<&'static str>,
}

const fn op(path: &'static str, reach: ReachClass) -> OpEntry {
    OpEntry { path, reach, capability: None }
}

const fn gated(path: &'static str, reach: ReachClass, capability: &'static str) -> OpEntry {
    OpEntry { path, reach, capability: Some(capability) }
}

/// THE MANIFEST: every path the Rust QuickJS realm registers, classified.
///
/// Kept in `enumerate_registered_surface()` order (sorted by path) so a diff in
/// the failing-test output reads as a clean insertion.
pub const OP_MANIFEST: &[OpEntry] = &[
    // -- Roots ---------------------------------------------------------------
    op("Calcula", ReachClass::Grid),
    op("console", ReachClass::Output),
    op("display", ReachClass::Output),
    gated("model", ReachClass::Model, "bi.query"),
    // Hidden native sinks behind the `display` / `model` JS glue. No author
    // calls these directly, but they ARE part of the realm's surface — the
    // writeback-validator harness must account for them, so they are listed.
    op("__calcula_display_table", ReachClass::Output),
    gated("__calcula_model_connections", ReachClass::Model, "bi.query"),
    gated("__calcula_model_info", ReachClass::Model, "bi.query"),
    gated("__calcula_model_kpi", ReachClass::Model, "bi.query"),
    gated("__calcula_model_members", ReachClass::Model, "bi.query"),
    gated("__calcula_model_query", ReachClass::Model, "bi.query"),
    gated("__calcula_model_sql", ReachClass::Model, "bi.sql"),
    gated("__calcula_model_value", ReachClass::Model, "bi.query"),
    // -- Calcula.application -------------------------------------------------
    op("Calcula.application", ReachClass::Workbook),
    op("Calcula.application.calculate", ReachClass::Workbook),
    op("Calcula.application.calculationMode", ReachClass::Workbook),
    op("Calcula.application.decimalSeparator", ReachClass::AppMetadata),
    op("Calcula.application.goto", ReachClass::View),
    op("Calcula.application.name", ReachClass::AppMetadata),
    op("Calcula.application.operatingSystem", ReachClass::AppMetadata),
    op("Calcula.application.pathSeparator", ReachClass::AppMetadata),
    op("Calcula.application.screenUpdating", ReachClass::View),
    op("Calcula.application.statusBar", ReachClass::View),
    op("Calcula.application.thousandsSeparator", ReachClass::AppMetadata),
    op("Calcula.application.version", ReachClass::AppMetadata),
    // -- Calcula.bookmarks ---------------------------------------------------
    op("Calcula.bookmarks", ReachClass::Bookmarks),
    op("Calcula.bookmarks.activateViewBookmark", ReachClass::Bookmarks),
    op("Calcula.bookmarks.addCellBookmark", ReachClass::Bookmarks),
    op("Calcula.bookmarks.createViewBookmark", ReachClass::Bookmarks),
    op("Calcula.bookmarks.deleteViewBookmark", ReachClass::Bookmarks),
    op("Calcula.bookmarks.listCellBookmarks", ReachClass::Bookmarks),
    op("Calcula.bookmarks.listViewBookmarks", ReachClass::Bookmarks),
    op("Calcula.bookmarks.removeCellBookmark", ReachClass::Bookmarks),
    // -- Calcula.* (cells / sheets / view / workbook props) ------------------
    op("Calcula.applyNamedStyle", ReachClass::Grid),
    op("Calcula.clearStatusBarText", ReachClass::View),
    op("Calcula.fillDown", ReachClass::Grid),
    op("Calcula.fillRight", ReachClass::Grid),
    op("Calcula.getActiveSheet", ReachClass::Workbook),
    op("Calcula.getCalculationState", ReachClass::Workbook),
    op("Calcula.getCellFormula", ReachClass::Grid),
    op("Calcula.getCellValue", ReachClass::Grid),
    op("Calcula.getCurrentRegion", ReachClass::Grid),
    op("Calcula.getDisplayGridlines", ReachClass::View),
    op("Calcula.getDisplayHeadings", ReachClass::View),
    op("Calcula.getDisplayZeros", ReachClass::View),
    op("Calcula.getIterationSettings", ReachClass::Workbook),
    op("Calcula.getNamedStyles", ReachClass::Workbook),
    op("Calcula.getRange", ReachClass::Grid),
    op("Calcula.getReferenceStyle", ReachClass::View),
    op("Calcula.getScrollArea", ReachClass::View),
    op("Calcula.getSheetCount", ReachClass::Workbook),
    op("Calcula.getSheetNames", ReachClass::Workbook),
    op("Calcula.getSheetVisibility", ReachClass::Workbook),
    op("Calcula.getUsedRange", ReachClass::Grid),
    op("Calcula.getViewMode", ReachClass::View),
    op("Calcula.getWorkbookProperty", ReachClass::Workbook),
    op("Calcula.getZoom", ReachClass::View),
    op("Calcula.hideSheet", ReachClass::Workbook),
    op("Calcula.isDirty", ReachClass::Workbook),
    op("Calcula.log", ReachClass::Output),
    op("Calcula.nextSheet", ReachClass::View),
    op("Calcula.previousSheet", ReachClass::View),
    op("Calcula.product", ReachClass::AppMetadata),
    op("Calcula.scrollToCell", ReachClass::View),
    op("Calcula.setActiveSheet", ReachClass::View),
    op("Calcula.setCellValue", ReachClass::Grid),
    op("Calcula.setDisplayGridlines", ReachClass::View),
    op("Calcula.setDisplayHeadings", ReachClass::View),
    op("Calcula.setDisplayZeros", ReachClass::View),
    op("Calcula.setIterationSettings", ReachClass::Workbook),
    op("Calcula.setRange", ReachClass::Grid),
    op("Calcula.setReferenceStyle", ReachClass::View),
    op("Calcula.setScrollArea", ReachClass::View),
    op("Calcula.setStatusBarText", ReachClass::View),
    op("Calcula.setViewMode", ReachClass::View),
    op("Calcula.setWorkbookProperty", ReachClass::Workbook),
    op("Calcula.setZoom", ReachClass::View),
    op("Calcula.unhideSheet", ReachClass::Workbook),
    // -- Calcula.workbook (canonical shared object model) --------------------
    op("Calcula.workbook", ReachClass::Workbook),
    op("Calcula.workbook.activeSheet", ReachClass::Workbook),
    op("Calcula.workbook.sheet", ReachClass::Workbook),
    op("Calcula.workbook.sheets", ReachClass::Workbook),
    // -- console -------------------------------------------------------------
    op("console.error", ReachClass::Output),
    op("console.info", ReachClass::Output),
    op("console.log", ReachClass::Output),
    op("console.warn", ReachClass::Output),
    // -- display -------------------------------------------------------------
    op("display.table", ReachClass::Output),
    // -- model (JS glue over the native sinks) -------------------------------
    gated("model.connections", ReachClass::Model, "bi.query"),
    gated("model.info", ReachClass::Model, "bi.query"),
    gated("model.kpi", ReachClass::Model, "bi.query"),
    gated("model.members", ReachClass::Model, "bi.query"),
    gated("model.query", ReachClass::Model, "bi.query"),
    gated("model.sql", ReachClass::Model, "bi.sql"),
    gated("model.value", ReachClass::Model, "bi.query"),
    // -- Sheet (Calcula.workbook.activeSheet()) ------------------------------
    // `Sheet` / `Range` are SYNTHETIC roots: the canonical object model hands
    // these objects out from function calls, so the probe builds one of each and
    // walks it. They are not globals.
    op("Sheet", ReachClass::Workbook),
    op("Sheet.activate", ReachClass::View),
    op("Sheet.cell", ReachClass::Grid),
    op("Sheet.index", ReachClass::Workbook),
    op("Sheet.name", ReachClass::Workbook),
    op("Sheet.range", ReachClass::Grid),
    // -- Range (Sheet.range("A1:B2")) ----------------------------------------
    op("Range", ReachClass::Grid),
    op("Range.address", ReachClass::Grid),
    op("Range.colCount", ReachClass::Grid),
    op("Range.endCol", ReachClass::Grid),
    op("Range.endRow", ReachClass::Grid),
    op("Range.getCell", ReachClass::Grid),
    op("Range.getValue", ReachClass::Grid),
    op("Range.getValues", ReachClass::Grid),
    op("Range.isSingleCell", ReachClass::Grid),
    op("Range.offset", ReachClass::Grid),
    op("Range.resize", ReachClass::Grid),
    op("Range.rowCount", ReachClass::Grid),
    op("Range.setValue", ReachClass::Grid),
    op("Range.setValues", ReachClass::Grid),
    op("Range.startCol", ReachClass::Grid),
    op("Range.startRow", ReachClass::Grid),
];

// ===========================================================================
// Surface profiles — HOW each host surface builds the realm
// ===========================================================================

/// How the host constructs the QuickJS realm for one script surface. These are
/// the only knobs that change what the realm can reach, and every one of them is
/// a fact about the CALL SITE, not about the interpreter — which is exactly why
/// the reach claim has to be per-surface rather than one blanket constant.
#[derive(Debug, Clone, Copy)]
pub struct SurfaceProfile {
    /// Matches `ScriptSurfaceId` in app/src/api/scriptSurfaces.ts.
    pub id: &'static str,
    /// True when the host injects a `ModelDataProvider`. Without one, every
    /// `model.*` op is still REGISTERED but throws "not available on this
    /// surface" — so the surface really is grid-only.
    pub model_provider: bool,
    /// The capability ids this surface's realm may ever hold — the CEILING the
    /// host's `CapabilityStore` grant is taken from, not a live grant.
    ///
    /// Injecting a provider is necessary but NOT sufficient: every provider call
    /// re-checks the capability store for the run's surface id
    /// (app/src-tauri/src/bi/script_provider.rs `check_cap`), so an op whose
    /// capability is not in this list throws on this surface even with a
    /// provider attached. `mcp-tool` is the case that makes the distinction
    /// load-bearing: it holds `bi.query` only, so `model.sql` is unreachable
    /// there while `model.query` is not.
    ///
    /// Must be empty when `model_provider` is false (nothing gated is reachable
    /// without a provider) and non-empty when it is true (a provider injected
    /// with no grant behind it would make the derivation understate the surface
    /// instead of describing it).
    pub granted: &'static [&'static str],
    /// True when the host deletes the registered host globals before evaluating
    /// the author's code, leaving a bare ECMAScript realm.
    pub host_globals_deleted: bool,
    /// Where the host constructs it — so a reader can check the claim.
    pub entry_point: &'static str,
}

/// Every surface that runs code in THIS interpreter. A surface that runs code
/// in the worker realm instead (object scripts, UDFs, chart transforms/marks,
/// sandboxed extensions) is governed by the broker and is deliberately absent.
pub const SURFACE_PROFILES: &[SurfaceProfile] = &[
    SurfaceProfile {
        id: "notebook-cell",
        model_provider: true,
        // The notebook's grants come from the user's own per-notebook consent,
        // so this is the consent CEILING: both model capabilities may be held.
        granted: &["bi.query", "bi.sql"],
        host_globals_deleted: false,
        entry_point: "app/src-tauri/src/scripting/notebook_executor.rs -> NotebookSession::new(provider, ...)",
    },
    SurfaceProfile {
        id: "one-off-script",
        model_provider: false,
        granted: &[],
        host_globals_deleted: false,
        entry_point: "app/src-tauri/src/scripting/commands.rs -> ScriptEngine::run_with_options (no provider parameter exists on this entry point)",
    },
    SurfaceProfile {
        id: "mcp-tool",
        // CORRECTED 2026-08-02. This row used to claim there was no model
        // provider here, and named `ScriptEngine::run` as the entry point; every
        // mirror repeated "grid-only". Both were false. `execute_script` — the
        // tool that runs AGENT-AUTHORED code — has injected a
        // `HostModelProvider` since the MCP co-author work. `ScriptEngine::run`
        // is still used on this surface, but only by `run_engine_script` for the
        // app-authored setCellValue/setRange snippets behind write_cell /
        // write_cell_range, never for agent code, so it is not what this profile
        // describes.
        // NB for anyone parsing this file (the TS drift test does): keep the
        // field names out of the prose, or a field-scanning parser reads the
        // commentary as the value.
        model_provider: true,
        // Hard-coded host grant, not a consent ceiling: `MCP_SCRIPT_CAPABILITIES`
        // in app/src-tauri/src/mcp/tools.rs is exactly `["bi.query"]`, granted
        // for the run's surface id and revoked when the run ends. `bi.sql` is
        // deliberately withheld — there is no MCP SQL tool, so granting it would
        // make execute_script the way to obtain reach the tool surface denies —
        // so `model.sql` raises the provider's consent error here.
        granted: &["bi.query"],
        host_globals_deleted: false,
        entry_point: "app/src-tauri/src/mcp/tools.rs -> run_script_with_model -> NotebookSession::new(Some(HostModelProvider), ...) (execute_script / execute_script_structured)",
    },
    SurfaceProfile {
        id: "writeback-validator",
        model_provider: false,
        granted: &[],
        host_globals_deleted: true,
        entry_point: "app/src-tauri/src/calp_commands.rs -> run_validator_batch (harness deletes the host globals)",
    },
];

/// Look a profile up by surface id.
pub fn surface_profile(id: &str) -> Option<&'static SurfaceProfile> {
    SURFACE_PROFILES.iter().find(|p| p.id == id)
}

/// The ops actually reachable on `profile` — derived from the manifest and the
/// call site's construction, never asserted.
///
/// A capability-gated op needs BOTH conditions the call site controls: the
/// provider has to be injected, and the op's capability has to be one the host
/// can hold for this surface. Checking only the first would have advertised
/// `model.sql` on `mcp-tool`, which holds `bi.query` alone.
pub fn surface_ops(profile: &SurfaceProfile) -> Vec<&'static OpEntry> {
    if profile.host_globals_deleted {
        return Vec::new();
    }
    OP_MANIFEST
        .iter()
        .filter(|e| match e.capability {
            None => true,
            Some(cap) => profile.model_provider && profile.granted.contains(&cap),
        })
        .collect()
}

/// The reach classes `profile` can touch, sorted and de-duplicated.
pub fn surface_reach(profile: &SurfaceProfile) -> Vec<ReachClass> {
    let mut classes: Vec<ReachClass> = surface_ops(profile).iter().map(|e| e.reach).collect();
    classes.sort();
    classes.dedup();
    classes
}

/// The capability ids the host gate demands for what `profile` can reach.
/// Empty means "nothing beyond the cloned workbook" — the honest form of the
/// "grid-only" claim the transparency panel makes.
pub fn surface_capability_ids(profile: &SurfaceProfile) -> Vec<&'static str> {
    let mut caps: Vec<&'static str> = surface_ops(profile)
        .iter()
        .filter_map(|e| e.capability)
        .collect();
    caps.sort();
    caps.dedup();
    caps
}

// ===========================================================================
// Live enumeration — the ground truth the manifest is checked against
// ===========================================================================

/// Marker the probe prefixes its JSON payload with, so the enumeration can be
/// picked out of the console output unambiguously.
const PROBE_MARKER: &str = "__calcula_surface_probe__";

/// The walk. `BASELINE` is spliced in by `enumerate_registered_surface()` as the
/// set of globals a BARE QuickJS realm already has — subtracting it is what
/// makes a brand-new root global (a future `net`, `fs`, ...) show up as an
/// addition instead of hiding among the ECMAScript built-ins.
const PROBE_TEMPLATE: &str = r#"
(function () {
  var BASELINE = __BASELINE__;
  var baseline = {};
  for (var b = 0; b < BASELINE.length; b++) { baseline[BASELINE[b]] = true; }
  var out = [];
  var seen = [];
  function walk(obj, prefix, depth) {
    if (depth > 4) { return; }
    var names = Object.getOwnPropertyNames(obj);
    names.sort();
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      var path = prefix + "." + n;
      out.push(path);
      var d = Object.getOwnPropertyDescriptor(obj, n);
      if (!d || d.get || d.set) { continue; }
      var v = d.value;
      if (v === null || typeof v !== "object") { continue; }
      if (seen.indexOf(v) >= 0) { continue; }
      seen.push(v);
      walk(v, path, depth + 1);
    }
  }
  var roots = Object.getOwnPropertyNames(globalThis);
  roots.sort();
  for (var r = 0; r < roots.length; r++) {
    var name = roots[r];
    if (baseline[name]) { continue; }
    out.push(name);
    var value = globalThis[name];
    if (value !== null && typeof value === "object") {
      seen.push(value);
      walk(value, name, 1);
    }
  }
  // The canonical object model hands out Sheet / Range objects from FUNCTION
  // calls, so a static walk of the globals cannot see their members. Build one
  // of each and walk it under a synthetic root, so a new Range op is caught too.
  try {
    var sheet = Calcula.workbook.activeSheet();
    out.push("Sheet");
    walk(sheet, "Sheet", 1);
    var range = sheet.range("A1:B2");
    out.push("Range");
    walk(range, "Range", 1);
  } catch (e) {
    out.push("SYNTHETIC_WALK_FAILED:" + String((e && e.message) || e));
  }
  out.sort();
  var deduped = [];
  for (var k = 0; k < out.length; k++) {
    if (k === 0 || out[k] !== out[k - 1]) { deduped.push(out[k]); }
  }
  console.log("__MARKER__" + JSON.stringify(deduped));
})();
"#;

/// Own property names of a BARE QuickJS realm (the ECMAScript built-ins).
fn baseline_globals() -> Result<Vec<String>, String> {
    let rt = rquickjs::Runtime::new().map_err(|e| format!("bare runtime: {e}"))?;
    let ctx = rquickjs::Context::full(&rt).map_err(|e| format!("bare context: {e}"))?;
    let json: String = ctx
        .with(|ctx| {
            ctx.eval::<String, _>(
                r#"JSON.stringify(Object.getOwnPropertyNames(globalThis).sort())"#,
            )
        })
        .map_err(|e| format!("bare enumeration: {e}"))?;
    serde_json::from_str::<Vec<String>>(&json).map_err(|e| format!("bare enumeration json: {e}"))
}

/// Boot the real interpreter through the SAME entry point a one-off run uses
/// and return every path it registers, sorted.
///
/// This is the ground truth `OP_MANIFEST` is diffed against. It is a library
/// function rather than test-only code on purpose: the manifest is a security
/// claim, and a claim that can only be checked by a test that might be deleted
/// is a weaker claim than one anything can re-derive.
///
/// KNOWN LIMITS OF THE WALK, so nobody mistakes it for more than it is:
///  - OWN properties only, to a depth of 4. An op hung on a PROTOTYPE, or nested
///    five namespaces deep, would not be seen. Neither pattern exists today (the
///    ops layer sets plain properties on plain objects) — if one is introduced,
///    extend the probe in the same commit.
///  - Objects reachable only by CALLING something are invisible to a static
///    walk, which is why the probe explicitly builds a `Sheet` and a `Range`.
///    A future factory op returning a new kind of object needs the same
///    treatment, or its members will not be enumerated.
pub fn enumerate_registered_surface() -> Result<Vec<String>, String> {
    let baseline = baseline_globals()?;
    let baseline_json = serde_json::to_string(&baseline).map_err(|e| e.to_string())?;
    let probe = PROBE_TEMPLATE
        .replace("__BASELINE__", &baseline_json)
        .replace("__MARKER__", PROBE_MARKER);

    let context = crate::types::ScriptContext::new(
        vec![engine::grid::Grid::new()],
        engine::style::StyleRegistry::new(),
        vec!["Sheet1".to_string()],
        0,
        crate::types::AppInfo::default(),
        crate::types::HostState::default(),
    );
    let outcome = crate::runtime::execute_script(
        &probe,
        "surface-probe.js",
        context,
        crate::limits::ScriptLimits::default(),
    )?;
    if let Some(err) = outcome.error {
        return Err(format!("surface probe failed: {err}"));
    }
    let output = outcome.context.console_output.borrow();
    let payload = output
        .iter()
        .rev()
        .find_map(|item| {
            let text = item.to_text();
            text.strip_prefix(PROBE_MARKER).map(|s| s.to_string())
        })
        .ok_or_else(|| "surface probe produced no enumeration".to_string())?;
    let mut paths: Vec<String> =
        serde_json::from_str(&payload).map_err(|e| format!("surface probe json: {e}"))?;
    paths.sort();
    paths.dedup();
    Ok(paths)
}

// ===========================================================================
// Tests — the guards
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::rc::Rc;

    use crate::model_provider::{
        ModelDataProvider, ModelProviderError, ModelQuerySpec, ModelTable,
    };

    /// A provider that answers everything, so "the op works when a provider is
    /// injected" is testable without the app.
    struct StubProvider;

    fn ok_table() -> ModelTable {
        ModelTable {
            columns: vec!["c".to_string()],
            rows: vec![vec![Some("1".to_string())]],
            total_rows: 1,
            truncated: false,
        }
    }

    impl ModelDataProvider for StubProvider {
        fn connections(&self, _s: &str) -> Result<String, ModelProviderError> {
            Ok("[{\"name\":\"c1\"}]".to_string())
        }
        fn model_info(&self, _s: &str, _c: &str) -> Result<String, ModelProviderError> {
            Ok("{\"tables\":[]}".to_string())
        }
        fn query(
            &self,
            _s: &str,
            _c: &str,
            _spec: &ModelQuerySpec,
        ) -> Result<ModelTable, ModelProviderError> {
            Ok(ok_table())
        }
        fn sql(&self, _s: &str, _c: &str, _q: &str) -> Result<ModelTable, ModelProviderError> {
            Ok(ok_table())
        }
        fn cube_value(
            &self,
            _s: &str,
            _c: &str,
            _m: &[String],
        ) -> Result<Option<f64>, ModelProviderError> {
            Ok(Some(1.0))
        }
        fn cube_members(
            &self,
            _s: &str,
            _c: &str,
            _l: &str,
        ) -> Result<Vec<String>, ModelProviderError> {
            Ok(vec!["m".to_string()])
        }
        fn cube_kpi(
            &self,
            _s: &str,
            _c: &str,
            _k: &str,
            _p: i64,
        ) -> Result<Option<f64>, ModelProviderError> {
            Ok(Some(2.0))
        }
    }

    fn run_with_provider(
        src: &str,
        provider: Option<Rc<dyn ModelDataProvider>>,
    ) -> (Vec<String>, Option<String>) {
        let mut context = crate::types::ScriptContext::new(
            vec![engine::grid::Grid::new()],
            engine::style::StyleRegistry::new(),
            vec!["Sheet1".to_string()],
            0,
            crate::types::AppInfo::default(),
            crate::types::HostState::default(),
        )
        .with_model_provider(provider);
        context.surface_id = "test:surface".to_string();
        let outcome = crate::runtime::execute_script(
            src,
            "manifest-test.js",
            context,
            crate::limits::ScriptLimits::default(),
        )
        .expect("runtime");
        let lines = outcome
            .context
            .console_output
            .borrow()
            .iter()
            .map(|i| i.to_text())
            .collect();
        (lines, outcome.error)
    }

    // -- (1) the manifest IS the interpreter --------------------------------

    #[test]
    fn op_manifest_matches_the_live_interpreter_surface() {
        let live = enumerate_registered_surface().expect("enumeration");
        assert!(
            !live.iter().any(|p| p.starts_with("SYNTHETIC_WALK_FAILED")),
            "the Sheet/Range walk could not run, so the canonical object model was NOT \
             enumerated: {live:?}"
        );

        let mut declared: Vec<String> = OP_MANIFEST.iter().map(|e| e.path.to_string()).collect();
        declared.sort();
        declared.dedup();

        let missing: Vec<&String> = live.iter().filter(|p| !declared.contains(p)).collect();
        let stale: Vec<&String> = declared.iter().filter(|p| !live.contains(p)).collect();

        assert!(
            missing.is_empty(),
            "The Rust QuickJS interpreter registers op(s) that OP_MANIFEST does not admit: {missing:?}\n\
             \n\
             FIX: add each path to OP_MANIFEST in core/script-engine/src/manifest.rs with the \
             ReachClass it actually reaches (and a capability id if the host gates it). This is \
             not bookkeeping: app/src/api/codeInventory.ts derives the \"what can this code \
             touch?\" claim the transparency panel shows from this manifest, so an unclassified \
             op means the panel is telling the user something false. If the new op reaches \
             outside the cloned workbook, it also needs a SurfaceProfile knob so the surfaces \
             that must NOT have it can be shown as not having it."
        );
        assert!(
            stale.is_empty(),
            "OP_MANIFEST declares op(s) the interpreter no longer registers: {stale:?}\n\
             \n\
             FIX: delete those rows from OP_MANIFEST in core/script-engine/src/manifest.rs. A \
             stale row OVERSTATES reach, which is safe for the user but makes the transparency \
             panel and the scriptSurfaces taxonomy wrong in the other direction."
        );
    }

    #[test]
    fn every_manifest_capability_is_a_known_capability_id() {
        // The one capability vocabulary lives in TypeScript; persistence pins
        // KNOWN_CAPABILITY_IDS against it. Here we only need the two ids this
        // interpreter can demand, so pin them exactly rather than by prefix.
        for entry in OP_MANIFEST {
            if let Some(cap) = entry.capability {
                assert!(
                    cap == "bi.query" || cap == "bi.sql",
                    "OP_MANIFEST row {} declares capability \"{cap}\", which the Rust QuickJS \
                     interpreter has no gate for. Only the ModelDataProvider ops are gated here \
                     (bi.query / bi.sql). If a genuinely new privileged reach was added to this \
                     interpreter, it needs a host-side gate + audit FIRST — see \
                     app/src-tauri/src/bi/script_provider.rs for the pattern — and \
                     app/src/api/scriptSurfaces.ts must grow the capability on every \
                     rust-quickjs row.",
                    entry.path
                );
            }
        }
        // A gated op must be Model-class and vice versa: the two fields cannot
        // drift apart without one of them lying.
        for entry in OP_MANIFEST {
            assert_eq!(
                entry.capability.is_some(),
                entry.reach.needs_model_provider(),
                "OP_MANIFEST row {} pairs reach {:?} with capability {:?}. Every capability-gated \
                 op must be ReachClass::Model and every ReachClass::Model op must name its \
                 capability — otherwise surface_capability_ids() understates the surface.",
                entry.path,
                entry.reach,
                entry.capability
            );
        }
    }

    // -- (2) reach is DERIVED from the injection, not asserted ---------------

    #[test]
    fn without_a_model_provider_every_model_op_throws() {
        // This is the behavioural proof behind the "one-off / MCP scripts are
        // grid-only" claim: the ops are registered on every surface, so the
        // claim rests entirely on the provider being None.
        let calls = [
            "model.connections()",
            "model.info('c')",
            "model.query('c', {})",
            "model.sql('c', 'select 1')",
            "model.value('c', 'x')",
            "model.members('c', 'T[C]')",
            "model.kpi('c', 'k', 1)",
        ];
        for call in calls {
            let src = format!(
                "try {{ {call}; console.log('REACHED'); }} catch (e) {{ console.log('THREW:' + e.message); }}"
            );
            let (lines, err) = run_with_provider(&src, None);
            assert!(err.is_none(), "{call} aborted the run: {err:?}");
            let last = lines.last().cloned().unwrap_or_default();
            assert!(
                last.starts_with("THREW:"),
                "{call} did NOT throw on a surface with no ModelDataProvider (got {last:?}). \
                 One-off scripts and writeback validators are advertised as grid-only in \
                 app/src/api/scriptSurfaces.ts and the transparency panel PURELY because no \
                 provider is injected for them. If this op now works without one, that claim \
                 is false and both must be corrected. (The MCP tool surface is NOT in that \
                 list: it does inject a provider — see SURFACE_PROFILES.)"
            );
        }
    }

    #[test]
    fn with_a_model_provider_the_model_ops_work() {
        // The other direction: the notebook surface's reach claim (bi.query /
        // bi.sql) must not be over-stated either — the ops really do resolve.
        let provider: Rc<dyn ModelDataProvider> = Rc::new(StubProvider);
        let (lines, err) = run_with_provider(
            "console.log('OK:' + model.query('c', {}).columns[0] + model.sql('c', 's').columns[0]);",
            Some(provider),
        );
        assert!(err.is_none(), "notebook-shaped run failed: {err:?}");
        assert_eq!(lines.last().map(String::as_str), Some("OK:cc"));
    }

    #[test]
    fn surface_reach_is_derived_per_surface() {
        let notebook = surface_profile("notebook-cell").expect("notebook profile");
        let one_off = surface_profile("one-off-script").expect("one-off profile");
        let mcp = surface_profile("mcp-tool").expect("mcp profile");
        let validator = surface_profile("writeback-validator").expect("validator profile");

        assert_eq!(surface_capability_ids(notebook), vec!["bi.query", "bi.sql"]);
        assert!(surface_reach(notebook).contains(&ReachClass::Model));

        for grid_only in [one_off, validator] {
            assert!(
                surface_capability_ids(grid_only).is_empty(),
                "{} must reach no capability-gated op",
                grid_only.id
            );
            assert!(
                !surface_reach(grid_only).contains(&ReachClass::Model),
                "{} must not reach the BI model",
                grid_only.id
            );
        }
        assert!(surface_reach(one_off).contains(&ReachClass::Grid));

        // The MCP surface is NOT grid-only, and saying so was the defect.
        assert!(
            surface_reach(mcp).contains(&ReachClass::Model),
            "the mcp-tool surface injects a HostModelProvider, so its reach includes the BI model"
        );

        assert!(
            surface_reach(validator).is_empty(),
            "the writeback validator harness deletes every host global, so its reach is empty"
        );
    }

    /// REGRESSION GUARD for the defect this profile carried for a whole program:
    /// `mcp-tool` was recorded as `model_provider: false` / "grid-only — no model
    /// provider" while `app/src-tauri/src/mcp/tools.rs` had been injecting a
    /// `HostModelProvider` into `execute_script` all along. The transparency
    /// panel derives its "what can this code touch?" claim from here, so the
    /// understatement was a false disclosure about the one surface that runs
    /// AI-authored code.
    ///
    /// The security property asserted is the pair, not just the reach: the MCP
    /// surface reaches the model through `bi.query` and does NOT reach `bi.sql`.
    #[test]
    fn mcp_tool_reaches_the_model_through_bi_query_only() {
        let mcp = surface_profile("mcp-tool").expect("mcp profile");

        assert!(
            mcp.model_provider,
            "SURFACE_PROFILES says the MCP tool surface has no ModelDataProvider. \
             app/src-tauri/src/mcp/tools.rs `run_script_with_model` builds \
             NotebookSession::new(Some(HostModelProvider::new(app, rt)), ..) for \
             execute_script / execute_script_structured. Either the injection was removed \
             (then also re-derive codeInventory.ts and scriptSurfaces.ts) or this flag is \
             lying to the transparency panel again."
        );
        assert_eq!(
            mcp.granted,
            &["bi.query"],
            "the MCP script grant must mirror MCP_SCRIPT_CAPABILITIES in \
             app/src-tauri/src/mcp/tools.rs exactly"
        );

        // Derived, not asserted: bi.query in, bi.sql out.
        assert_eq!(surface_capability_ids(mcp), vec!["bi.query"]);
        assert!(surface_reach(mcp).contains(&ReachClass::Model));
        assert!(surface_reach(mcp).contains(&ReachClass::Grid));

        let paths: Vec<&str> = surface_ops(mcp).iter().map(|e| e.path).collect();
        assert!(
            paths.contains(&"model.query"),
            "model.query is gated on bi.query, which this surface holds"
        );
        for withheld in ["model.sql", "__calcula_model_sql"] {
            assert!(
                !paths.contains(&withheld),
                "{withheld} is gated on bi.sql, which the MCP surface deliberately does NOT \
                 hold — there is no MCP SQL tool, so granting it would make execute_script the \
                 way to obtain reach the tool surface denies. Advertising it here would \
                 OVERSTATE the surface in the transparency panel."
            );
        }
    }

    /// The `granted` ceiling cannot drift into meaninglessness: an unknown id
    /// would silently drop an op out of every derivation, and a provider with no
    /// grant behind it would understate the surface instead of describing it.
    #[test]
    fn every_surface_grant_is_consistent_with_the_manifest() {
        let manifest_caps: Vec<&str> = OP_MANIFEST.iter().filter_map(|e| e.capability).collect();
        for profile in SURFACE_PROFILES {
            for cap in profile.granted {
                assert!(
                    manifest_caps.contains(cap),
                    "surface {} declares grant \"{cap}\", which no OP_MANIFEST row demands. \
                     A grant no op reads changes nothing and hides the typo it probably is.",
                    profile.id
                );
            }
            if profile.model_provider {
                assert!(
                    !profile.granted.is_empty(),
                    "surface {} injects a ModelDataProvider but declares no grant, so \
                     surface_ops() derives no model reach for it — an injected provider with \
                     an empty ceiling understates the surface rather than describing it.",
                    profile.id
                );
            } else {
                assert!(
                    profile.granted.is_empty(),
                    "surface {} declares grant(s) {:?} with no ModelDataProvider injected. \
                     Nothing gated is reachable without a provider, so the grant would \
                     OVERSTATE the surface.",
                    profile.id,
                    profile.granted
                );
            }
        }
    }

    #[test]
    fn reach_class_wire_names_are_unique_and_stable() {
        let mut names: Vec<&str> = ALL_REACH_CLASSES.iter().map(|c| c.as_str()).collect();
        let count = names.len();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), count, "duplicate ReachClass wire name");
        assert_eq!(count, 7, "a ReachClass was added or removed: mirror it in the InterpreterReachClass union in app/src/api/codeInventory.ts and re-run its drift test");
    }
}
