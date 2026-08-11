//! FILENAME: app/src-tauri/src/table_deps.rs
//! PURPOSE: Excel-parity structured references — a typed formula KEEPS its
//!          `Table1[Column]`, the specifier is resolved at EVALUATION, and the
//!          dependency graph carries a table -> dependent-formula edge so a
//!          table that grows, shrinks, is renamed or is deleted recalculates
//!          every formula that reads it through the ONE shared cascade.
//! CONTEXT:  §2aj in docs/design/open-decisions-2026-08.md.
//!
//! # WHAT CHANGED, AND WHY IT IS THE WHOLE POINT
//!
//! `split_entered_formula` used to splice a structured reference into a plain
//! absolute range **at entry**: with `Sales` over `A1:A4`, typing
//! `=SUM(Sales[Amount])` stored `=SUM($A$2:$A$4)`. The specifier never reached
//! the document, which cost two different things.
//!
//! * TRANSPARENCY: the formula bar showed a substitute for what the user typed.
//! * CORRECTNESS-BY-PARITY: a fixed rectangle in absolute coordinates cannot
//!   follow a table. Add a row to `Sales` and the total stayed at its old
//!   number, silently — the whole point of a structured reference in Excel is
//!   that it does not.
//!
//! This is the identical defect D2 fixed for DEFINED NAMES, and it is fixed the
//! same way, deliberately: [`crate::name_resolution`] is the model this module
//! mirrors, function for function, so the two indirections cannot drift.
//!
//! | defined names (D2)          | structured references (§2aj) |
//! |-----------------------------|------------------------------|
//! | `NameDependentsMap`         | [`TableDependentsMap`]       |
//! | `collect_names`             | [`collect_table_names`]      |
//! | `cell_reads_any_name`       | [`cell_reads_any_table`]     |
//! | `restamp_name_casing`       | [`restamp_table_casing`]     |
//! | `recalc_after_name_change`  | [`crate::tables::recalc_after_table_change`] |
//!
//! # THE EDGE, AND WHY A STORED REFERENCE WITHOUT ONE IS A BUG
//!
//! A table is not a cell, so it is in none of `dependents` /
//! `column_dependents` / `row_dependents` / `cross_sheet_dependents`. Growing
//! `Sales` changes what `Sales[Amount]` MEANS without touching any cell the
//! reader's edges mention, so no cell seed can describe it.
//! [`TableDependentsMap`] is that edge.
//!
//! There is a SECOND half the name case does not need. Repointing a name
//! changes which cells a formula reads, and so does resizing a table — so the
//! cell-level edges of every reader are stale the moment the extent moves.
//! `recalc_after_table_change` therefore rebuilds the active sheet's dependency
//! maps from the stored ASTs (through `eval_ast`, which resolves the specifier)
//! BEFORE it seeds the cascade. Without that, `=SUM(Sales[Amount])` would pick
//! up the new row once and then never notice an edit to it.
//!
//! # BARE THIS-ROW REFERENCES
//!
//! `[@Amount]` names no table: it means "the column of the table this cell sits
//! in". The AST cannot say which table that is, and the answer depends on the
//! cell's position, which a later row insert can change. Rather than resolve it
//! at edge-registration time — a second authority that can go stale — a bare
//! reference registers under [`BARE_TABLE_KEY`], and every table change adds
//! that bucket to its seed set. It over-recalculates by exactly the cells that
//! contain a bare this-row reference (calculated columns and totals rows, i.e.
//! cells inside a table), which is a rounding error against a table structural
//! change, and it cannot miss.

use std::collections::HashSet;

use engine::Expression;

use crate::tables::{Table, TableNameRegistry, TableStorage};
use crate::CoordSet;

/// UPPERCASE table-name keys — the same casing `AppState::table_names` uses.
pub type TableSet = HashSet<String>;

/// table name -> formula cells on the ACTIVE sheet that read it.
///
/// Active-sheet only, exactly like `dependents` / `name_dependents`: those maps
/// are keyed without a sheet dimension and are rebuilt on every sheet switch.
/// Formulas on OTHER sheets that read the table are found by asking each grid
/// with [`cell_reads_any_table`], the same shape `recalc_after_name_change`
/// uses.
pub type TableDependentsMap = rustc_hash::FxHashMap<String, CoordSet>;

