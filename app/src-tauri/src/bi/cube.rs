//! FILENAME: app/src-tauri/src/bi/cube.rs
//! PURPOSE: Async resolution of the Excel-style CUBE formula family against
//!          Calcula BI models (CUBEVALUE, CUBEMEMBER, CUBESET, CUBESETCOUNT,
//!          CUBERANKEDMEMBER, CUBEMEMBERPROPERTY, CUBEKPIMEMBER).
//!
//! CONTEXT: The formula evaluator (core/engine) is synchronous, but BI model
//! queries are async (`Connection.engine: Arc<TokioMutex<bi_engine::Engine>>`).
//! Following the GETPIVOTDATA / UDF pre-fetch pattern, this module runs an async
//! pass that resolves every cube call in the cells about to recalc and returns a
//! serializable `engine::CubePrefetch`. The frontend forwards that into the write
//! command as the `cube_results` parameter -- `update_cell` (one edit),
//! `update_cells_batch` and `update_cell_on_sheets` (a batch of writes, the
//! `edits` shape, BUG-0476), `calculate_now` (the full refresh) -- and the
//! synchronous evaluator then serves results without any I/O (see
//! core/engine/src/cube.rs and evaluator.rs).
//!
//! ## Member-expression syntax (Calcula-native)
//! - `[Measure Name]`          -> a model measure
//! - `Table[Column]=Value`     -> a dimension member (value may be 'single-quoted')
//! - `Table[Column]`           -> a level (all members of a column)
//! - `m1, m2`                  -> a tuple (AND of members) within one argument
//! - `{m1, m2, ...}`           -> an explicit set (CUBESET)
//!
//! The connection (first argument of most cube functions) is a Calcula
//! `Connection.name`, resolved by name against `BiState`.
//!
//! ## Known limitations (v1)
//! The async pre-pass and the sync evaluator must compute the SAME lookup key.
//! They agree for the common case — cube arguments that are string literals or
//! direct cell references (to a cube-member cell or a plain text cell). They can
//! DIVERGE (yielding #N/A) for these less common shapes, deferred to a follow-up:
//! - A cube argument that is a NAMED RANGE, a structured TABLE reference, or a
//!   SPILL ref: the pre-pass walks the raw parsed AST while `update_cell` walks a
//!   name/table/spill-RESOLVED AST. Use a literal or a direct cell reference.
//! - A cube argument that is a cell reference to ANOTHER FORMULA cell recomputed
//!   in the same edit (the pre-pass reads the pre-edit snapshot text). Reference
//!   CUBEMEMBER cells or stable inputs instead.
//! - A sheet-QUALIFIED cube argument (`Inputs!B2`) reads the sheet it names (both
//!   sides apply `engine::cube::qualified_cell_arg`), but a CUBEMEMBER/CUBESET
//!   cell on ANOTHER sheet is refused with #VALUE!: its object is resolved only
//!   for cells on the sheet a pre-fetch is built for.
//! Also: CUBEVALUE member filters are column-name-only (the engine FilterCondition
//! carries no table), so member columns should be uniquely named across tables;
//! and CUBESET measure ordering (sort_order 1/2) applies to level sets, not
//! explicit `{...}` lists (which support alphabetical sort 3/4).
//!
//! ## A recalculation WITHOUT cube data (docs/design/cube-formulas-and-custom-functions.md 2.4)
//! The cross-sheet walk, a fill, a background-sheet write, a Rust-side writer
//! and Calculate Now before the session has seen a CUBE formula carry no cube
//! data. A
//! cube call there -- the whole formula or any part of one -- is answered from
//! the sheet's results cache, `engine::cube::CallMemo`: the answer recorded for
//! exactly the arguments it has now, else `#N/A`. The cache is filled by every
//! served call and, for a workbook just opened, by
//! [`remember_loaded_call_results`] (for the sheets an application install
//! brings, by [`remember_installed_call_results`]). A FULL recalculation
//! without data (Calculate Now before the latch, the save's own) does not
//! refuse a call the cache cannot answer when nothing the cell reads has
//! changed: it keeps the cell's stored result (`calculation::run_calculation_pass`,
//! `KeepWithoutData`). Those routes never REFRESH a cube cell: only a
//! pre-fetch does, and Calculate Now's covers every sheet
//! ([`build_full_refresh_prefetch`]).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

use engine::{
    col_to_index, cube_call_key, cube_function_name, resolve_cube_arg, BuiltinFunction, CellValue,
    CubeBinding, CubeBindingKind, CubeCallResult, CubeError, CubePrefetch, CubeResolver, Expression,
};

use super::types::{BiState, ConnectionId};
use crate::AppState;

// ===========================================================================
// Tauri command
// ===========================================================================

/// Pre-fetch cube data for pending cell writes. Called by the frontend BEFORE
/// the write, mirroring the UDF pre-fetch hook: the returned `CubePrefetch` is
/// forwarded into the write command as `cube_results` and served by the
/// synchronous evaluator.
///
/// Two shapes, one command:
/// - `row` + `col` + `value`: the grid editor's single edit, before
///   `update_cell`.
/// - `edits` (+ `sheet_index`): every write of ONE batch -- before
///   `update_cells_batch` (a paste, a fill, a script's or an extension's
///   `CellRange.setValue(s)`), or, with `sheet_index` naming a sheet that is
///   not active, before `update_cell_on_sheets` writes that sheet (BUG-0476).
///   The writes are seen in place of the cells they replace, so a CUBE
///   formula that reads a cell the same batch writes is keyed exactly as the
///   batch will evaluate it.
///
/// `udf_volatile_cells`: the volatile custom-function cells the frontend's UDF
/// pass found for the same write -- the list the write command receives, and
/// so cells its cascade evaluates.
///
/// The frontend calls it once the session has seen a CUBE formula (or for a
/// write that carries one), so an ordinary write in a workbook with no cube
/// costs no extra IPC.
#[tauri::command]
pub async fn cube_prefetch(
    state: tauri::State<'_, AppState>,
    bi_state: tauri::State<'_, BiState>,
    row: Option<u32>,
    col: Option<u32>,
    value: Option<String>,
    edits: Option<Vec<crate::api_types::CellUpdateInput>>,
    sheet_index: Option<usize>,
    udf_volatile_cells: Option<Vec<crate::scripting::udf::UdfCellRef>>,
) -> Result<CubePrefetch, String> {
    let (edits, door) = match (edits, row, col, value) {
        (Some(edits), None, None, None) => (edits, CubeWriteDoor::Batch),
        (None, Some(row), Some(col), Some(value)) => (
            vec![crate::api_types::CellUpdateInput {
                row,
                col,
                value,
                style_index: None,
                invariant: None,
                pasted: None,
                moved: None,
            }],
            CubeWriteDoor::Edit,
        ),
        _ => {
            return Err(
                "cube_prefetch takes either row, col and value (one edit) or edits (a batch), not both"
                    .to_string(),
            )
        }
    };
    Ok(build_cube_prefetch(
        &state,
        &bi_state,
        Some(CubePrefetchEdits {
            edits: &edits,
            sheet_index,
            door,
            udf_volatile_cells: udf_volatile_cells.as_deref(),
        }),
    )
    .await)
}

/// Pre-fetch cube data for EVERY cube cell in the workbook (no specific edit):
/// the active sheet's, and each other sheet's in `other_sheets`
/// ([`build_full_refresh_prefetch`]). Called by the frontend before a full
/// recalc (`calculate_now`) so cube cells refresh against current model data —
/// e.g. after a calculated measure is added/edited, or on F9.
#[tauri::command]
pub async fn cube_prefetch_all(
    state: tauri::State<'_, AppState>,
    bi_state: tauri::State<'_, BiState>,
) -> Result<CubePrefetch, String> {
    Ok(build_full_refresh_prefetch(&state, &bi_state).await)
}

/// THE OPEN PATH'S HALF OF THE RESULTS CACHE (rev3A#3, BUG-0476): record every
/// cube and custom-function cell's SAVED value as its call's answer for the
/// arguments saved with it, in each sheet's `engine::cube::CallMemo`.
///
/// WHY. A recalculation that carries no cube data or UDF resolver answers such
/// a call from the cache, for exactly the arguments it has NOW
/// (`Evaluator::preserved_cube_value` / `preserved_udf_value`). A workbook just
/// opened has served nothing yet, so without this the first edit whose cascade
/// reaches such a cell -- with no resolver, or no pre-fetch covering it --
/// would turn it into `#NAME?` / `#N/A` although its arguments are unchanged.
/// (A FULL recalculation keeps an unchanged cell's stored result even without
/// a recorded answer: `calculation::run_calculation_pass`.)
///
/// WHAT IS SEEDED. Only a call that IS its cell's formula (`=MYFN(A1)`,
/// `=CUBEVALUE(..)`): its saved value is that call's answer. A call inside a
/// larger formula (`=MYFN(A1)*2`) has no saved value of its own -- the cell's
/// is the product -- so it is not seeded and refuses until a recalculation
/// with data serves it, unless a root call elsewhere on the sheet makes the
/// same call (same fingerprint) and seeded its answer. Cells are seeded in
/// row-major order, so two root cells that saved different values for the
/// same call (one left stale under manual calculation) seed the later one,
/// deterministically.
///
/// WHY IT IS TRUE HERE AND NOWHERE ELSE. The values were calculated for the
/// arguments saved beside them: every recalculation that could not compute a
/// call with changed arguments writes `#N/A` / `#NAME?` rather than a stale
/// number, so a saved number belongs to its saved arguments. Run any later
/// and an argument may have changed since the value was computed -- which is
/// the very case the cache's fingerprint exists to catch. So `open_file` calls
/// this once, after the grids, names and tables are installed and before
/// anything can edit them (an application install calls
/// [`remember_installed_call_results`] at the same point of its own path). A
/// dynamic-array origin is seeded with the WHOLE array its footprint holds
/// (rev5B#2). Skipped: cells a cancelled recalculation left
/// un-recalculated (`pending_recalc`, saved with the file), whose values are
/// stale by definition; and custom-function cells whose arguments contain a
/// cube or custom-function call of their own, which the engine refuses to
/// seed.
///
/// Derived state only (the cache is never saved), so no `DocumentEffect`.
pub(crate) fn remember_loaded_call_results(state: &AppState) {
    remember_saved_call_results(state, None);
}

/// Sheets an application install has just put in place -- a subscribe, a
/// checkout, an update (refresh), a dev pull -- for
/// [`remember_installed_call_results`].
pub(crate) struct InstalledSheets<'a> {
    /// The sheets' FINAL indices (after any partition repair).
    pub sheets: &'a [usize],
    /// The application's own defined names, uppercased name -> `refers_to`.
    /// A formula naming a defined name the workbook resolves to anything else
    /// (the subscriber kept their own on a collision, or the application never
    /// defined it) does not read what it read when its value was computed.
    pub names: &'a HashMap<String, String>,
}

/// [`remember_loaded_call_results`] for the sheets an APPLICATION install has
/// just put in place (rev5B#1): a subscribe and a checkout
/// (`calp_commands::materialize_pull_result`), an update
/// (`calp_commands::apply_refresh_payloads`, BEFORE the subscriber's overrides
/// and writeback values are painted back on), a dev subscribe or dev refresh.
/// Those sheets arrive with the values the publisher's workbook computed, and
/// nothing had seeded their results cache, so the first recalculation without
/// data -- the save's own Calculate Now -- refused every cube and
/// custom-function cell on them and wrote `#N/A` / `#NAME?` into the file.
///
/// THE SAME SOUNDNESS ARGUMENT AS AN OPEN, WITH ONE MORE CONDITION. A pulled
/// value was computed for the arguments the publisher's workbook had; it is
/// the answer for the arguments the cell has HERE only when the formula reads
/// nothing but the installed sheets and the application's own names. A cell
/// whose formula reads a sheet outside the install (the subscriber's own
/// sheet, a sheet the application did not carry), a defined name the workbook
/// resolves differently, a structured reference to a table that does not live
/// on an installed sheet, or a 3D range, is FOREIGN: it is not seeded, and its
/// sheet is marked as holding values that may be stale
/// (`CallMemo::note_values_may_be_stale`), so a full recalculation refuses a
/// call on it that it cannot answer instead of keeping the publisher's number
/// (`calculation::run_calculation_pass`) -- until a completed Calculate Now
/// vouches for the values again.
pub(crate) fn remember_installed_call_results(state: &AppState, installed: InstalledSheets<'_>) {
    remember_saved_call_results(state, Some(installed));
}

/// The reserved script id (and, with a suffix, the per-application ids) that
/// carry a Custom Functions library: JSON `{ "functions": [{ "name": .. }] }`.
const CUSTOM_FUNCTION_LIBRARY_ID_PREFIX: &str = "__calcula_custom_functions__";

/// The uppercased names every Custom Functions library in the workbook's
/// script store defines (BUG-0615#1).
pub(crate) fn library_custom_function_names(
    scripts: &HashMap<String, crate::scripting::types::WorkbookScript>,
) -> Vec<String> {
    let mut names: Vec<String> = scripts
        .iter()
        .filter(|(id, _)| id.starts_with(CUSTOM_FUNCTION_LIBRARY_ID_PREFIX))
        .filter_map(|(_, script)| serde_json::from_str::<serde_json::Value>(&script.source).ok())
        .flat_map(|lib| {
            lib.get("functions")
                .and_then(|f| f.as_array())
                .map(|fns| {
                    fns.iter()
                        .filter_map(|f| f.get("name").and_then(|n| n.as_str()))
                        .map(|n| n.trim().to_uppercase())
                        .filter(|n| !n.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
        .collect();
    names.sort();
    names.dedup();
    names
}

/// What every custom function the workbook's Custom Functions libraries define
/// IS: uppercased name -> its definition (the library record it lives in, the
/// library's capabilities, and the function's own JSON -- params, body,
/// volatility). Two snapshots that differ for a name mean that function's
/// CODE may have changed ([`forget_redefined_custom_functions`]).
pub(crate) fn custom_function_definitions_in(
    scripts: &HashMap<String, crate::scripting::types::WorkbookScript>,
) -> std::collections::BTreeMap<String, String> {
    let mut definitions: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
    for (id, script) in scripts.iter().filter(|(id, _)| id.starts_with(CUSTOM_FUNCTION_LIBRARY_ID_PREFIX)) {
        let Ok(lib) = serde_json::from_str::<serde_json::Value>(&script.source) else { continue };
        let capabilities = lib.get("capabilities").map(|c| c.to_string()).unwrap_or_default();
        let Some(functions) = lib.get("functions").and_then(|f| f.as_array()) else { continue };
        for function in functions {
            let Some(name) = function.get("name").and_then(|n| n.as_str()) else { continue };
            let name = name.trim().to_uppercase();
            if name.is_empty() {
                continue;
            }
            definitions.entry(name).or_default().push(format!("{}\u{1f}{}\u{1f}{}", id, capabilities, function));
        }
    }
    definitions
        .into_iter()
        .map(|(name, mut defs)| {
            defs.sort();
            (name, defs.join("\u{1e}"))
        })
        .collect()
}

/// A Custom Functions library CHANGED (rev8A): the author saved it (or edited
/// it in the JSON view -- both through `scripting::commands`'s one writer,
/// `write_script_record`), or an
/// application's subscribe or update merged its functions in or out
/// (`materialize_distributed_scripts`). `before` and `after` are
/// [`custom_function_definitions_in`] of the store around the change.
///
/// - A function whose definition differs -- edited, newly defined, or gone --
///   forgets every answer it gave on every sheet
///   (`CallMemo::forget_custom_function_answers`): those answers belong to the
///   old code, and nothing would ever replace the one for an argument no cell
///   holds when the new code is installed, so the cross-sheet walk, F9 or the
///   save would serve the old code's number for it as current.
/// - A function the libraries no longer define is forgotten altogether
///   (`CallMemo::forget_custom_function`): a call of it is Excel's ordinary
///   `#NAME?` again, which an IFERROR handles (`=IFERROR(GONEFN(A1),0)` is 0),
///   not the sticky refusal of a function the workbook defines.
///
/// Forgetting only turns an answer into a refusal until the call is served
/// again. Run AFTER the store is written and its lock released: canonical
/// order, `grid` then `grids` (reads; each memo records through its own lock).
pub(crate) fn forget_redefined_custom_functions(
    state: &AppState,
    before: &std::collections::BTreeMap<String, String>,
    after: &std::collections::BTreeMap<String, String>,
) {
    let changed: Vec<(&String, bool)> = before
        .keys()
        .chain(after.keys())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|name| before.get(*name) != after.get(*name))
        .map(|name| (name, after.contains_key(name)))
        .collect();
    if changed.is_empty() {
        return;
    }
    let (Ok(grid), Ok(grids)) = (state.grid.read(), state.grids.read()) else { return };
    for memo in std::iter::once(grid.call_memo()).chain(grids.iter().map(|sheet| sheet.call_memo())) {
        for &(name, still_defined) in &changed {
            if still_defined {
                memo.forget_custom_function_answers(name);
            } else {
                memo.forget_custom_function(name);
            }
        }
    }
    crate::log_info!(
        "CALC",
        "custom-function library changed: forgot the answers of {} function(s) whose definition changed",
        changed.len()
    );
}

/// Tells every sheet's results cache which names are the workbook's custom
/// functions (`CallMemo::note_custom_function`) -- the ones its Custom
/// Functions libraries define -- before a full recalculation (BUG-0615#1).
///
/// A full pass runs no custom function, so a call of one is answered from the
/// cache or refused, and the engine answers a refusal of a KNOWN function
/// whole (`=IFERROR(MYFN(A1),0)` is never a plausible 0) while an UNKNOWN name
/// stays Excel's `#NAME?`, which IFERROR handles (`=IFERROR(TYPO(RAND()),0)`
/// is 0 in Excel). Until now a function was known only once a resolver had
/// served it or a saved ROOT call of it was seeded -- so right after an open a
/// function used only inside composite formulas was not, and the pass had to
/// refuse every cell whole to stay safe, typos included. The library is the
/// authority on what the workbook defines.
///
/// The page's REGISTERED functions count the same way (rev10 rev9A): an
/// add-in's function (`formulas.registerFunction`) is defined by the add-in
/// being loaded, not by any library, and F9 and the save serve no custom
/// function at all -- so without this a composite call of one right after an
/// open (`=IFERROR(FXRATE("USD",TODAY()),0)`) was an unknown name and the
/// save wrote IFERROR's plausible 0. Run before every full pass and at every
/// open (`persistence::open_file`): seeding a saved value vouches for no name.
///
/// Lock order: the script store and the registry are read and released before
/// `grid` / `grids` (reads; `CallMemo` records through its own lock).
pub(crate) fn note_library_custom_functions(state: &AppState, script_state: &crate::scripting::types::ScriptState) {
    let names = workbook_custom_function_names(script_state);
    note_custom_function_names(state, &names);
}

/// Every name that is one of the workbook's custom functions NOW: its
/// libraries' ([`library_custom_function_names`]) and the page's registered
/// ones (`ScriptState::registered_custom_functions`), uppercased, sorted,
/// deduplicated. Each store is read and released here.
pub(crate) fn workbook_custom_function_names(script_state: &crate::scripting::types::ScriptState) -> Vec<String> {
    let mut names = script_state
        .workbook_scripts
        .read()
        .map(|scripts| library_custom_function_names(&scripts))
        .unwrap_or_default();
    if let Ok(registered) = script_state.registered_custom_functions.lock() {
        names.extend(registered.iter().cloned());
    }
    names.sort();
    names.dedup();
    names
}

/// The library generation (rev10 cache2 residual): bumped by every
/// application install that changed a custom function's definition
/// ([`hold_custom_functions_until_reinstalled`]) and carried by the
/// `custom-functions:refresh` event, so the page can say WHICH library it has
/// installed. Process-wide and monotonic: only its order matters.
static CUSTOM_FUNCTION_LIBRARY_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The newest library generation ([`CUSTOM_FUNCTION_LIBRARY_GENERATION`]).
pub(crate) fn custom_function_library_generation() -> u64 {
    CUSTOM_FUNCTION_LIBRARY_GENERATION.load(std::sync::atomic::Ordering::SeqCst)
}

/// The `custom-functions:refresh` event's payload: the library generation the
/// page installs when it hears it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomFunctionsRefresh {
    pub generation: u64,
}

/// THE CALP WINDOW (rev10 cache2 residual). An application's subscribe or
/// update merged a Custom Functions library in the BACKEND, and
/// [`forget_redefined_custom_functions`] forgot what the changed functions
/// answered. But the page re-installs only when it hears
/// `custom-functions:refresh`, and until then its OLD realm still serves edits:
/// an answer served in that window is the old code's, and filing it would
/// hand the cross-sheet walk, F9 and the save the old code's number as
/// current. So every function whose definition changed is HELD on every
/// sheet's results cache under a fresh library generation
/// (`CallMemo::hold_custom_function`): a served answer still answers its edit
/// but is not filed, until the page reports it has installed that generation
/// ([`note_custom_function_registry_impl`]). Returns the generation (the
/// current one when nothing changed); the caller emits it with the event.
///
/// The authoring Save does not hold: the dialog installs the new realm FIRST
/// and saves after, so no old realm is live when the backend forgets.
pub(crate) fn hold_custom_functions_until_reinstalled(
    state: &AppState,
    before: &std::collections::BTreeMap<String, String>,
    after: &std::collections::BTreeMap<String, String>,
) -> u64 {
    let changed: Vec<&String> = before
        .keys()
        .chain(after.keys())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|name| before.get(*name) != after.get(*name))
        .collect();
    if changed.is_empty() {
        return custom_function_library_generation();
    }
    let generation = CUSTOM_FUNCTION_LIBRARY_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let (Ok(grid), Ok(grids)) = (state.grid.read(), state.grids.read()) else { return generation };
    for memo in std::iter::once(grid.call_memo()).chain(grids.iter().map(|sheet| sheet.call_memo())) {
        for name in &changed {
            memo.hold_custom_function(name, generation);
        }
    }
    generation
}

/// What the page reports about its custom-function registry: every name it
/// registers now that this side cannot read itself (every add-in's; the page
/// leaves the Custom Functions library's names out, since the libraries are
/// read here from the workbook held -- rev11C), and -- after a successful
/// install of the library it read -- the generation it installed. Derived,
/// session-only state: no `DocumentEffect`.
///
/// - The names are kept (`ScriptState::registered_custom_functions`) for every
///   later full pass and open, and noted on every sheet's results cache now,
///   so a refused call of an add-in's function is the sticky refusal on every
///   route -- never IFERROR's plausible 0 (rev10 rev9A).
/// - A name the page STOPPED registering (its add-in was unloaded) that no
///   library defines is no longer known (`CallMemo::unnote_custom_function`):
///   a call of it is Excel's ordinary `#NAME?` again, which IFERROR handles.
///   Its recorded answers stay -- they are what those calls computed.
/// - `installed_generation` releases every hold of that generation or older
///   ([`hold_custom_functions_until_reinstalled`]).
///
/// Lock order: the registry and the script store are taken and released one
/// at a time before `grid` / `grids` (reads).
pub(crate) fn note_custom_function_registry_impl(
    state: &AppState,
    script_state: &crate::scripting::types::ScriptState,
    names: Vec<String>,
    installed_generation: Option<u64>,
) {
    let mut names: Vec<String> =
        names.into_iter().map(|n| n.trim().to_uppercase()).filter(|n| !n.is_empty()).collect();
    names.sort();
    names.dedup();
    let previous = match script_state.registered_custom_functions.lock() {
        Ok(mut registered) => std::mem::replace(&mut *registered, names.clone()),
        Err(_) => return,
    };
    let library: HashSet<String> = script_state
        .workbook_scripts
        .read()
        .map(|scripts| library_custom_function_names(&scripts).into_iter().collect())
        .unwrap_or_default();
    let dropped: Vec<&String> =
        previous.iter().filter(|name| names.binary_search(name).is_err() && !library.contains(*name)).collect();
    let (Ok(grid), Ok(grids)) = (state.grid.read(), state.grids.read()) else { return };
    for memo in std::iter::once(grid.call_memo()).chain(grids.iter().map(|sheet| sheet.call_memo())) {
        for name in &dropped {
            memo.unnote_custom_function(name);
        }
        for name in &names {
            memo.note_custom_function(name);
        }
        if let Some(generation) = installed_generation {
            memo.release_custom_functions_up_to(generation);
        }
    }
}

/// The page reports its custom-function registry (see
/// [`note_custom_function_registry_impl`]): on every registry change, and with
/// the installed library generation after every successful install of the
/// library it READ from the backend.
///
/// Answers the CURRENT library generation ([`custom_function_library_generation`]).
/// A generation is bumped only after its library write has landed, so a page
/// that asks before it reads the library knows every generation up to the
/// answer is in what it reads -- and may report that one once its install of
/// it has succeeded. That is what lets ANY successful install (the refresh
/// listener's, the consent reinstall's, an open's, the authoring dialog's Save)
/// release a hold, not only the refresh-driven one: a hold whose refresh
/// install failed, or whose door errored before it emitted the event, used to
/// stay for the rest of the session (rev11C).
#[tauri::command]
pub fn note_custom_function_registry(
    state: tauri::State<'_, AppState>,
    script_state: tauri::State<'_, crate::scripting::types::ScriptState>,
    names: Vec<String>,
    installed_generation: Option<u64>,
) -> u64 {
    note_custom_function_registry_impl(&state, &script_state, names, installed_generation);
    custom_function_library_generation()
}

/// [`note_library_custom_functions`] with the names already in hand.
pub(crate) fn note_custom_function_names(state: &AppState, names: &[String]) {
    if names.is_empty() {
        return;
    }
    let grid = state.grid.read().unwrap();
    let grids = state.grids.read().unwrap();
    for name in names {
        grid.call_memo().note_custom_function(name);
        for sheet in grids.iter() {
            sheet.call_memo().note_custom_function(name);
        }
    }
}

/// The body of both doors. `installed: None` is a workbook just read from
/// disk: every sheet, nothing foreign.
fn remember_saved_call_results(state: &AppState, installed: Option<InstalledSheets<'_>>) {
    // Canonical lock order: `grids` first, then everything else; all reads.
    // The name tables are cloned out (as the UDF discovery pass does) so no
    // guard but `grids` is held while formulas are evaluated -- `NameTables`
    // takes the spill map's lock itself, per cell that needs it.
    // A poisoned store seeds nothing: every cell then refuses until it is
    // served, which is the safe direction.
    let Ok(grids) = state.grids.read() else { return };
    let Ok(sheet_names) = state.sheet_names.read().map(|names| (*names).clone()) else { return };
    let pending = state.pending_recalc.read().ok().and_then(|p| p.clone());
    let Ok(named_ranges) = state.named_ranges.read().map(|n| (*n).clone()) else { return };
    let Ok(tables) = state.tables.read().map(|t| (*t).clone()) else { return };
    let Ok(table_names) = state.table_names.read().map(|t| (*t).clone()) else { return };
    let name_tables = crate::name_resolution::NameTables {
        named_ranges: &named_ranges,
        tables: &tables,
        table_names: &table_names,
        sheet_names: &sheet_names,
        spill_ranges: &state.spill_ranges,
    };
    let sheets: Vec<usize> = match &installed {
        None => (0..grids.len()).collect(),
        Some(installed) => installed.sheets.iter().copied().filter(|&s| s < grids.len()).collect(),
    };
    let install = installed.as_ref().map(|installed| InstallScope {
        sheet_names: installed
            .sheets
            .iter()
            .filter_map(|&s| sheet_names.get(s))
            .map(|name| identity::sheet_name_key(name))
            .collect(),
        sheet_indices: installed.sheets.iter().copied().collect(),
        names: installed.names,
        workbook_names: &named_ranges,
        table_names: &table_names,
    });
    for sheet in sheets {
        let grid = &grids[sheet];
        let Some(sheet_name) = sheet_names.get(sheet) else { continue };
        // A workbook saved with calculation INCOMPLETE (Excel's
        // `calcCompleted="0"`, BUG-0615#2) was marked on open: a saved value
        // may belong to arguments its cell no longer has, so none is filed as
        // an answer -- every call is served or refused until a recalculation
        // with data answers it.
        if installed.is_none() && grid.call_memo().values_may_be_stale() {
            continue;
        }
        // Row-major, so a call two root cells make is seeded the same way on
        // every open (the later cell's value), never by hash order.
        let mut roots: Vec<((u32, u32), &Expression)> = Vec::new();
        // A count, not a set of cells: nothing here writes a cell (and the
        // spill-map census reads `cells.insert(` as a cell write).
        let mut foreign: usize = 0;
        for (&at, cell) in grid.cells.iter() {
            let Some(ast) = cell.get_ast() else { continue };
            if !engine::cube::contains_memo_call(ast) {
                continue;
            }
            if let Some(scope) = &install {
                let resolved = crate::name_resolution::eval_ast(ast, &name_tables.at(sheet, at.0, at.1));
                if scope.is_foreign(ast, &resolved) {
                    foreign += 1;
                    continue;
                }
            }
            if engine::cube::is_memo_call(ast) {
                roots.push((at, ast));
            }
        }
        if foreign > 0 {
            crate::log_info!(
                "CALC",
                "{} installed cube/custom-function cell(s) on '{}' read something the install did not \
                 bring; a recalculation without data will refuse them rather than keep the publisher's values",
                foreign,
                sheet_name
            );
            grid.call_memo().note_values_may_be_stale();
        }
        roots.sort_unstable_by_key(|&(at, _)| at);
        for ((row, col), ast) in roots {
            if pending
                .as_ref()
                .is_some_and(|p| p.sheet_index == sheet && p.contains(row, col))
            {
                continue;
            }
            // A dynamic-array ORIGIN's answer is the whole array its footprint
            // holds -- recording the first element the origin stores would
            // hand the next recalculation without data a scalar, and it would
            // collapse the spill (rev5B#2). Read BEFORE the evaluator exists:
            // the resolver below takes the spill map's lock itself.
            let footprint = spill_footprint(state, sheet, row, col);
            let stored_array = match &footprint {
                Some(cells) => match spilled_answer(grid, row, col, cells) {
                    Some(array) => Some(array),
                    // An incomplete footprint is no answer at all.
                    None => continue,
                },
                None => None,
            };
            // The formula as recalculation evaluates it: names, structured
            // references and `A1#` expanded through the ONE resolver, so the
            // fingerprint recorded here is the one a later pass computes.
            let resolved = crate::name_resolution::eval_ast(ast, &name_tables.at(sheet, row, col));
            let context = crate::create_multi_sheet_context(&grids, &sheet_names, sheet_name);
            let eval_ctx = engine::EvalContext {
                current_row: Some(row),
                current_col: Some(col),
                ..Default::default()
            };
            let mut evaluator = engine::Evaluator::with_context(grid, context, eval_ctx);
            crate::eval_budget::apply(&mut evaluator);
            match stored_array {
                Some(array) => evaluator.remember_stored_call_answer(&resolved, array),
                None => evaluator.remember_stored_call_result(&resolved),
            };
        }
    }
}

/// What an application install brought, for [`InstallScope::is_foreign`].
struct InstallScope<'a> {
    /// The installed sheets' names, uppercased.
    sheet_names: HashSet<String>,
    sheet_indices: HashSet<usize>,
    /// The application's own names (uppercased -> `refers_to`).
    names: &'a HashMap<String, String>,
    /// What the workbook's names resolve to now.
    workbook_names: &'a HashMap<String, crate::named_ranges::NamedRange>,
    table_names: &'a crate::tables::TableNameRegistry,
}

impl InstallScope<'_> {
    /// Whether the formula `stored` (as the cell keeps it) / `resolved` (as a
    /// recalculation evaluates it) reads anything the install did not bring --
    /// see [`remember_installed_call_results`]. Errs towards "foreign": a
    /// foreign cell merely refuses until a recalculation with data serves it.
    fn is_foreign(&self, stored: &Expression, resolved: &Expression) -> bool {
        self.names_foreign(stored) || self.sheets_foreign(resolved)
    }

    /// A defined name the workbook does not resolve to the application's own
    /// definition, or a table that does not live on an installed sheet.
    fn names_foreign(&self, expr: &Expression) -> bool {
        match expr {
            Expression::NamedRef { name, .. } => {
                let key = crate::name_resolution::name_key(name);
                match (self.names.get(&key), self.workbook_names.get(&key)) {
                    (Some(own), Some(now)) => *own != now.refers_to,
                    _ => true,
                }
            }
            Expression::TableRef { table_name, .. } => !self
                .table_names
                .get(&crate::tables::table_name_key(table_name))
                .is_some_and(|(sheet, _)| self.sheet_indices.contains(sheet)),
            _ => engine::cube::sub_expressions(expr).into_iter().any(|e| self.names_foreign(e)),
        }
    }

    /// A reference to a sheet outside the install, or a 3D range.
    fn sheets_foreign(&self, expr: &Expression) -> bool {
        let names_outside = |sheet: &Option<String>| {
            sheet
                .as_ref()
                .is_some_and(|name| !self.sheet_names.contains(&identity::sheet_name_key(name)))
        };
        match expr {
            Expression::CellRef { sheet, .. }
            | Expression::ColumnRef { sheet, .. }
            | Expression::RowRef { sheet, .. } => names_outside(sheet),
            Expression::Range { sheet, start, end, .. } => {
                names_outside(sheet) || self.sheets_foreign(start) || self.sheets_foreign(end)
            }
            Expression::Sheet3DRef { .. } => true,
            _ => engine::cube::sub_expressions(expr).into_iter().any(|e| self.sheets_foreign(e)),
        }
    }
}

