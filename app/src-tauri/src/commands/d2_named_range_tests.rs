//! FILENAME: app/src-tauri/src/commands/d2_named_range_tests.rs
//! PURPOSE: D2 — a typed formula KEEPS ITS NAME, and repointing the name moves
//! every formula that reads it.
//!
//! A child module of `commands::data` (declared with `#[path]` there) so it
//! reaches `update_cell_impl` and reuses the `Workbook` harness from
//! `cross_sheet_recalc_tests`. A copied harness drifts, and a drifted harness is
//! how a recalculation defect hides.
//!
//! THE DEFECT THESE PIN. `update_cell` resolved defined names AT ENTRY and
//! stored the expansion: with `RATE` = `$D$5`, typing `=RATE` left the cell
//! holding `$D$5`. The name never reached the document, the formula bar showed
//! `=$D$5`, and repointing `RATE` moved nothing — a defined name was a one-shot
//! typing macro, not a modelling tool. Excel stores the name and resolves it
//! while calculating; so does this now.
//!
//! The half that is easy to get wrong is the DEPENDENCY EDGE. A name is not a
//! cell, so it is in none of `dependents` / `column_dependents` /
//! `row_dependents` / `cross_sheet_dependents`. A stored name with no edge of
//! its own is a stale-value bug: the formula would keep the number it computed
//! from the OLD definition with nothing in the document saying so. Half of these
//! tests are about that edge — including the two places it is quietly DERIVED
//! rather than maintained (`rebuild_all_dependencies`, which a sheet switch and
//! every structural undo run) and the one place it must not be dropped
//! (extraction through a name, which `extract_references_recursive` cannot do on
//! its own because a `NamedRef` has no coordinates).

use super::*;
use super::cross_sheet_recalc_tests::{body_of, Workbook};
use crate::named_ranges::NamedRange;
use engine::CellValue;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

impl Workbook {
    /// Define (or repoint) a name, straight into `AppState`.
    ///
    /// The CRUD commands take `State<..>` and cannot run in-process, so the
    /// store write is reproduced here and the recalculation is driven through
    /// the same shared helper the commands call. `command_wiring` below pins
    /// from source that they really do call it.
    fn define_name(&self, name: &str, refers_to: &str, scope: Option<usize>) {
        let mut names = self
            .state
            .named_ranges
            .write(&crate::document_effect::test_seed_effect())
            .unwrap();
        names.insert(
            name.to_uppercase(),
            NamedRange {
                name: name.to_string(),
                sheet_index: scope,
                refers_to: refers_to.to_string(),
                comment: None,
                folder: None,
            },
        );
    }

    fn delete_name(&self, name: &str) {
        self.state
            .named_ranges
            .write(&crate::document_effect::test_seed_effect())
            .unwrap()
            .remove(&name.to_uppercase());
    }

    /// What the commands run after the store write: the shared recalculation.
    fn name_changed(&self, names: &[&str]) {
        let owned: Vec<String> = names.iter().map(|n| n.to_string()).collect();
        crate::named_ranges::recalc_after_name_change(
            &self.state,
            &self.files,
            &self.pivots,
            &self.pane,
            &self.filters,
            &owned,
        );
    }

    /// The formula the FORMULA BAR would show for a cell — rendered from the
    /// stored AST, exactly as `CellData::formula` is.
    fn formula(&self, sheet: usize, row: u32, col: u32) -> String {
        self.state.grids.read().unwrap()[sheet]
            .get_cell(row, col)
            .and_then(|c| c.formula_string())
            .unwrap_or_default()
    }

    fn name_dependents_of(&self, name: &str) -> Vec<(u32, u32)> {
        let map = self.state.name_dependents.lock().unwrap();
        let mut v: Vec<(u32, u32)> = map
            .get(&name.to_uppercase())
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default();
        v.sort_unstable();
        v
    }
}

// ---------------------------------------------------------------------------
// 1. The cell keeps the name
// ---------------------------------------------------------------------------