/// formula cell -> the tables it reads (for edge cleanup).
pub type TableDependenciesMap = rustc_hash::FxHashMap<(u32, u32), TableSet>;

/// The bucket a bare `[@Column]` registers under.
///
/// Not a legal table name — `is_valid_table_name` requires a letter or
/// underscore first — so it can never collide with a real one.
pub const BARE_TABLE_KEY: &str = "\u{1}BARE";

/// Every table a STORED formula reads, ready for [`update_table_dependencies`].
///
/// Records table names whether or not they currently EXIST, for the reason
/// `collect_names` records undefined names: `=SUM(Sales[Amount])` typed before
/// `Sales` exists is a `#NAME?` cell, and creating the table has to turn it
/// into a number.
pub fn collect_table_names(ast: &Expression, out: &mut TableSet) {
    match ast {
        Expression::TableRef { table_name, .. } => {
            if table_name.is_empty() {
                out.insert(BARE_TABLE_KEY.to_string());
            } else {
                out.insert(table_name.to_uppercase());
            }
        }
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::NamedRef { .. } => {}
        Expression::BinaryOp { left, right, .. } => {
            collect_table_names(left, out);
            collect_table_names(right, out);
        }
        Expression::UnaryOp { operand, .. } => collect_table_names(operand, out),
        Expression::FunctionCall { args, .. } => {
            for a in args {
                collect_table_names(a, out);
            }
        }
        Expression::Range { start, end, .. } => {
            collect_table_names(start, out);
            collect_table_names(end, out);
        }
        Expression::Sheet3DRef { reference, .. } => collect_table_names(reference, out),
        Expression::IndexAccess { target, index } => {
            collect_table_names(target, out);
            collect_table_names(index, out);
        }
        Expression::ListLiteral { elements } => {
            for e in elements {
                collect_table_names(e, out);
            }
        }
        Expression::DictLiteral { entries } => {
            for (k, v) in entries {
                collect_table_names(k, out);
                collect_table_names(v, out);
            }
        }
        Expression::SpillRef { cell, .. } => collect_table_names(cell, out),
        Expression::ImplicitIntersection { operand } => collect_table_names(operand, out),
    }
}

/// The tables a formula cell's STORED AST reads. Empty for a non-formula cell.
pub fn tables_of_cell(cell: &engine::Cell) -> TableSet {
    let mut out = TableSet::default();
    if let Some(ast) = cell.get_ast() {
        collect_table_names(ast, &mut out);
    }
    out
}

/// Does this cell's formula read any of `wanted` (UPPERCASE keys)?
///
/// The allocation-free form of `tables_of_cell(...).intersects(...)`, and the
/// distinction is not pedantry for the reason `cell_reads_any_name` gives:
/// `recalc_after_table_change` asks this of EVERY cell on every non-active
/// sheet, and building a `HashSet` per cell would put an allocation per cell on
/// a gesture as ordinary as typing one row under a table.
pub fn cell_reads_any_table(cell: &engine::Cell, wanted: &TableSet) -> bool {
    if wanted.is_empty() {
        return false;
    }
    match cell.get_ast() {
        Some(ast) => reads_any(ast, wanted),
        None => false,
    }
}

fn reads_any(ast: &Expression, wanted: &TableSet) -> bool {
    match ast {
        Expression::TableRef { table_name, .. } => {
            if table_name.is_empty() {
                wanted.contains(BARE_TABLE_KEY)
            } else {
                wanted.contains(&table_name.to_uppercase())
            }
        }
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::NamedRef { .. } => false,
        Expression::BinaryOp { left, right, .. } => {
            reads_any(left, wanted) || reads_any(right, wanted)
        }
        Expression::UnaryOp { operand, .. } => reads_any(operand, wanted),
        Expression::FunctionCall { args, .. } => args.iter().any(|a| reads_any(a, wanted)),
        Expression::Range { start, end, .. } => {
            reads_any(start, wanted) || reads_any(end, wanted)
        }
        Expression::Sheet3DRef { reference, .. } => reads_any(reference, wanted),
        Expression::IndexAccess { target, index } => {
            reads_any(target, wanted) || reads_any(index, wanted)
        }
        Expression::ListLiteral { elements } => elements.iter().any(|e| reads_any(e, wanted)),
        Expression::DictLiteral { entries } => entries
            .iter()
            .any(|(k, v)| reads_any(k, wanted) || reads_any(v, wanted)),
        Expression::SpillRef { cell, .. } => reads_any(cell, wanted),
        Expression::ImplicitIntersection { operand } => reads_any(operand, wanted),
    }
}