/// The cells the dynamic-array origin at (sheet, row, col) spills into (its
/// `spill_ranges` entry, the origin excluded), copied out so the guard is
/// dropped before any formula is resolved -- the resolver takes the same lock
/// (`no_spill_map_holder_also_resolves_a_formula`).
fn spill_footprint(state: &AppState, sheet: usize, row: u32, col: u32) -> Option<Vec<(u32, u32)>> {
    state.spill_ranges.read().ok().and_then(|ranges| ranges.get(&(sheet, row, col)).cloned())
}

/// The whole array a dynamic-array origin at (row, col) spilled, read back
/// from the grid: the origin's own value plus its footprint `cells` (the
/// `spill_ranges` entry, which excludes the origin), in
/// `EvalResult::spill_dimensions`' shape -- one flat column, or rows of
/// cells. `None` when the footprint is not exactly the rectangle it implies
/// or a cell in it holds something an array element cannot be (a blank, a
/// list): such a footprint is no answer, and the caller seeds nothing.
fn spilled_answer(
    grid: &engine::Grid,
    row: u32,
    col: u32,
    cells: &[(u32, u32)],
) -> Option<engine::EvalResult> {
    use engine::EvalResult;
    let mut covered: HashSet<(u32, u32)> = cells.iter().copied().collect();
    if covered.len() != cells.len() || !covered.insert((row, col)) {
        return None;
    }
    if covered.iter().any(|&(r, c)| r < row || c < col) {
        return None;
    }
    let last_row = covered.iter().map(|&(r, _)| r).max()?;
    let last_col = covered.iter().map(|&(_, c)| c).max()?;
    let rows = (last_row - row + 1) as usize;
    let cols = (last_col - col + 1) as usize;
    if covered.len() != rows.checked_mul(cols)? {
        return None;
    }
    let element = |r: u32, c: u32| -> Option<EvalResult> {
        match &grid.get_cell(r, c)?.value {
            CellValue::Number(n) => Some(EvalResult::Number(*n)),
            CellValue::Text(s) => Some(EvalResult::Text(s.clone())),
            CellValue::Boolean(b) => Some(EvalResult::Boolean(*b)),
            CellValue::Error(e) => Some(EvalResult::Error(e.clone())),
            _ => None,
        }
    };
    if cols == 1 {
        (0..rows as u32).map(|dr| element(row + dr, col)).collect::<Option<Vec<_>>>().map(EvalResult::Array)
    } else {
        (0..rows as u32)
            .map(|dr| {
                (0..cols as u32)
                    .map(|dc| element(row + dr, col + dc))
                    .collect::<Option<Vec<_>>>()
                    .map(EvalResult::Array)
            })
            .collect::<Option<Vec<_>>>()
            .map(EvalResult::Array)
    }
}

// ===========================================================================
// Script-facing cube API (Layer 1): cube.value / cube.kpi for user scripts
//
// A user script (object script, or a future UDF) can query the BI model with
// CUBE member-expression ergonomics instead of building a QueryRequest. These
// reuse the SAME resolution helpers as the formula path, but take resolved
// STRING arguments (no cell references), so no CubeResolver is involved. They
// are brokered through the `bi.query` capability (model-scoped, read-only).
// ===========================================================================

pub(crate) fn cube_err_message(e: CubeError) -> String {
    match e {
        CubeError::Name => "Unknown BI connection".to_string(),
        CubeError::Value => "Invalid member expression".to_string(),
        CubeError::NotAvailable => "No data available".to_string(),
        CubeError::Reference => "Invalid reference".to_string(),
        CubeError::Refused => "Refused by the model's security: the active \"view as\" role \
                              denies an object this formula reads"
            .to_string(),
    }
}

/// Record a script-attributed cube capability call — **both** outcomes.
///
/// A missing audit row is bad; a FALSE one is worse. Recording only successes
/// tells a reviewer of the trail that a query the model refused went through,
/// and because these commands are server-audited the broker deliberately
/// writes nothing, so this is the only recorder.
fn audit_cube_call<T>(
    app_state: &crate::AppState,
    script_id: Option<&str>,
    detail: &str,
    result: &Result<T, String>,
) {
    let Some(sid) = script_id else { return };
    match result {
        Ok(_) => crate::net_commands::record_capability_call(
            &app_state.audit_log,
            "bi.query",
            sid,
            true,
            Some(detail),
            None,
        ),
        Err(e) => crate::net_commands::record_capability_call(
            &app_state.audit_log,
            "bi.query",
            sid,
            false,
            Some(detail),
            Some(e),
        ),
    }
}

/// Resolve a CUBEVALUE from raw member-expression strings (a measure + member
/// filters). `Ok(None)` means the query ran but returned no value.
pub async fn script_cube_value(
    bi: &BiState,
    connection: &str,
    members: &[String],
) -> Result<Option<f64>, CubeError> {
    let mut ctx = CubeCtx::new(bi);
    let conn_id = ctx.conn(connection).await?;

    let mut measures: Vec<String> = Vec::new();
    let mut filters: Vec<(String, String)> = Vec::new();
    for s in members {
        if s.trim().is_empty() {
            continue;
        }
        for m in parse_members(s)? {
            match m {
                MemberExpr::Measure(name) => measures.push(name),
                MemberExpr::Member { column, value, .. } => filters.push((column, value)),
                MemberExpr::Level { .. } => return Err(CubeError::Value),
            }
        }
    }

    let measure = match measures.first() {
        Some(m) => m.clone(),
        None => match ctx.meta(&conn_id).await.and_then(|m| m.first_measure) {
            Some(m) => m,
            None => return Err(CubeError::NotAvailable),
        },
    };

    match query_scalar(bi, &conn_id, &measure, &filters).await {
        Ok(v) => Ok(Some(v)),
        Err(CubeError::NotAvailable) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Resolve a KPI value/goal/status (property 1/2/3) for a script.
pub async fn script_cube_kpi(
    bi: &BiState,
    connection: &str,
    kpi: &str,
    property: i64,
) -> Result<Option<f64>, CubeError> {
    let mut ctx = CubeCtx::new(bi);
    let conn_id = ctx.conn(connection).await?;
    let kpi_data = fetch_kpi(bi, &conn_id, kpi).await.ok_or(CubeError::NotAvailable)?;
    // Treat "no rows" as no value (null) to match script_cube_value's contract,
    // rather than surfacing it as an error.
    let value = match query_scalar(bi, &conn_id, &kpi_data.base_measure, &[]).await {
        Ok(v) => v,
        Err(CubeError::NotAvailable) => return Ok(None),
        Err(e) => return Err(e),
    };
    let goal = match &kpi_data.target {
        bi_engine::KpiTarget::Constant(v) => *v,
        bi_engine::KpiTarget::Measure(m) => match query_scalar(bi, &conn_id, m, &[]).await {
            Ok(v) => v,
            Err(CubeError::NotAvailable) => return Ok(None),
            Err(e) => return Err(e),
        },
    };
    let result = match property {
        1 => value,
        2 => goal,
        3 => compute_status(value, goal, &kpi_data.bands) as f64,
        _ => return Err(CubeError::NotAvailable),
    };
    Ok(Some(result))
}

/// Distinct members of a level (Table[Column]) for a script to iterate.
pub async fn script_cube_members(
    bi: &BiState,
    connection: &str,
    member_or_level: &str,
) -> Result<Vec<String>, CubeError> {
    let mut ctx = CubeCtx::new(bi);
    let conn_id = ctx.conn(connection).await?;
    match parse_member_expr(member_or_level)? {
        MemberExpr::Level { table, column } => distinct_members(&mut ctx, &conn_id, &table, &column).await,
        _ => Err(CubeError::Value),
    }
}

#[tauri::command]
pub async fn cube_udf_value(
    bi_state: tauri::State<'_, BiState>,
    cap_store: tauri::State<'_, crate::scripting::CapabilityStore>,
    app_state: tauri::State<'_, crate::AppState>,
    connection: String,
    members: Vec<String>,
    script_id: Option<String>,
    window: tauri::Window,
) -> Result<Option<f64>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // A3.4-S2: authoritative server-side re-check. cube.* maps to the bi.query
    // capability, so a sandboxed script (carries a script_id) must have been
    // granted bi.query — a compromised renderer can't bypass the broker check.
    // A trusted main-window call carries no script_id and passes untouched.
    if let Some(sid) = script_id.as_deref() {
        if !cap_store.is_granted(sid, "bi.query") {
            crate::log_warn!("SECURITY", "cube_udf_value DENIED (bi.query not granted): script={}", sid);
            crate::net_commands::record_capability_call(
                &app_state.audit_log, "bi.query", sid, false, None, Some("bi.query not granted"),
            );
            return Err("PermissionDenied: bi.query not granted for this script".to_string());
        }
    }
    let result = script_cube_value(&bi_state, &connection, &members)
        .await
        .map_err(cube_err_message);
    audit_cube_call(
        &app_state,
        script_id.as_deref(),
        &format!("cube.value connection {}", connection),
        &result,
    );
    result
}

#[tauri::command]
pub async fn cube_udf_kpi(
    bi_state: tauri::State<'_, BiState>,
    cap_store: tauri::State<'_, crate::scripting::CapabilityStore>,
    app_state: tauri::State<'_, crate::AppState>,
    connection: String,
    kpi: String,
    property: i64,
    script_id: Option<String>,
    window: tauri::Window,
) -> Result<Option<f64>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    if let Some(sid) = script_id.as_deref() {
        if !cap_store.is_granted(sid, "bi.query") {
            crate::log_warn!("SECURITY", "cube_udf_kpi DENIED (bi.query not granted): script={}", sid);
            crate::net_commands::record_capability_call(
                &app_state.audit_log, "bi.query", sid, false, None, Some("bi.query not granted"),
            );
            return Err("PermissionDenied: bi.query not granted for this script".to_string());
        }
    }
    let result = script_cube_kpi(&bi_state, &connection, &kpi, property)
        .await
        .map_err(cube_err_message);
    audit_cube_call(
        &app_state,
        script_id.as_deref(),
        &format!("cube.kpi connection {} kpi {}", connection, kpi),
        &result,
    );
    result
}

#[tauri::command]
pub async fn cube_udf_members(
    bi_state: tauri::State<'_, BiState>,
    cap_store: tauri::State<'_, crate::scripting::CapabilityStore>,
    app_state: tauri::State<'_, crate::AppState>,
    connection: String,
    level: String,
    script_id: Option<String>,
    window: tauri::Window,
) -> Result<Vec<String>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    if let Some(sid) = script_id.as_deref() {
        if !cap_store.is_granted(sid, "bi.query") {
            crate::log_warn!("SECURITY", "cube_udf_members DENIED (bi.query not granted): script={}", sid);
            crate::net_commands::record_capability_call(
                &app_state.audit_log, "bi.query", sid, false, None, Some("bi.query not granted"),
            );
            return Err("PermissionDenied: bi.query not granted for this script".to_string());
        }
    }
    let result = script_cube_members(&bi_state, &connection, &level)
        .await
        .map_err(cube_err_message);
    audit_cube_call(
        &app_state,
        script_id.as_deref(),
        &format!("cube.members connection {} level {}", connection, level),
        &result,
    );
    result
}

// ===========================================================================
// Public entry point
// ===========================================================================

/// Which write a pre-fetch is built for. The doors evaluate different cells,
/// and a pre-fetch must cover exactly the cells its door evaluates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CubeWriteDoor {
    /// `update_cell`: the grid editor's one edit. Its cascade also re-spills
    /// the dynamic arrays the edit unblocked, and a writeback-claimed cell it
    /// is allowed to write (the editor drafted it first) is written.
    Edit,
    /// `update_cells_batch` (a paste, a fill, a script's or an extension's
    /// `CellRange.setValue(s)`), which SKIPS writeback-claimed cells and, like
    /// the edit, re-spills the arrays a written cell was blocking; or, with a
    /// `sheet_index` that is not the active sheet, `update_cell_on_sheets`.
    Batch,
}

/// The pending writes a pre-fetch is built for, in the order the write
/// performs them, on `sheet_index` (`None`, or the active sheet's index: the
/// active sheet).
pub struct CubePrefetchEdits<'a> {
    pub edits: &'a [crate::api_types::CellUpdateInput],
    pub sheet_index: Option<usize>,
    pub door: CubeWriteDoor,
    /// The volatile custom-function cells the frontend's UDF pass found: the
    /// list the write command receives, and so members of its cascade.
    pub udf_volatile_cells: Option<&'a [crate::scripting::udf::UdfCellRef]>,
}

/// How the write will STORE `u`'s value, or `None` for a clear -- the batch's
/// own recipe (`update_cells_batch_core`): an all-blank value clears the cell;
/// anything else is parsed in the number format it LANDS in (an explicit
/// `styleIndex`'s, else the effective format at the cell, row and column
/// tiers included), through the invariant ladder for a script's typed write.
/// So `0012` written into an `@` cell is the text "0012" here, as in the grid,
/// not the number 12 a format-blind parse would key on. `update_cell` and
/// `update_cell_on_sheets` store the same value: neither sends a `styleIndex`,
/// both read the destination's format, and the format moves only the Text
/// rung of the ladder -- which a PASTE skips (`CellUpdateInput::pasted`), so a
/// pasted CUBE formula in an `@` cell is a formula here as in the grid.
/// (`the_prefetch_parses_a_write_as_the_batch_stores_it` pins the agreement
/// against the real batch body.)
fn parse_pending_write(
    u: &crate::api_types::CellUpdateInput,
    grid: &engine::Grid,
    styles: &engine::StyleRegistry,
    locale: &engine::LocaleSettings,
) -> Option<engine::Cell> {
    if u.value.trim().is_empty() {
        return None;
    }
    let target_format = match u.style_index {
        Some(idx) => styles.get(idx).number_format.clone(),
        None => crate::entry_format_at(grid, styles, u.row, u.col),
    };
    let ladder_format = if u.is_paste() { None } else { Some(&target_format) };
    Some(if u.invariant.unwrap_or(false) {
        crate::parse_cell_input_invariant_in_format(&u.value, locale, ladder_format)
    } else {
        crate::parse_cell_input_in_format(&u.value, locale, ladder_format).0
    })
}

/// The cells of `edits` a published writeback region claims on `sheet`. The
/// batch SKIPS them (partial success), so they write nothing a cube argument
/// could read. Each lock is taken on its own.
fn writeback_claimed(
    state: &AppState,
    sheet: usize,
    edits: &[crate::api_types::CellUpdateInput],
) -> HashSet<(u32, u32)> {
    let Some(sheet_id) = state.sheet_ids.read().unwrap().get(sheet).copied() else {
        return HashSet::new();
    };
    let index = state.writeback_index.lock().unwrap();
    if index.is_empty() {
        return HashSet::new();
    }
    edits
        .iter()
        .filter(|u| index.contains(sheet_id, u.row, u.col))
        .map(|u| (u.row, u.col))
        .collect()
}

/// Record what a pending write leaves in its cell for a cube argument to read:
/// a clear or an error leaves no text, a literal its text. A FORMULA write
/// leaves no entry -- its new value is not known until the write evaluates it,
/// so a cube argument naming it reads its pre-write text (the documented
/// limit: an argument cell recomputed by the same write).
fn overlay_write(
    overlay: &mut HashMap<(u32, u32), Option<String>>,
    at: (u32, u32),
    cell: &Option<engine::Cell>,
) {
    match cell {
        None => {
            overlay.insert(at, None);
        }
        Some(c) if c.has_formula() => {
            overlay.remove(&at);
        }
        Some(c) => {
            overlay.insert(at, engine::cube::cube_cell_text(&c.value));
        }
    }
}

/// A sheet-qualified cube argument's target as the pre-pass snapshotted it.
/// The evaluator reads the same cell live, through the same
/// `engine::cube::qualified_cell_arg` rule.
enum QualifiedSnapshot {
    NoSuchSheet,
    Cell(Option<engine::Cell>),
}

/// Every sheet-qualified cell argument in `args` (nested cube calls included)
/// that names a sheet other than `own_upper`, as (SHEET UPPERCASED, row, col).
fn collect_qualified_refs(
    args: &[Expression],
    own_upper: &str,
    out: &mut HashSet<(String, u32, u32)>,
) {
    for a in args {
        match a {
            Expression::CellRef { sheet: Some(s), col, row, .. } => {
                let upper = identity::sheet_name_key(s);
                if upper != own_upper {
                    out.insert((upper, row.saturating_sub(1), col_to_index(col) as u32));
                }
            }
            Expression::FunctionCall { args, .. } => collect_qualified_refs(args, own_upper, out),
            _ => {}
        }
    }
}

/// The ROOT call of a cell's formula: (function, arguments).
fn root_call(ast: &Expression) -> Option<(&BuiltinFunction, &[Expression])> {
    match ast {
        Expression::FunctionCall { func, args, .. } => Some((func, args.as_slice())),
        _ => None,
    }
}

/// Resolve every cube call in `calls` that `resolver` keys to something the
/// pre-fetch does not hold yet. `reuse` is the cell's Phase-A outcome, offered
/// only when Phase A resolved this very ROOT object call under the same keys,
/// so it is not resolved twice.
async fn resolve_calls(
    ctx: &mut CubeCtx<'_>,
    prefetch: &mut CubePrefetch,
    calls: &[(BuiltinFunction, Vec<Expression>)],
    root: Option<(&BuiltinFunction, &[Expression])>,
    reuse: Option<&Result<CubeBinding, CubeError>>,
    resolver: &AppCubeResolver<'_>,
) {
    for (func, args) in calls {
        let Some(fname) = cube_function_name(func) else { continue };
        let key = match cube_call_key(fname, args, resolver) {
            Ok(k) => k,
            Err(_) => continue,
        };
        if prefetch.results.contains_key(&key) {
            continue;
        }
        let is_root = root.is_some_and(|(rf, ra)| rf == func && ra == args.as_slice());
        let result = if is_object_func(func) {
            match reuse.filter(|_| is_root) {
                Some(Ok(b)) => CubeCallResult::Object { caption: b.caption.clone() },
                Some(Err(e)) => CubeCallResult::Error(*e),
                None => match resolve_object(ctx, func, args, resolver).await {
                    Ok(b) => CubeCallResult::Object { caption: b.caption },
                    Err(e) => CubeCallResult::Error(e),
                },
            }
        } else {
            match resolve_value(ctx, func, args, resolver).await {
                Ok(res) => res,
                Err(e) => CubeCallResult::Error(e),
            }
        };
        prefetch.results.insert(key, result);
    }
}

/// Resolve all cube formulas a write evaluates (or, with `edits` `None`,
/// every cube cell on the active sheet) into a `CubePrefetch`. All BI
/// `.await` happens here; the returned struct contains only pre-fetched data
/// the synchronous recalc serves.
///
/// WHICH CELLS GET RESULTS -- and the pre-fetch's `scope` names exactly these,
/// so the evaluator treats any other cube cell as if nothing was fetched (each
/// of its calls is answered from the sheet's results cache for the arguments
/// it has now, else #N/A; see `engine::cube::CubePrefetchScope` and
/// `engine::cube::CallMemo`):
/// - a full refresh (`None`): every cube cell on the active sheet;
/// - every written CUBE formula, keyed as the write evaluates it AT ITS TURN:
///   with the writes before it in place and the writes after it not yet made
///   (the batch evaluates each written formula inside its loop, under manual
///   calculation too). A formula written before the literal it reads is
///   therefore served under manual calculation, where no cascade re-evaluates
///   it, as consistently as every other formula of that batch;
/// - on the ACTIVE sheet under AUTOMATIC calculation, every cell the write's
///   cascade evaluates once all writes have landed -- computed by
///   `commands::data::active_sheet_write_cascade`, the very function the write
///   bodies build their cascade with, so the two cannot drift (a cascade cell
///   the pre-fetch did not cover used to answer `#N/A`: a CUBEVALUE fed by a
///   `TODAY()` cell, or one under a whole-column reader). Under MANUAL
///   calculation no cascade runs, so what the user left stale stays stale, as
///   Excel leaves it.
/// - a write to ANOTHER sheet resolves the written cell only: that sheet's
///   whole-sheet recalculation (`recalc_after_off_sheet_write`) carries no cube
///   data, and answers every other cube call from the results cache for its
///   exact arguments (#N/A where the write changed them to ones never served).
///
/// A sheet-qualified argument (`Inputs!B2`) reads the sheet it names, under
/// the rule both sides share (`engine::cube::qualified_cell_arg`).
///
/// COST (rev4A#4). Every write of a session that has seen a CUBE formula runs
/// this, so the workbook is read in ONE synchronous step
/// ([`snapshot_prefetch_sheet`]) that copies only what the async half reads:
/// the formulas of the cube-bearing cells and the text of the cells their
/// arguments name. It used to clone the whole sheet and then every formula's
/// AST a second time, per write -- on a sheet of a million formulas, a stall
/// on every one-cell `setValue`.
pub async fn build_cube_prefetch(
    state: &AppState,
    bi: &BiState,
    edits: Option<CubePrefetchEdits<'_>>,
) -> CubePrefetch {
    let active_sheet = *state.active_sheet.read().unwrap();
    let sheet = edits.as_ref().and_then(|e| e.sheet_index).unwrap_or(active_sheet);
    prefetch_sheet(state, bi, edits, sheet, active_sheet).await
}