#[test]
fn typing_a_name_stores_the_name_not_its_expansion() {
    let wb = Workbook::new(1);
    wb.define_name("RATE", "=$D$5", None);
    wb.set(4, 3, "0.25"); // D5
    wb.set(0, 0, "=RATE");

    assert_eq!(
        wb.formula(0, 0, 0),
        "RATE",
        "the document must hold the NAME. Storing `$D$5` is what made a defined \
         name a one-shot typing macro"
    );
    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Number(0.25),
        "and it must still evaluate through the name"
    );
}

#[test]
fn the_formula_bar_round_trips_the_name() {
    let wb = Workbook::new(1);
    wb.define_name("RATE", "=$D$5", None);
    wb.set(4, 3, "0.25");
    wb.set(0, 0, "=RATE*100");

    // Render -> re-parse -> render must be a fixed point, or every path that
    // goes through the string form (persistence, .calp publish, the formula
    // bar, Apply Names) would change the formula behind the user's back.
    let shown = wb.formula(0, 0, 0);
    assert_eq!(shown, "RATE*100");
    let reparsed = parser::parse(&shown).expect("the rendered form re-parses");
    assert_eq!(engine::ast_render::render_formula(&reparsed), shown);
}

#[test]
fn a_name_used_in_function_position_keeps_its_name() {
    // `=Double(21)` where Double is a named LAMBDA. Entry used to rewrite this
    // into `__INVOKE__("Double", LAMBDA(x, x*2), 21)`; it now stays as typed.
    let wb = Workbook::new(1);
    // `refers_to` is parsed INVARIANT (`parser::parse`), so the separator is a
    // comma here even though a cell's own input on this machine uses `;`.
    wb.define_name("Double", "=LAMBDA(x, x*2)", None);
    wb.set(0, 0, "=Double(21)");

    assert_eq!(wb.value(0, 0, 0), CellValue::Number(42.0));
    assert_eq!(
        wb.formula(0, 0, 0),
        "Double(21)",
        "the stored form is the call the user typed, not the expanded LAMBDA — \
         and it carries the name's OWN capitalisation, not the lexer's uppercase"
    );
}

#[test]
fn the_stored_name_carries_the_name_managers_capitalisation() {
    // The lexer uppercases bare identifiers, which never showed while the name
    // was expanded away at entry. `=SALESDATA*2` in the formula bar for a name
    // the user called `SalesData` is not what Excel shows.
    let wb = Workbook::new(1);
    wb.set(4, 3, "10");
    wb.define_name("SalesData", "=$D$5", None);
    wb.set(0, 0, "=salesdata*2");

    assert_eq!(wb.formula(0, 0, 0), "SalesData*2");
    assert_eq!(wb.number(0, 0, 0), 20.0, "and resolution stays case-insensitive");
}

#[test]
fn a_let_binding_is_not_respelled_after_a_colliding_name() {
    // A local that happens to share an identifier with a workbook name must not
    // be re-spelled after it — that would tell the reader the value comes from
    // somewhere it does not.
    let wb = Workbook::new(1);
    wb.set(4, 3, "10");
    wb.define_name("Rate", "=$D$5", None);
    wb.set(0, 0, "=LET(rate; 2; rate*10)");

    assert_eq!(wb.number(0, 0, 0), 20.0);
    let shown = wb.formula(0, 0, 0);
    assert!(
        !shown.contains("Rate"),
        "the LET binding is a local, not the workbook name — got `{}`",
        shown
    );
}

// ---------------------------------------------------------------------------
// 2. Repointing a name moves its readers — the whole point
// ---------------------------------------------------------------------------

#[test]
fn repointing_a_name_recalculates_every_formula_that_reads_it() {
    let wb = Workbook::new(1);
    wb.set(4, 3, "0.25"); // D5
    wb.set(4, 4, "0.40"); // E5
    wb.define_name("RATE", "=$D$5", None);
    wb.set(0, 0, "=RATE*100");
    wb.set(1, 0, "=RATE*200");
    assert_eq!(wb.number(0, 0, 0), 25.0);
    assert_eq!(wb.number(0, 1, 0), 50.0);

    wb.define_name("RATE", "=$E$5", None);
    wb.name_changed(&["RATE"]);

    assert_eq!(
        wb.number(0, 0, 0),
        40.0,
        "repointing RATE must move every formula that reads it — this is the \
         behaviour a defined name is FOR, and it is what pre-resolution made \
         impossible"
    );
    assert_eq!(wb.number(0, 1, 0), 80.0, "...every one of them, not just the first");
}