/// Re-point one formula cell's table edges. Same contract as
/// `update_name_dependencies`: old edges are removed, new ones inserted, and an
/// emptied bucket is dropped so the map does not grow monotonically.
pub fn update_table_dependencies(
    cell_pos: (u32, u32),
    new_tables: TableSet,
    table_dependencies: &mut TableDependenciesMap,
    table_dependents: &mut TableDependentsMap,
) {
    let old_tables = table_dependencies.remove(&cell_pos).unwrap_or_default();

    for old in &old_tables {
        if let Some(deps) = table_dependents.get_mut(old) {
            deps.remove(&cell_pos);
            if deps.is_empty() {
                table_dependents.remove(old);
            }
        }
    }

    for new in &new_tables {
        table_dependents.entry(new.clone()).or_default().insert(cell_pos);
    }

    if !new_tables.is_empty() {
        table_dependencies.insert(cell_pos, new_tables);
    }
}

// ============================================================================
// CASING  (§2t, for tables)
// ============================================================================

/// Restamp every structured reference with the table's own capitalisation and
/// its column's own capitalisation, in place.
///
/// WHY THIS IS NEEDED AT ALL, and why it is not optional. The lexer normalises
/// bare identifiers to UPPERCASE (`core/parser/src/lexer.rs`), and
/// `parse_bracket_content` builds a column name out of those same identifier
/// tokens — so `Sales[Amount]` parses as `SALES[AMOUNT]`. That never showed
/// while the specifier was flattened to `$A$2:$A$4` at entry. Now that the cell
/// KEEPS it, the formula bar would shout, which is exactly §2t one document
/// over. Excel shows the table as the Name Manager spells it and the column as
/// the header cell spells it.
///
/// PURELY COSMETIC BY CONSTRUCTION: every lookup on this path uppercases
/// (`find_table_by_name` uppercases, `Table::get_column_index` compares
/// case-insensitively, `collect_table_names` uppercases), so no resolution,
/// edge or value can depend on the spelling stored here.
///
/// A reference naming a table that does not exist is left EXACTLY as typed. Two
/// reasons: there is no authority to re-spell it from, and inventing one would
/// let a `#NAME?` acquire a plausible-looking name it never had — the same trap
/// §2ai names for sheet qualifiers.
pub fn restamp_table_casing(
    ast: &mut Expression,
    tables: &TableStorage,
    table_names: &TableNameRegistry,
) {
    if table_names.is_empty() {
        return;
    }
    restamp(ast, tables, table_names);
}

/// The same restamp over every stored formula of one sheet's grid — the LOAD
/// half, exactly as `restamp_grid_name_casing` is the load half of
/// `restamp_name_casing`. A `.cala` re-parses saved formula text, so the
/// lexer's uppercasing lands on an AST that entry had deliberately spelled
/// correctly.
///
/// NOT A CELL WRITE: it mutates the AST a cell already holds in place, calls
/// neither `set_cell` nor `clear_cell` and creates no value, so it is not a
/// member of the recalculation census's population. Returns how many references
/// were respelled, for logging.
pub fn restamp_grid_table_casing(
    grid: &mut engine::Grid,
    tables: &TableStorage,
    table_names: &TableNameRegistry,
) -> usize {
    if table_names.is_empty() {
        return 0;
    }
    let mut changed = 0usize;
    for cell in grid.cells.values_mut() {
        let Some(ast) = cell.ast.as_deref_mut() else { continue };
        // The gate keeps the dominant case (no structured reference anywhere)
        // off the render path entirely.
        if !crate::ast_has_table_refs(ast) {
            continue;
        }
        let before = engine::ast_render::render_formula_raw(ast);
        restamp(ast, tables, table_names);
        if engine::ast_render::render_formula_raw(ast) != before {
            changed += 1;
        }
    }
    changed
}