/// THE FULL REFRESH (Calculate Now once the session has a CUBE formula,
/// `recalcWithCube` after a model change): the active sheet's pre-fetch, with
/// one more in `other_sheets` for every other sheet that has cube cells, so
/// the workbook pass serves EVERY sheet's cube calls with current data
/// (NEW-f9-other-sheet-cube-na). It used to be built from the active sheet
/// alone, and every other sheet's cube cells were never refreshed by F9.
pub(crate) async fn build_full_refresh_prefetch(state: &AppState, bi: &BiState) -> CubePrefetch {
    let active_sheet = *state.active_sheet.read().unwrap();
    let sheet_count = state.sheet_names.read().unwrap().len();
    let mut prefetch = prefetch_sheet(state, bi, None, active_sheet, active_sheet).await;
    for sheet in (0..sheet_count).filter(|&s| s != active_sheet) {
        let other = prefetch_sheet(state, bi, None, sheet, active_sheet).await;
        let Some(name) = other.scope.as_ref().filter(|s| !s.covered.is_empty()).map(|s| identity::sheet_name_key(&s.sheet)) else {
            continue; // no cube cell on that sheet
        };
        prefetch.other_sheets.insert(name, other);
    }
    prefetch
}

/// [`build_cube_prefetch`]'s body, for `sheet` (`edits` `None`: every cube
/// cell on it, a full refresh of that sheet).
async fn prefetch_sheet(
    state: &AppState,
    bi: &BiState,
    edits: Option<CubePrefetchEdits<'_>>,
    sheet: usize,
    active_sheet: usize,
) -> CubePrefetch {
    // --- 1. Read the workbook in ONE synchronous step (no std lock across an
    //        await), copying only what the async half reads ---
    let sheet_names: Vec<String> = state.sheet_names.read().unwrap().clone();
    let Some(sheet_name) = sheet_names.get(sheet).cloned() else {
        // No such sheet: nothing to serve, and the write refuses it anyway.
        return CubePrefetch::default();
    };
    let locale = state.locale.lock().unwrap().clone();
    let automatic = state.calculation_mode.lock().unwrap().as_str() == "automatic";
    let Some(snap) = snapshot_prefetch_sheet(
        state,
        edits.as_ref(),
        sheet,
        sheet == active_sheet,
        &sheet_names,
        &sheet_name,
        &locale,
        automatic,
    ) else {
        return CubePrefetch::default();
    };
    let own_upper = identity::sheet_name_key(&sheet_name);

    let mut prefetch = CubePrefetch::default();
    let mut scope = engine::cube::CubePrefetchScope { sheet: sheet_name.clone(), covered: HashSet::new() };
    if snap.cube_cells.is_empty() && snap.pending_cube.iter().all(Option::is_none) {
        // No cube cell anywhere this write could evaluate: an EMPTY scope, so
        // any cube cell the recalculation does reach is treated as having no
        // data (answered from the results cache for its exact arguments, else
        // #N/A).
        prefetch.scope = Some(scope);
        return prefetch;
    }

    let mut ctx = CubeCtx::new(bi);

    // --- 2. Phase A: resolve object-cell bindings in dependency order ---
    // A fixed-point loop: each round resolves any object cell whose referenced
    // cube cells are already resolved. Cube formulas can't form cycles (the
    // dependency graph forbids them), so this converges.
    let object_cells = &snap.object_cells;
    let object_coords: HashSet<(u32, u32)> = object_cells.iter().map(|(k, _, _)| *k).collect();
    let mut outcomes: HashMap<(u32, u32), Result<CubeBinding, CubeError>> = HashMap::new();
    loop {
        let mut progressed = false;
        for ((r, c), func, args) in object_cells {
            if outcomes.contains_key(&(*r, *c)) {
                continue;
            }
            if !object_deps_ready(args, &own_upper, &object_coords, &outcomes) {
                continue;
            }
            let outcome = {
                let resolver = AppCubeResolver {
                    outcomes: &outcomes,
                    texts: &snap.texts,
                    overlay: &snap.final_overlay,
                    own_sheet_upper: &own_upper,
                    qualified: &snap.qualified,
                };
                resolve_object(&mut ctx, func, args, &resolver).await
            };
            outcomes.insert((*r, *c), outcome);
            progressed = true;
        }
        if !progressed || outcomes.len() == object_cells.len() {
            break;
        }
    }

    // Record the per-cell bindings (successful objects only) into the prefetch.
    for ((r, c), outcome) in &outcomes {
        if let Ok(binding) = outcome {
            prefetch.insert_binding(*r, *c, binding.clone());
        }
    }

    // --- 3. Phase B: results for the cells the cascade evaluates (final view) ---
    for (r, c) in &snap.final_view_cells {
        let Some((ast, calls)) = snap.cube_cells.get(&(*r, *c)) else { continue };
        scope.covered.insert(engine::cube::cell_key(*r, *c));
        let resolver = AppCubeResolver {
            outcomes: &outcomes,
            texts: &snap.texts,
            overlay: &snap.final_overlay,
            own_sheet_upper: &own_upper,
            qualified: &snap.qualified,
        };
        resolve_calls(&mut ctx, &mut prefetch, calls, root_call(ast), outcomes.get(&(*r, *c)), &resolver)
            .await;
    }

    // --- 4. Phase B, at each written formula's turn ---
    // The view the write's own evaluation of write i sees: writes 0..i landed,
    // the rest not yet made. A key the final view already resolved is skipped.
    let mut at_turn: HashMap<(u32, u32), Option<String>> = HashMap::new();
    for (i, ((at, cell), cube)) in snap.pending.iter().zip(&snap.pending_cube).enumerate() {
        if let (Some(calls), Some(ast)) = (cube, cell.as_ref().and_then(|c| c.get_ast())) {
            scope.covered.insert(engine::cube::cell_key(at.0, at.1));
            let resolver = AppCubeResolver {
                outcomes: &outcomes,
                texts: &snap.texts,
                overlay: &at_turn,
                own_sheet_upper: &own_upper,
                qualified: &snap.qualified,
            };
            // Phase A's outcome is this write's only when its object formula
            // is the cell's FINAL one and keys the same at its turn as in the
            // final view (Phase A resolved it in the final view).
            let is_final_formula = snap.last_write.get(at).is_some_and(|&last| {
                last == i || snap.pending[last].1.as_ref().and_then(|c| c.get_ast()) == Some(ast)
            });
            let reuse = match root_call(ast) {
                Some((func, args)) if is_object_func(func) && is_final_formula => {
                    let final_resolver = AppCubeResolver {
                        outcomes: &outcomes,
                        texts: &snap.texts,
                        overlay: &snap.final_overlay,
                        own_sheet_upper: &own_upper,
                        qualified: &snap.qualified,
                    };
                    let same_keys = cube_function_name(func).is_some_and(|name| {
                        cube_call_key(name, args, &resolver).ok() == cube_call_key(name, args, &final_resolver).ok()
                    });
                    if same_keys { outcomes.get(at) } else { None }
                }
                _ => None,
            };
            resolve_calls(&mut ctx, &mut prefetch, calls, root_call(ast), reuse, &resolver).await;
        }
        overlay_write(&mut at_turn, *at, cell);
    }

    prefetch.scope = Some(scope);
    prefetch
}

/// What [`build_cube_prefetch`] reads from the workbook, copied in one
/// synchronous step: only the cube-bearing cells' formulas and the text of the
/// cells their arguments name, never the whole sheet (rev4A#4).
struct PrefetchSnapshot {
    /// The pending writes, in the write's order, parsed exactly as the write
    /// stores them -- minus the cells the batch skips for a writeback claim.
    pending: Vec<((u32, u32), Option<engine::Cell>)>,
    /// The index in `pending` of the LAST write to each written cell.
    last_write: HashMap<(u32, u32), usize>,
    /// Each pending write's own cube calls (`None`: it carries none).
    pending_cube: Vec<Option<Vec<(BuiltinFunction, Vec<Expression>)>>>,
    /// What every write leaves for a cube argument to read, all writes landed.
    final_overlay: HashMap<(u32, u32), Option<String>>,
    /// Every cell of the FINAL view (all writes landed) that contains a cube
    /// call: its formula and those calls.
    cube_cells: HashMap<(u32, u32), (Expression, Vec<(BuiltinFunction, Vec<Expression>)>)>,
    /// The cells whose formula's ROOT is a cube object (they carry a binding).
    object_cells: Vec<((u32, u32), BuiltinFunction, Vec<Expression>)>,
    /// The cells sheet-qualified arguments name on other sheets.
    qualified: HashMap<(String, u32, u32), QualifiedSnapshot>,
    /// The cells the write's cascade evaluates (final view).
    final_view_cells: Vec<(u32, u32)>,
    /// The pre-write text (`cube_cell_text`) of every own-sheet cell a cube
    /// argument names -- what `AppCubeResolver::cell_text` reads beneath the
    /// overlay. A cell with no text is absent.
    texts: HashMap<(u32, u32), String>,
}

/// The ONE synchronous read [`build_cube_prefetch`] makes of the workbook.
/// `None` when the sheet does not exist.
///
/// LOCKS, in the canonical order and all released before it returns: `grid`
/// (when the sheet is the active one, whose live copy it is), then `grids`,
/// then each leaf on its own (`style_registry`, the writeback claim stores,
/// `spill_blocks`) and the three dependency maps together in their order.
#[allow(clippy::too_many_arguments)]
fn snapshot_prefetch_sheet(
    state: &AppState,
    edits: Option<&CubePrefetchEdits<'_>>,
    sheet: usize,
    on_active_sheet: bool,
    sheet_names: &[String],
    sheet_name: &str,
    locale: &engine::LocaleSettings,
    automatic: bool,
) -> Option<PrefetchSnapshot> {
    let own_upper = identity::sheet_name_key(&sheet_name);
    let active_guard = if on_active_sheet { Some(state.grid.read().unwrap()) } else { None };
    let grids = state.grids.read().unwrap();
    let grid: &engine::Grid = match &active_guard {
        Some(active) => &**active,
        None => grids.get(sheet)?,
    };

    // The pending writes, in the write's order, parsed exactly as the write
    // stores them -- minus the cells the batch skips for a writeback claim.
    let pending: Vec<((u32, u32), Option<engine::Cell>)> = match edits {
        None => Vec::new(),
        Some(e) => {
            let skipped = if e.door == CubeWriteDoor::Batch && on_active_sheet {
                writeback_claimed(state, sheet, e.edits)
            } else {
                HashSet::new()
            };
            let styles = state.style_registry.read().unwrap();
            e.edits
                .iter()
                .filter(|u| !skipped.contains(&(u.row, u.col)))
                .map(|u| ((u.row, u.col), parse_pending_write(u, grid, &styles, locale)))
                .collect()
        }
    };

    // THE FINAL VIEW: every write landed (a cell written twice holds its last
    // write). This is what the cascade reads.
    let mut final_overlay: HashMap<(u32, u32), Option<String>> = HashMap::new();
    let mut last_write: HashMap<(u32, u32), usize> = HashMap::new();
    for (i, (at, cell)) in pending.iter().enumerate() {
        overlay_write(&mut final_overlay, *at, cell);
        last_write.insert(*at, i);
    }

    // --- Every cube cell on the sheet in the final view. Screened by
    // reference (`contains_cube_call` neither clones nor allocates); only a
    // cube-bearing cell's formula is copied. ---
    let mut qualified_refs: HashSet<(String, u32, u32)> = HashSet::new();
    let mut cube_cells: HashMap<(u32, u32), (Expression, Vec<(BuiltinFunction, Vec<Expression>)>)> =
        HashMap::new();
    let mut object_cells: Vec<((u32, u32), BuiltinFunction, Vec<Expression>)> = Vec::new();
    let mut note_cube_cell = |at: (u32, u32), ast: &Expression| {
        if !engine::cube::contains_cube_call(ast) {
            return;
        }
        let mut calls = Vec::new();
        collect_cube_calls(ast, &mut calls);
        for (_, args) in &calls {
            collect_qualified_refs(args, &own_upper, &mut qualified_refs);
        }
        if let Expression::FunctionCall { func, args, .. } = ast {
            if is_object_func(func) {
                object_cells.push((at, func.clone(), args.clone()));
            }
        }
        cube_cells.insert(at, (ast.clone(), calls));
    };
    for (&at, cell) in grid.cells.iter() {
        if last_write.contains_key(&at) {
            continue; // the final view holds the write, below
        }
        if let Some(ast) = cell.get_ast() {
            note_cube_cell(at, ast);
        }
    }
    for (&at, &i) in &last_write {
        if let Some(ast) = pending[i].1.as_ref().and_then(|c| c.get_ast()) {
            note_cube_cell(at, ast);
        }
    }
    // Each pending write's OWN formula, which the write evaluates at its turn
    // (a cell written twice is evaluated once per write).
    let pending_cube: Vec<Option<Vec<(BuiltinFunction, Vec<Expression>)>>> = pending
        .iter()
        .map(|(_, cell)| {
            let ast = cell.as_ref().and_then(|c| c.get_ast())?;
            if !engine::cube::contains_cube_call(ast) {
                return None;
            }
            let mut calls = Vec::new();
            collect_cube_calls(ast, &mut calls);
            for (_, args) in &calls {
                collect_qualified_refs(args, &own_upper, &mut qualified_refs);
            }
            Some(calls)
        })
        .collect();

    let mut snapshot = PrefetchSnapshot {
        pending,
        last_write,
        pending_cube,
        final_overlay,
        cube_cells,
        object_cells,
        qualified: HashMap::new(),
        final_view_cells: Vec::new(),
        texts: HashMap::new(),
    };
    if snapshot.cube_cells.is_empty() && snapshot.pending_cube.iter().all(Option::is_none) {
        return Some(snapshot);
    }

    // The text of every own-sheet cell a cube argument names, as the grid
    // holds it before the write (the overlay holds what the write leaves).
    let mut refs: Vec<(u32, u32)> = Vec::new();
    for (_, calls) in snapshot.cube_cells.values() {
        for (_, args) in calls {
            collect_cell_refs(args, &own_upper, &mut refs);
        }
    }
    for calls in snapshot.pending_cube.iter().flatten() {
        for (_, args) in calls {
            collect_cell_refs(args, &own_upper, &mut refs);
        }
    }
    for at in refs {
        if let Some(text) = grid.get_cell(at.0, at.1).and_then(|cell| engine::cube::cube_cell_text(&cell.value)) {
            snapshot.texts.insert(at, text);
        }
    }

    // The cells sheet-qualified arguments name on other sheets, read once.
    snapshot.qualified = qualified_refs
        .into_iter()
        .map(|(name, r, c)| {
            let read = match sheet_names.iter().position(|n| identity::sheet_name_key(n) == name) {
                Some(idx) => QualifiedSnapshot::Cell(grids.get(idx).and_then(|g| g.get_cell(r, c).cloned())),
                None => QualifiedSnapshot::NoSuchSheet,
            };
            ((name, r, c), read)
        })
        .collect();

    // --- The cells the write's CASCADE evaluates (final view) ---
    snapshot.final_view_cells = match edits {
        None => snapshot.cube_cells.keys().copied().collect(),
        Some(e) if automatic && on_active_sheet => {
            let written: Vec<(u32, u32)> = snapshot.pending.iter().map(|(at, _)| *at).collect();
            let seeds = match (e.door, written.first()) {
                (CubeWriteDoor::Edit, Some(&cell)) => crate::commands::data::CascadeSeeds::Edited(cell),
                _ => crate::commands::data::CascadeSeeds::Written(&written),
            };
            let unblocked = match seeds {
                crate::commands::data::CascadeSeeds::Edited((r, c)) => {
                    crate::commands::data::origins_blocked_by(state, sheet, r, c)
                }
                // The batch's own rule: the arrays a written cell was blocking.
                crate::commands::data::CascadeSeeds::Written(cells) => {
                    crate::commands::data::origins_blocked_by_any(state, sheet, cells)
                }
            };
            let mut cells = {
                let dependents = state.dependents.lock().unwrap();
                let column_dependents = state.column_dependents.lock().unwrap();
                let row_dependents = state.row_dependents.lock().unwrap();
                crate::commands::data::active_sheet_write_cascade(
                    grid,
                    seeds,
                    &dependents,
                    &column_dependents,
                    &row_dependents,
                    e.udf_volatile_cells,
                    &unblocked,
                )
            };
            // The written cells themselves: members of a batch's order, and the
            // single edit's own cell is evaluated with its write.
            let mut seen: HashSet<(u32, u32)> = cells.iter().copied().collect();
            for at in written {
                if seen.insert(at) {
                    cells.push(at);
                }
            }
            cells
        }
        // Manual calculation (no cascade runs), or another sheet (its
        // recalculation carries no cube data): the written cells' own
        // evaluation only, which the at-turn pass covers.
        Some(_) => Vec::new(),
    };
    Some(snapshot)
}

// ===========================================================================
// Resolution context (connection + model-metadata caches)
// ===========================================================================

pub(crate) struct CubeCtx<'a> {
    bi: &'a BiState,
    /// connection name -> id (None = not found).
    conn_ids: HashMap<String, Option<ConnectionId>>,
    /// connections already auto-connected/bound this pass.
    ensured: HashSet<ConnectionId>,
    /// model metadata cache keyed by connection id.
    meta_cache: HashMap<ConnectionId, Option<ModelMeta>>,
}

impl<'a> CubeCtx<'a> {
    pub(crate) fn new(bi: &'a BiState) -> Self {
        Self {
            bi,
            conn_ids: HashMap::new(),
            ensured: HashSet::new(),
            meta_cache: HashMap::new(),
        }
    }

    /// Resolve a connection by name and ensure it is ready to query (auto-connect
    /// + auto-bind when not cache-warm). Unknown name -> #NAME?.
    async fn conn(&mut self, name: &str) -> Result<ConnectionId, CubeError> {
        let id = match self.conn_ids.get(name) {
            Some(cached) => cached.clone(),
            None => {
                let found = conn_id_by_name(self.bi, name);
                self.conn_ids.insert(name.to_string(), found.clone());
                found
            }
        };
        let id = id.ok_or(CubeError::Name)?;
        if !self.ensured.contains(&id) {
            ensure_ready(self.bi, &id).await?;
            self.ensured.insert(id.clone());
        }
        Ok(id)
    }

    async fn meta(&mut self, id: &ConnectionId) -> Option<ModelMeta> {
        if let Some(cached) = self.meta_cache.get(id) {
            return cached.clone();
        }
        let m = fetch_model_meta(self.bi, id).await;
        self.meta_cache.insert(id.clone(), m.clone());
        m
    }
}

#[derive(Debug, Clone)]
struct ModelMeta {
    measures: HashSet<String>,
    columns: HashSet<(String, String)>,
    first_measure: Option<String>,
}

#[derive(Debug, Clone)]
struct KpiData {
    base_measure: String,
    target: bi_engine::KpiTarget,
    bands: Vec<(f64, i32)>,
}

// ===========================================================================
// The pre-pass resolver (mirrors engine's CubeResolver so keys match)
// ===========================================================================

struct AppCubeResolver<'a> {
    outcomes: &'a HashMap<(u32, u32), Result<CubeBinding, CubeError>>,
    /// The pre-write text of every cell of the pre-fetch's sheet that a cube
    /// argument names (`PrefetchSnapshot::texts`; absent: no text).
    texts: &'a HashMap<(u32, u32), String>,
    /// What the pending writes leave in their cells in THIS view (the final
    /// one, or one write's turn): `Some(text)`, or `None` for no text.
    overlay: &'a HashMap<(u32, u32), Option<String>>,
    /// That sheet's name, uppercased.
    own_sheet_upper: &'a str,
    /// The cells sheet-qualified arguments name on other sheets.
    qualified: &'a HashMap<(String, u32, u32), QualifiedSnapshot>,
}

impl CubeResolver for AppCubeResolver<'_> {
    fn binding_at(&self, row: u32, col: u32) -> Option<&CubeBinding> {
        self.outcomes.get(&(row, col)).and_then(|o| o.as_ref().ok())
    }
    fn cell_text(&self, row: u32, col: u32) -> Option<String> {
        match self.overlay.get(&(row, col)) {
            Some(text) => text.clone(),
            None => self.texts.get(&(row, col)).cloned(),
        }
    }
    fn is_own_sheet(&self, sheet: &str) -> bool {
        identity::sheet_name_key(sheet) == self.own_sheet_upper
    }
    fn qualified_cell_arg(&self, sheet: &str, row: u32, col: u32) -> Result<String, CubeError> {
        let upper = identity::sheet_name_key(sheet);
        let target = if upper == self.own_sheet_upper {
            engine::cube::QualifiedCell::OwnSheet
        } else {
            match self.qualified.get(&(upper, row, col)) {
                Some(QualifiedSnapshot::NoSuchSheet) => engine::cube::QualifiedCell::NoSuchSheet,
                Some(QualifiedSnapshot::Cell(cell)) => engine::cube::QualifiedCell::OtherSheet(cell.as_ref()),
                // Every qualified argument of every call keyed here was
                // snapshotted (`collect_qualified_refs`); unreachable.
                None => return Err(CubeError::Value),
            }
        };
        engine::cube::qualified_cell_arg(self, target, row, col)
    }
}

// ===========================================================================
// Object resolution (CUBEMEMBER / CUBESET / CUBERANKEDMEMBER / CUBEKPIMEMBER)
// ===========================================================================

pub(crate) async fn resolve_object(
    ctx: &mut CubeCtx<'_>,
    func: &BuiltinFunction,
    args: &[Expression],
    resolver: &dyn CubeResolver,
) -> Result<CubeBinding, CubeError> {
    match func {
        BuiltinFunction::CubeMember => resolve_cube_member(ctx, args, resolver).await,
        BuiltinFunction::CubeSet => resolve_cube_set(ctx, args, resolver).await,
        BuiltinFunction::CubeRankedMember => resolve_cube_ranked_member(ctx, args, resolver).await,
        BuiltinFunction::CubeKpiMember => resolve_cube_kpi_member(ctx, args, resolver).await,
        _ => Err(CubeError::Value),
    }
}

async fn resolve_cube_member(
    ctx: &mut CubeCtx<'_>,
    args: &[Expression],
    resolver: &dyn CubeResolver,
) -> Result<CubeBinding, CubeError> {
    if args.len() < 2 {
        return Err(CubeError::Value);
    }
    let conn_name = arg_str(args, 0, resolver)?;
    let conn_id = ctx.conn(&conn_name).await?;
    let member_str = arg_str(args, 1, resolver)?;
    let members = parse_members(&member_str)?;

    // Validate each measure/column exists in the model.
    if let Some(meta) = ctx.meta(&conn_id).await {
        for m in &members {
            match m {
                MemberExpr::Measure(name) => {
                    if !meta.measures.contains(name) {
                        return Err(CubeError::NotAvailable);
                    }
                }
                MemberExpr::Member { table, column, .. } => {
                    if !column_known(&meta, table.as_deref(), column) {
                        return Err(CubeError::NotAvailable);
                    }
                }
                MemberExpr::Level { table, column } => {
                    if !column_known(&meta, Some(table.as_str()), column) {
                        return Err(CubeError::NotAvailable);
                    }
                }
            }
        }
    }

    let caption = match arg_str_opt(args, 2, resolver) {
        Some(c) if !c.is_empty() => c,
        _ => default_caption(&members),
    };
    Ok(CubeBinding {
        connection: conn_name,
        kind: CubeBindingKind::Member,
        expression: member_str,
        caption,
        members: vec![],
        scalar: None,
    })
}

async fn resolve_cube_set(
    ctx: &mut CubeCtx<'_>,
    args: &[Expression],
    resolver: &dyn CubeResolver,
) -> Result<CubeBinding, CubeError> {
    if args.len() < 2 {
        return Err(CubeError::Value);
    }
    let conn_name = arg_str(args, 0, resolver)?;
    let conn_id = ctx.conn(&conn_name).await?;
    let set_str = arg_str(args, 1, resolver)?;

    // sort_order (arg 3): 0 none, 1 asc, 2 desc, 3 alpha-asc, 4 alpha-desc.
    let sort_order = arg_num_opt(args, 3, resolver).unwrap_or(0.0) as i64;
    let sort_by = arg_str_opt(args, 4, resolver).filter(|s| !s.is_empty());

    let mut members =
        resolve_set_members(ctx, &conn_id, &set_str, sort_order, sort_by.clone()).await?;

    // Alphabetical sort modes are independent of a measure.
    if sort_order == 3 {
        members.sort();
    } else if sort_order == 4 {
        members.sort();
        members.reverse();
    }

    let caption = match arg_str_opt(args, 2, resolver) {
        Some(c) if !c.is_empty() => c,
        _ => set_str.clone(),
    };
    // Fold the sort into the set's identity so two CUBESET cells over the same
    // set expression but DIFFERENT sort are distinct objects — otherwise
    // CUBERANKEDMEMBER / CUBESETCOUNT referencing them would key identically.
    let expression = if sort_order != 0 {
        format!("{}\u{1f}sort={}\u{1f}by={}", set_str, sort_order, sort_by.as_deref().unwrap_or(""))
    } else {
        set_str.clone()
    };
    Ok(CubeBinding {
        connection: conn_name,
        kind: CubeBindingKind::Set,
        expression,
        caption,
        members,
        scalar: None,
    })
}

/// Resolve a set expression to an ordered list of member-expression strings.
async fn resolve_set_members(
    ctx: &mut CubeCtx<'_>,
    conn_id: &ConnectionId,
    set_str: &str,
    sort_order: i64,
    sort_by: Option<String>,
) -> Result<Vec<String>, CubeError> {
    let s = set_str.trim();
    // Explicit list: {m1, m2, ...}
    if s.starts_with('{') && s.ends_with('}') {
        let inner = &s[1..s.len() - 1];
        return Ok(split_top_level_commas(inner)
            .into_iter()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .collect());
    }

    match parse_member_expr(s)? {
        MemberExpr::Level { table, column } => {
            // Distinct members of the column, optionally ordered by a measure.
            if sort_order == 1 || sort_order == 2 {
                // sort_by may be a bracketed measure expression like "[Revenue]";
                // the engine wants the bare name. With no sort_by, order by the
                // model's default measure rather than silently leaving unordered.
                let measure = match sort_by {
                    Some(m) => Some(measure_name(&m)),
                    None => model_first_measure(ctx, conn_id).await,
                };
                if let Some(measure) = measure {
                    let req = bi_engine::QueryRequest {
                        measures: vec![measure.clone()],
                        group_by: vec![bi_engine::ColumnRef::new(&table, &column)],
                        ..Default::default()
                    };
                    let result = run_query(ctx.bi, conn_id, req).await?;
                    let mut pairs: Vec<(String, f64)> = Vec::new();
                    for row in &result.rows {
                        let member = row.first().and_then(|o| o.clone());
                        let val = row.get(1).and_then(|o| o.as_ref()).and_then(|s| s.parse::<f64>().ok());
                        if let Some(m) = member {
                            if !m.is_empty() {
                                pairs.push((m, val.unwrap_or(0.0)));
                            }
                        }
                    }
                    pairs.sort_by(|a, b| {
                        let o = a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal);
                        if sort_order == 2 { o.reverse() } else { o }
                    });
                    return Ok(pairs
                        .into_iter()
                        .map(|(m, _)| format!("{}[{}]={}", table, column, m))
                        .collect());
                }
            }
            // Unordered (or alpha): just the distinct members.
            let members = distinct_members(ctx, conn_id, &table, &column).await?;
            Ok(members
                .into_iter()
                .map(|m| format!("{}[{}]={}", table, column, m))
                .collect())
        }
        MemberExpr::Member { table, column, value } => {
            let table = table.unwrap_or_default();
            Ok(vec![format!("{}[{}]={}", table, column, value)])
        }
        MemberExpr::Measure(_) => Err(CubeError::Value),
    }
}