#[test]
fn a_repoint_cascades_into_the_readers_dependents() {
    let wb = Workbook::new(1);
    wb.set(4, 3, "10");
    wb.set(4, 4, "30");
    wb.define_name("BASE", "=$D$5", None);
    wb.set(0, 0, "=BASE");
    wb.set(1, 0, "=A1*2"); // reads the name's reader, not the name
    assert_eq!(wb.number(0, 1, 0), 20.0);

    wb.define_name("BASE", "=$E$5", None);
    wb.name_changed(&["BASE"]);

    assert_eq!(
        wb.number(0, 1, 0),
        60.0,
        "the seeds are ORDERED among themselves and expanded through the shared \
         cascade, so a reader's own dependents follow"
    );
}

#[test]
fn defining_a_name_repairs_the_cells_that_were_waiting_for_it() {
    // Excel: `=RATE` before RATE exists is #NAME?, and defining RATE makes it a
    // number. That needs an edge for a name that does not exist yet.
    let wb = Workbook::new(1);
    wb.set(4, 3, "0.25");
    wb.set(0, 0, "=RATE*100");
    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Error(engine::CellError::Name),
        "an undefined name is #NAME?"
    );
    assert_eq!(
        wb.name_dependents_of("RATE"),
        vec![(0, 0)],
        "the edge is recorded for a name that does not exist YET — without it \
         nothing could find this cell when the name arrives"
    );

    wb.define_name("RATE", "=$D$5", None);
    wb.name_changed(&["RATE"]);
    assert_eq!(wb.number(0, 0, 0), 25.0);
}

// ---------------------------------------------------------------------------
// 3. Deleting a name — Excel leaves #NAME?
// ---------------------------------------------------------------------------

#[test]
fn deleting_a_name_leaves_name_error_and_keeps_the_formula_text() {
    let wb = Workbook::new(1);
    wb.set(4, 3, "0.25");
    wb.define_name("RATE", "=$D$5", None);
    wb.set(0, 0, "=RATE*100");
    assert_eq!(wb.number(0, 0, 0), 25.0);

    wb.delete_name("RATE");
    wb.name_changed(&["RATE"]);

    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Error(engine::CellError::Name),
        "Excel does NOT substitute the old definition back in and does NOT blank \
         the formula — the cell shows #NAME? until the name is defined again"
    );
    assert_eq!(
        wb.formula(0, 0, 0),
        "RATE*100",
        "...and the formula TEXT survives, which is what makes redefining the \
         name a repair rather than a retype"
    );
}

// ---------------------------------------------------------------------------
// 4. Scope
// ---------------------------------------------------------------------------

#[test]
fn a_sheet_scoped_name_resolves_only_on_its_own_sheet() {
    let wb = Workbook::new(2);
    // LOCAL is scoped to Sheet2 and points at Sheet2!$A$5.
    wb.define_name("LOCAL", "=Sheet2!$A$5", Some(1));

    wb.switch_to(1);
    wb.set(4, 0, "7"); // Sheet2!A5
    wb.set(0, 0, "=LOCAL");
    assert_eq!(wb.number(1, 0, 0), 7.0, "in scope on Sheet2");

    wb.switch_to(0);
    wb.set(0, 0, "=LOCAL");
    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Error(engine::CellError::Name),
        "a sheet-scoped name is not visible from another sheet"
    );
}

#[test]
fn a_workbook_scoped_name_reaches_every_sheet_and_a_repoint_follows_it() {
    let wb = Workbook::new(2);
    wb.set(4, 0, "10"); // Sheet1!A5
    wb.set(4, 1, "50"); // Sheet1!B5
    wb.define_name("GLOBAL", "=Sheet1!$A$5", None);

    wb.switch_to(1);
    wb.set(0, 0, "=GLOBAL*2");
    assert_eq!(wb.number(1, 0, 0), 20.0);

    wb.switch_to(0);
    wb.define_name("GLOBAL", "=Sheet1!$B$5", None);
    wb.name_changed(&["GLOBAL"]);

    assert_eq!(
        wb.number(1, 0, 0),
        100.0,
        "a reader on a NON-active sheet has no seed in the (row,col)-keyed maps, \
         so the sheets that mention the name go through the shared off-sheet \
         helper instead"
    );
}