fn find_table<'a>(
    name: &str,
    tables: &'a TableStorage,
    table_names: &TableNameRegistry,
) -> Option<&'a Table> {
    let (sheet_index, table_id) = table_names.get(&name.to_uppercase())?;
    tables.get(sheet_index)?.get(table_id)
}

/// The column's own spelling, when the table has a column by that name.
fn column_spelling(table: &Table, col_name: &str) -> Option<String> {
    let idx = table.get_column_index(col_name)?;
    let spelled = table.columns.get(idx)?.name.clone();
    (spelled != col_name).then_some(spelled)
}

fn restamp_specifier(spec: &mut parser::ast::TableSpecifier, table: &Table) {
    use parser::ast::TableSpecifier as S;
    match spec {
        S::Column(c) | S::ThisRow(c) => {
            if let Some(s) = column_spelling(table, c) {
                *c = s;
            }
        }
        S::ColumnRange(a, b) | S::ThisRowRange(a, b) => {
            if let Some(s) = column_spelling(table, a) {
                *a = s;
            }
            if let Some(s) = column_spelling(table, b) {
                *b = s;
            }
        }
        S::AllRows | S::DataRows | S::Headers | S::Totals => {}
        S::SpecialColumn(inner, c) => {
            restamp_specifier(inner, table);
            if let Some(s) = column_spelling(table, c) {
                *c = s;
            }
        }
    }
}

fn restamp(ast: &mut Expression, tables: &TableStorage, table_names: &TableNameRegistry) {
    match ast {
        Expression::TableRef { table_name, specifier, .. } => {
            // A BARE `[@Col]` names no table, so there is nothing to look the
            // column up in without a cell position. Left alone: an over-eager
            // guess here would rename a column after a table the cell is not in.
            if table_name.is_empty() {
                return;
            }
            let Some(table) = find_table(table_name, tables, table_names) else {
                return;
            };
            if table.name != *table_name {
                *table_name = table.name.clone();
            }
            restamp_specifier(specifier, table);
        }
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::NamedRef { .. } => {}
        Expression::BinaryOp { left, right, .. } => {
            restamp(left, tables, table_names);
            restamp(right, tables, table_names);
        }
        Expression::UnaryOp { operand, .. } => restamp(operand, tables, table_names),
        Expression::FunctionCall { args, .. } => {
            for a in args {
                restamp(a, tables, table_names);
            }
        }
        Expression::Range { start, end, .. } => {
            restamp(start, tables, table_names);
            restamp(end, tables, table_names);
        }
        Expression::Sheet3DRef { reference, .. } => restamp(reference, tables, table_names),
        Expression::IndexAccess { target, index } => {
            restamp(target, tables, table_names);
            restamp(index, tables, table_names);
        }
        Expression::ListLiteral { elements } => {
            for e in elements {
                restamp(e, tables, table_names);
            }
        }
        Expression::DictLiteral { entries } => {
            for (k, v) in entries {
                restamp(k, tables, table_names);
                restamp(v, tables, table_names);
            }
        }
        Expression::SpillRef { cell, .. } => restamp(cell, tables, table_names),
        Expression::ImplicitIntersection { operand } => restamp(operand, tables, table_names),
    }
}

/// Rewrite the COLUMN name of every specifier that reads `old_name` on
/// `table_name_upper` to `new_name`, leaving every other reference alone.
///
/// This is what makes a table-column rename non-destructive, and it is the same
/// argument `rename_table_refs_in_ast` makes for the table name: a column
/// rename only re-keyed `Table::columns`, so a STORED `Sales[Amount]` stopped
/// resolving the moment the header was retyped, and an unresolvable structured
/// reference degrades to a `NamedRef` the evaluator renders as `#NAME?`.
///
/// A bare `[@Amount]` is rewritten too, but ONLY when `include_bare` says the
/// cell is inside the table being renamed — the caller knows the cell's
/// position and this function does not.
///
/// Returns `(new_ast, changed)`.
pub fn rename_table_column_in_ast(
    ast: &Expression,
    table_name_upper: &str,
    old_name: &str,
    new_name: &str,
    include_bare: bool,
) -> (Expression, bool) {
    let mut out = ast.clone();
    let mut changed = false;
    rename_col_walk(
        &mut out,
        table_name_upper,
        &old_name.to_uppercase(),
        new_name,
        include_bare,
        &mut changed,
    );
    (out, changed)
}