async fn resolve_cube_ranked_member(
    ctx: &mut CubeCtx<'_>,
    args: &[Expression],
    resolver: &dyn CubeResolver,
) -> Result<CubeBinding, CubeError> {
    if args.len() < 3 {
        return Err(CubeError::Value);
    }
    let conn_name = arg_str(args, 0, resolver)?;
    let _conn_id = ctx.conn(&conn_name).await?;
    let set = resolve_set_binding(ctx, &args[1], resolver).await?;
    let rank = arg_num(args, 2, resolver)? as i64;
    if rank < 1 || (rank as usize) > set.members.len() {
        return Err(CubeError::Reference);
    }
    let member_expr = set.members[(rank - 1) as usize].clone();
    let members = parse_members(&member_expr).unwrap_or_default();
    let caption = match arg_str_opt(args, 3, resolver) {
        Some(c) if !c.is_empty() => c,
        _ => default_caption(&members),
    };
    Ok(CubeBinding {
        connection: conn_name,
        kind: CubeBindingKind::Member,
        expression: member_expr,
        caption,
        members: vec![],
        scalar: None,
    })
}

async fn resolve_cube_kpi_member(
    ctx: &mut CubeCtx<'_>,
    args: &[Expression],
    resolver: &dyn CubeResolver,
) -> Result<CubeBinding, CubeError> {
    if args.len() < 3 {
        return Err(CubeError::Value);
    }
    let conn_name = arg_str(args, 0, resolver)?;
    let conn_id = ctx.conn(&conn_name).await?;
    let kpi_name = arg_str(args, 1, resolver)?;
    let property = arg_num(args, 2, resolver)? as i64;

    let kpi = fetch_kpi(ctx.bi, &conn_id, &kpi_name)
        .await
        .ok_or(CubeError::NotAvailable)?;
    let value = query_scalar(ctx.bi, &conn_id, &kpi.base_measure, &[]).await?;
    let goal = match &kpi.target {
        bi_engine::KpiTarget::Constant(v) => *v,
        bi_engine::KpiTarget::Measure(m) => query_scalar(ctx.bi, &conn_id, m, &[]).await?,
    };

    let (scalar, caption) = match property {
        1 => (value, format_scalar(value)),
        2 => (goal, format_scalar(goal)),
        3 => {
            let st = compute_status(value, goal, &kpi.bands);
            (st as f64, status_string(st).to_string())
        }
        _ => return Err(CubeError::NotAvailable),
    };

    let caption = match arg_str_opt(args, 3, resolver) {
        Some(c) if !c.is_empty() => c,
        _ => caption,
    };
    Ok(CubeBinding {
        connection: conn_name,
        kind: CubeBindingKind::Member,
        expression: format!("KPI:{}:{}", kpi_name, property),
        caption,
        members: vec![],
        scalar: Some(scalar),
    })
}

// ===========================================================================
// Value resolution (CUBEVALUE / CUBESETCOUNT / CUBEMEMBERPROPERTY)
// ===========================================================================

pub(crate) async fn resolve_value(
    ctx: &mut CubeCtx<'_>,
    func: &BuiltinFunction,
    args: &[Expression],
    resolver: &dyn CubeResolver,
) -> Result<CubeCallResult, CubeError> {
    match func {
        BuiltinFunction::CubeValue => resolve_cube_value(ctx, args, resolver).await,
        BuiltinFunction::CubeSetCount => resolve_cube_set_count(ctx, args, resolver).await,
        BuiltinFunction::CubeMemberProperty => {
            resolve_cube_member_property(ctx, args, resolver).await
        }
        _ => Err(CubeError::Value),
    }
}

async fn resolve_cube_value(
    ctx: &mut CubeCtx<'_>,
    args: &[Expression],
    resolver: &dyn CubeResolver,
) -> Result<CubeCallResult, CubeError> {
    if args.is_empty() {
        return Err(CubeError::Value);
    }
    let conn_name = arg_str(args, 0, resolver)?;
    let conn_id = ctx.conn(&conn_name).await?;

    let mut measures: Vec<String> = Vec::new();
    let mut filters: Vec<(String, String)> = Vec::new();
    let mut scalar_override: Option<f64> = None;

    for (i, a) in args.iter().enumerate().skip(1) {
        // A referenced member carrying a precomputed scalar (e.g. a KPI member).
        // On this sheet only: a reference to another sheet never borrows the
        // object at the same coordinates here.
        if let Expression::CellRef { sheet, col, row, .. } = a {
            let r0 = row.saturating_sub(1);
            let c0 = col_to_index(col) as u32;
            if let Some(b) = engine::cube::referenced_binding(resolver, sheet, r0, c0) {
                if let Some(s) = b.scalar {
                    scalar_override = Some(s);
                    continue;
                }
            }
        }
        let s = arg_str(args, i, resolver)?;
        if s.is_empty() {
            continue;
        }
        for m in parse_members(&s)? {
            match m {
                MemberExpr::Measure(name) => measures.push(name),
                MemberExpr::Member { column, value, .. } => filters.push((column, value)),
                MemberExpr::Level { .. } => return Err(CubeError::Value),
            }
        }
    }

    // Choose the measure: explicit > scalar-carrying member > model default.
    let measure = if let Some(m) = measures.first() {
        m.clone()
    } else if let Some(s) = scalar_override {
        return Ok(CubeCallResult::Number(s));
    } else {
        match ctx.meta(&conn_id).await.and_then(|m| m.first_measure) {
            Some(m) => m,
            None => return Err(CubeError::NotAvailable),
        }
    };

    match query_scalar(ctx.bi, &conn_id, &measure, &filters).await {
        Ok(v) => Ok(CubeCallResult::Number(v)),
        Err(e) => Err(e),
    }
}

async fn resolve_cube_set_count(
    ctx: &mut CubeCtx<'_>,
    args: &[Expression],
    resolver: &dyn CubeResolver,
) -> Result<CubeCallResult, CubeError> {
    if args.is_empty() {
        return Err(CubeError::Value);
    }
    // CUBESETCOUNT(set) — the only argument is the set (no connection).
    let set = resolve_set_binding(ctx, &args[0], resolver).await?;
    Ok(CubeCallResult::Number(set.members.len() as f64))
}

async fn resolve_cube_member_property(
    ctx: &mut CubeCtx<'_>,
    args: &[Expression],
    resolver: &dyn CubeResolver,
) -> Result<CubeCallResult, CubeError> {
    if args.len() < 3 {
        return Err(CubeError::Value);
    }
    let conn_name = arg_str(args, 0, resolver)?;
    let conn_id = ctx.conn(&conn_name).await?;
    let member_str = arg_str(args, 1, resolver)?;
    let property = arg_str(args, 2, resolver)?;

    let member = parse_members(&member_str)?
        .into_iter()
        .find_map(|m| match m {
            MemberExpr::Member { table, column, value } => Some((table, column, value)),
            _ => None,
        })
        .ok_or(CubeError::Value)?;
    let (table, column, value) = member;

    let prop_upper = property.trim().to_uppercase();
    if prop_upper == "CAPTION" || prop_upper == "MEMBER_VALUE" || prop_upper == "VALUE" {
        return Ok(CubeCallResult::Text(value));
    }

    // Otherwise the property is another column on the member's table.
    let table = table.ok_or(CubeError::Value)?;
    let req = bi_engine::QueryRequest {
        measures: model_first_measure(ctx, &conn_id).await.into_iter().collect(),
        group_by: vec![bi_engine::ColumnRef::new(&table, &property)],
        filters: vec![bi_engine::FilterCondition::new(
            column.clone(),
            bi_engine::FilterOperator::Equal,
            value.clone(),
        )],
        ..Default::default()
    };
    let result = run_query(ctx.bi, &conn_id, req).await?;
    let cell = result
        .rows
        .first()
        .and_then(|r| r.first())
        .and_then(|o| o.clone());
    match cell {
        Some(s) => match s.parse::<f64>() {
            Ok(n) if n.is_finite() => Ok(CubeCallResult::Number(n)),
            _ => Ok(CubeCallResult::Text(s)),
        },
        None => Err(CubeError::NotAvailable),
    }
}

/// Resolve an argument to a set binding: a CellRef to a CUBESET cell, or a
/// nested CUBESET call.
async fn resolve_set_binding(
    ctx: &mut CubeCtx<'_>,
    arg: &Expression,
    resolver: &dyn CubeResolver,
) -> Result<CubeBinding, CubeError> {
    match arg {
        Expression::CellRef { sheet, col, row, .. } => {
            let r0 = row.saturating_sub(1);
            let c0 = col_to_index(col) as u32;
            match engine::cube::referenced_binding(resolver, sheet, r0, c0) {
                Some(b) if b.kind == CubeBindingKind::Set => Ok(b.clone()),
                _ => Err(CubeError::Reference),
            }
        }
        Expression::FunctionCall { func: BuiltinFunction::CubeSet, args, .. } => {
            resolve_cube_set(ctx, args, resolver).await
        }
        _ => Err(CubeError::Reference),
    }
}

// ===========================================================================
// BI engine plumbing
// ===========================================================================

pub(crate) fn conn_id_by_name(bi: &BiState, name: &str) -> Option<ConnectionId> {
    let conns = bi.connections.lock().unwrap();
    if let Some(c) = conns.values().find(|c| c.name == name) {
        return Some(c.id.clone());
    }
    // Fall back to treating the string as a connection id (scripts use ids).
    ConnectionId::parse(name).filter(|id| conns.contains_key(id))
}

fn engine_arc_by_id(
    bi: &BiState,
    id: &ConnectionId,
) -> Option<Arc<TokioMutex<bi_engine::Engine>>> {
    let conns = bi.connections.lock().unwrap();
    conns.get(id).and_then(|c| c.engine.clone())
}

/// Ensure tables are bound (auto-connect + auto-bind) unless already cache-warm.
async fn ensure_ready(bi: &BiState, conn_id: &ConnectionId) -> Result<(), CubeError> {
    let all_tables: Vec<String> = {
        let arc = engine_arc_by_id(bi, conn_id).ok_or(CubeError::NotAvailable)?;
        let engine = arc.lock().await;
        engine.model().tables().iter().map(|t| t.name().to_string()).collect()
    };
    let refs: Vec<&str> = all_tables.iter().map(|s| s.as_str()).collect();
    if !super::commands::bi_tables_cache_warm(bi, conn_id.clone(), &refs).await {
        super::commands::auto_connect_bi_connection(bi, conn_id.clone())
            .await
            .map_err(|_| CubeError::NotAvailable)?;
        super::commands::auto_bind_tables_on_connection(bi, conn_id.clone(), &refs)
            .await
            .map_err(|_| CubeError::NotAvailable)?;
    }
    Ok(())
}

/// Run a query and return the string-rendered result rows.
async fn run_query(
    bi: &BiState,
    conn_id: &ConnectionId,
    req: bi_engine::QueryRequest,
) -> Result<super::types::BiQueryResult, CubeError> {
    let arc = engine_arc_by_id(bi, conn_id).ok_or(CubeError::NotAvailable)?;
    let mut engine = arc.lock().await;
    super::commands::apply_connection_role(&mut engine, bi, conn_id.clone());
    match engine.query_auto_refresh(req).await {
        Ok((batches, _)) => Ok(super::commands::batches_to_result(&batches)),
        Err(e) if is_security_refusal(&e) => {
            crate::log_warn!("BI", "CUBE query refused: {}", e);
            Err(CubeError::Refused)
        }
        Err(_) => Err(CubeError::NotAvailable),
    }
}

/// True when the engine refused this query for a SECURITY reason rather than
/// failing to answer it: the active role denies an object (object-level
/// security), its row filters cannot be enforced for this query (fail-closed
/// row-level security), or the role itself is gone.
///
/// Matched on the TYPED error, never on message text. This codebase has been
/// bitten twice by the other kind: `friendly_bi_query_error`'s two
/// row-level-security branches matched Rust VARIANT names against `Display`
/// output and were therefore dead for their whole life.
pub(crate) fn is_security_refusal(e: &bi_engine::QueryError) -> bool {
    matches!(
        e,
        bi_engine::QueryError::Engine(
            bi_engine::EngineError::ObjectLevelSecurityDenied { .. }
                | bi_engine::EngineError::RowLevelSecurityNotEnforceable { .. }
                | bi_engine::EngineError::SecurityRoleNotFound(_)
        )
    )
}

/// Compute a single scalar measure value, optionally filtered to members.
async fn query_scalar(
    bi: &BiState,
    conn_id: &ConnectionId,
    measure: &str,
    filters: &[(String, String)],
) -> Result<f64, CubeError> {
    // THE BLANK MEMBER (found with wave C's W6). The CUBE builder picks its
    // members from the model value list, which offers a column's NULL and
    // empty rows as `pivot_engine::BLANK_ITEM_LABEL` ("(blank)"). An `Equal`
    // filter on that label matches no row (the CUBEVALUE answered `#N/A`), so
    // such a member goes to the engine as a scoped IN-list -- which reads the
    // label as BLANK -- at the level a plain filter takes (`LEVEL_SLICER`).
    // Since ruling Q8 the list's blank member is KEYED "" (label "(Blank)"):
    // either spelling names it, and it reaches the engine in the engine's
    // own spelling (`bi::member::engine_in_value`).
    let (blank, plain): (Vec<&(String, String)>, Vec<&(String, String)>) =
        filters.iter().partition(|(_, val)| pivot_engine::is_blank_member_key(val));
    let req = bi_engine::QueryRequest {
        measures: vec![measure.to_string()],
        group_by: vec![],
        filters: plain
            .iter()
            .map(|(col, val)| {
                bi_engine::FilterCondition::new(
                    col.clone(),
                    bi_engine::FilterOperator::Equal,
                    val.clone(),
                )
            })
            .collect(),
        scoped_in_filters: blank
            .iter()
            .map(|(col, val)| bi_engine::ScopedInFilter {
                table: None,
                filter: bi_engine::InFilter::new(col.clone(), [crate::bi::member::engine_in_value(val)]),
                level: bi_engine::LEVEL_SLICER,
            })
            .collect(),
        ..Default::default()
    };
    let result = run_query(bi, conn_id, req).await?;
    // A scalar query has one measure column; take the first non-null cell.
    let idx = result
        .columns
        .iter()
        .position(|c| c == measure)
        .unwrap_or(0);
    result
        .rows
        .first()
        .and_then(|r| r.get(idx))
        .and_then(|o| o.as_ref())
        .and_then(|s| s.parse::<f64>().ok())
        // Non-finite (NaN/Inf, e.g. a divide-by-zero measure) cannot cross the
        // JSON IPC boundary; surface it as no-data rather than corrupting the
        // whole CubePrefetch payload.
        .filter(|v| v.is_finite())
        .ok_or(CubeError::NotAvailable)
}

/// Distinct, non-empty values of a column (members of a level).
async fn distinct_members(
    ctx: &mut CubeCtx<'_>,
    conn_id: &ConnectionId,
    table: &str,
    column: &str,
) -> Result<Vec<String>, CubeError> {
    // The engine requires at least one measure even when only grouping.
    let first_measure = model_first_measure(ctx, conn_id).await;
    let req = bi_engine::QueryRequest {
        measures: first_measure.into_iter().collect(),
        group_by: vec![bi_engine::ColumnRef::new(table, column)],
        ..Default::default()
    };
    let result = run_query(ctx.bi, conn_id, req).await?;
    let mut values: Vec<String> = Vec::new();
    for row in &result.rows {
        if let Some(Some(v)) = row.first() {
            if !v.is_empty() {
                values.push(v.clone());
            }
        }
    }
    values.sort();
    values.dedup();
    Ok(values)
}

async fn model_first_measure(ctx: &mut CubeCtx<'_>, conn_id: &ConnectionId) -> Option<String> {
    ctx.meta(conn_id).await.and_then(|m| m.first_measure)
}

async fn fetch_model_meta(bi: &BiState, conn_id: &ConnectionId) -> Option<ModelMeta> {
    let arc = engine_arc_by_id(bi, conn_id)?;
    let engine = arc.lock().await;
    let model = engine.model();
    let measures: HashSet<String> = model.measures().iter().map(|m| m.name().to_string()).collect();
    let mut columns: HashSet<(String, String)> = HashSet::new();
    for t in model.tables() {
        for col in t.columns() {
            columns.insert((t.name().to_string(), col.name().to_string()));
        }
    }
    let first_measure = model.measures().first().map(|m| m.name().to_string());
    Some(ModelMeta { measures, columns, first_measure })
}

async fn fetch_kpi(bi: &BiState, conn_id: &ConnectionId, name: &str) -> Option<KpiData> {
    let arc = engine_arc_by_id(bi, conn_id)?;
    let engine = arc.lock().await;
    let kpi = engine.model().kpi(name)?;
    let bands = kpi
        .status_bands()
        .iter()
        .map(|b| (b.threshold, status_code(b.status)))
        .collect();
    Some(KpiData {
        base_measure: kpi.base_measure().to_string(),
        target: kpi.target().clone(),
        bands,
    })
}

// ===========================================================================
// Member-expression parsing
// ===========================================================================

#[derive(Debug, Clone, PartialEq)]
enum MemberExpr {
    Measure(String),
    Member { table: Option<String>, column: String, value: String },
    Level { table: String, column: String },
}

/// Parse one member expression (no top-level commas).
fn parse_member_expr(raw: &str) -> Result<MemberExpr, CubeError> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(CubeError::Value);
    }
    // Measure: the whole token is `[Name]` with no table prefix and no nesting.
    if s.starts_with('[') {
        if let Some(inner) = s.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
            if !inner.contains('[') && !inner.contains(']') {
                let name = inner.trim();
                if name.is_empty() {
                    return Err(CubeError::Value);
                }
                return Ok(MemberExpr::Measure(name.to_string()));
            }
        }
        return Err(CubeError::Value);
    }
    // Table[Column] optionally `= value`.
    let lb = s.find('[').ok_or(CubeError::Value)?;
    let rb = s.find(']').ok_or(CubeError::Value)?;
    if rb <= lb {
        return Err(CubeError::Value);
    }
    let table = s[..lb].trim().to_string();
    let column = s[lb + 1..rb].trim().to_string();
    if table.is_empty() || column.is_empty() {
        return Err(CubeError::Value);
    }
    let rest = s[rb + 1..].trim();
    if rest.is_empty() {
        Ok(MemberExpr::Level { table, column })
    } else if let Some(v) = rest.strip_prefix('=') {
        Ok(MemberExpr::Member {
            table: Some(table),
            column,
            value: unquote(v.trim()),
        })
    } else {
        Err(CubeError::Value)
    }
}

/// Parse a (possibly tuple) member argument into its components.
fn parse_members(raw: &str) -> Result<Vec<MemberExpr>, CubeError> {
    let parts = split_top_level_commas(raw);
    let mut out = Vec::new();
    for p in parts {
        let p = p.trim();
        if p.is_empty() {
            continue;
        }
        out.push(parse_member_expr(p)?);
    }
    if out.is_empty() {
        return Err(CubeError::Value);
    }
    Ok(out)
}

/// Strip the surrounding `[ ]` from a bracketed measure expression like
/// `[Revenue]`, yielding the bare measure name the engine expects.
fn measure_name(s: &str) -> String {
    let t = s.trim();
    match t.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
        Some(inner) => inner.trim().to_string(),
        None => t.to_string(),
    }
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    let bytes = v.as_bytes();
    if v.len() >= 2
        && ((bytes[0] == b'\'' && bytes[v.len() - 1] == b'\'')
            || (bytes[0] == b'"' && bytes[v.len() - 1] == b'"'))
    {
        v[1..v.len() - 1].to_string()
    } else {
        v.to_string()
    }
}

/// Split on commas that are not inside quotes, brackets, or braces. A quote
/// (`'` or `"`) only opens a quoted token at a token boundary (start, or right
/// after `= [ { ( ,`), so a stray apostrophe inside an unquoted value (e.g.
/// `Geo[Name]=O'Brien`) is treated as a literal and does not swallow commas.
fn split_top_level_commas(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut cur = String::new();
    let mut last_significant: Option<char> = None;
    for ch in s.chars() {
        if let Some(q) = quote {
            cur.push(ch);
            if ch == q {
                quote = None;
            }
            if !ch.is_whitespace() {
                last_significant = Some(ch);
            }
            continue;
        }
        match ch {
            '\'' | '"' if is_quote_boundary(last_significant) => {
                quote = Some(ch);
            }
            '[' | '{' | '(' => depth += 1,
            ']' | '}' | ')' => depth -= 1,
            ',' if depth == 0 => {
                out.push(std::mem::take(&mut cur));
                last_significant = None;
                continue;
            }
            _ => {}
        }
        cur.push(ch);
        if !ch.is_whitespace() {
            last_significant = Some(ch);
        }
    }
    if !cur.trim().is_empty() || !out.is_empty() {
        out.push(cur);
    }
    out
}

/// A quote char opens a quoted token only at a token boundary.
fn is_quote_boundary(prev: Option<char>) -> bool {
    match prev {
        None => true,
        Some(c) => matches!(c, '=' | '[' | '{' | '('),
    }
}

fn default_caption(members: &[MemberExpr]) -> String {
    let parts: Vec<String> = members
        .iter()
        .map(|m| match m {
            MemberExpr::Measure(name) => name.clone(),
            MemberExpr::Member { value, .. } => value.clone(),
            MemberExpr::Level { column, .. } => column.clone(),
        })
        .collect();
    parts.join(" ")
}

fn column_known(meta: &ModelMeta, table: Option<&str>, column: &str) -> bool {
    match table {
        Some(t) => meta.columns.contains(&(t.to_string(), column.to_string())),
        None => meta.columns.iter().any(|(_, c)| c == column),
    }
}

// ===========================================================================
// KPI helpers
// ===========================================================================

fn status_code(s: bi_engine::KpiStatus) -> i32 {
    match s {
        bi_engine::KpiStatus::OffTrack => -1,
        bi_engine::KpiStatus::AtRisk => 0,
        bi_engine::KpiStatus::OnTrack => 1,
    }
}

fn status_string(code: i32) -> &'static str {
    match code {
        1 => "On Track",
        0 => "At Risk",
        _ => "Off Track",
    }
}

/// Map a base/target ratio onto the KPI's status bands (-1/0/1).
fn compute_status(value: f64, goal: f64, bands: &[(f64, i32)]) -> i32 {
    let ratio = if goal != 0.0 {
        value / goal
    } else if value >= 0.0 {
        f64::INFINITY
    } else {
        f64::NEG_INFINITY
    };
    if bands.is_empty() {
        return if ratio >= 1.0 {
            1
        } else if ratio >= 0.9 {
            0
        } else {
            -1
        };
    }
    let mut sorted: Vec<&(f64, i32)> = bands.iter().collect();
    sorted.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut status = sorted.first().map(|b| b.1).unwrap_or(-1);
    for (thr, st) in &sorted {
        if ratio >= *thr {
            status = *st;
        }
    }
    status
}