// ---------------------------------------------------------------------------
// 5. The dependency edges, including the ones that are re-derived
// ---------------------------------------------------------------------------

#[test]
fn the_cell_edges_survive_a_rebuild_even_though_the_reference_is_hidden_in_a_name() {
    // `rebuild_all_dependencies` runs on EVERY sheet switch and every structural
    // undo, and it re-derives the maps from the stored ASTs. Those now hold a
    // `NamedRef`, which `extract_references_recursive` cannot turn into
    // coordinates — so without expanding first, this rebuild would silently drop
    // the edge and editing D5 would move nothing.
    let wb = Workbook::new(1);
    wb.set(4, 3, "10"); // D5
    wb.define_name("RATE", "=$D$5", None);
    wb.set(0, 0, "=RATE*2");
    assert_eq!(wb.number(0, 0, 0), 20.0);

    crate::undo_commands::rebuild_all_dependencies(&wb.state);

    let deps = wb.state.dependents.lock().unwrap();
    assert!(
        deps.get(&(4, 3)).is_some_and(|d| d.contains(&(0, 0))),
        "after a rebuild, D5 must still know that A1 reads it THROUGH the name"
    );
    drop(deps);

    wb.set(4, 3, "11");
    assert_eq!(
        wb.number(0, 0, 0),
        22.0,
        "and the precedent edit must still cascade"
    );
}

#[test]
fn the_name_edges_survive_a_rebuild_too() {
    let wb = Workbook::new(1);
    wb.set(4, 3, "10");
    wb.define_name("RATE", "=$D$5", None);
    wb.set(0, 0, "=RATE*2");
    assert_eq!(wb.name_dependents_of("RATE"), vec![(0, 0)]);

    crate::undo_commands::rebuild_all_dependencies(&wb.state);
    assert_eq!(
        wb.name_dependents_of("RATE"),
        vec![(0, 0)],
        "a sheet switch must not lose the name edge either"
    );
}

#[test]
fn retyping_a_formula_without_the_name_drops_its_edge() {
    let wb = Workbook::new(1);
    wb.set(4, 3, "10");
    wb.define_name("RATE", "=$D$5", None);
    wb.set(0, 0, "=RATE*2");
    assert_eq!(wb.name_dependents_of("RATE"), vec![(0, 0)]);

    wb.set(0, 0, "=99");
    assert!(
        wb.name_dependents_of("RATE").is_empty(),
        "an edge that outlives the formula that earned it makes every later \
         repoint recalculate cells that no longer read the name"
    );

    wb.set(0, 0, "");
    wb.set(0, 0, "=RATE*3");
    assert_eq!(wb.name_dependents_of("RATE"), vec![(0, 0)], "and comes back");
}

#[test]
fn a_let_binding_that_shadows_a_name_earns_no_edge() {
    let wb = Workbook::new(1);
    wb.define_name("RATE", "=$D$5", None);
    wb.set(4, 3, "0.25");
    // `;` not `,`: this harness runs under the machine's real locale (sv-SE),
    // where `parse_cell_input` delocalizes a comma as a DECIMAL separator.
    wb.set(0, 0, "=LET(rate; 2; rate*10)");

    assert_eq!(
        wb.number(0, 0, 0),
        20.0,
        "the LET binding shadows the workbook name, as in Excel"
    );
    assert!(
        wb.name_dependents_of("RATE").is_empty(),
        "...so repointing RATE must not recalculate this cell"
    );
}

// ---------------------------------------------------------------------------
// 6. Nested names, and the cycle guard
// ---------------------------------------------------------------------------

#[test]
fn a_name_defined_in_terms_of_another_name_resolves_through_both() {
    let wb = Workbook::new(1);
    wb.set(4, 3, "10");
    wb.define_name("BASE", "=$D$5", None);
    wb.define_name("DOUBLED", "=BASE*2", None);
    wb.set(0, 0, "=DOUBLED");
    assert_eq!(wb.number(0, 0, 0), 20.0);

    wb.set(4, 3, "15");
    assert_eq!(
        wb.number(0, 0, 0),
        30.0,
        "the cell edge is extracted through BOTH hops"
    );
}