fn rename_spec_col(
    spec: &mut parser::ast::TableSpecifier,
    old_upper: &str,
    new_name: &str,
    changed: &mut bool,
) {
    use parser::ast::TableSpecifier as S;
    let swap = |c: &mut String, changed: &mut bool| {
        if c.to_uppercase() == old_upper {
            *c = new_name.to_string();
            *changed = true;
        }
    };
    match spec {
        S::Column(c) | S::ThisRow(c) => swap(c, changed),
        S::ColumnRange(a, b) | S::ThisRowRange(a, b) => {
            swap(a, changed);
            swap(b, changed);
        }
        S::AllRows | S::DataRows | S::Headers | S::Totals => {}
        S::SpecialColumn(inner, c) => {
            swap(c, changed);
            rename_spec_col(inner, old_upper, new_name, changed);
        }
    }
}

fn rename_col_walk(
    ast: &mut Expression,
    table_upper: &str,
    old_upper: &str,
    new_name: &str,
    include_bare: bool,
    changed: &mut bool,
) {
    match ast {
        Expression::TableRef { table_name, specifier, .. } => {
            let applies = if table_name.is_empty() {
                include_bare
            } else {
                table_name.to_uppercase() == table_upper
            };
            if applies {
                rename_spec_col(specifier, old_upper, new_name, changed);
            }
        }
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::NamedRef { .. } => {}
        Expression::BinaryOp { left, right, .. } => {
            rename_col_walk(left, table_upper, old_upper, new_name, include_bare, changed);
            rename_col_walk(right, table_upper, old_upper, new_name, include_bare, changed);
        }
        Expression::UnaryOp { operand, .. } => {
            rename_col_walk(operand, table_upper, old_upper, new_name, include_bare, changed)
        }
        Expression::FunctionCall { args, .. } => {
            for a in args {
                rename_col_walk(a, table_upper, old_upper, new_name, include_bare, changed);
            }
        }
        Expression::Range { start, end, .. } => {
            rename_col_walk(start, table_upper, old_upper, new_name, include_bare, changed);
            rename_col_walk(end, table_upper, old_upper, new_name, include_bare, changed);
        }
        Expression::Sheet3DRef { reference, .. } => {
            rename_col_walk(reference, table_upper, old_upper, new_name, include_bare, changed)
        }
        Expression::IndexAccess { target, index } => {
            rename_col_walk(target, table_upper, old_upper, new_name, include_bare, changed);
            rename_col_walk(index, table_upper, old_upper, new_name, include_bare, changed);
        }
        Expression::ListLiteral { elements } => {
            for e in elements {
                rename_col_walk(e, table_upper, old_upper, new_name, include_bare, changed);
            }
        }
        Expression::DictLiteral { entries } => {
            for (k, v) in entries {
                rename_col_walk(k, table_upper, old_upper, new_name, include_bare, changed);
                rename_col_walk(v, table_upper, old_upper, new_name, include_bare, changed);
            }
        }
        Expression::SpillRef { cell, .. } => {
            rename_col_walk(cell, table_upper, old_upper, new_name, include_bare, changed)
        }
        Expression::ImplicitIntersection { operand } => {
            rename_col_walk(operand, table_upper, old_upper, new_name, include_bare, changed)
        }
    }
}

// ============================================================================
// THE EDGE REFRESH
// ============================================================================