fn format_scalar(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

// ===========================================================================
// Argument helpers (resolve via the shared engine resolver so keys match)
// ===========================================================================

fn arg_str(
    args: &[Expression],
    i: usize,
    resolver: &dyn CubeResolver,
) -> Result<String, CubeError> {
    let a = args.get(i).ok_or(CubeError::Value)?;
    resolve_cube_arg(a, resolver)
}

fn arg_str_opt(args: &[Expression], i: usize, resolver: &dyn CubeResolver) -> Option<String> {
    args.get(i).and_then(|a| resolve_cube_arg(a, resolver).ok())
}

fn arg_num(args: &[Expression], i: usize, resolver: &dyn CubeResolver) -> Result<f64, CubeError> {
    let s = arg_str(args, i, resolver)?;
    s.trim().parse::<f64>().map_err(|_| CubeError::Value)
}

fn arg_num_opt(args: &[Expression], i: usize, resolver: &dyn CubeResolver) -> Option<f64> {
    arg_str_opt(args, i, resolver).and_then(|s| s.trim().parse::<f64>().ok())
}

// ===========================================================================
// AST walking
// ===========================================================================

pub(crate) fn is_object_func(func: &BuiltinFunction) -> bool {
    // The engine's list, so the pre-pass and the evaluator's refusal of a cube
    // object on another sheet (`engine::cube::qualified_cell_arg`) agree.
    engine::cube::is_cube_object_function(func)
}

/// Collect every cube function call in an expression tree (with its arguments).
/// Recurses into ALL container variants — a missed cube call would be evaluated
/// by the engine but have no pre-fetched result (silent #N/A).
pub(crate) fn collect_cube_calls(expr: &Expression, out: &mut Vec<(BuiltinFunction, Vec<Expression>)>) {
    if let Expression::FunctionCall { func, args, .. } = expr {
        if cube_function_name(func).is_some() {
            out.push((func.clone(), args.clone()));
        }
    }
    for child in child_exprs(expr) {
        collect_cube_calls(child, out);
    }
}

/// Collect the 0-based coordinates of all direct cell references in `args`
/// that point at the sheet named `own_upper` (unqualified, or qualified with
/// that sheet's own name): a reference to another sheet never names one of
/// this sheet's object cells.
fn collect_cell_refs(args: &[Expression], own_upper: &str, out: &mut Vec<(u32, u32)>) {
    for a in args {
        collect_cell_refs_expr(a, own_upper, out);
    }
}

fn collect_cell_refs_expr(expr: &Expression, own_upper: &str, out: &mut Vec<(u32, u32)>) {
    if let Expression::CellRef { sheet, col, row, .. } = expr {
        if sheet.as_ref().is_none_or(|s| identity::sheet_name_key(s) == own_upper) {
            out.push((row.saturating_sub(1), col_to_index(col) as u32));
        }
    }
    for child in child_exprs(expr) {
        collect_cell_refs_expr(child, own_upper, out);
    }
}

/// All directly-nested child expressions of `expr`, for generic tree walks.
fn child_exprs(expr: &Expression) -> Vec<&Expression> {
    match expr {
        Expression::FunctionCall { args, .. } => args.iter().collect(),
        Expression::BinaryOp { left, right, .. } => vec![left, right],
        Expression::UnaryOp { operand, .. } => vec![operand],
        Expression::Range { start, end, .. } => vec![start, end],
        Expression::Sheet3DRef { reference, .. } => vec![reference],
        Expression::IndexAccess { target, index } => vec![target, index],
        Expression::ArrayLiteral { rows } => rows.iter().flatten().collect(),
        Expression::ListLiteral { elements } => elements.iter().collect(),
        Expression::DictLiteral { entries } => {
            entries.iter().flat_map(|(k, v)| [k, v]).collect()
        }
        Expression::SpillRef { cell, .. } => vec![cell],
        Expression::ImplicitIntersection { operand } => vec![operand],
        _ => Vec::new(),
    }
}

/// True when every cube cell referenced by `args` already has an outcome.
fn object_deps_ready(
    args: &[Expression],
    own_upper: &str,
    object_coords: &HashSet<(u32, u32)>,
    outcomes: &HashMap<(u32, u32), Result<CubeBinding, CubeError>>,
) -> bool {
    let mut refs = Vec::new();
    collect_cell_refs(args, own_upper, &mut refs);
    refs.iter()
        .all(|coord| !object_coords.contains(coord) || outcomes.contains_key(coord))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_measure() {
        assert_eq!(parse_member_expr("[Revenue]").unwrap(), MemberExpr::Measure("Revenue".into()));
        assert_eq!(
            parse_member_expr("[Total Revenue]").unwrap(),
            MemberExpr::Measure("Total Revenue".into())
        );
    }

    #[test]
    fn parses_member_with_value() {
        assert_eq!(
            parse_member_expr("Geo[Country]=Sweden").unwrap(),
            MemberExpr::Member {
                table: Some("Geo".into()),
                column: "Country".into(),
                value: "Sweden".into()
            }
        );
    }

    #[test]
    fn parses_quoted_value() {
        assert_eq!(
            parse_member_expr("Geo[City]='New York'").unwrap(),
            MemberExpr::Member {
                table: Some("Geo".into()),
                column: "City".into(),
                value: "New York".into()
            }
        );
    }

    #[test]
    fn parses_level() {
        assert_eq!(
            parse_member_expr("Geo[Country]").unwrap(),
            MemberExpr::Level { table: "Geo".into(), column: "Country".into() }
        );
    }

    #[test]
    fn rejects_malformed() {
        assert!(parse_member_expr("").is_err());
        assert!(parse_member_expr("Geo[]=x").is_err());
        assert!(parse_member_expr("[Bad[Nested]]").is_err());
        assert!(parse_member_expr("NoBracket").is_err());
    }

    #[test]
    fn parses_tuple() {
        let members = parse_members("Geo[Country]=Sweden, Date[Year]=2025").unwrap();
        assert_eq!(members.len(), 2);
    }

    #[test]
    fn splits_top_level_commas_respecting_quotes_and_braces() {
        let parts = split_top_level_commas("a, b['x, y'], {c, d}");
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].trim(), "a");
        assert_eq!(parts[1].trim(), "b['x, y']");
        assert_eq!(parts[2].trim(), "{c, d}");
    }

    #[test]
    fn split_treats_stray_apostrophe_as_literal() {
        // An apostrophe inside an unquoted value must NOT open a quote and swallow
        // the following comma (a quote only opens at a token boundary).
        let parts = split_top_level_commas("Geo[Name]=O'Brien, Date[Year]=2025");
        assert_eq!(parts.len(), 2, "got {:?}", parts);
        assert_eq!(parts[0].trim(), "Geo[Name]=O'Brien");
        assert_eq!(parts[1].trim(), "Date[Year]=2025");
        // A boundary quote still groups commas inside it.
        let quoted = split_top_level_commas("Geo[City]='New, York', X[Y]=1");
        assert_eq!(quoted.len(), 2, "got {:?}", quoted);
        assert_eq!(quoted[0].trim(), "Geo[City]='New, York'");
    }

    #[test]
    fn collect_cube_calls_recurses_containers() {
        // A cube call nested inside a list literal must still be discovered.
        let ast = parser::parse(r#"={CUBEVALUE("S","[R]"), 2}"#).unwrap();
        let mut calls = Vec::new();
        collect_cube_calls(&ast, &mut calls);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, BuiltinFunction::CubeValue);
    }

    #[test]
    fn status_bands_map_ratio() {
        let bands = vec![(0.0, -1), (0.9, 0), (1.0, 1)];
        assert_eq!(compute_status(100.0, 100.0, &bands), 1);
        assert_eq!(compute_status(95.0, 100.0, &bands), 0);
        assert_eq!(compute_status(50.0, 100.0, &bands), -1);
    }

    #[test]
    fn default_caption_uses_values() {
        let members = parse_members("Geo[Country]=Sweden").unwrap();
        assert_eq!(default_caption(&members), "Sweden");
    }

    #[test]
    fn security_refusals_are_matched_by_type_never_by_message() {
        use bi_engine::{EngineError, QueryError};
        assert!(is_security_refusal(&QueryError::Engine(
            EngineError::ObjectLevelSecurityDenied {
                object: "Sales[amount]".into()
            }
        )));
        assert!(is_security_refusal(&QueryError::Engine(
            EngineError::RowLevelSecurityNotEnforceable {
                table: "Geography".into(),
                reason: "not single-hop".into()
            }
        )));
        assert!(is_security_refusal(&QueryError::Engine(
            EngineError::SecurityRoleNotFound("Gone".into())
        )));

        // An ordinary failure is not a refusal.
        assert!(!is_security_refusal(&QueryError::InvalidQuery(
            "no such measure".into()
        )));
        // And neither is one whose TEXT happens to contain the phrase — the
        // exact trap `friendly_bi_query_error`'s two row-level-security
        // branches fell into, where they matched Rust variant names against
        // Display output and were dead for their whole life.
        assert!(!is_security_refusal(&QueryError::InvalidQuery(
            "object-level security".into()
        )));
    }
}

#[cfg(test)]
mod integration_tests {
    //! End-to-end resolution against an in-memory BI model (no database):
    //! query building, scalar reading, member enumeration, and KPI computation.
    use super::*;
    use crate::bi::types::{Connection, ConnectionType};
    use arrow::array::{Float64Array, StringArray};
    use arrow::datatypes::{DataType as ArrowType, Field, Schema};
    use arrow::record_batch::RecordBatch;
    use bi_engine::{
        sum_measure, Column, DataModel, DataType, Engine, InMemoryConnector, Kpi, KpiStatus,
        KpiTarget, QueryRequest, SourceBinding, StatusBand, StorageMode, Table,
    };
    use identity::EntityId;
    use std::collections::HashMap;

    struct NoResolver;
    impl CubeResolver for NoResolver {
        fn binding_at(&self, _r: u32, _c: u32) -> Option<&CubeBinding> {
            None
        }
        fn cell_text(&self, _r: u32, _c: u32) -> Option<String> {
            None
        }
    }