#[test]
fn a_self_referential_name_does_not_hang() {
    let wb = Workbook::new(1);
    wb.define_name("LOOP", "=LOOP+1", None);
    wb.set(0, 0, "=LOOP");
    // The value is whatever the cycle guard produces; the contract under test is
    // that resolution TERMINATES rather than recursing forever.
    let _ = wb.value(0, 0, 0);
}

// ---------------------------------------------------------------------------
// 7. Persistence shape
// ---------------------------------------------------------------------------

#[test]
fn the_saved_formula_text_carries_the_name() {
    // `.cala` stores `formula_string_raw()` and re-parses on load, so what the
    // save writes is what the reload gets. A workbook saved BEFORE this change
    // holds the pre-resolved reference; that file is not wrong, it is just not
    // live, and nothing migrates it — "Apply Names…" is the repair, exactly as
    // in Excel.
    let wb = Workbook::new(1);
    wb.set(4, 3, "0.25");
    wb.define_name("RATE", "=$D$5", None);
    wb.set(0, 0, "=RATE*100");

    let stored = wb
        .state
        .grid
        .read()
        .unwrap()
        .get_cell(0, 0)
        .and_then(|c| c.formula_string_raw())
        .expect("A1 is a formula");
    assert_eq!(stored, "RATE*100");

    // ...and re-parsing it (what the load path does) gives a cell that still
    // evaluates through the name.
    let reloaded = engine::Cell::new_formula(format!("={}", stored));
    assert_eq!(reloaded.formula_string().unwrap(), "RATE*100");
}

// ---------------------------------------------------------------------------
// 8. Wiring, asserted from source
// ---------------------------------------------------------------------------

/// The four CRUD commands take `State<..>` and cannot run in-process, so the
/// behavioural tests above drive `recalc_after_name_change` directly. This is
/// the other half: the commands must actually call it. Same two-part split as
/// `sort_range` / `clear_range`.
#[test]
fn every_name_mutation_command_recalculates() {
    const NAMED_RANGES_RS: &str = include_str!("../named_ranges.rs");
    for name in [
        "create_named_range",
        "update_named_range",
        "delete_named_range",
        "rename_named_range",
    ] {
        let body = body_of(NAMED_RANGES_RS, name);
        assert!(
            body.contains("recalc_after_name_change("),
            "`{}` changes what a name means without recalculating the formulas \
             that read it — every one of them keeps the number it computed from \
             the previous definition, silently",
            name
        );
    }
}

/// Apply Names must NOT seed a recalculation (the name and the reference it
/// replaced denote the same cell, so no value moves) but MUST register the
/// edges, or the next repoint would leave exactly the cells it rewrote stale.
#[test]
fn apply_names_registers_edges_without_recalculating() {
    const NAMED_RANGES_RS: &str = include_str!("../named_ranges.rs");
    let body = body_of(NAMED_RANGES_RS, "apply_names_to_formulas");
    assert!(
        body.contains("rebuild_all_dependencies("),
        "Apply Names rewrites formulas to use a NAME; until the name edges are \
         rebuilt, repointing that name would not reach the cells it just changed"
    );
    assert!(
        !body.contains("recalc_after_name_change("),
        "Apply Names changes no VALUE — seeding a cascade here would recompute \
         the whole scanned range for nothing"
    );
}

/// The entry paths must not splice names into what they STORE. All three go
/// through the one recipe, which is the thing that keeps them agreeing.
#[test]
fn every_entry_path_stores_the_name_bearing_tree() {
    const DATA_RS: &str = include_str!("data.rs");
    for name in ["update_cell_impl", "update_cells_batch_core", "fill_range"] {
        let body = body_of(DATA_RS, name);
        assert!(
            body.contains("split_entered_formula("),
            "`{}` builds its stored AST by hand instead of through the one \
             recipe — the three will drift about what a defined name means",
            name
        );
        assert!(
            body.contains("crate::convert_expr(&entered.stored)"),
            "`{}` must cache the NAME-BEARING tree; caching the expansion is \
             exactly the pre-resolution defect D2 removes",
            name
        );
    }
}