/// Re-derive the CELL-level dependency edges of `cells` on the ACTIVE sheet from
/// the trees they store.
///
/// WHY A TABLE CHANGE NEEDS THIS AND A NAME CHANGE DOES NOT. Repointing a
/// defined name changes which cells a formula reads, and D2 handles that by
/// recalculating the readers — but the readers' own edges are re-derived by
/// `rebuild_all_dependencies` on the next sheet switch, and in the meantime the
/// name's own edge keeps them reachable. A TABLE resize is different in one
/// decisive way: after it, the reader's precedents include a row that was not in
/// any map, and an ordinary edit to that row must reach the total. Nothing else
/// would ever record that edge, so the total would be right once and silently
/// wrong from the next keystroke on.
///
/// TARGETED, not `rebuild_all_dependencies`. This runs on `check_table_auto_expand`,
/// i.e. on typing one row under a table, and re-extracting every formula on the
/// sheet there would put a whole-sheet walk on a per-keystroke gesture. The
/// readers are exactly the cells whose edges can have moved.
///
/// LOCK ORDER: sheet names, then the naming authorities, then the grid, then the
/// dependency maps — the same order `rebuild_all_dependencies_from_grid` uses,
/// so the two cannot deadlock against each other. THE CALLER MUST HOLD NONE OF
/// THEM.
pub fn refresh_reader_edges(state: &crate::AppState, cells: &[(u32, u32)]) {
    if cells.is_empty() {
        return;
    }
    let Ok(active_sheet) = state.active_sheet.read().map(|a| *a) else { return };
    let Ok(sheet_names) = state.sheet_names.read().map(|n| n.clone()) else { return };
    let Ok(named_ranges) = state.named_ranges.read() else { return };
    let Ok(tables) = state.tables.read() else { return };
    let Ok(table_names) = state.table_names.read() else { return };
    let Ok(grid) = state.grid.read() else { return };

    let name_tables = crate::name_resolution::NameTables {
        named_ranges: &named_ranges,
        tables: &tables,
        table_names: &table_names,
        sheet_names: &sheet_names,
        spill_ranges: &state.spill_ranges,
    };

    let mut dependents = state.dependents.lock().unwrap();
    let mut dependencies = state.dependencies.lock().unwrap();
    let mut column_dependents = state.column_dependents.lock().unwrap();
    let mut column_dependencies = state.column_dependencies.lock().unwrap();
    let mut row_dependents = state.row_dependents.lock().unwrap();
    let mut row_dependencies = state.row_dependencies.lock().unwrap();
    let mut table_dependents = state.table_dependents.lock().unwrap();
    let mut table_dependencies = state.table_dependencies.lock().unwrap();
    let mut cross_sheet_dependents = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies = state.cross_sheet_dependencies.lock().unwrap();

    for &(row, col) in cells {
        // A reader whose cell is gone loses every edge it owned — the same
        // contract the `update_*` helpers implement for a cleared cell.
        let refs = match grid.get_cell(row, col).and_then(|c| c.get_ast()) {
            Some(ast) => crate::stored_ast_references(ast, &grid, name_tables, active_sheet, row, col),
            None => crate::ExtractedRefs::new(),
        };
        crate::update_dependencies((row, col), refs.cells, &mut dependencies, &mut dependents);
        crate::update_column_dependencies(
            (row, col),
            refs.columns,
            &mut column_dependencies,
            &mut column_dependents,
        );
        crate::update_row_dependencies(
            (row, col),
            refs.rows,
            &mut row_dependencies,
            &mut row_dependents,
        );
        crate::update_cross_sheet_dependencies(
            (active_sheet, row, col),
            crate::normalize_cross_sheet_refs(&refs.cross_sheet_cells, &sheet_names),
            &mut cross_sheet_dependencies,
            &mut cross_sheet_dependents,
        );
        // ...and the TABLE edge itself, which a RENAME re-keys: the stored tree
        // now says `Revenue[Amount]` where the map still files the cell under
        // `SALES`. `update_table_dependencies` removes the old key because
        // `table_dependencies` still remembers it.
        let read_tables = grid
            .get_cell(row, col)
            .map(tables_of_cell)
            .unwrap_or_default();
        update_table_dependencies(
            (row, col),
            read_tables,
            &mut table_dependencies,
            &mut table_dependents,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ast(f: &str) -> Expression {
        parser::parse(f).expect("test formula parses")
    }

    fn tabs(f: &str) -> Vec<String> {
        let mut out = TableSet::default();
        collect_table_names(&ast(f), &mut out);
        let mut v: Vec<String> = out.into_iter().collect();
        v.sort();
        v
    }

    #[test]
    fn a_structured_reference_is_an_edge() {
        assert_eq!(tabs("=SUM(Sales[Amount])"), vec!["SALES".to_string()]);
        assert_eq!(tabs("=Sales[Amount]*2"), vec!["SALES".to_string()]);
        assert_eq!(tabs("=SUM(Sales[#All])"), vec!["SALES".to_string()]);
    }

    #[test]
    fn a_plain_reference_is_not() {
        assert!(tabs("=A1+B2").is_empty());
        assert!(tabs("=SUM(A1:A10)").is_empty());
        assert!(tabs("=RATE*2").is_empty());
    }

    #[test]
    fn a_bare_this_row_reference_registers_under_the_bare_bucket() {
        assert_eq!(tabs("=[@Amount]*2"), vec![BARE_TABLE_KEY.to_string()]);
    }

    #[test]
    fn two_tables_in_one_formula_are_two_edges() {
        let mut v = tabs("=SUM(Sales[Amount])-SUM(Costs[Amount])");
        v.sort();
        assert_eq!(v, vec!["COSTS".to_string(), "SALES".to_string()]);
    }

    /// `cell_reads_any_table` is the allocation-free twin of
    /// `collect_table_names(...).contains(...)`, and two walks that must agree
    /// are two walks that can drift. Pinned against each other.
    #[test]
    fn the_fast_predicate_agrees_with_the_collecting_walk() {
        for formula in [
            "=SUM(Sales[Amount])",
            "=Sales[Amount]*2",
            "=[@Amount]",
            "=SUM(Sales[Amount])-SUM(Costs[Amount])",
            "=A1+B2",
            "=IF(A1>0, Sales[Amount], 0)",
            "=SUBTOTAL(109,Sales[[Amount]:[Tax]])",
            "={1,2,3}",
        ] {
            let tree = ast(formula);
            let mut collected = TableSet::default();
            collect_table_names(&tree, &mut collected);

            let cell = engine::Cell::new_formula_with_ast(tree);
            for probe in ["SALES", "COSTS", "NOPE", BARE_TABLE_KEY] {
                let mut wanted = TableSet::default();
                wanted.insert(probe.to_string());
                assert_eq!(
                    cell_reads_any_table(&cell, &wanted),
                    collected.contains(probe),
                    "`{}` vs probe {:?}: the two table walks disagree",
                    formula,
                    probe
                );
            }
        }
    }

    #[test]
    fn edges_are_removed_when_a_formula_stops_reading_a_table() {
        let mut deps = TableDependenciesMap::default();
        let mut dependents = TableDependentsMap::default();

        let mut first = TableSet::default();
        first.insert("SALES".to_string());
        update_table_dependencies((0, 0), first, &mut deps, &mut dependents);
        assert!(dependents.get("SALES").unwrap().contains(&(0, 0)));

        update_table_dependencies((0, 0), TableSet::default(), &mut deps, &mut dependents);
        assert!(dependents.get("SALES").is_none(), "an emptied bucket is dropped");
        assert!(deps.get(&(0, 0)).is_none());
    }

    /// The rename touches the COLUMN and nothing else. The table names come
    /// back from the lexer uppercased, which is what `restamp_table_casing`
    /// exists to fix at entry and on load -- this walk deliberately does not
    /// re-spell anything it was not asked to.
    #[test]
    fn a_column_rename_rewrites_only_the_named_table() {
        let tree = ast("=SUM(Sales[Amount])+SUM(Costs[Amount])");
        let (out, changed) = rename_table_column_in_ast(&tree, "SALES", "Amount", "Total", false);
        assert!(changed);
        assert_eq!(
            format!("={}", engine::ast_render::render_formula_raw(&out)),
            "=SUM(SALES[Total])+SUM(COSTS[AMOUNT])"
        );
    }

    #[test]
    fn a_bare_reference_is_renamed_only_when_the_caller_says_it_is_inside() {
        let tree = ast("=[@Amount]*2");
        let (kept, changed) = rename_table_column_in_ast(&tree, "SALES", "Amount", "Total", false);
        assert!(!changed);
        assert_eq!(
            format!("={}", engine::ast_render::render_formula_raw(&kept)),
            "=[@AMOUNT]*2",
            "untouched -- the lexer's spelling, because this walk was told the              cell is not inside the table being renamed"
        );

        let (moved, changed) = rename_table_column_in_ast(&tree, "SALES", "Amount", "Total", true);
        assert!(changed);
        assert_eq!(
            format!("={}", engine::ast_render::render_formula_raw(&moved)),
            "=[@Total]*2"
        );
    }
}