    fn sales_batch() -> RecordBatch {
        RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("country", ArrowType::Utf8, true),
                Field::new("amount", ArrowType::Float64, true),
            ])),
            vec![
                Arc::new(StringArray::from(vec!["USA", "UK", "USA"])),
                Arc::new(Float64Array::from(vec![100.0, 50.0, 75.0])),
            ],
        )
        .unwrap()
    }

    fn build_model() -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("country", DataType::String),
                        Column::new("amount", DataType::Float64),
                    ],
                )
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
            )
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .add_kpi(
                Kpi::new("Revenue KPI", "Revenue", KpiTarget::Constant(200.0))
                    .with_status_band(StatusBand::new(0.0, KpiStatus::OffTrack))
                    .with_status_band(StatusBand::new(0.9, KpiStatus::AtRisk))
                    .with_status_band(StatusBand::new(1.0, KpiStatus::OnTrack)),
            )
            .build()
            .unwrap()
    }

    /// The fixture model plus an `Analyst` role that denies the column the
    /// only measure reads, so any query for `Revenue` is refused by
    /// object-level security.
    fn build_model_with_denied_column() -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("country", DataType::String),
                        Column::new("amount", DataType::Float64),
                    ],
                )
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
            )
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .add_security_role(
                bi_engine::SecurityRole::new("Analyst")
                    .with_denied_columns(vec!["Sales[amount]".to_string()]),
            )
            .build()
            .unwrap()
    }

    async fn make_state() -> (BiState, ConnectionId) {
        state_from(build_model(), None, [7u8; 16]).await
    }

    /// The same shape with the denying role ACTIVE on the connection, which is
    /// what `apply_connection_role` installs on the engine before every query.
    async fn make_state_denied() -> (BiState, ConnectionId) {
        state_from(
            build_model_with_denied_column(),
            Some("Analyst".to_string()),
            [9u8; 16],
        )
        .await
    }

    async fn state_from(
        model: DataModel,
        active_role: Option<String>,
        id_bytes: [u8; 16],
    ) -> (BiState, ConnectionId) {
        state_from_batch(model, active_role, id_bytes, sales_batch()).await
    }

    /// [`state_from`] over other sales rows: the same model, connection name
    /// and id, as after a data refresh of the source.
    async fn state_from_batch(
        model: DataModel,
        active_role: Option<String>,
        id_bytes: [u8; 16],
        batch: RecordBatch,
    ) -> (BiState, ConnectionId) {
        let mut engine = Engine::new(model);
        let connector = InMemoryConnector::new().with_table("public", "sales", batch);
        let idx = engine.add_in_memory_source(connector);
        engine.bind_table("Sales", idx, SourceBinding::new("public", "sales"));
        // Warm the in-memory cache so ensure_ready's cache-warm check passes and
        // skips the DB auto-connect (there is no real database here).
        let _ = engine
            .query_auto_refresh(QueryRequest {
                measures: vec!["Revenue".into()],
                group_by: vec![bi_engine::ColumnRef::new("Sales", "country")],
                ..Default::default()
            })
            .await;

        let id = EntityId::from_bytes(id_bytes);
        let conn = Connection {
            id,
            name: "Sales".into(),
            description: String::new(),
            connection_type: ConnectionType::PostgreSQL,
            connection_string: String::new(),
            server: String::new(),
            database: String::new(),
            preferred_auth: "Integrated".into(),
            model_path: None,
            engine: Some(Arc::new(TokioMutex::new(engine))),
            model_key: None,
            connector_index: Some(idx),
            bindings: vec![],
            last_refreshed: None,
            created_at: String::new(),
            is_connected: true,
            active_queries: HashMap::new(),
            package_data_source_id: None,
            active_role,
            base_model: None,
            calculated_measures: vec![],
        };
        let bi = BiState::new();
        bi.connections.lock().unwrap().insert(id, conn);
        (bi, id)
    }

    #[tokio::test]
    async fn a_security_refusal_is_never_reported_as_no_value() {
        // A CUBE cell reads #N/A either way — Excel's semantics, and a cell has
        // nowhere to put a message. But every caller that CAN carry one must be
        // able to tell a refusal from an empty result: `script_cube_value` folds
        // only "no data" into `Ok(None)`, so a refusal that arrived as
        // `NotAvailable` would reach the MCP and AI-chat tools as the string
        // "(no value)" and the capability audit trail as a SUCCESSFUL call.
        use engine::CellError;
        let (bi, id) = make_state_denied().await;

        assert_eq!(
            query_scalar(&bi, &id, "Revenue", &[]).await.unwrap_err(),
            CubeError::Refused
        );
        assert_eq!(
            script_cube_value(&bi, "Sales", &["[Revenue]".to_string()])
                .await
                .unwrap_err(),
            CubeError::Refused,
            "a refusal must not fold into Ok(None)"
        );
        assert_ne!(
            cube_err_message(CubeError::Refused),
            cube_err_message(CubeError::NotAvailable),
            "the two must not read the same to a script or an AI client"
        );
        // The cell is unchanged: #N/A, as before.
        assert_eq!(CubeError::Refused.to_cell_error(), CellError::NA);

        // Positive control: the same measure, no role active, answers.
        let (bi, id) = make_state().await;
        assert_eq!(query_scalar(&bi, &id, "Revenue", &[]).await.unwrap(), 225.0);
    }

    fn parse_args(formula: &str) -> Vec<Expression> {
        match parser::parse(formula).unwrap() {
            Expression::FunctionCall { args, .. } => args,
            _ => panic!("expected a function call"),
        }
    }

    #[tokio::test]
    async fn query_scalar_total_and_filtered() {
        let (bi, id) = make_state().await;
        let total = query_scalar(&bi, &id, "Revenue", &[]).await.unwrap();
        assert_eq!(total, 225.0);
        let usa = query_scalar(&bi, &id, "Revenue", &[("country".into(), "USA".into())])
            .await
            .unwrap();
        assert_eq!(usa, 175.0);
    }

    #[tokio::test]
    async fn distinct_members_lists_countries() {
        let (bi, id) = make_state().await;
        let mut ctx = CubeCtx::new(&bi);
        let members = distinct_members(&mut ctx, &id, "Sales", "country").await.unwrap();
        assert_eq!(members, vec!["UK".to_string(), "USA".to_string()]);
    }

    #[tokio::test]
    async fn cubevalue_resolves_measure_with_member_filter() {
        let (bi, _id) = make_state().await;
        let mut ctx = CubeCtx::new(&bi);
        let args = parse_args(r#"=CUBEVALUE("Sales","[Revenue]","Sales[country]=USA")"#);
        let result = resolve_cube_value(&mut ctx, &args, &NoResolver).await.unwrap();
        assert_eq!(result, CubeCallResult::Number(175.0));
    }

    #[tokio::test]
    async fn cubevalue_unknown_connection_is_name_error() {
        let (bi, id) = make_state().await;
        let _ = id;
        let mut ctx = CubeCtx::new(&bi);
        let args = parse_args(r#"=CUBEVALUE("Nope","[Revenue]")"#);
        let err = resolve_cube_value(&mut ctx, &args, &NoResolver).await.unwrap_err();
        assert_eq!(err, CubeError::Name);
    }

    #[tokio::test]
    async fn cubeset_enumerates_and_orders_members() {
        let (bi, id) = make_state().await;
        let _ = id;
        let mut ctx = CubeCtx::new(&bi);
        // Unordered level set -> both countries (sorted alphabetically by distinct).
        let set = parse_args(r#"=CUBESET("Sales","Sales[country]")"#);
        let binding = resolve_cube_set(&mut ctx, &set, &NoResolver).await.unwrap();
        assert_eq!(binding.kind, CubeBindingKind::Set);
        assert_eq!(binding.members.len(), 2);
        assert!(binding.members.iter().any(|m| m.contains("USA")));

        // Ordered by Revenue descending -> USA (175) before UK (50).
        let ordered = parse_args(r#"=CUBESET("Sales","Sales[country]","Top",2,"[Revenue]")"#);
        let ob = resolve_cube_set(&mut ctx, &ordered, &NoResolver).await.unwrap();
        assert_eq!(ob.members.len(), 2);
        assert!(ob.members[0].contains("USA"), "USA should rank first, got {:?}", ob.members);
    }

    #[tokio::test]
    async fn cubekpimember_value_and_status() {
        let (bi, id) = make_state().await;
        let _ = id;
        let mut ctx = CubeCtx::new(&bi);
        // Property 1 = Value -> 225.
        let value = resolve_cube_kpi_member(
            &mut ctx,
            &parse_args(r#"=CUBEKPIMEMBER("Sales","Revenue KPI",1)"#),
            &NoResolver,
        )
        .await
        .unwrap();
        assert_eq!(value.scalar, Some(225.0));

        // Property 3 = Status -> 225/200 = 1.125 -> On Track (1).
        let status = resolve_cube_kpi_member(
            &mut ctx,
            &parse_args(r#"=CUBEKPIMEMBER("Sales","Revenue KPI",3)"#),
            &NoResolver,
        )
        .await
        .unwrap();
        assert_eq!(status.scalar, Some(1.0));
        assert_eq!(status.caption, "On Track");
    }

    // ---- Script-facing API (Layer 1) ----

    #[tokio::test]
    async fn script_value_by_name_and_id() {
        let (bi, id) = make_state().await;
        // By connection NAME.
        let v = script_cube_value(&bi, "Sales", &["[Revenue]".into()]).await.unwrap();
        assert_eq!(v, Some(225.0));
        // By connection ID string (scripts use ids).
        let v2 = script_cube_value(&bi, &id.to_string(), &["[Revenue]".into()]).await.unwrap();
        assert_eq!(v2, Some(225.0));
    }

    #[tokio::test]
    async fn script_value_with_member_filter() {
        let (bi, _id) = make_state().await;
        let v = script_cube_value(
            &bi,
            "Sales",
            &["[Revenue]".into(), "Sales[country]=USA".into()],
        )
        .await
        .unwrap();
        assert_eq!(v, Some(175.0));
    }

    #[tokio::test]
    async fn script_value_unknown_connection_errors() {
        let (bi, _id) = make_state().await;
        let err = script_cube_value(&bi, "Nope", &["[Revenue]".into()]).await.unwrap_err();
        assert_eq!(err, CubeError::Name);
    }

    #[tokio::test]
    async fn script_kpi_value_and_status() {
        let (bi, _id) = make_state().await;
        assert_eq!(script_cube_kpi(&bi, "Sales", "Revenue KPI", 1).await.unwrap(), Some(225.0));
        // 225/200 = 1.125 -> On Track (1).
        assert_eq!(script_cube_kpi(&bi, "Sales", "Revenue KPI", 3).await.unwrap(), Some(1.0));
    }

    #[tokio::test]
    async fn script_members_lists_distinct() {
        let (bi, _id) = make_state().await;
        let members = script_cube_members(&bi, "Sales", "Sales[country]").await.unwrap();
        assert_eq!(members, vec!["UK".to_string(), "USA".to_string()]);
    }

    // ---- BUG-0476: the BATCH and BACKGROUND write doors ----
    //
    // A CUBE formula written through `update_cells_batch` (@api
    // CellRange.setValue / setValues, a script, a paste) or
    // `update_cell_on_sheets` (the same on a sheet that is not active) showed
    // #N/A: neither command took cube data, and nothing pre-fetched for them.
    // Each now takes the TARGETED pre-fetch `cube_prefetch` builds for exactly
    // the writes in hand (its `edits` shape), as `update_cell` takes the
    // single edit's -- no full recalculation, so manual calculation keeps what
    // the user left stale. These run the real pre-fetch against the in-memory
    // model (Revenue = 225) and the real write bodies, with no Tauri runtime.

    /// A workbook the write bodies can run against: `sheets` grid sheets,
    /// sheet 0 active, the en-US locale, automatic calculation.
    struct Host {
        state: AppState,
        file: crate::persistence::FileState,
        files: crate::persistence::UserFilesState,
        pivots: crate::pivot::PivotState,
        pane: crate::pane_control::PaneControlState,
        filters: crate::ribbon_filter::RibbonFilterState,
        slicer: crate::slicer::SlicerState,
    }

    impl Host {
        fn new(sheets: usize) -> Self {
            let state = crate::create_app_state();
            let seed = crate::document_effect::test_seed_effect;
            for i in 1..sheets {
                state.grids.write(&seed()).unwrap().push(engine::Grid::new());
                state.sheet_names.write(&seed()).unwrap().push(format!("Sheet{}", i + 1));
                state.all_column_widths.write(&seed()).unwrap().push(Default::default());
                state.all_row_heights.write(&seed()).unwrap().push(Default::default());
                state.all_user_hidden_rows.write(&seed()).unwrap().push(Default::default());
                state.all_user_hidden_cols.write(&seed()).unwrap().push(Default::default());
                state
                    .sheet_ids
                    .write(&seed())
                    .unwrap()
                    .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
            }
            {
                let mut all = state.all_merged_regions.write(&seed()).unwrap();
                while all.len() < sheets {
                    all.push(Default::default());
                }
            }
            *state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("en-US");
            Host {
                state,
                file: crate::persistence::FileState::default(),
                files: crate::persistence::UserFilesState::default(),
                pivots: crate::pivot::PivotState::new(),
                pane: crate::pane_control::PaneControlState::new(),
                filters: crate::ribbon_filter::RibbonFilterState::new(),
                slicer: crate::slicer::SlicerState::new(),
            }
        }

        /// The batch door's body, as `update_cells_batch` runs it.
        fn batch(&self, updates: Vec<crate::api_types::CellUpdateInput>, cube: Option<CubePrefetch>) -> Vec<crate::api_types::CellData> {
            crate::commands::data::update_cells_batch_core(
                &self.state, &self.file, &self.files, &self.pivots, updates, None, None, None, cube,
            )
            .expect("the batch writes")
        }

        fn value(&self, sheet: usize, row: u32, col: u32) -> CellValue {
            self.state.grids.read().unwrap()[sheet]
                .get_cell(row, col)
                .map(|c| c.value.clone())
                .unwrap_or(CellValue::Empty)
        }

        /// A literal straight into a NON-active sheet's grid.
        fn seed_off_sheet(&self, sheet: usize, row: u32, col: u32, value: CellValue) {
            let seed = crate::document_effect::test_seed_effect();
            self.state.grids.write(&seed).unwrap()[sheet].set_cell(
                row,
                col,
                engine::Cell { value, ast: None, style_index: 0, rich_text: None },
            );
        }
    }

    /// A script-style write: canonical (invariant) syntax.
    fn write(row: u32, col: u32, value: &str) -> crate::api_types::CellUpdateInput {
        crate::api_types::CellUpdateInput {
            row,
            col,
            value: value.to_string(),
            style_index: None,
            invariant: Some(true),
            pasted: None,
            moved: None,
        }
    }

    const REVENUE: &str = r#"=CUBEVALUE("Sales","[Revenue]")"#;

    /// The async half (the model, the pre-fetch) runs on this; the write
    /// bodies are synchronous and run outside it, as on a Tauri worker.
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    /// The pre-fetch for `edits`, built the way the async command builds it.
    fn prefetch_for(
        rt: &tokio::runtime::Runtime,
        host: &Host,
        bi: &BiState,
        edits: &[crate::api_types::CellUpdateInput],
        sheet_index: Option<usize>,
    ) -> CubePrefetch {
        rt.block_on(build_cube_prefetch(
            &host.state,
            bi,
            Some(CubePrefetchEdits { edits, sheet_index, door: CubeWriteDoor::Batch, udf_volatile_cells: None }),
        ))
    }

    /// THE LEDGER'S REPRO, at the batch door. `CellRange.fromCell(6,3).setValue(
    /// '=CUBEVALUE(...)')` reaches `update_cells_batch` with one write; with the
    /// batch's own pre-fetch the cell shows the model's value, and every answer
    /// the batch returns for it does (the written cell is evaluated once on
    /// write and again in the dependent cascade -- both must be served, or the
    /// caller paints the second one's #N/A).
    #[test]
    fn a_cube_formula_written_through_the_batch_is_served_by_its_targeted_prefetch() {
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(1);
        let updates = vec![write(0, 0, "plain"), write(6, 3, REVENUE)];

        let prefetch = prefetch_for(&rt, &host, &bi, &updates, None);
        let cells = host.batch(updates, Some(prefetch));

        assert_eq!(
            host.value(0, 6, 3),
            CellValue::Number(225.0),
            "a CUBE formula written through the batch door is not served its model value"
        );
        let answers: Vec<&str> =
            cells.iter().filter(|c| c.row == 6 && c.col == 3).map(|c| c.display.as_str()).collect();
        assert!(!answers.is_empty(), "the batch reports the cell it wrote");
        assert!(
            answers.iter().all(|d| *d == "225"),
            "the batch answered #N/A for the cube cell it wrote: {:?}",
            answers
        );
        assert_eq!(host.value(0, 0, 0), CellValue::Text("plain".to_string()));
    }

    /// A CUBE formula whose argument names a cell THE SAME BATCH writes
    /// (`A2 = [Revenue]`, `B2 = CUBEVALUE("Sales", A2)`) -- a script filling a
    /// small report. The pre-fetch must read the pending literal, not the
    /// empty cell it replaces, or the two sides key the call differently and
    /// the cell is #N/A.
    #[test]
    fn a_cube_argument_naming_a_cell_the_same_batch_writes_reads_the_written_text() {
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(1);
        let updates = vec![write(1, 0, "[Revenue]"), write(1, 1, r#"=CUBEVALUE("Sales",A2)"#)];

        let prefetch = prefetch_for(&rt, &host, &bi, &updates, None);
        host.batch(updates, Some(prefetch));

        assert_eq!(
            host.value(0, 1, 1),
            CellValue::Number(225.0),
            "the pre-fetch keyed the call on the cell's OLD (empty) text, not the batch's literal"
        );
    }

    /// MANUAL CALCULATION. The written CUBE formula is served (Excel calculates
    /// the cell you enter even in manual mode), and NOTHING else is
    /// recalculated: B1 = A1*2 was left stale by the user, and a cube write
    /// must not calculate it behind their back -- which is what the full
    /// workbook recalculation this replaced did.
    #[test]
    fn under_manual_calculation_the_written_cube_cell_is_served_and_stale_cells_stay_stale() {
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(1);
        host.batch(vec![write(0, 0, "5"), write(0, 1, "=A1*2")], None);
        assert_eq!(host.value(0, 0, 1), CellValue::Number(10.0), "precondition: automatic calculation");

        *host.state.calculation_mode.lock().unwrap() = "manual".to_string();
        host.batch(vec![write(0, 0, "7")], None);
        assert_eq!(host.value(0, 0, 1), CellValue::Number(10.0), "precondition: B1 is stale under manual");

        let updates = vec![write(6, 3, REVENUE)];
        let prefetch = prefetch_for(&rt, &host, &bi, &updates, None);
        host.batch(updates, Some(prefetch));

        assert_eq!(
            host.value(0, 6, 3),
            CellValue::Number(225.0),
            "under manual calculation the written CUBE formula is not served"
        );
        assert_eq!(
            host.value(0, 0, 1),
            CellValue::Number(10.0),
            "a cube write recalculated a cell the user left stale under manual calculation"
        );
    }

    /// THE BACKGROUND DOOR. `CellRange.setValue` on a sheet that is not active
    /// goes through `update_cell_on_sheets`; Sheet2's own A1 holds the measure
    /// name its formula reads, so the pre-fetch must be built from SHEET2's
    /// cells (`sheet_index`), and the command must serve it to Sheet2's
    /// evaluation. The off-sheet recalculation that follows keeps the value.
    #[test]
    fn a_cube_formula_written_to_a_background_sheet_is_served_from_that_sheets_cells() {
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(2);
        host.seed_off_sheet(1, 0, 0, CellValue::Text("[Revenue]".to_string()));
        let formula = r#"=CUBEVALUE("Sales",A1)"#;

        let prefetch = prefetch_for(&rt, &host, &bi, &[write(6, 3, formula)], Some(1));
        let wrote = crate::commands::data::update_cell_on_sheets_inner(
            &host.state,
            &host.file,
            &host.files,
            &host.pivots,
            &host.pane,
            &host.filters,
            vec![1],
            6,
            3,
            formula.to_string(),
            Some(true),
            None,
            Some(vec![prefetch]),
        )
        .expect("the background write");

        assert_eq!(wrote, vec![1]);
        assert_eq!(
            host.value(1, 6, 3),
            CellValue::Number(225.0),
            "a CUBE formula written to a background sheet is not served (or was served from the ACTIVE sheet's cells)"
        );
        assert_eq!(host.value(0, 6, 3), CellValue::Empty, "the active sheet is not written");
    }

    // ---- BUG-0476 follow-up: the pre-fetch covers exactly what the write evaluates ----
    //
    // The cascade of a write evaluates its cells WITH the write's cube data in
    // hand. The pre-fetch used to compute its own, smaller set (each edit's
    // dependents), so a cube cell the cascade reached another way -- the
    // volatile splice, a whole-column reader, a volatile custom-function cell
    // -- answered #N/A. Each test below stamps the cube cell with a MARKER value
    // first and empties the sheet's results cache (`Host::stamp`): the write
    // must REFRESH it from the model (Revenue 225, USA 175). A cell the
    // pre-fetch does not cover is answered from that empty cache -- #N/A -- so
    // only a real serve shows the model's number.

    const MARKER: f64 = -1.0;

    impl Host {
        /// The batch body with the volatile custom-function cells the
        /// frontend's UDF pass found.
        fn batch_with_volatile(
            &self,
            updates: Vec<crate::api_types::CellUpdateInput>,
            volatile: Vec<crate::scripting::udf::UdfCellRef>,
            cube: Option<CubePrefetch>,
        ) -> Vec<crate::api_types::CellData> {
            crate::commands::data::update_cells_batch_core(
                &self.state, &self.file, &self.files, &self.pivots, updates, None, Some(volatile), None, cube,
            )
            .expect("the batch writes")
        }

        /// The grid editor's door, `update_cell_impl`, with its pre-fetch.
        fn type_value(&self, row: u32, col: u32, value: &str, cube: Option<CubePrefetch>) {
            crate::commands::data::update_cell_impl(
                &self.state,
                &self.file,
                &self.files,
                &self.slicer,
                &self.pivots,
                &self.pane,
                &self.filters,
                row,
                col,
                value.to_string(),
                None,
                None,
                cube,
            )
            .expect("the edit writes");
        }

        /// Overwrite an active-sheet cell's last computed VALUE (both mirrors),
        /// keeping its formula -- and FORGET what the sheet's results cache
        /// recorded (round 6): a cube call the pre-fetch did not cover is
        /// answered from that cache, which still holds the model's number from
        /// the setup, so without this an uncovered cell would show the model's
        /// number too and the marker could no longer tell "served" from
        /// "answered from the cache". With it, an uncovered cell is #N/A.
        fn stamp(&self, row: u32, col: u32, value: CellValue) {
            let seed = crate::document_effect::test_seed_effect();
            {
                let mut grid = self.state.grid.write(&seed).unwrap();
                grid.cells.get_mut(&(row, col)).expect("a cell to stamp").value = value.clone();
            }
            let mut grids = self.state.grids.write(&seed).unwrap();
            grids[0].cells.get_mut(&(row, col)).expect("a cell to stamp").value = value;
            grids[0].call_memo().clear();
        }
    }

    /// The single edit's pre-fetch, as `cube_prefetch` builds it for
    /// `{ row, col, value }`.
    fn prefetch_for_edit(rt: &tokio::runtime::Runtime, host: &Host, bi: &BiState, row: u32, col: u32, value: &str) -> CubePrefetch {
        let edits = [crate::api_types::CellUpdateInput {
            row,
            col,
            value: value.to_string(),
            style_index: None,
            invariant: None,
            pasted: None,
            moved: None,
        }];
        rt.block_on(build_cube_prefetch(
            &host.state,
            bi,
            Some(CubePrefetchEdits { edits: &edits, sheet_index: None, door: CubeWriteDoor::Edit, udf_volatile_cells: None }),
        ))
    }

    /// A1 builds its member name from TODAY() -- a VOLATILE cell, refreshed by
    /// every edit -- and B1 = CUBEVALUE(..., A1) reads it ("Sales[country]=USA"
    /// for the rest of this century, so USA's 175). Each written through the
    /// batch with its own pre-fetch; then B1 is stamped with the marker.
    fn today_driven_cube_cell(rt: &tokio::runtime::Runtime, bi: &BiState) -> Host {
        let host = Host::new(1);
        host.batch(vec![write(0, 0, r#"="Sales[country]="&IF(YEAR(TODAY())>2000,"USA","UK")"#)], None);
        let b1 = vec![write(0, 1, r#"=CUBEVALUE("Sales","[Revenue]",A1)"#)];
        let prefetch = prefetch_for(rt, &host, bi, &b1, None);
        host.batch(b1, Some(prefetch));
        assert_eq!(host.value(0, 0, 1), CellValue::Number(175.0), "precondition: B1 serves USA's revenue");
        host.stamp(0, 1, CellValue::Number(MARKER));
        host
    }

    #[test]
    fn a_cube_cell_fed_by_a_volatile_cell_is_served_when_a_batch_writes_elsewhere() {
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = today_driven_cube_cell(&rt, &bi);

        // A script writes an unrelated CUBE formula (the batch carries cube
        // data); the volatile splice re-evaluates A1 and B1 with it.
        let updates = vec![write(9, 3, REVENUE)];
        let prefetch = prefetch_for(&rt, &host, &bi, &updates, None);
        host.batch(updates, Some(prefetch));

        assert_eq!(host.value(0, 9, 3), CellValue::Number(225.0));
        assert_eq!(
            host.value(0, 0, 1),
            CellValue::Number(175.0),
            "the cascade re-evaluated B1 (downstream of a TODAY() cell) with cube data the pre-fetch never resolved for it"
        );
    }

    #[test]
    fn a_cube_cell_fed_by_a_volatile_cell_is_served_when_the_user_types_elsewhere() {
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = today_driven_cube_cell(&rt, &bi);

        // Once the session has a cube formula, every typed edit pre-fetches.
        let prefetch = prefetch_for_edit(&rt, &host, &bi, 9, 3, "5");
        host.type_value(9, 3, "5", Some(prefetch));

        assert_eq!(
            host.value(0, 0, 1),
            CellValue::Number(175.0),
            "update_cell's volatile splice re-evaluated B1 with cube data the pre-fetch never resolved for it"
        );
    }

    /// A1 holds a value, C1 = IF(COUNTA(A:A)>0, CUBEVALUE(...), "") -- a
    /// WHOLE-COLUMN reader of A, which lives in the stripe maps rather than
    /// the dependents map. Stamped with the marker.
    fn column_reading_cube_cell(rt: &tokio::runtime::Runtime, bi: &BiState) -> Host {
        let host = Host::new(1);
        host.batch(vec![write(0, 0, "seed")], None);
        let c1 = vec![write(0, 2, r#"=IF(COUNTA(A:A)>0,CUBEVALUE("Sales","[Revenue]"),"")"#)];
        let prefetch = prefetch_for(rt, &host, bi, &c1, None);
        host.batch(c1, Some(prefetch));
        assert_eq!(host.value(0, 0, 2), CellValue::Number(225.0), "precondition: C1 serves the revenue");
        host.stamp(0, 2, CellValue::Number(MARKER));
        host
    }

    #[test]
    fn a_whole_column_reader_wrapping_a_cube_is_served_by_a_paste_into_the_column() {
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = column_reading_cube_cell(&rt, &bi);

        let updates = vec![write(4, 0, "more")];
        let prefetch = prefetch_for(&rt, &host, &bi, &updates, None);
        host.batch(updates, Some(prefetch));

        assert_eq!(
            host.value(0, 0, 2),
            CellValue::Number(225.0),
            "the batch re-evaluated a COUNTA(A:A) reader with cube data the pre-fetch never resolved for it"
        );
    }

    #[test]
    fn a_whole_column_reader_wrapping_a_cube_is_served_by_a_typed_edit_in_the_column() {
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = column_reading_cube_cell(&rt, &bi);

        let prefetch = prefetch_for_edit(&rt, &host, &bi, 4, 0, "more");
        host.type_value(4, 0, "more", Some(prefetch));

        assert_eq!(
            host.value(0, 0, 2),
            CellValue::Number(225.0),
            "update_cell re-evaluated a COUNTA(A:A) reader with cube data the pre-fetch never resolved for it"
        );
    }

    #[test]
    fn a_volatile_custom_function_cell_is_covered_by_the_prefetch_it_rides_with() {
        // The frontend's UDF pass lists C3 as a VOLATILE custom-function cell;
        // the batch re-evaluates it on every write, so the same list must reach
        // the pre-fetch. (C3's own formula is a plain CUBEVALUE: what makes it a
        // cascade member is the list, which is all the backend reads.)
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(1);
        let c3 = vec![write(2, 2, REVENUE)];
        let prefetch = prefetch_for(&rt, &host, &bi, &c3, None);
        host.batch(c3, Some(prefetch));
        host.stamp(2, 2, CellValue::Number(MARKER));

        let volatile = vec![crate::scripting::udf::UdfCellRef { row: 2, col: 2 }];
        let updates = vec![write(8, 0, "1")];
        let prefetch = rt.block_on(build_cube_prefetch(
            &host.state,
            &bi,
            Some(CubePrefetchEdits {
                edits: &updates,
                sheet_index: None,
                door: CubeWriteDoor::Batch,
                udf_volatile_cells: Some(&volatile),
            }),
        ));
        host.batch_with_volatile(updates, volatile, Some(prefetch));

        assert_eq!(
            host.value(0, 2, 2),
            CellValue::Number(225.0),
            "a volatile custom-function cell the batch re-evaluated was not covered by its pre-fetch"
        );
    }

    /// revFU#4: ONE multi-root traversal, from the function the write bodies
    /// use -- never a full traversal per written cell, which is quadratic on a
    /// re-pasted block whose cells feed a running total.
    #[test]
    fn the_prefetch_takes_its_cascade_from_the_write_bodies_own_function() {
        const CUBE_RS: &str = include_str!("cube.rs");
        let start = CUBE_RS
            .find("pub async fn build_cube_prefetch(")
            .expect("build_cube_prefetch is in bi/cube.rs");
        let rest = &CUBE_RS[start..];
        let body = &rest[..rest.find("\n// ====").expect("the section after it")];
        assert!(
            body.contains("active_sheet_write_cascade("),
            "build_cube_prefetch computes its own set of cascade cells instead of the write bodies' \
             `active_sheet_write_cascade` -- the two drift, and every cell only the cascade reaches is #N/A"
        );
        for per_edit in ["get_recalculation_order(", "recalc_order_from_seeds("] {
            assert!(
                !body.contains(per_edit),
                "build_cube_prefetch walks the dependents itself (`{per_edit}`)"
            );
        }
    }

    /// rev4A#4: every write of a latched session pre-fetches, so the pre-fetch
    /// must not copy the sheet. It cloned the whole grid and then every
    /// formula's AST again; the snapshot copies only the cube-bearing cells'
    /// formulas and the text of the cells their arguments name.
    #[test]
    fn the_prefetch_snapshot_copies_only_the_cube_cells_and_the_cells_they_read() {
        let host = Host::new(1);
        let mut updates: Vec<crate::api_types::CellUpdateInput> = (1..=200).map(|r| write(r, 5, "=1+1")).collect();
        updates.push(write(0, 0, "Sales[country]=USA"));
        updates.push(write(0, 1, r#"=CUBEVALUE("Sales","[Revenue]",A1)"#));
        updates.push(write(0, 2, "unread text"));
        host.batch(updates, None);

        let sheet_names = host.state.sheet_names.read().unwrap().clone();
        let locale = host.state.locale.lock().unwrap().clone();
        let snap = snapshot_prefetch_sheet(&host.state, None, 0, true, &sheet_names, &sheet_names[0], &locale, true)
            .expect("the sheet exists");
        assert_eq!(
            snap.cube_cells.keys().copied().collect::<Vec<_>>(),
            vec![(0, 1)],
            "only the cube-bearing cell's formula may be copied, not the sheet's 200 others"
        );
        assert_eq!(
            snap.texts,
            HashMap::from([((0, 0), "Sales[country]=USA".to_string())]),
            "only the text a cube argument names may be copied"
        );
        assert_eq!(snap.final_view_cells, vec![(0, 1)], "a full refresh covers every cube cell");
    }

    // ---- revFU#6: each written formula is keyed AT ITS TURN ----

    #[test]
    fn under_manual_calculation_a_cube_formula_written_before_the_literal_it_reads_is_served() {
        // Row-major paste order puts A1 (the formula) before B1 (the literal it
        // reads). The batch evaluates A1 inside its loop, before B1 lands, and
        // under manual calculation no cascade re-evaluates it afterwards.
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(1);
        *host.state.calculation_mode.lock().unwrap() = "manual".to_string();
        let updates = vec![write(0, 0, r#"=CUBEVALUE("Sales",B1)"#), write(0, 1, "[Revenue]")];
        let prefetch = prefetch_for(&rt, &host, &bi, &updates, None);
        host.batch(updates, Some(prefetch));

        assert_ne!(
            host.value(0, 0, 0),
            CellValue::Error(engine::CellError::NA),
            "the pre-fetch keyed A1 on B1's NEW text, but the batch evaluated A1 before B1 was written"
        );
        // Consistent with every other formula of a manual-mode batch: A1 saw
        // B1 as it was at its turn (empty), so it answers the measure-less call.
        assert_eq!(host.value(0, 0, 0), CellValue::Number(225.0));
    }

    #[test]
    fn under_automatic_calculation_every_answer_for_a_formula_written_before_its_literal_is_served() {
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(1);
        let updates = vec![write(0, 0, r#"=CUBEVALUE("Sales","[Revenue]",B1)"#), write(0, 1, "Sales[country]=UK")];
        let prefetch = prefetch_for(&rt, &host, &bi, &updates, None);
        let cells = host.batch(updates, Some(prefetch));

        assert_eq!(host.value(0, 0, 0), CellValue::Number(50.0), "the cascade serves A1 with B1 written");
        let answers: Vec<&str> =
            cells.iter().filter(|c| c.row == 0 && c.col == 0).map(|c| c.display.as_str()).collect();
        assert!(
            answers.iter().all(|d| *d != "#N/A"),
            "the batch answered #N/A for A1 at its own turn: {:?}",
            answers
        );
    }

    // ---- revFU#8: the pre-fetch parses a write as the batch STORES it ----

    /// A Text-format (`@`) style index.
    fn text_style(host: &Host) -> usize {
        let seed = crate::document_effect::test_seed_effect();
        let mut styles = host.state.style_registry.write(&seed).unwrap();
        let style = styles
            .get(0)
            .clone()
            .with_number_format(engine::NumberFormat::Custom { format: "@".to_string() });
        styles.get_or_create(style)
    }

    #[test]
    fn a_text_formatted_argument_cell_is_keyed_on_the_text_the_batch_stores() {
        // The connection is named "0012"; a script writes that name into A1
        // with an explicit Text style. The batch stores the TEXT "0012"; a
        // format-blind parse keys the call on the number 12.
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        for conn in bi.connections.lock().unwrap().values_mut() {
            conn.name = "0012".to_string();
        }
        let host = Host::new(1);
        let text = text_style(&host);
        let updates = vec![
            crate::api_types::CellUpdateInput {
                row: 0,
                col: 0,
                value: "0012".to_string(),
                style_index: Some(text),
                invariant: Some(true),
                pasted: None,
                moved: None,
            },
            write(0, 1, r#"=CUBEVALUE(A1,"[Revenue]")"#),
        ];
        let prefetch = prefetch_for(&rt, &host, &bi, &updates, None);
        host.batch(updates, Some(prefetch));

        assert_eq!(host.value(0, 0, 0), CellValue::Text("0012".to_string()), "precondition: stored as text");
        assert_eq!(
            host.value(0, 0, 1),
            CellValue::Number(225.0),
            "the pre-fetch parsed the argument cell's write without the format it lands in"
        );
    }

    #[test]
    fn a_write_the_batch_skips_for_a_writeback_claim_is_not_read_by_the_prefetch() {
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(1);
        host.batch(vec![write(1, 0, "Sales[country]=USA")], None);
        // A published writeback region claims A2.
        let sheet_id = host.state.sheet_ids.read().unwrap()[0];
        let decl = calp::writeback::WritebackRegionDeclaration {
            id: "wb-1".to_string(),
            selector: calp::writeback::RegionSelector {
                sheet_id,
                row_start: 1,
                row_end: 1,
                col_start: 0,
                col_end: 0,
            },
            mode: None,
            schema: None,
            visibility: None,
            submission_policy: None,
            version_binding: None,
            lifecycle: None,
            aggregation_hint: None,
            expected_respondents: Vec::new(),
            extra: Default::default(),
        };
        *host.state.writeback_index.lock().unwrap() =
            calp::WritebackIndex::from_declarations(std::slice::from_ref(&decl)).expect("index builds");

        let updates = vec![write(1, 0, "Sales[country]=UK"), write(1, 1, r#"=CUBEVALUE("Sales","[Revenue]",A2)"#)];
        let prefetch = prefetch_for(&rt, &host, &bi, &updates, None);
        host.batch(updates, Some(prefetch));

        assert_eq!(host.value(0, 1, 0), CellValue::Text("Sales[country]=USA".to_string()), "precondition: A2 skipped");
        assert_eq!(
            host.value(0, 1, 1),
            CellValue::Number(175.0),
            "the pre-fetch read a write the batch skipped (keyed on UK, the cell still says USA)"
        );
    }

    /// The pre-fetch's parse is the batch's: for every rung of the ladder the
    /// format can move (the Text format by explicit style or by the cell's own
    /// format, the apostrophe, the invariant ladder, implied formats, error
    /// literals, a PASTE that skips the Text rung), what `parse_pending_write`
    /// predicts is what the batch stores.
    #[test]
    fn the_prefetch_parses_a_write_as_the_batch_stores_it() {
        struct Case {
            value: &'static str,
            invariant: bool,
            explicit_text: bool,
            preformatted_text: bool,
            pasted: bool,
        }
        let cases = [
            Case { value: "0012", invariant: true, explicit_text: true, preformatted_text: false, pasted: false },
            Case { value: "0012", invariant: false, explicit_text: true, preformatted_text: false, pasted: false },
            Case { value: "0012", invariant: false, explicit_text: false, preformatted_text: true, pasted: false },
            Case { value: "0012", invariant: true, explicit_text: false, preformatted_text: false, pasted: false },
            Case { value: "'007", invariant: false, explicit_text: false, preformatted_text: false, pasted: false },
            Case { value: "50%", invariant: false, explicit_text: false, preformatted_text: false, pasted: false },
            Case { value: "2020-06-01", invariant: false, explicit_text: false, preformatted_text: false, pasted: false },
            Case { value: "TRUE", invariant: true, explicit_text: false, preformatted_text: false, pasted: false },
            Case { value: "#N/A", invariant: true, explicit_text: false, preformatted_text: false, pasted: false },
            Case { value: "  spaced  ", invariant: false, explicit_text: false, preformatted_text: false, pasted: false },
            // A PASTE into an @ cell keeps the kind: the number, the formula, the boolean.
            Case { value: "0012", invariant: true, explicit_text: true, preformatted_text: false, pasted: true },
            Case { value: "=1+1", invariant: false, explicit_text: false, preformatted_text: true, pasted: true },
            Case { value: "TRUE", invariant: true, explicit_text: false, preformatted_text: true, pasted: true },
        ];
        for case in cases {
            let host = Host::new(1);
            let text = text_style(&host);
            if case.preformatted_text {
                let seed = crate::document_effect::test_seed_effect();
                let styled = engine::Cell { value: CellValue::Empty, ast: None, style_index: text, rich_text: None };
                host.state.grid.write(&seed).unwrap().set_cell(0, 0, styled.clone());
                host.state.grids.write(&seed).unwrap()[0].set_cell(0, 0, styled);
            }
            let update = crate::api_types::CellUpdateInput {
                row: 0,
                col: 0,
                value: case.value.to_string(),
                style_index: case.explicit_text.then_some(text),
                invariant: Some(case.invariant),
                pasted: case.pasted.then_some(true),
                moved: None,
            };
            // A formula's VALUE is not the parse's to predict (the write
            // evaluates it): what must agree is THAT it is a formula.
            let predicted = {
                let grid = host.state.grid.read().unwrap().clone();
                let styles = host.state.style_registry.read().unwrap();
                let locale = host.state.locale.lock().unwrap().clone();
                parse_pending_write(&update, &grid, &styles, &locale)
                    .map(|c| if c.has_formula() { None } else { Some(c.value) })
            };
            host.batch(vec![update], None);
            let stored = host.state.grids.read().unwrap()[0].get_cell(0, 0).cloned();
            let stored = stored.map(|c| if c.has_formula() { None } else { Some(c.value) });
            assert_eq!(
                predicted.unwrap_or(Some(CellValue::Empty)),
                stored.unwrap_or(Some(CellValue::Empty)),
                "the pre-fetch's parse of {:?} (invariant {}, explicit Text {}, Text cell {}, pasted {}) is not what the batch stored (None = a formula)",
                case.value,
                case.invariant,
                case.explicit_text,
                case.preformatted_text,
                case.pasted
            );
        }
    }

    /// A pre-fetch built for ONE sheet, served to the workbook pass: a cube
    /// cell on another sheet whose key the active sheet does not happen to
    /// share was clobbered to #N/A by every F9 once the session had a CUBE
    /// formula (Calculate Now's pre-fetch was then built from the active sheet
    /// alone). The prefetch's scope names its sheet, so that cell is answered
    /// from its sheet's results cache while its member is unchanged -- the same
    /// as any recalculation that carries no cube data. (Calculate Now itself now
    /// carries every sheet's pre-fetch: calculate_now_refreshes_every_sheets_cube_cells.)
    #[test]
    fn calculate_now_keeps_a_cube_cell_on_another_sheet_instead_of_clobbering_it() {
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(2);
        // The active sheet's own cube cell.
        let d7 = vec![write(6, 3, REVENUE)];
        let prefetch = prefetch_for(&rt, &host, &bi, &d7, None);
        host.batch(d7, Some(prefetch));
        // Sheet2: UK's revenue, last computed as 50 -- in a workbook opened
        // with it, so the open path recorded 50 as that call's answer (without
        // that record no recalculation lacking cube data may keep it; rev3A#3).
        {
            let seed = crate::document_effect::test_seed_effect();
            let mut cell = engine::Cell::new_formula(r#"=CUBEVALUE("Sales","[Revenue]","Sales[country]=UK")"#.to_string());
            cell.value = CellValue::Number(50.0);
            host.state.grids.write(&seed).unwrap()[1].set_cell(0, 0, cell);
        }
        remember_loaded_call_results(&host.state);

        let full = rt.block_on(build_cube_prefetch(&host.state, &bi, None));
        crate::calculation::run_calculation_pass(
            crate::calculation::CalcScope::Workbook,
            None,
            &host.state,
            &host.files,
            &host.pivots,
            &host.pane,
            &host.filters,
            Some(full),
        )
        .expect("Calculate Now runs");

        assert_eq!(host.value(0, 6, 3), CellValue::Number(225.0), "the active sheet's cube cell is refreshed");
        assert_eq!(
            host.value(1, 0, 0),
            CellValue::Number(50.0),
            "Calculate Now clobbered a cube cell on another sheet with the ACTIVE sheet's cube data"
        );
    }

    // ---- rev3A#3 / NEW-f9-other-sheet-cube-na: a value is kept only for the
    //      member it was answered for ----

    /// Run Calculate Now (the workbook pass) with the full refresh
    /// `cube_prefetch_all` builds, as `recalcAll` does once the session has a
    /// CUBE formula: every sheet's cube cells.
    fn calculate_now(rt: &tokio::runtime::Runtime, host: &Host, bi: &BiState) {
        let full = rt.block_on(build_full_refresh_prefetch(&host.state, bi));
        crate::calculation::run_calculation_pass(
            crate::calculation::CalcScope::Workbook,
            None,
            &host.state,
            &host.files,
            &host.pivots,
            &host.pane,
            &host.filters,
            Some(full),
        )
        .expect("Calculate Now runs");
    }

    /// Calculate Now with NO cube data: F9 before the session has seen a CUBE
    /// formula (a workbook just opened), or after a failed `cube_prefetch_all`.
    fn calculate_now_without_cube_data(host: &Host) {
        crate::calculation::run_calculation_pass(
            crate::calculation::CalcScope::Workbook,
            None,
            &host.state,
            &host.files,
            &host.pivots,
            &host.pane,
            &host.filters,
            None,
        )
        .expect("Calculate Now runs");
    }

    #[test]
    fn calculate_now_refreshes_every_sheets_cube_cells() {
        // NEW-f9-other-sheet-cube-na: Calculate Now's pre-fetch was built from
        // the active sheet alone, so a cube cell on another sheet was never
        // refreshed by F9. Sheet2's cells hold a value nobody computed (-1);
        // the full refresh must serve them the model's numbers, bare and inside
        // a larger formula, and again when their member changes.
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(2);
        host.batch(vec![write(6, 3, REVENUE)], None);
        host.seed_off_sheet(1, 0, 0, CellValue::Text("Sales[country]=UK".to_string()));
        {
            let seed = crate::document_effect::test_seed_effect();
            let mut grids = host.state.grids.write(&seed).unwrap();
            for (row, formula) in [(0, r#"=CUBEVALUE("Sales","[Revenue]",A1)"#), (1, r#"=CUBEVALUE("Sales","[Revenue]",A1)/1000"#)] {
                let mut cell = engine::Cell::new_formula(formula.to_string());
                cell.value = CellValue::Number(-1.0);
                grids[1].set_cell(row, 1, cell);
            }
        }

        calculate_now(&rt, &host, &bi);
        assert_eq!(host.value(0, 6, 3), CellValue::Number(225.0), "the active sheet's cube cell is refreshed");
        assert_eq!(host.value(1, 0, 1), CellValue::Number(50.0), "Sheet2!B1 was not refreshed by Calculate Now");
        assert_eq!(host.value(1, 1, 1), CellValue::Number(0.05), "Sheet2!B2 (UK / 1000) was not refreshed by Calculate Now");

        host.seed_off_sheet(1, 0, 0, CellValue::Text("Sales[country]=USA".to_string()));
        calculate_now(&rt, &host, &bi);
        assert_eq!(host.value(1, 0, 1), CellValue::Number(175.0), "a new member on Sheet2 is refreshed, never UK's number or #N/A");
        assert_eq!(host.value(1, 1, 1), CellValue::Number(0.175));
    }

    #[test]
    fn calculate_now_refuses_another_sheets_cube_cell_whose_member_changed() {
        // Sheet2!B1 = CUBEVALUE(.., A1) was opened showing UK's 50. Sheet2!A1
        // then names USA (a script's or a background write; the cell is set
        // here directly). A Calculate Now WITHOUT cube data (before the session
        // has seen a CUBE formula; Calculate Now with data refreshes every
        // sheet since round 6) gives B1 no data: keeping 50 would show UK's
        // number beside "USA".
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(2);
        host.batch(vec![write(6, 3, REVENUE)], None);
        host.seed_off_sheet(1, 0, 0, CellValue::Text("Sales[country]=UK".to_string()));
        {
            let seed = crate::document_effect::test_seed_effect();
            let mut cell = engine::Cell::new_formula(r#"=CUBEVALUE("Sales","[Revenue]",A1)"#.to_string());
            cell.value = CellValue::Number(50.0);
            host.state.grids.write(&seed).unwrap()[1].set_cell(0, 1, cell);
        }
        remember_loaded_call_results(&host.state);

        calculate_now(&rt, &host, &bi);
        assert_eq!(host.value(1, 0, 1), CellValue::Number(50.0), "control: the member did not change");

        // CHANGED ON PURPOSE (round 7). The member changes through the real
        // background door, which carries no cube data here (a script's write
        // before the session latched): its own recalculation of Sheet2 refuses
        // B1. It used to be poked into the grid with no recalculation at all --
        // a route no user has, and the one shape under which Calculate Now
        // cannot know the stored 50 is stale (a full pass now keeps a stored
        // value nothing it reads has changed in, Excel's own F9).
        host.write_on_sheet_without_data(1, 0, 0, "Sales[country]=USA");
        calculate_now_without_cube_data(&host);
        assert_eq!(
            host.value(1, 0, 1),
            CellValue::Error(engine::CellError::NA),
            "Calculate Now kept UK's revenue for a cell that now names USA"
        );
        assert_eq!(
            host.value(0, 6, 3),
            CellValue::Number(225.0),
            "the active sheet's cube cell keeps the answer the first Calculate Now served"
        );

        // Back to UK: its recorded answer serves again, although B1 holds the
        // #N/A it was refused with (round 6; round 5 kept a refused cell
        // refused until a recalculation with data reached it).
        host.write_on_sheet_without_data(1, 0, 0, "Sales[country]=UK");
        calculate_now_without_cube_data(&host);
        assert_eq!(host.value(1, 0, 1), CellValue::Number(50.0), "UK's recorded answer serves again");
    }

    #[test]
    fn a_served_cube_value_is_kept_by_a_later_write_without_data_only_for_its_member() {
        // B2 = CUBEVALUE(.., A2) is SERVED by the batch's pre-fetch (USA, 175),
        // which records the answer. A later batch with NO cube data (a
        // Rust-side writer: the script surfaces, MCP) rewrites A2: the same
        // member keeps 175, another member is refused.
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(1);
        let updates = vec![write(1, 0, "Sales[country]=USA"), write(1, 1, r#"=CUBEVALUE("Sales","[Revenue]",A2)"#)];
        let prefetch = prefetch_for(&rt, &host, &bi, &updates, None);
        host.batch(updates, Some(prefetch));
        assert_eq!(host.value(0, 1, 1), CellValue::Number(175.0), "precondition: served");

        host.batch(vec![write(1, 0, "Sales[country]=USA")], None);
        assert_eq!(host.value(0, 1, 1), CellValue::Number(175.0), "the same member keeps its served value");

        host.batch(vec![write(1, 0, "Sales[country]=UK")], None);
        assert_eq!(
            host.value(0, 1, 1),
            CellValue::Error(engine::CellError::NA),
            "USA's served revenue was kept for UK"
        );

        host.batch(vec![write(1, 0, "Sales[country]=USA")], None);
        assert_eq!(host.value(0, 1, 1), CellValue::Number(175.0), "back to USA: its recorded answer serves again");
    }

    // ---- Round 6: the RESULTS CACHE. A call with no data is answered with
    //      the answer recorded for exactly its arguments, wherever it sits in
    //      its formula -- so a composite formula keeps its correct value on
    //      every route without data, is never divided again, and refuses only
    //      arguments no recalculation with data has answered. ----

    const COMPOSITE: &str = r#"=CUBEVALUE("Sales","[Revenue]",A2)/1000"#;

    impl Host {
        /// The background door (`update_cell_on_sheets`) writing `value` to
        /// (row, col) of `sheet`, served by its own pre-fetch.
        fn write_on_sheet_served(&self, rt: &tokio::runtime::Runtime, bi: &BiState, sheet: usize, row: u32, col: u32, value: &str) {
            let prefetch = prefetch_for(rt, self, bi, &[write(row, col, value)], Some(sheet));
            let wrote = crate::commands::data::update_cell_on_sheets_inner(
                &self.state,
                &self.file,
                &self.files,
                &self.pivots,
                &self.pane,
                &self.filters,
                vec![sheet],
                row,
                col,
                value.to_string(),
                Some(true),
                None,
                Some(vec![prefetch]),
            )
            .expect("the background write");
            assert_eq!(wrote, vec![sheet]);
        }

        /// The background door writing `value` with NO cube data: a script's
        /// write before the session has seen a CUBE formula. Its own
        /// recalculation of `sheet` re-evaluates what the write reaches.
        fn write_on_sheet_without_data(&self, sheet: usize, row: u32, col: u32, value: &str) {
            let wrote = crate::commands::data::update_cell_on_sheets_inner(
                &self.state,
                &self.file,
                &self.files,
                &self.pivots,
                &self.pane,
                &self.filters,
                vec![sheet],
                row,
                col,
                value.to_string(),
                Some(true),
                None,
                None,
            )
            .expect("the background write");
            assert_eq!(wrote, vec![sheet]);
        }

        /// The batch body serving custom-function answers, as
        /// `update_cells_batch` does with the frontend's `udf_results`.
        fn batch_with_udf(
            &self,
            updates: Vec<crate::api_types::CellUpdateInput>,
            udf: HashMap<String, crate::scripting::udf::UdfValue>,
        ) {
            crate::commands::data::update_cells_batch_core(
                &self.state, &self.file, &self.files, &self.pivots, updates, Some(udf), None, None, None,
            )
            .expect("the batch writes");
        }
    }

    #[test]
    fn a_composite_cube_formula_keeps_its_value_through_writes_without_cube_data() {
        // A paste or a Rust-side writer (the script surfaces, MCP) rewrites A2
        // with no cube data; B2 = CUBEVALUE(.., A2)/1000 is re-evaluated by the
        // batch's cascade (`reevaluate_formula_cell`, fill's evaluator too).
        // Before rev3A#3 each pass divided the stored quotient again; round 5
        // refused it with #N/A on every one of them.
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(1);
        let updates = vec![write(1, 0, "Sales[country]=USA"), write(1, 1, COMPOSITE)];
        let prefetch = prefetch_for(&rt, &host, &bi, &updates, None);
        host.batch(updates, Some(prefetch));
        assert_eq!(host.value(0, 1, 1), CellValue::Number(0.175), "precondition: served (USA 175 / 1000)");

        for pass in 1..=3 {
            host.batch(vec![write(1, 0, "Sales[country]=USA")], None);
            assert_eq!(
                host.value(0, 1, 1),
                CellValue::Number(0.175),
                "write {pass} without cube data: the composite formula must compute from its call's recorded answer"
            );
        }
        host.batch(vec![write(1, 0, "Sales[country]=UK")], None);
        assert_eq!(
            host.value(0, 1, 1),
            CellValue::Error(engine::CellError::NA),
            "UK was never served: refused, never USA's quotient"
        );
        host.batch(vec![write(1, 0, "Sales[country]=USA")], None);
        assert_eq!(host.value(0, 1, 1), CellValue::Number(0.175), "back to USA: served again");
    }

    #[test]
    fn calculate_now_keeps_a_composite_cube_formula_on_another_sheet() {
        // Sheet2!B2 = CUBEVALUE(.., A2)/1000, served by its background write.
        // Calculate Now WITHOUT cube data (before the session has seen a CUBE
        // formula, or after a failed pre-fetch) evaluates B2 with none on
        // every F9. (With data it refreshes every sheet:
        // calculate_now_refreshes_every_sheets_cube_cells.)
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(2);
        host.seed_off_sheet(1, 1, 0, CellValue::Text("Sales[country]=USA".to_string()));
        host.write_on_sheet_served(&rt, &bi, 1, 1, 1, COMPOSITE);
        assert_eq!(host.value(1, 1, 1), CellValue::Number(0.175), "precondition: served on Sheet2");

        for pass in 1..=3 {
            calculate_now_without_cube_data(&host);
            assert_eq!(
                host.value(1, 1, 1),
                CellValue::Number(0.175),
                "F9 {pass}: another sheet's composite cube formula must keep its value, never divided again, never #N/A"
            );
        }
        // CHANGED ON PURPOSE (round 7): the member changes through the real
        // background door (no cube data), whose own recalculation refuses B2,
        // instead of being poked into the grid with no recalculation at all --
        // a full pass now keeps a stored value nothing it reads has changed
        // in, so a poke no user can make would read as "unchanged".
        host.write_on_sheet_without_data(1, 1, 0, "Sales[country]=UK");
        calculate_now_without_cube_data(&host);
        assert_eq!(host.value(1, 1, 1), CellValue::Error(engine::CellError::NA), "UK was never served on Sheet2");
        host.write_on_sheet_without_data(1, 1, 0, "Sales[country]=USA");
        calculate_now_without_cube_data(&host);
        assert_eq!(host.value(1, 1, 1), CellValue::Number(0.175), "back to USA: served again");
    }

    #[test]
    fn the_cross_sheet_walk_keeps_a_composite_cube_formula_reading_another_sheet() {
        // Sheet2!B1 = CUBEVALUE(.., Sheet1!A1)/1000. An edit of Sheet1!A1
        // reaches B1 only through the cross-sheet walk, which carries no cube
        // data by any caller.
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(2);
        host.type_value(0, 0, "Sales[country]=USA", None);
        host.write_on_sheet_served(&rt, &bi, 1, 0, 1, r#"=CUBEVALUE("Sales","[Revenue]",Sheet1!A1)/1000"#);
        assert_eq!(host.value(1, 0, 1), CellValue::Number(0.175), "precondition: served on Sheet2");

        for pass in 1..=3 {
            host.type_value(0, 0, "Sales[country]=USA", None);
            assert_eq!(
                host.value(1, 0, 1),
                CellValue::Number(0.175),
                "edit {pass}: the walk must answer the call from its recorded answer, never divide the stored quotient"
            );
        }
        host.type_value(0, 0, "Sales[country]=UK", None);
        assert_eq!(
            host.value(1, 0, 1),
            CellValue::Error(engine::CellError::NA),
            "the walk reached B1 with a member never served: refused"
        );
        host.type_value(0, 0, "Sales[country]=USA", None);
        assert_eq!(host.value(1, 0, 1), CellValue::Number(0.175), "back to USA: served again");
    }

    #[test]
    fn calculate_now_keeps_a_composite_custom_function_formula() {
        // F9 never runs custom functions (calculate_now wires no UDF resolver),
        // so before the results cache every F9 refused =MYFN(A1)*2 with #NAME?
        // (round 5), and before rev3A#3 it doubled its own stored value.
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(1);
        host.batch(vec![write(0, 0, "3")], None);
        let served: HashMap<String, crate::scripting::udf::UdfValue> = [(
            crate::scripting::udf::udf_key("MYFN", &[crate::scripting::udf::UdfValue::Number { value: 3.0 }]),
            crate::scripting::udf::UdfValue::Number { value: 42.0 },
        )]
        .into_iter()
        .collect();
        host.batch_with_udf(vec![write(0, 1, "=MYFN(A1)*2"), write(0, 2, "=IF(A1>0,MYFN(A1)+1,0)")], served);
        assert_eq!(host.value(0, 0, 1), CellValue::Number(84.0), "precondition: served");
        assert_eq!(host.value(0, 0, 2), CellValue::Number(43.0), "precondition: served");

        for pass in 1..=3 {
            calculate_now(&rt, &host, &bi);
            assert_eq!(host.value(0, 0, 1), CellValue::Number(84.0), "F9 {pass}: =MYFN(A1)*2");
            assert_eq!(host.value(0, 0, 2), CellValue::Number(43.0), "F9 {pass}: =IF(A1>0,MYFN(A1)+1,0)");
        }
        host.batch(vec![write(0, 0, "4")], None);
        assert_eq!(
            host.value(0, 0, 1),
            CellValue::Error(engine::CellError::Name),
            "MYFN(4) was never served: refused, never MYFN(3)'s answer"
        );
        host.batch(vec![write(0, 0, "3")], None);
        assert_eq!(host.value(0, 0, 1), CellValue::Number(84.0), "back to 3: served again");
    }

    #[test]
    fn file_new_gives_the_mirror_and_the_sheet_one_memo() {
        // The active sheet is held twice (`state.grid` and `grids[0]`), and the
        // calculation pass copies the first over the second. File > New built
        // the two from separate `Grid::new()`s, so they had separate memos and
        // that copy dropped every answer recorded through `grids[0]`.
        let host = Host::new(1);
        let script_state = crate::scripting::types::ScriptState::new();
        let bi_state = BiState::new();
        let timelines = crate::timeline_slicer::TimelineSlicerState::new();
        let effect = crate::document_effect::DocumentEffect::deliberately_clean(
            crate::document_effect::CleanReason::LoadingFromDisk,
        );
        crate::persistence::reset_document_scoped_stores(
            &host.state,
            &host.files,
            &host.slicer,
            &host.filters,
            &host.pane,
            &script_state,
            &host.pivots,
            &bi_state,
            &timelines,
            &effect,
        )
        .expect("the reset runs");
        host.state.grids.read().unwrap()[0]
            .call_memo()
            .remember(engine::cube::CallKey::cube("F"), &engine::EvalResult::Number(1.0));
        assert_eq!(
            host.state.grid.read().unwrap().call_memo().answer(&engine::cube::CallKey::cube("F")),
            Some(engine::EvalResult::Number(1.0)),
            "after File > New the active-sheet mirror does not share grids[0]'s memo"
        );
    }

    #[test]
    fn opening_a_workbook_records_its_saved_cube_and_custom_function_values() {
        // `open_file` cannot run in-process (Tauri State); this pins that it
        // calls the seeding AFTER the document is installed (the grids, then
        // the dependency rebuild) and before it returns the cells.
        let src = include_str!("../persistence.rs");
        let start = src.find("pub fn open_file(").expect("open_file is in persistence.rs");
        let body = &src[start..];
        let end = body[1..].find("\npub fn ").map(|i| i + 1).unwrap_or(body.len());
        let body = &body[..end];
        let rebuild = body.find("rebuild_all_dependencies(&state)").expect("open_file rebuilds the dependencies");
        let seed = body
            .find("remember_loaded_call_results(")
            .expect("open_file must record the saved cube / custom-function values (rev3A#3)");
        let cells = body.find("collect_active_sheet_cells(&state)").expect("open_file returns the cells");
        assert!(rebuild < seed && seed < cells, "the seeding runs once the document is installed");
        // ...and then says which names are the workbook's custom functions:
        // the seeding itself vouches for none (rev10 cache2).
        let names = body
            .find("note_library_custom_functions(state.inner(), script_state.inner())")
            .expect("open_file must note the libraries' and the page's registered custom functions");
        assert!(seed < names && names < cells, "the names are noted once the document is installed");
    }

    /// rev10 rev9A. An add-in registers FXRATE (`formulas.registerFunction`);
    /// no library defines it, and F9 and the save serve no custom function.
    /// `=IFERROR(FXRATE("USD",TODAY()),0)` has no plain root call, so right
    /// after an open nothing made FXRATE known: the pass refused the call as an
    /// unknown name and wrote IFERROR's plausible 0 into the saved file. Excel
    /// computes the loaded add-in's function; Calcula cannot on this route, so
    /// the refusal stays whole. A name nothing defines is still Excel's
    /// ordinary #NAME? for IFERROR (BUG-0615#1), and so is FXRATE once its
    /// add-in is unloaded.
    ///
    /// SABOTAGE (registry): `note_custom_function_registry_impl` notes nothing.
    /// SABOTAGE (open): `workbook_custom_function_names` ignores the registry.
    #[test]
    fn an_add_ins_custom_function_stays_a_refusal_around_iferror_and_a_typo_does_not() {
        let opened = || {
            let host = Host::new(1);
            host.put_saved(
                0,
                &[
                    (0, 1, "=IFERROR(FXRATE(\"USD\",TODAY()),0)", CellValue::Number(10.5)),
                    (1, 1, "=IFERROR(NOSUCHFN(RAND()),0)", CellValue::Number(0.0)),
                ],
            );
            crate::undo_commands::rebuild_all_dependencies(&host.state);
            remember_loaded_call_results(&host.state);
            host
        };

        // The add-in registers FXRATE while the workbook is open.
        let host = opened();
        let scripts = crate::scripting::types::ScriptState::new();
        note_custom_function_registry_impl(&host.state, &scripts, vec!["fxRate".to_string()], None);
        calculate_now_without_cube_data(&host);
        assert_eq!(
            host.value(0, 0, 1),
            CellValue::Error(engine::CellError::Name),
            "the save wrote IFERROR's plausible 0 around an add-in's call nobody computed"
        );
        assert_eq!(host.value(0, 1, 1), CellValue::Number(0.0), "a name nothing defines is Excel's #NAME? for IFERROR");

        // The add-in was registered BEFORE the open: what `open_file` notes.
        let host = opened();
        *scripts.registered_custom_functions.lock().unwrap() = vec!["FXRATE".to_string()];
        note_library_custom_functions(&host.state, &scripts);
        assert!(
            host.state.grids.read().unwrap()[0].call_memo().knows_custom_function("FXRATE"),
            "the open did not note the page's registered function"
        );
        calculate_now_without_cube_data(&host);
        assert_eq!(host.value(0, 0, 1), CellValue::Error(engine::CellError::Name));

        // The add-in is unloaded: FXRATE is a name nothing defines.
        note_custom_function_registry_impl(&host.state, &scripts, Vec::new(), None);
        calculate_now_without_cube_data(&host);
        assert_eq!(
            host.value(0, 0, 1),
            CellValue::Number(0.0),
            "an unloaded add-in's function is Excel's #NAME? for IFERROR"
        );
    }

    /// rev10 cache2 residual. Seeding a saved ROOT call noted its function as
    /// known even when nothing defines it any more, so a composite call of it
    /// (`=IFERROR(GONEFN(RAND()),0)`) stayed the sticky refusal on F9 where
    /// Excel answers 0. The seeded answer itself stays: it is what that call
    /// computed. A function a library defines is still sticky.
    ///
    /// SABOTAGE: note the name again in `Evaluator::remember_stored_call_answer`.
    #[test]
    fn a_saved_root_call_of_a_function_nothing_defines_does_not_make_it_sticky() {
        let opened = || {
            let host = Host::new(1);
            host.put_saved(
                0,
                &[
                    (0, 0, "3", CellValue::Number(3.0)),
                    (0, 1, "=GONEFN(A1)", CellValue::Number(30.0)),
                    (1, 1, "=IFERROR(GONEFN(RAND()),0)", CellValue::Number(42.0)),
                ],
            );
            crate::undo_commands::rebuild_all_dependencies(&host.state);
            remember_loaded_call_results(&host.state);
            host
        };
        let host = opened();
        note_library_custom_functions(&host.state, &crate::scripting::types::ScriptState::new());
        calculate_now_without_cube_data(&host);
        assert_eq!(host.value(0, 0, 1), CellValue::Number(30.0), "the seeded root answer");
        assert_eq!(
            host.value(0, 1, 1),
            CellValue::Number(0.0),
            "seeding a saved value made GONEFN a known function although nothing defines it"
        );

        let host = opened();
        note_library(&host, &["GONEFN"]);
        calculate_now_without_cube_data(&host);
        assert_eq!(
            host.value(0, 1, 1),
            CellValue::Error(engine::CellError::Name),
            "a function the library defines stays a whole refusal"
        );
    }

    // ---- Round 7 (rev5B#1, rev5B#2): the SAVE's own recalculation ----
    //
    // `save_file` runs Calculate Now with no cube data and no custom-function
    // resolver on every Ctrl+S (`calculate_before_save` defaults to true):
    // `calculate_now_without_cube_data` IS that pass. A call it cannot answer
    // from the results cache was refused -- and the refusal was SAVED -- even
    // where nothing had changed: every composite formula right after an open.

    impl Host {
        /// Cells as a workbook just read from disk holds them -- each formula
        /// with its SAVED value, in both copies of the active sheet -- before
        /// the open path's seeding runs.
        fn put_saved(&self, sheet: usize, cells: &[(u32, u32, &str, CellValue)]) {
            let seed = crate::document_effect::test_seed_effect();
            let mut grid = self.state.grid.write(&seed).unwrap();
            let mut grids = self.state.grids.write(&seed).unwrap();
            for (row, col, text, value) in cells {
                let cell = if text.starts_with('=') {
                    let mut cell = engine::Cell::new_formula(text.to_string());
                    cell.value = value.clone();
                    cell
                } else {
                    engine::Cell { value: value.clone(), ast: None, style_index: 0, rich_text: None }
                };
                grids[sheet].set_cell(*row, *col, cell.clone());
                if sheet == 0 {
                    grid.set_cell(*row, *col, cell);
                }
            }
        }
    }

    /// A1 = 3 and A2 = USA, read by three COMPOSITE formulas -- none of whose
    /// calls any root cell makes, so the open seeds nothing for them -- and a
    /// plain dependent.
    fn opened_with_composites() -> Host {
        let host = Host::new(1);
        host.put_saved(
            0,
            &[
                (0, 0, "3", CellValue::Number(3.0)),
                (1, 0, "USA", CellValue::Text("Sales[country]=USA".to_string())),
                (0, 1, "=MYFN(A1)*2", CellValue::Number(84.0)),
                (1, 1, "=IF(A1>0,MYFN(A1)+1,0)", CellValue::Number(43.0)),
                (2, 1, COMPOSITE, CellValue::Number(0.175)),
                (0, 2, "=B1+1", CellValue::Number(85.0)),
            ],
        );
        // What `open_file` does next: the active sheet's dependency maps (an
        // edit's cascade walks them), then the results-cache seeding.
        crate::undo_commands::rebuild_all_dependencies(&host.state);
        remember_loaded_call_results(&host.state);
        host
    }

    #[test]
    fn the_save_recalculation_keeps_composite_custom_function_and_cube_values_after_an_open() {
        // concerns@resultcache item 2 and rev5B#1: only ROOT calls are seeded
        // at open, so this pass refused all three composites and Ctrl+S saved
        // #NAME? / #N/A. Their arguments have not changed since the values were
        // computed, so the pass keeps each value whole -- and keeps it, never
        // feeding it to its operator again, however many times it runs.
        let host = opened_with_composites();
        for pass in 1..=3 {
            calculate_now_without_cube_data(&host);
            assert_eq!(host.value(0, 0, 1), CellValue::Number(84.0), "save {pass}: =MYFN(A1)*2");
            assert_eq!(host.value(0, 1, 1), CellValue::Number(43.0), "save {pass}: =IF(A1>0,MYFN(A1)+1,0)");
            assert_eq!(host.value(0, 2, 1), CellValue::Number(0.175), "save {pass}: =CUBEVALUE(..,A2)/1000");
            assert_eq!(host.value(0, 0, 2), CellValue::Number(85.0), "save {pass}: a plain dependent of a kept cell");
        }
        // A CASCADE still refuses a call whose argument changed (round 6): the
        // edit of A1 has no resolver and MYFN(4) was never answered...
        host.batch(vec![write(0, 0, "4")], None);
        assert_eq!(host.value(0, 0, 1), CellValue::Error(engine::CellError::Name), "MYFN(4) is not MYFN(3)'s answer");
        // ...and the save keeps that honest refusal, never the old 84.
        calculate_now_without_cube_data(&host);
        assert_eq!(host.value(0, 0, 1), CellValue::Error(engine::CellError::Name));
        assert_eq!(host.value(0, 0, 2), CellValue::Error(engine::CellError::Name), "B1+1 over a refusal");
        assert_eq!(host.value(0, 2, 1), CellValue::Number(0.175), "the cube composite did not read A1");
    }

    #[test]
    fn the_save_recalculation_refuses_a_cell_a_cancelled_recalculation_left_pending() {
        // A pending cell's stored value may be stale by definition: no keep,
        // and the refusal is the WHOLE cell -- =IFERROR(MYFN(A1),0) must not
        // answer a plausible 0 around a call nobody computed.
        //
        // CHANGED ON PURPOSE (BUG-0615#1): MYFN is one of the workbook's
        // custom functions, so its library says so -- as the commands tell the
        // caches before every pass (`note_library_custom_functions`). Without
        // that, MYFN is a name nobody defined, and Excel's own answer for
        // `=IFERROR(UNKNOWNFN(..),0)` is 0 (see
        // `a_full_pass_answers_iferror_around_an_unknown_name_as_excel_does`).
        let host = opened_with_composites();
        note_library(&host, &["myFn"]);
        host.put_saved(0, &[(3, 1, "=IFERROR(MYFN(A1),0)", CellValue::Number(42.0))]);
        {
            let seed = crate::document_effect::test_seed_effect();
            *host.state.pending_recalc.write(&seed).unwrap() = Some(crate::eval_budget::PendingRecalc {
                sheet_index: 0,
                cells: vec![
                    crate::eval_budget::PendingCell { row: 0, col: 1 },
                    crate::eval_budget::PendingCell { row: 3, col: 1 },
                ],
            });
        }
        calculate_now_without_cube_data(&host);
        assert_eq!(
            host.value(0, 0, 1),
            CellValue::Error(engine::CellError::Name),
            "a pending cell's stored value cannot be vouched for"
        );
        assert_eq!(
            host.value(0, 3, 1),
            CellValue::Error(engine::CellError::Name),
            "a refused cell is refused whole, never IFERROR's plausible 0"
        );
        assert_eq!(host.value(0, 1, 1), CellValue::Number(43.0), "a cell that is not pending keeps its value");
    }

    /// Puts a Custom Functions library defining `names` into a script store and
    /// tells the host's caches about it, as `run_calculation_pass_with` does
    /// for the commands.
    fn note_library(host: &Host, names: &[&str]) {
        let script_state = crate::scripting::types::ScriptState::new();
        let functions: Vec<serde_json::Value> =
            names.iter().map(|n| serde_json::json!({ "name": n, "params": [], "body": "return 1;" })).collect();
        let effect = crate::document_effect::test_seed_effect();
        script_state.workbook_scripts.write(&effect).unwrap().insert(
            "__calcula_custom_functions__".to_string(),
            crate::scripting::types::WorkbookScript {
                id: "__calcula_custom_functions__".to_string(),
                name: "Custom Functions (data)".to_string(),
                description: None,
                source: serde_json::json!({ "functions": functions }).to_string(),
                scope: Default::default(),
                source_package: None,
            },
        );
        note_library_custom_functions(&host.state, &script_state);
    }

    /// BUG-0615#1. `=IFERROR(UNKNOWNFN(RAND()),0)` is 0 in Excel [LIVE, Excel
    /// 16, CalculateFull]: an unknown function is `#NAME?`, an ordinary error
    /// IFERROR catches. A full pass cannot keep the cell (RAND() is volatile)
    /// and used to overwrite IFERROR's 0 with the refusal `#NAME?`. A refused
    /// call of a function the workbook DOES define stays sticky: no plausible
    /// 0 around a call nobody computed.
    ///
    /// SABOTAGE: put back the pass's `Error(refused)` override for a
    /// non-error result.
    #[test]
    fn a_full_pass_answers_iferror_around_an_unknown_name_as_excel_does() {
        let host = opened_with_composites();
        note_library(&host, &["MYFN"]);
        host.put_saved(
            0,
            &[
                (5, 1, "=IFERROR(UNKNOWNFN(RAND()),0)", CellValue::Number(0.0)),
                (6, 1, "=IFERROR(MYFN(RAND()),0)", CellValue::Number(42.0)),
                (7, 1, "=IFERROR(MYFN(A1),0)", CellValue::Number(42.0)),
            ],
        );
        crate::undo_commands::rebuild_all_dependencies(&host.state);
        calculate_now_without_cube_data(&host);
        assert_eq!(
            host.value(0, 5, 1),
            CellValue::Number(0.0),
            "F9 answered =IFERROR(UNKNOWNFN(RAND()),0) with #NAME?; Excel answers 0"
        );
        assert_eq!(
            host.value(0, 6, 1),
            CellValue::Error(engine::CellError::Name),
            "a refused call of the workbook's own custom function must stay sticky"
        );
        assert_eq!(
            host.value(0, 7, 1),
            CellValue::Number(42.0),
            "nothing MYFN(A1) reads changed: the stored value is kept"
        );
    }

    /// BUG-0615#2. Excel [LIVE, Excel 16]: under manual calculation, change an
    /// input and save without recalculating -- the file says
    /// `calcCompleted="0"` and marks the dirty cell, and the reopened workbook
    /// shows the stale value with `CalculationState` = xlPending until F9
    /// recalculates it. Calcula saved the stale values and reopened them as
    /// vouched for: the next Calculate Now (manual, nothing edited since the
    /// open) KEPT a stale composite and seeded a stale root call's value as the
    /// answer for its new argument. Now the save writes the mark and the open
    /// applies it, so neither happens.
    ///
    /// SABOTAGE: drop the mark in `restore_pending_recalc_on_load`.
    #[test]
    fn a_manual_workbook_saved_without_recalculating_reopens_marked_stale() {
        // The session: A1 changes 3 -> 4 under manual; B1 (=MYFN(A1)*2) still
        // shows MYFN(3)'s 84. Saved WITHOUT recalculating.
        let session = opened_with_composites();
        crate::calculation::set_calculation_mode_impl(&session.state, "manual");
        session.batch(vec![write(0, 0, "4")], None);
        assert_eq!(session.value(0, 0, 1), CellValue::Number(84.0), "precondition: B1 is stale under manual");
        crate::calculation::note_manual_edits_outlive_a_save(&session.state, true);
        let bi = BiState::new();
        let (saved, _) = crate::persistence::build_workbook_for_save(
            &session.state,
            &session.files,
            &bi,
            crate::persistence::ChartKeysFor::Document,
        )
        .expect("the save builds");
        assert!(saved.calculation_incomplete, "the save did not say its values may be stale");

        // The reopen: the same cells as saved, plus a ROOT call whose saved
        // value belongs to A1's OLD argument.
        let reopened = Host::new(1);
        *reopened.state.calculation_mode.lock().unwrap() = "manual".to_string();
        reopened.put_saved(
            0,
            &[
                (0, 0, "4", CellValue::Number(4.0)),
                (0, 1, "=MYFN(A1)*2", CellValue::Number(84.0)),
                (4, 1, "=MYFN(A1)", CellValue::Number(42.0)),
            ],
        );
        crate::undo_commands::rebuild_all_dependencies(&reopened.state);
        crate::persistence::restore_pending_recalc_on_load(&reopened.state, &saved);
        remember_loaded_call_results(&reopened.state);
        note_library(&reopened, &["MYFN"]);
        calculate_now_as_the_commands_do(&reopened, true);
        assert_eq!(
            reopened.value(0, 0, 1),
            CellValue::Error(engine::CellError::Name),
            "a value the saved file marked stale was kept as calculated"
        );
        assert_eq!(
            reopened.value(0, 4, 1),
            CellValue::Error(engine::CellError::Name),
            "a stale root value was filed as MYFN(4)'s answer"
        );

        // A calculated workbook carries no mark.
        let clean = opened_with_composites();
        let (saved, _) = crate::persistence::build_workbook_for_save(
            &clean.state,
            &clean.files,
            &bi,
            crate::persistence::ChartKeysFor::Document,
        )
        .expect("the save builds");
        assert!(!saved.calculation_incomplete);
    }

    #[test]
    fn the_library_names_every_custom_function_it_defines() {
        let mut scripts = HashMap::new();
        for (id, source) in [
            ("__calcula_custom_functions__", r#"{"functions":[{"name":"myFn"},{"name":" Other "}]}"#),
            ("__calcula_custom_functions__pkg:Sales", r#"{"functions":[{"name":"PKGFN"},{"name":""}]}"#),
            ("ordinary_module", r#"{"functions":[{"name":"NOTAFUNCTION"}]}"#),
            ("__calcula_custom_functions__broken", "not json"),
        ] {
            scripts.insert(
                id.to_string(),
                crate::scripting::types::WorkbookScript {
                    id: id.to_string(),
                    name: id.to_string(),
                    description: None,
                    source: source.to_string(),
                    scope: Default::default(),
                    source_package: None,
                },
            );
        }
        assert_eq!(library_custom_function_names(&scripts), vec!["MYFN", "OTHER", "PKGFN"]);
    }

    /// The authoring dialog's Save of the Custom Functions library, through
    /// the command's own body: `(name, body)` per function.
    fn save_library(host: &Host, scripts: &crate::scripting::types::ScriptState, functions: &[(&str, &str)]) {
        let functions: Vec<serde_json::Value> = functions
            .iter()
            .map(|(name, body)| serde_json::json!({ "name": name, "params": ["x"], "body": body }))
            .collect();
        crate::scripting::commands::save_script_core(
            &host.state,
            &host.file,
            scripts,
            crate::scripting::types::WorkbookScript {
                id: "__calcula_custom_functions__".to_string(),
                name: "Custom Functions (data)".to_string(),
                description: None,
                source: serde_json::json!({ "functions": functions, "capabilities": [] }).to_string(),
                scope: Default::default(),
                source_package: None,
            },
        )
        .expect("the library saves");
    }

    /// What the frontend's resolver serves: `(name, argument, answer)`.
    fn served(answers: &[(&str, f64, f64)]) -> HashMap<String, crate::scripting::udf::UdfValue> {
        answers
            .iter()
            .map(|(name, arg, answer)| {
                (
                    crate::scripting::udf::udf_key(name, &[crate::scripting::udf::UdfValue::Number { value: *arg }]),
                    crate::scripting::udf::UdfValue::Number { value: *answer },
                )
            })
            .collect()
    }

    /// rev8A: custom-function answers were never forgotten when the function's
    /// CODE changed. MYFN(x) = x*10 answered MYFN(4) = 40 and MYFN(3) = 30;
    /// the author edits it to x*100 and the new code re-serves the cell's
    /// current call (MYFN(3) = 300). A1 back to 4 through a write without a
    /// resolver served the OLD code's 40 as current. A function the edit did
    /// not touch keeps its answers.
    ///
    /// SABOTAGE: `forget_redefined_custom_functions` returns at once.
    #[test]
    fn an_edited_custom_function_never_serves_its_old_codes_answer() {
        let host = Host::new(1);
        let scripts = crate::scripting::types::ScriptState::new();
        save_library(&host, &scripts, &[("MYFN", "return x*10;"), ("OTHER", "return x+3;")]);
        host.batch(vec![write(0, 0, "4")], None);
        host.batch_with_udf(
            vec![write(0, 1, "=MYFN(A1)"), write(0, 2, "=OTHER(A1)")],
            served(&[("MYFN", 4.0, 40.0), ("OTHER", 4.0, 7.0)]),
        );
        host.batch_with_udf(vec![write(0, 0, "3")], served(&[("MYFN", 3.0, 30.0), ("OTHER", 3.0, 6.0)]));
        assert_eq!(host.value(0, 0, 1), CellValue::Number(30.0), "precondition: MYFN(3) served");

        save_library(&host, &scripts, &[("MYFN", "return x*100;"), ("OTHER", "return x+3;")]);
        host.batch_with_udf(vec![write(0, 0, "3")], served(&[("MYFN", 3.0, 300.0), ("OTHER", 3.0, 6.0)]));
        assert_eq!(host.value(0, 0, 1), CellValue::Number(300.0), "precondition: the new code served MYFN(3)");

        host.batch(vec![write(0, 0, "4")], None);
        assert_eq!(
            host.value(0, 0, 1),
            CellValue::Error(engine::CellError::Name),
            "MYFN(4) showed the OLD code's 40 as current"
        );
        assert_eq!(host.value(0, 0, 2), CellValue::Number(7.0), "OTHER's code did not change: its answer stands");
        host.batch(vec![write(0, 0, "3")], None);
        assert_eq!(host.value(0, 0, 1), CellValue::Number(300.0), "the new code's answer is served from the cache");
    }

    /// keeprule leftover: a custom function the library DROPPED stayed known,
    /// so `=IFERROR(GONEFN(..),0)` stayed the sticky `#NAME?` until a reopen.
    /// Excel: once the function is gone a call of it is `#NAME?`, which IFERROR
    /// catches -- 0. Before the drop the sticky refusal is right: the workbook
    /// defines the function and nobody computed the call.
    ///
    /// SABOTAGE: `forget_redefined_custom_functions` forgets only the answers
    /// of a function that is gone (`forget_custom_function_answers`).
    #[test]
    fn a_custom_function_the_library_dropped_is_an_ordinary_name_error_again() {
        let host = Host::new(1);
        let scripts = crate::scripting::types::ScriptState::new();
        save_library(&host, &scripts, &[("GONEFN", "return x*10;")]);
        host.batch(vec![write(0, 0, "3")], None);
        host.batch_with_udf(vec![write(0, 1, "=IFERROR(GONEFN(A1),0)")], served(&[("GONEFN", 3.0, 30.0)]));
        assert_eq!(host.value(0, 0, 1), CellValue::Number(30.0), "precondition: served");
        host.put_saved(0, &[(1, 1, "=IFERROR(GONEFN(RAND()),0)", CellValue::Number(42.0))]);
        crate::undo_commands::rebuild_all_dependencies(&host.state);
        calculate_now_without_cube_data(&host);
        assert_eq!(
            host.value(0, 1, 1),
            CellValue::Error(engine::CellError::Name),
            "precondition: a call of the workbook's own function nobody computed is refused whole"
        );

        save_library(&host, &scripts, &[]);
        host.batch(vec![write(0, 0, "4")], None);
        assert_eq!(
            host.value(0, 0, 1),
            CellValue::Number(0.0),
            "=IFERROR(GONEFN(A1),0) after GONEFN was deleted: Excel answers 0"
        );
        calculate_now_without_cube_data(&host);
        assert_eq!(
            host.value(0, 1, 1),
            CellValue::Number(0.0),
            "F9 on =IFERROR(GONEFN(RAND()),0) after GONEFN was deleted: Excel answers 0"
        );
    }

    #[test]
    fn values_manual_calculation_left_stale_are_refused_never_kept() {
        // Manual calculation recalculates no dependent and records no pending
        // set. A1 changes to 4 under manual; B1 still shows MYFN(3)'s 84. A
        // script then switches back to automatic -- which recalculates nothing
        // -- and the user saves: keeping 84 beside A1 = 4 would be a lie.
        let host = opened_with_composites();
        crate::calculation::set_calculation_mode_impl(&host.state, "manual");
        host.batch(vec![write(0, 0, "4")], None);
        assert_eq!(host.value(0, 0, 1), CellValue::Number(84.0), "precondition: B1 is stale under manual");
        crate::calculation::set_calculation_mode_impl(&host.state, "automatic");

        calculate_now_without_cube_data(&host);
        assert_eq!(
            host.value(0, 0, 1),
            CellValue::Error(engine::CellError::Name),
            "the save kept a value manual calculation left stale"
        );
        // That completed Calculate Now evaluated every formula, so the stored
        // values are vouched for again (each is its formula's answer or a
        // refusal) and the next save may keep what is current.
        assert!(
            !host.state.grids.read().unwrap()[0].call_memo().values_may_be_stale(),
            "a completed Calculate Now vouches for the values again"
        );
    }

    /// Calculate Now as the commands run it (`calculate_now`, the save's
    /// `calculate_before_save` pass): told whether the document is unedited
    /// since it was opened or saved (`FileState::is_dirty`).
    fn calculate_now_as_the_commands_do(host: &Host, document_unedited: bool) {
        crate::calculation::run_calculation_pass_with(
            crate::calculation::CalcScope::Workbook,
            None,
            &host.state,
            &host.files,
            &host.pivots,
            &host.pane,
            &host.filters,
            None,
            document_unedited,
        )
        .expect("Calculate Now runs");
    }

    #[test]
    fn under_manual_calculation_an_unedited_workbook_keeps_its_values_and_an_edited_one_refuses() {
        // Manual calculation is a SESSION preference: it survives File > Open,
        // so a user who once chose it opens every workbook under it. Nothing
        // edited since the open means nothing left stale -- the save keeps
        // every value. Once anything was edited, nothing can be vouched for.
        let host = opened_with_composites();
        *host.state.calculation_mode.lock().unwrap() = "manual".to_string();
        calculate_now_as_the_commands_do(&host, true);
        assert_eq!(host.value(0, 0, 1), CellValue::Number(84.0), "unedited: =MYFN(A1)*2 is kept");
        assert_eq!(host.value(0, 2, 1), CellValue::Number(0.175), "unedited: the cube composite is kept");
        calculate_now_as_the_commands_do(&host, false);
        assert_eq!(
            host.value(0, 0, 1),
            CellValue::Error(engine::CellError::Name),
            "edited under manual: the value may be stale, so it is refused"
        );

        // Saved WITHOUT recalculating after an edit (`calculate_before_save`
        // off): the save makes the document clean, but its values stay
        // unvouched until a completed Calculate Now.
        let saved = opened_with_composites();
        *saved.state.calculation_mode.lock().unwrap() = "manual".to_string();
        crate::calculation::note_manual_edits_outlive_a_save(&saved.state, true);
        calculate_now_as_the_commands_do(&saved, true);
        assert_eq!(
            saved.value(0, 0, 1),
            CellValue::Error(engine::CellError::Name),
            "a save that did not recalculate an edited manual workbook vouched for its values"
        );
    }

    #[test]
    fn a_value_the_same_pass_changes_upstream_is_refused_not_kept() {
        // Within the pass itself: a volatile precedent the pass recalculates
        // (A1 = RAND()), or a volatile call inside the formula, changes the
        // call's argument -- the stored value belongs to the old one.
        let host = Host::new(1);
        host.put_saved(
            0,
            &[
                (0, 0, "=RAND()", CellValue::Number(5.0)),
                (0, 1, "=MYFN(A1)*2", CellValue::Number(7.0)),
                (1, 1, "=MYFN(RAND())*2", CellValue::Number(9.0)),
                (2, 1, "=MYFN(B5)*2", CellValue::Number(11.0)),
            ],
        );
        remember_loaded_call_results(&host.state);
        calculate_now_without_cube_data(&host);
        assert_eq!(
            host.value(0, 0, 1),
            CellValue::Error(engine::CellError::Name),
            "B1 reads A1, which this pass changed"
        );
        assert_eq!(
            host.value(0, 1, 1),
            CellValue::Error(engine::CellError::Name),
            "B2 calls RAND() itself"
        );
        assert_eq!(host.value(0, 2, 1), CellValue::Number(11.0), "control: B3 reads nothing that changed");
    }

    #[test]
    fn a_spilled_custom_function_keeps_its_spill_through_the_save_recalculation() {
        // rev5B#2: A1 = MYFN() spilled {1;2;3} over A1:A3 and C1 = SUM(A1#)
        // showed 6. The open seeded the origin's stored FIRST element, so the
        // save's recalculation answered MYFN() with the scalar 1, erased A2:A3
        // and saved C1 = 1.
        let host = Host::new(1);
        host.put_saved(
            0,
            &[
                (0, 0, "=MYFN()", CellValue::Number(1.0)),
                (1, 0, "2", CellValue::Number(2.0)),
                (2, 0, "3", CellValue::Number(3.0)),
                (0, 2, "=SUM(A1#)", CellValue::Number(6.0)),
            ],
        );
        {
            let seed = crate::document_effect::test_seed_effect();
            host.state.spill_ranges.write(&seed).unwrap().insert((0, 0, 0), vec![(1, 0), (2, 0)]);
            let mut hosts = host.state.spill_hosts.lock().unwrap();
            hosts.insert((0, 1, 0), (0, 0));
            hosts.insert((0, 2, 0), (0, 0));
        }
        remember_loaded_call_results(&host.state);
        for pass in 1..=2 {
            calculate_now_without_cube_data(&host);
            assert_eq!(host.value(0, 0, 0), CellValue::Number(1.0), "save {pass}: the origin");
            assert_eq!(host.value(0, 1, 0), CellValue::Number(2.0), "save {pass}: the spill collapsed (A2)");
            assert_eq!(host.value(0, 2, 0), CellValue::Number(3.0), "save {pass}: the spill collapsed (A3)");
            assert_eq!(host.value(0, 0, 2), CellValue::Number(6.0), "save {pass}: =SUM(A1#)");
        }
    }

    // ---- revFU#3: a sheet-qualified argument reads the sheet it names ----

    #[test]
    fn a_sheet_qualified_cube_argument_reads_the_named_sheet_end_to_end() {
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(2);
        {
            let seed = crate::document_effect::test_seed_effect();
            host.state.sheet_names.write(&seed).unwrap()[1] = "Inputs".to_string();
        }
        host.seed_off_sheet(1, 0, 0, CellValue::Text("Sales[country]=USA".to_string()));
        // The formula's own A1 names a DIFFERENT member.
        host.batch(vec![write(0, 0, "Sales[country]=UK")], None);

        let updates = vec![write(0, 1, r#"=CUBEVALUE("Sales","[Revenue]",Inputs!A1)"#)];
        let prefetch = prefetch_for(&rt, &host, &bi, &updates, None);
        host.batch(updates, Some(prefetch));

        assert_eq!(
            host.value(0, 0, 1),
            CellValue::Number(175.0),
            "Inputs!A1 (USA) was read from the formula's own sheet (UK: 50) -- served the wrong member"
        );
    }

    #[test]
    fn a_cube_member_on_another_sheet_is_refused_end_to_end() {
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(2);
        {
            let seed = crate::document_effect::test_seed_effect();
            host.state.sheet_names.write(&seed).unwrap()[1] = "Inputs".to_string();
            let mut member = engine::Cell::new_formula(r#"=CUBEMEMBER("Sales","Sales[country]=USA")"#.to_string());
            member.value = CellValue::Text("USA".to_string());
            host.state.grids.write(&seed).unwrap()[1].set_cell(1, 0, member);
        }

        let updates = vec![write(0, 1, r#"=CUBEVALUE("Sales","[Revenue]",Inputs!A2)"#)];
        let prefetch = prefetch_for(&rt, &host, &bi, &updates, None);
        host.batch(updates, Some(prefetch));

        assert_eq!(
            host.value(0, 0, 1),
            CellValue::Error(engine::CellError::Value),
            "a CUBEMEMBER on another sheet must be refused, never keyed on whatever sits at A2 here"
        );
    }

    // ---- Round 8 ----

    /// The fixture's sales rows after a data refresh of the source: USA
    /// 200 + 75 = 275, UK 60 (were 175 and 50).
    fn sales_batch_after_refresh() -> RecordBatch {
        RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("country", ArrowType::Utf8, true),
                Field::new("amount", ArrowType::Float64, true),
            ])),
            vec![
                Arc::new(StringArray::from(vec!["USA", "UK", "USA"])),
                Arc::new(Float64Array::from(vec![200.0, 60.0, 75.0])),
            ],
        )
        .unwrap()
    }

    /// rev6A#1: Sheet2!B1 = CUBEVALUE(.., Sheet1!A1). F9 serves UK (50), then
    /// USA (175); the MODEL changes (here its data; a measure edit or a "view
    /// as" switch is the same) and `recalcWithCube` re-serves USA. UK then
    /// comes back through the cross-sheet walk, which carries no cube data: the
    /// results cache still held UK's 50 from the model as it was, and served
    /// it as current with no error. A refresh now forgets every cube answer
    /// before it re-serves.
    ///
    /// SABOTAGE: make `CallMemo::forget_cube_answers` keep everything.
    #[test]
    fn a_model_refresh_never_leaves_the_old_models_answer_for_an_argument_that_comes_back() {
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(2);
        host.type_value(0, 0, "Sales[country]=UK", None);
        host.write_on_sheet_served(&rt, &bi, 1, 0, 1, r#"=CUBEVALUE("Sales","[Revenue]",Sheet1!A1)"#);
        calculate_now(&rt, &host, &bi);
        assert_eq!(host.value(1, 0, 1), CellValue::Number(50.0), "precondition: UK served");
        host.type_value(0, 0, "Sales[country]=USA", None);
        calculate_now(&rt, &host, &bi);
        assert_eq!(host.value(1, 0, 1), CellValue::Number(175.0), "precondition: USA served");

        let (refreshed, _id) = rt.block_on(state_from_batch(build_model(), None, [7u8; 16], sales_batch_after_refresh()));
        calculate_now(&rt, &host, &refreshed);
        assert_eq!(host.value(1, 0, 1), CellValue::Number(275.0), "the refresh serves USA's new revenue");

        host.type_value(0, 0, "Sales[country]=UK", None);
        assert_eq!(
            host.value(1, 0, 1),
            CellValue::Error(engine::CellError::NA),
            "the walk served UK's revenue from the model as it was before the refresh"
        );
        calculate_now(&rt, &host, &refreshed);
        assert_eq!(host.value(1, 0, 1), CellValue::Number(60.0), "the next refresh serves UK's new revenue");
    }

    /// NEW-iferror-masks-a-refusal, the batch cascade (a paste, a fill's
    /// cascade, a Rust-side writer): a call with no data inside IFERROR / IFNA
    /// used to be written as the wrapper's plausible 0.
    ///
    /// SABOTAGE: drop the refusal branch of `Evaluator::evaluate`'s sticky
    /// override.
    #[test]
    fn a_cascade_writes_a_refused_call_as_the_refusal_never_as_iferrors_fallback() {
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(1);
        host.batch(vec![write(0, 0, "3")], None);
        let served: HashMap<String, crate::scripting::udf::UdfValue> = [(
            crate::scripting::udf::udf_key("MYFN", &[crate::scripting::udf::UdfValue::Number { value: 3.0 }]),
            crate::scripting::udf::UdfValue::Number { value: 42.0 },
        )]
        .into_iter()
        .collect();
        host.batch_with_udf(vec![write(0, 1, "=IFERROR(MYFN(A1),0)")], served);
        let updates = vec![write(1, 0, "Sales[country]=USA"), write(1, 1, r#"=IFNA(CUBEVALUE("Sales","[Revenue]",A2),0)"#)];
        let prefetch = prefetch_for(&rt, &host, &bi, &updates, None);
        host.batch(updates, Some(prefetch));
        assert_eq!(host.value(0, 0, 1), CellValue::Number(42.0), "precondition: MYFN(3) served");
        assert_eq!(host.value(0, 1, 1), CellValue::Number(175.0), "precondition: USA served");

        host.batch(vec![write(0, 0, "4"), write(1, 0, "Sales[country]=UK")], None);
        assert_eq!(
            host.value(0, 0, 1),
            CellValue::Error(engine::CellError::Name),
            "MYFN(4) was never answered: IFERROR's 0 was written as if computed"
        );
        assert_eq!(
            host.value(0, 1, 1),
            CellValue::Error(engine::CellError::NA),
            "UK was never served: IFNA's 0 was written as if computed"
        );

        host.batch(vec![write(0, 0, "3"), write(1, 0, "Sales[country]=USA")], None);
        assert_eq!(host.value(0, 0, 1), CellValue::Number(42.0), "an answered call is never touched");
        assert_eq!(host.value(0, 1, 1), CellValue::Number(175.0), "an answered call is never touched");
    }

    /// NEW-iferror-masks-a-refusal, the cross-sheet walk.
    #[test]
    fn the_cross_sheet_walk_writes_a_refused_call_as_the_refusal() {
        let rt = runtime();
        let (bi, _id) = rt.block_on(make_state());
        let host = Host::new(2);
        host.type_value(0, 0, "Sales[country]=USA", None);
        host.write_on_sheet_served(&rt, &bi, 1, 0, 1, r#"=IFERROR(CUBEVALUE("Sales","[Revenue]",Sheet1!A1),0)"#);
        assert_eq!(host.value(1, 0, 1), CellValue::Number(175.0), "precondition: served on Sheet2");
        host.type_value(0, 0, "Sales[country]=UK", None);
        assert_eq!(
            host.value(1, 0, 1),
            CellValue::Error(engine::CellError::NA),
            "the walk wrote IFERROR's 0 for a member nobody served"
        );
        host.type_value(0, 0, "Sales[country]=USA", None);
        assert_eq!(host.value(1, 0, 1), CellValue::Number(175.0), "back to USA: served from the cache");
    }

    /// NEW-iferror-masks-a-refusal, a fill (Fill Down on a floating grid, whose
    /// body evaluates every filled formula itself, with no cube data).
    #[test]
    fn a_fill_writes_a_refused_call_as_the_refusal() {
        let host = Host::new(1);
        let info = crate::floating_range::create_floating_range_inner(
            &host.state,
            &host.file,
            Some("Float1".to_string()),
            100.0,
            50.0,
        )
        .expect("create a floating range");
        crate::floating_range::update_floating_range_inner(
            &host.state,
            &host.file,
            info.range.id,
            crate::api_types::FloatingRangePatch { row_count: Some(3), col_count: Some(2), ..Default::default() },
            crate::floating_range::PatchGate::ObjectEdit,
        )
        .expect("size the window");
        let type_in = |row: u32, col: u32, value: &str| {
            crate::floating_range::update_floating_range_cell_inner(
                &host.state,
                &host.file,
                &host.files,
                &host.pivots,
                &host.pane,
                &host.filters,
                info.range.id,
                row,
                col,
                value.to_string(),
                None,
            )
            .unwrap_or_else(|e| panic!("type into ({row},{col}): {e}"));
        };
        for (row, member) in ["Sales[country]=USA", "Sales[country]=UK", "Sales[country]=USA"].iter().enumerate() {
            type_in(row as u32, 0, member);
        }
        type_in(0, 1, r#"=IFERROR(CUBEVALUE("Sales","[Revenue]",A1),0)"#);
        crate::commands::data::fill_range_on_target(
            &host.state,
            &host.file,
            &host.files,
            &host.pivots,
            &host.pane,
            &host.filters,
            &crate::api_types::CellTargetRef::FloatingRange { id: info.range.id },
            (0, 1, 0, 1),
            (1, 1, 2, 1),
        )
        .expect("fill B1 down to B3");
        let backing = info.backing_sheet_index;
        for row in 0..3 {
            assert_eq!(
                host.value(backing, row, 1),
                CellValue::Error(engine::CellError::NA),
                "row {}: a call nobody served was written as IFERROR's 0",
                row + 1
            );
        }
    }
}
