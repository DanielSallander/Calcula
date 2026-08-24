//! FILENAME: app/src-tauri/src/name_resolution.rs
//! PURPOSE: Excel-parity named-range handling — a typed formula KEEPS ITS NAME,
//!          the name is expanded at EVALUATION, and the dependency graph carries
//!          a name -> dependent-formula edge so repointing a name recalculates
//!          every formula that reads it through the ONE shared cascade.
//! CONTEXT:  D2 in docs/design/open-decisions-2026-08.md §4.
//!
//! # WHAT CHANGED, AND WHY IT IS THE WHOLE POINT
//!
//! `update_cell` used to splice a name's definition into the AST **at entry**:
//! with `RATE` = `$D$5`, typing `=RATE` stored `$D$5`. The name never reached
//! the document. That made a defined name a one-shot typing macro rather than a
//! modelling tool: the formula bar showed `=$D$5`, repointing `RATE` moved
//! nothing, and Formulas > "Apply Names…" was the only route back — the reverse
//! of Excel, where Apply Names is a repair tool.
//!
//! Excel stores the NAME and resolves it while calculating. So does this now.
//! The consequence a spreadsheet engine must not get wrong is the second half:
//! **a stored name with no dependency edge is a stale-value bug.** A name is not
//! a cell, so it is in none of `dependents` / `column_dependents` /
//! `row_dependents` / `cross_sheet_dependents`; without an edge of its own,
//! repointing `RATE` would leave every formula reading it displaying the number
//! it computed from the OLD definition, with nothing in the document saying so.
//! [`NameDependentsMap`] is that edge, and it is maintained exactly where the
//! cell-level edges are maintained (`update_cell`, the batch writer, `fill_range`
//! and `rebuild_all_dependencies_from_grid`).
//!
//! # COST
//!
//! Resolution moved from once-per-EDIT to once-per-EVALUATION, so it has to stay
//! off the recalculation hot path. Two properties make it cheap enough to need no
//! cache at all:
//!
//! 1. **The parser AST and the engine AST are the same type**
//!    (`engine::Expression` re-exports `parser::ast::Expression`), so expanding a
//!    name at evaluation is an AST *splice*, not a re-parse. The expensive step —
//!    parsing — still happens exactly once, at entry.
//! 2. **The gate is precise.** [`needs_name_resolution`] is an allocation-free
//!    walk that asks the workbook's own name table, so a formula that names
//!    nothing returns `Cow::Borrowed` and the evaluator gets the stored AST
//!    unchanged. Note it asks about `Custom(_)` calls too, because
//!    `=myLambda(5)` is a name in function position — but only when `myLambda`
//!    IS a defined name, unlike `ast_has_named_refs`, which answers `true` for
//!    every custom function call and would therefore have made every JS-UDF
//!    formula pay a tree clone per evaluation.
//!
//! What a name-USING formula pays is one tree clone per evaluation, which is the
//! same order as the evaluation walk it feeds. **A workbook with NO DEFINED NAMES
//! — the overwhelmingly common case — pays a single `HashMap::is_empty()` per
//! evaluated dependent**, because that is the first thing the gate asks; a
//! workbook that has names pays a short-circuiting predicate walk on top. If that
//! ever shows up in a profile, the shape to add is a
//! resolved-AST cache keyed by `(sheet_index, formula)` and invalidated by a
//! name-table generation counter — deliberately NOT built here, because an
//! invalidation channel that can go stale is exactly the defect class this
//! change exists to close.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use engine::Expression;
use parser::ast::BuiltinFunction;

use crate::named_ranges::NamedRange;
use crate::CoordSet;

/// UPPERCASE name keys — the same casing `AppState::named_ranges` is keyed by.
pub type NameSet = HashSet<String>;

/// name -> formula cells on the ACTIVE sheet that resolve through it.
///
/// Active-sheet only, exactly like `dependents` / `column_dependents` /
/// `row_dependents`: those maps are keyed by `(row, col)` with no sheet
/// dimension and are rebuilt on every sheet switch. Formulas on OTHER sheets
/// that read the name are reached by [`crate::named_ranges::sheets_using_names`]
/// + the shared off-sheet helper instead.
pub type NameDependentsMap = rustc_hash::FxHashMap<String, CoordSet>;

/// formula cell -> the names it resolves through (for edge cleanup).
pub type NameDependenciesMap = rustc_hash::FxHashMap<(u32, u32), NameSet>;

/// The workbook-wide tables a name expansion reads, held once by a cascade and
/// pointed at one cell at a time with [`NameTables::at`].
///
/// `tables` / `table_names` are here because a name's `refers_to` may itself be
/// a structured reference (`=Table1[Amount]`). Entry-time resolution used to
/// cover that for free by running the table pass over the already-expanded tree;
/// now that the expansion happens later, the table pass has to travel with it or
/// such a name would evaluate to `#NAME?`.
#[derive(Clone, Copy)]
pub struct NameTables<'a> {
    pub named_ranges: &'a HashMap<String, NamedRange>,
    pub tables: &'a crate::tables::TableStorage,
    pub table_names: &'a crate::tables::TableNameRegistry,
    /// The workbook's sheet names, in index order — for QUALIFYING a structured
    /// reference that names a table on another sheet. See
    /// [`crate::TableRefContext::sheet_names`]: without it, `=SUM(Sales[Amount])`
    /// written on Sheet2 resolved to Sheet2's own `A2:A4`.
    pub sheet_names: &'a [String],
    /// The LIVE spill map, for `A1#` (§3bf).
    ///
    /// THE LOCK IS TAKEN HERE, per evaluated cell that actually contains a
    /// spill reference, and that is deliberate rather than an oversight. A
    /// snapshot cannot work: within ONE cascade an array is re-laid and then a
    /// formula reading `A1#` is evaluated, so anything taken at the start of the
    /// pass would answer with the extent that cascade just replaced — §3bf
    /// again, merely narrowed to one pass. The gate is
    /// [`crate::ast_has_spill_refs`], the same shape `ast_has_table_refs`
    /// already costs on this path, so a workbook with no `#` never locks.
    ///
    /// **A caller must not hold this lock across an evaluation.** `std::Mutex`
    /// is not reentrant and this would deadlock;
    /// `no_spill_map_holder_also_resolves_a_formula` in `spill_ref_tests`
    /// enumerates the crate and refuses the combination.
    pub spill_ranges: &'a crate::document_effect::Persisted<crate::SpillRangeMap>,
}

impl<'a> NameTables<'a> {
    /// Point these tables at ONE evaluating cell.
    ///
    /// `sheet_index` is the sheet the cell LIVES ON, not the active sheet: name
    /// scope is per sheet, and the cross-sheet walk evaluates cells on sheets
    /// the user is not looking at.
    pub fn at(&self, sheet_index: usize, row: u32, col: u32) -> NameEvalCtx<'a> {
        NameEvalCtx {
            named_ranges: self.named_ranges,
            tables: self.tables,
            table_names: self.table_names,
            sheet_names: self.sheet_names,
            spill_ranges: self.spill_ranges,
            sheet_index,
            row,
            col,
        }
    }
}

/// Everything expanding a name needs at EVALUATION time, for one cell.
pub struct NameEvalCtx<'a> {
    pub named_ranges: &'a HashMap<String, NamedRange>,
    pub tables: &'a crate::tables::TableStorage,
    pub table_names: &'a crate::tables::TableNameRegistry,
    /// See [`NameTables::sheet_names`].
    pub sheet_names: &'a [String],
    /// See [`NameTables::spill_ranges`].
    pub spill_ranges: &'a crate::document_effect::Persisted<crate::SpillRangeMap>,
    /// Scope: a sheet-scoped name resolves only on its own sheet.
    pub sheet_index: usize,
    /// The evaluating cell's row — only consulted for `[@ThisRow]` table refs
    /// reached through a name's definition.
    pub row: u32,
    /// The evaluating cell's column, for the same reason as `row`. A bare
    /// `[@Column]` resolves against the table the cell is INSIDE, and a
    /// rectangle is not entered on one axis. See
    /// [`crate::TableRefContext::current_col`].
    pub col: u32,
}

/// The AST to hand the evaluator for a STORED formula that may name a defined
/// range or a table. Borrowed — zero cost — when there is nothing to expand.
///
/// TWO INDIRECTIONS, ONE GATE. A stored formula can now hold a defined name
/// (D2) *and* a structured table reference (§2aj), and both are resolved HERE,
/// against the workbook as it is at the moment of evaluation. That is what makes
/// `=SUM(Sales[Amount])` follow the table when it grows: nothing rewrites the
/// stored formula, the specifier simply resolves against a different extent.
///
/// The table half is checked SECOND and on the already-expanded tree, because a
/// name's `refers_to` may itself be a structured reference (`=Table1[Amount]`),
/// so a specifier can appear only after the name splice.
///
/// THREE INDIRECTIONS SINCE §3bf, and the third is the spill reference. `A1#`
/// used to be frozen into the STORED form at entry, so `=SUM(A1#)` was kept,
/// rendered and saved as `=SUM(A1:A4)` and did not follow its array when the
/// array grew or shrank — in Excel `A1#` is a LIVE reference to whatever the
/// array currently spans, which is its entire purpose. It is resolved here now,
/// for the same reason and by the same recipe as the other two: nothing
/// rewrites the stored formula, the `#` simply resolves against a different
/// extent. It is resolved LAST because a name's `refers_to` may itself be a
/// spill reference, so a `#` can appear only after the name splice.
pub fn eval_ast<'a>(stored: &'a Expression, ctx: &NameEvalCtx<'_>) -> Cow<'a, Expression> {
    let has_names = needs_name_resolution(stored, ctx.named_ranges);
    let has_tables = crate::ast_has_table_refs(stored);
    let has_spills = crate::ast_has_spill_refs(stored);
    if !has_names && !has_tables && !has_spills {
        return Cow::Borrowed(stored);
    }
    let expanded = if has_names {
        let mut visited = HashSet::new();
        crate::resolve_names_in_ast(stored, ctx.named_ranges, ctx.sheet_index, &mut visited)
    } else {
        stored.clone()
    };
    let expanded = if crate::ast_has_table_refs(&expanded) {
        let table_ctx = crate::TableRefContext {
            tables: ctx.tables,
            table_names: ctx.table_names,
            current_sheet_index: ctx.sheet_index,
            current_row: ctx.row,
            current_col: ctx.col,
            sheet_names: ctx.sheet_names,
        };
        crate::resolve_table_refs_in_ast(&expanded, &table_ctx)
    } else {
        expanded
    };
    // The lock is taken and released HERE, around a pure map read: no
    // evaluation happens inside it. See `NameTables::spill_ranges`.
    let expanded = if crate::ast_has_spill_refs(&expanded) {
        let map = ctx.spill_ranges.read().unwrap();
        let out = crate::resolve_spill_refs_in_ast(&expanded, &map, ctx.sheet_index, ctx.sheet_names);
        drop(map);
        out
    } else {
        expanded
    };
    Cow::Owned(crate::convert_expr(&expanded))
}

/// True when `ast` mentions something THIS workbook's name table can expand.
///
/// Allocation-free and short-circuiting. Asking the name table (rather than
/// answering "any `NamedRef` or any `Custom` call", which is what
/// `ast_has_named_refs` does for the entry path) is what keeps `=LET(x,1,x+1)`
/// and `=MY_JS_UDF(A1)` on the borrowed path.
pub fn needs_name_resolution(ast: &Expression, named_ranges: &HashMap<String, NamedRange>) -> bool {
    if named_ranges.is_empty() {
        return false;
    }
    walk_needs(ast, named_ranges)
}

fn is_defined(name: &str, named_ranges: &HashMap<String, NamedRange>) -> bool {
    named_ranges.contains_key(&name.to_uppercase())
}

fn walk_needs(ast: &Expression, nr: &HashMap<String, NamedRange>) -> bool {
    match ast {
        Expression::NamedRef { name, .. } => is_defined(name, nr),
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::TableRef { .. } => false,
        Expression::BinaryOp { left, right, .. } => walk_needs(left, nr) || walk_needs(right, nr),
        Expression::UnaryOp { operand, .. } => walk_needs(operand, nr),
        Expression::FunctionCall { func, args, .. } => {
            if let BuiltinFunction::Custom(name) = func {
                if is_defined(name, nr) {
                    return true;
                }
            }
            args.iter().any(|a| walk_needs(a, nr))
        }
        Expression::Range { start, end, .. } => walk_needs(start, nr) || walk_needs(end, nr),
        Expression::Sheet3DRef { reference, .. } => walk_needs(reference, nr),
        Expression::IndexAccess { target, index } => walk_needs(target, nr) || walk_needs(index, nr),
        Expression::ArrayLiteral { rows } => rows.iter().flatten().any(|e| walk_needs(e, nr)),
        Expression::ListLiteral { elements } => elements.iter().any(|e| walk_needs(e, nr)),
        Expression::DictLiteral { entries } => entries
            .iter()
            .any(|(k, v)| walk_needs(k, nr) || walk_needs(v, nr)),
        Expression::SpillRef { cell, .. } => walk_needs(cell, nr),
        Expression::ImplicitIntersection { operand } => walk_needs(operand, nr),
    }
}

/// Every name a STORED formula resolves through — the dependency edge itself.
///
/// Records names whether or not they are currently DEFINED, and that is not an
/// oversight: `=RATE` before `RATE` exists is a `#NAME?` cell, and Excel turns it
/// into a number the moment the name is defined. Without the edge for an
/// undefined name, defining one would leave every `#NAME?` cell that was waiting
/// for it still saying `#NAME?`.
///
/// LET / LAMBDA parameter names are EXCLUDED. They are local bindings, they
/// shadow defined names during evaluation (`resolve_names_in_ast_with_shadows`),
/// and registering `=LET(rate, 0.2, rate*A1)` as a dependent of a workbook name
/// called `rate` would recalculate a formula the name cannot reach.
pub fn collect_names(ast: &Expression, out: &mut NameSet) {
    collect_with_shadows(ast, &[], out);
}

fn collect_with_shadows(ast: &Expression, shadows: &[String], out: &mut NameSet) {
    match ast {
        Expression::NamedRef { name, .. } => {
            let key = name.to_uppercase();
            if !shadows.contains(&key) {
                out.insert(key);
            }
        }
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::TableRef { .. } => {}
        Expression::BinaryOp { left, right, .. } => {
            collect_with_shadows(left, shadows, out);
            collect_with_shadows(right, shadows, out);
        }
        Expression::UnaryOp { operand, .. } => collect_with_shadows(operand, shadows, out),
        Expression::FunctionCall { func, args, .. } => match func {
            // LAMBDA(param1, ..., body): the leading arguments are BINDINGS.
            BuiltinFunction::Lambda if args.len() >= 2 => {
                let mut inner: Vec<String> = shadows.to_vec();
                for p in &args[..args.len() - 1] {
                    if let Expression::NamedRef { name, .. } = p {
                        inner.push(name.to_uppercase());
                    }
                }
                collect_with_shadows(args.last().unwrap(), &inner, out);
            }
            // LET(name1, value1, ..., calculation): odd positions are bindings.
            BuiltinFunction::Let if args.len() >= 3 && args.len() % 2 == 1 => {
                let pair_count = (args.len() - 1) / 2;
                let mut inner: Vec<String> = shadows.to_vec();
                for i in 0..pair_count {
                    if let Expression::NamedRef { name, .. } = &args[i * 2] {
                        inner.push(name.to_uppercase());
                    }
                }
                for (idx, arg) in args.iter().enumerate() {
                    if idx % 2 == 0 && idx < args.len() - 1 {
                        continue; // a binding position, not a reference
                    }
                    collect_with_shadows(arg, &inner, out);
                }
            }
            _ => {
                // `=myLambda(5)` is a name in FUNCTION position. `__INVOKE__` is
                // the already-expanded marker, never a user name.
                if let BuiltinFunction::Custom(name) = func {
                    let key = name.to_uppercase();
                    if key != "__INVOKE__" && !shadows.contains(&key) {
                        out.insert(key);
                    }
                }
                for a in args {
                    collect_with_shadows(a, shadows, out);
                }
            }
        },
        Expression::Range { start, end, .. } => {
            collect_with_shadows(start, shadows, out);
            collect_with_shadows(end, shadows, out);
        }
        Expression::Sheet3DRef { reference, .. } => collect_with_shadows(reference, shadows, out),
        Expression::IndexAccess { target, index } => {
            collect_with_shadows(target, shadows, out);
            collect_with_shadows(index, shadows, out);
        }
        Expression::ArrayLiteral { rows } => {
            for e in rows.iter().flatten() {
                collect_with_shadows(e, shadows, out);
            }
        }
        Expression::ListLiteral { elements } => {
            for e in elements {
                collect_with_shadows(e, shadows, out);
            }
        }
        Expression::DictLiteral { entries } => {
            for (k, v) in entries {
                collect_with_shadows(k, shadows, out);
                collect_with_shadows(v, shadows, out);
            }
        }
        Expression::SpillRef { cell, .. } => collect_with_shadows(cell, shadows, out),
        Expression::ImplicitIntersection { operand } => collect_with_shadows(operand, shadows, out),
    }
}

/// Restamp every reference to a DEFINED name with that name's own
/// capitalisation, in place.
///
/// WHY THIS IS NEEDED AT ALL. The lexer normalises bare identifiers to
/// UPPERCASE (`core/parser/src/lexer.rs:196`), which never showed before because
/// a name never reached the document — it was expanded to `$D$5` at entry. Now
/// that the cell keeps the name, `=SalesData*2` would come back from the formula
/// bar as `=SALESDATA*2`, and `=myLambda(5)` as `=MYLAMBDA(5)`. Excel shows the
/// name as the Name Manager spells it, and the product already cared about
/// exactly this for named LAMBDAs — the `__INVOKE__` marker carried a display-name
/// literal for no other reason. This restores that for every name, at the one
/// place a formula enters the document.
///
/// PURELY COSMETIC BY CONSTRUCTION: every lookup on this path uppercases
/// (`named_ranges` is UPPERCASE-keyed, `resolve_names_in_ast` uppercases, the
/// evaluator's LET/LAMBDA scope uppercases, `collect_names` uppercases), so no
/// resolution, edge or value can depend on the spelling stored here.
///
/// LET / LAMBDA BINDING POSITIONS are skipped: those identifiers are locals, and
/// respelling one after a workbook name that merely collides with it would tell
/// the reader the wrong thing about where the value comes from.
pub fn restamp_name_casing(ast: &mut Expression, named_ranges: &HashMap<String, NamedRange>) {
    if named_ranges.is_empty() {
        return;
    }
    restamp(ast, named_ranges, &[]);
}

/// The same restamp, over every stored formula of one sheet's grid — the LOAD
/// half of the entry-time pass above.
///
/// WHY A SECOND CALL SITE EXISTS, AND WHY IT IS NOT A SECOND RECIPE. `split_entered_formula`
/// restamps what the USER types; nothing restamped what a `.cala` brings back.
/// A cell stores only its AST (`engine::Cell` has no raw formula field —
/// `formula_string()` renders it), so a reload re-parses the saved text and the
/// lexer's uppercasing lands on the AST that entry had deliberately spelled
/// correctly. Measured: `=BudgetTotal` saved, reopened as `=BUDGETTOTAL`
/// (§2t). It is the SAME function doing the work — `restamp_name_casing` — so
/// entry and reload cannot disagree about what a name is called.
///
/// COSMETIC BY CONSTRUCTION, exactly as above: it rewrites the `name` field of
/// `NamedRef` nodes and touches nothing else. No value, no edge and no lookup
/// can move, because every lookup on this path uppercases. That is also why it
/// runs BEFORE `rebuild_all_dependencies` rather than after — not because the
/// order matters for correctness, but so the maps are built from the ASTs the
/// document will keep.
///
/// NOT A CELL WRITE. It mutates the AST a cell already holds in place; it calls
/// neither `set_cell` nor `clear_cell` and creates no new value, so it is not a
/// member of the recalculation census's population and needs no exemption.
/// Returns how many references were respelled, for logging.
pub fn restamp_grid_name_casing(
    grid: &mut engine::Grid,
    named_ranges: &HashMap<String, NamedRange>,
) -> usize {
    if named_ranges.is_empty() {
        return 0;
    }
    let mut changed = 0usize;
    for cell in grid.cells.values_mut() {
        let Some(ast) = cell.ast.as_deref_mut() else { continue };
        // The gate keeps the dominant case (no names anywhere in the formula)
        // off the render path entirely; only a formula that actually mentions
        // a name is rendered twice to see whether its spelling moved.
        if !crate::ast_has_named_refs(ast) {
            continue;
        }
        let before = engine::ast_render::render_formula_raw(ast);
        restamp(ast, named_ranges, &[]);
        if engine::ast_render::render_formula_raw(ast) != before {
            changed += 1;
        }
    }
    changed
}

fn defined_spelling(name: &str, nr: &HashMap<String, NamedRange>) -> Option<String> {
    let entry = nr.get(&name.to_uppercase())?;
    (entry.name != name).then(|| entry.name.clone())
}

fn restamp(ast: &mut Expression, nr: &HashMap<String, NamedRange>, shadows: &[String]) {
    match ast {
        Expression::NamedRef { name, .. } => {
            if shadows.contains(&name.to_uppercase()) {
                return;
            }
            if let Some(spelling) = defined_spelling(name, nr) {
                *name = spelling;
            }
        }
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::TableRef { .. } => {}
        Expression::BinaryOp { left, right, .. } => {
            restamp(left, nr, shadows);
            restamp(right, nr, shadows);
        }
        Expression::UnaryOp { operand, .. } => restamp(operand, nr, shadows),
        Expression::FunctionCall { func, args, .. } => {
            // Binding positions first, so the body sees the right shadow set.
            let (skip_head, bound): (usize, Vec<String>) = match func {
                BuiltinFunction::Lambda if args.len() >= 2 => (
                    args.len() - 1,
                    args[..args.len() - 1]
                        .iter()
                        .filter_map(|a| match a {
                            Expression::NamedRef { name, .. } => Some(name.to_uppercase()),
                            _ => None,
                        })
                        .collect(),
                ),
                BuiltinFunction::Let if args.len() >= 3 && args.len() % 2 == 1 => (
                    0,
                    (0..(args.len() - 1) / 2)
                        .filter_map(|i| match &args[i * 2] {
                            Expression::NamedRef { name, .. } => Some(name.to_uppercase()),
                            _ => None,
                        })
                        .collect(),
                ),
                _ => {
                    if let BuiltinFunction::Custom(name) = func {
                        if !shadows.contains(&name.to_uppercase()) {
                            if let Some(spelling) = defined_spelling(name, nr) {
                                *func = BuiltinFunction::Custom(spelling);
                            }
                        }
                    }
                    (0, Vec::new())
                }
            };
            let inner: Vec<String> = if bound.is_empty() {
                shadows.to_vec()
            } else {
                let mut v = shadows.to_vec();
                v.extend(bound);
                v
            };
            let is_let = matches!(func, BuiltinFunction::Let) && !inner.is_empty();
            let arg_count = args.len();
            for (idx, arg) in args.iter_mut().enumerate() {
                // LAMBDA: the leading params are bindings. LET: the even
                // positions before the final calculation are bindings.
                if skip_head > 0 && idx < skip_head {
                    continue;
                }
                if is_let && idx % 2 == 0 && idx < arg_count - 1 {
                    continue;
                }
                restamp(arg, nr, &inner);
            }
        }
        Expression::Range { start, end, .. } => {
            restamp(start, nr, shadows);
            restamp(end, nr, shadows);
        }
        Expression::Sheet3DRef { reference, .. } => restamp(reference, nr, shadows),
        Expression::IndexAccess { target, index } => {
            restamp(target, nr, shadows);
            restamp(index, nr, shadows);
        }
        Expression::ArrayLiteral { rows } => {
            for e in rows.iter_mut().flatten() {
                restamp(e, nr, shadows);
            }
        }
        Expression::ListLiteral { elements } => {
            for e in elements {
                restamp(e, nr, shadows);
            }
        }
        Expression::DictLiteral { entries } => {
            for (k, v) in entries {
                restamp(k, nr, shadows);
                restamp(v, nr, shadows);
            }
        }
        Expression::SpillRef { cell, .. } => restamp(cell, nr, shadows),
        Expression::ImplicitIntersection { operand } => restamp(operand, nr, shadows),
    }
}

// ============================================================================
// RENAMING A DEFINED NAME — THE REPOINT
// ============================================================================

/// Rewrite every reference to `old_name` as `new_name`, and report whether
/// anything moved.
///
/// WHY THIS EXISTS. `rename_named_range` used to move the registry key and
/// nothing else. D2 stores the NAME inside the formula and resolves it while
/// calculating, so the instant the key moved, every formula that read the old
/// name resolved to nothing and showed `#NAME?` — a rename broke the workbook,
/// and the product's answer was a confirmation dialog the user could click
/// through. Excel's Name Manager carries the references with the rename; so does
/// this now.
///
/// IT IS [`restamp`] WITH A DIFFERENT AUTHORITY, deliberately, function for
/// function: the same walk, the same shadow rules, and the same treatment of a
/// name in FUNCTION position (`=myLambda(5)` parses as a `Custom` call whose
/// callee is a name, and a named LAMBDA is renamed from the Name Manager like
/// any other name). Keeping the two the same shape is what stops them
/// disagreeing about what counts as a reference to a defined name — and this
/// walk must agree with [`collect_names`] exactly, because that is the walk that
/// decides which cells the name's dependency edge reaches. A cell the edge
/// counts as a reader and this walk does not rewrite is a cell that recalculates
/// to `#NAME?` after the rename.
///
/// SHADOWING IS NOT COSMETIC HERE. `restamp` re-spells, so getting a LET binding
/// wrong there misleads a reader; this REPOINTS, so getting it wrong changes
/// what the formula COMPUTES. `=LET(rate, 2, rate*10)` binds a local that
/// shadows a workbook name called `rate` during evaluation (that is what
/// `a_let_binding_that_shadows_a_name_earns_no_edge` pins), so rewriting it
/// would silently bind the formula to a name it never read.
///
/// `__INVOKE__` is the already-expanded named-LAMBDA marker, never a user name.
/// It is skipped for the reason [`collect_names`] skips it: it earns no edge, so
/// it must not earn a rewrite either.
///
/// A reference already spelled `new_name` reports NO change, so a case-only
/// rename ("total" -> "Total") only touches the cells whose spelling actually
/// moves.
pub fn rename_name_in_ast(ast: &Expression, old_name: &str, new_name: &str) -> (Expression, bool) {
    let mut out = ast.clone();
    let mut changed = false;
    rename_walk(&mut out, &old_name.to_uppercase(), new_name, &[], &mut changed);
    (out, changed)
}

fn rename_walk(
    ast: &mut Expression,
    old_upper: &str,
    new_name: &str,
    shadows: &[String],
    changed: &mut bool,
) {
    match ast {
        Expression::NamedRef { name, .. } => {
            let key = name.to_uppercase();
            if shadows.contains(&key) || key != old_upper || name == new_name {
                return;
            }
            // The name is written in the USER'S SPELLING, the same thing
            // `restamp` puts there. It does not survive a bare render ->
            // re-parse — the lexer uppercases every identifier — and it does not
            // need to: `restamp_name_casing` runs on the reload path for exactly
            // that reason, and is what makes `=Fee*100` come home spelled `Fee`.
            *name = new_name.to_string();
            *changed = true;
        }
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::TableRef { .. } => {}
        Expression::BinaryOp { left, right, .. } => {
            rename_walk(left, old_upper, new_name, shadows, changed);
            rename_walk(right, old_upper, new_name, shadows, changed);
        }
        Expression::UnaryOp { operand, .. } => {
            rename_walk(operand, old_upper, new_name, shadows, changed)
        }
        Expression::FunctionCall { func, args, .. } => {
            // Binding positions first, so the body sees the right shadow set —
            // the identical shape `restamp` uses.
            let (skip_head, bound): (usize, Vec<String>) = match func {
                BuiltinFunction::Lambda if args.len() >= 2 => (
                    args.len() - 1,
                    args[..args.len() - 1]
                        .iter()
                        .filter_map(|a| match a {
                            Expression::NamedRef { name, .. } => Some(name.to_uppercase()),
                            _ => None,
                        })
                        .collect(),
                ),
                BuiltinFunction::Let if args.len() >= 3 && args.len() % 2 == 1 => (
                    0,
                    (0..(args.len() - 1) / 2)
                        .filter_map(|i| match &args[i * 2] {
                            Expression::NamedRef { name, .. } => Some(name.to_uppercase()),
                            _ => None,
                        })
                        .collect(),
                ),
                _ => {
                    if let BuiltinFunction::Custom(name) = func {
                        let key = name.to_uppercase();
                        if key != "__INVOKE__"
                            && !shadows.contains(&key)
                            && key == old_upper
                            && name != new_name
                        {
                            *func = BuiltinFunction::Custom(new_name.to_string());
                            *changed = true;
                        }
                    }
                    (0, Vec::new())
                }
            };
            let inner: Vec<String> = if bound.is_empty() {
                shadows.to_vec()
            } else {
                let mut v = shadows.to_vec();
                v.extend(bound);
                v
            };
            let is_let = matches!(func, BuiltinFunction::Let) && !inner.is_empty();
            let arg_count = args.len();
            for (idx, arg) in args.iter_mut().enumerate() {
                // LAMBDA: the leading params are bindings. LET: the even
                // positions before the final calculation are bindings.
                if skip_head > 0 && idx < skip_head {
                    continue;
                }
                if is_let && idx % 2 == 0 && idx < arg_count - 1 {
                    continue;
                }
                rename_walk(arg, old_upper, new_name, &inner, changed);
            }
        }
        Expression::Range { start, end, .. } => {
            rename_walk(start, old_upper, new_name, shadows, changed);
            rename_walk(end, old_upper, new_name, shadows, changed);
        }
        Expression::Sheet3DRef { reference, .. } => {
            rename_walk(reference, old_upper, new_name, shadows, changed)
        }
        Expression::IndexAccess { target, index } => {
            rename_walk(target, old_upper, new_name, shadows, changed);
            rename_walk(index, old_upper, new_name, shadows, changed);
        }
        Expression::ArrayLiteral { rows } => {
            for e in rows.iter_mut().flatten() {
                rename_walk(e, old_upper, new_name, shadows, changed);
            }
        }
        Expression::ListLiteral { elements } => {
            for e in elements {
                rename_walk(e, old_upper, new_name, shadows, changed);
            }
        }
        Expression::DictLiteral { entries } => {
            for (k, v) in entries {
                rename_walk(k, old_upper, new_name, shadows, changed);
                rename_walk(v, old_upper, new_name, shadows, changed);
            }
        }
        Expression::SpillRef { cell, .. } => {
            rename_walk(cell, old_upper, new_name, shadows, changed)
        }
        Expression::ImplicitIntersection { operand } => {
            rename_walk(operand, old_upper, new_name, shadows, changed)
        }
    }
}

/// Re-point one formula cell's name edges. Same contract as
/// `update_column_dependencies`: old edges are removed, new ones inserted, and
/// an emptied bucket is dropped so the map does not grow monotonically.
pub fn update_name_dependencies(
    cell_pos: (u32, u32),
    new_names: NameSet,
    name_dependencies: &mut NameDependenciesMap,
    name_dependents: &mut NameDependentsMap,
) {
    let old_names = name_dependencies.remove(&cell_pos).unwrap_or_default();

    for old in &old_names {
        if let Some(deps) = name_dependents.get_mut(old) {
            deps.remove(&cell_pos);
            if deps.is_empty() {
                name_dependents.remove(old);
            }
        }
    }

    for new in &new_names {
        name_dependents.entry(new.clone()).or_default().insert(cell_pos);
    }

    if !new_names.is_empty() {
        name_dependencies.insert(cell_pos, new_names);
    }
}

/// The names a formula cell's STORED AST reads, ready for
/// [`update_name_dependencies`]. Empty for a non-formula cell.
pub fn names_of_cell(cell: &engine::Cell) -> NameSet {
    let mut out = NameSet::default();
    if let Some(ast) = cell.get_ast() {
        collect_names(ast, &mut out);
    }
    out
}

/// Does this cell's formula read any of `wanted` (UPPERCASE keys)?
///
/// The allocation-free form of `names_of_cell(...).intersects(...)`, and the
/// distinction is not pedantry: `recalc_after_name_change` asks this of EVERY
/// cell on every non-active sheet to decide which sheets a name change reaches,
/// and building a `HashSet` per cell would put an allocation per cell on a
/// gesture as ordinary as editing a name in the Name Manager.
pub fn cell_reads_any_name(cell: &engine::Cell, wanted: &NameSet) -> bool {
    if wanted.is_empty() {
        return false;
    }
    match cell.get_ast() {
        Some(ast) => reads_any(ast, wanted, &[]),
        None => false,
    }
}

fn reads_any(ast: &Expression, wanted: &NameSet, shadows: &[String]) -> bool {
    match ast {
        Expression::NamedRef { name, .. } => {
            let key = name.to_uppercase();
            !shadows.contains(&key) && wanted.contains(&key)
        }
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::TableRef { .. } => false,
        Expression::BinaryOp { left, right, .. } => {
            reads_any(left, wanted, shadows) || reads_any(right, wanted, shadows)
        }
        Expression::UnaryOp { operand, .. } => reads_any(operand, wanted, shadows),
        Expression::FunctionCall { func, args, .. } => match func {
            BuiltinFunction::Lambda if args.len() >= 2 => {
                let mut inner: Vec<String> = shadows.to_vec();
                for p in &args[..args.len() - 1] {
                    if let Expression::NamedRef { name, .. } = p {
                        inner.push(name.to_uppercase());
                    }
                }
                reads_any(args.last().unwrap(), wanted, &inner)
            }
            BuiltinFunction::Let if args.len() >= 3 && args.len() % 2 == 1 => {
                let mut inner: Vec<String> = shadows.to_vec();
                for i in 0..(args.len() - 1) / 2 {
                    if let Expression::NamedRef { name, .. } = &args[i * 2] {
                        inner.push(name.to_uppercase());
                    }
                }
                args.iter().enumerate().any(|(idx, a)| {
                    !(idx % 2 == 0 && idx < args.len() - 1) && reads_any(a, wanted, &inner)
                })
            }
            _ => {
                if let BuiltinFunction::Custom(name) = func {
                    let key = name.to_uppercase();
                    if key != "__INVOKE__" && !shadows.contains(&key) && wanted.contains(&key) {
                        return true;
                    }
                }
                args.iter().any(|a| reads_any(a, wanted, shadows))
            }
        },
        Expression::Range { start, end, .. } => {
            reads_any(start, wanted, shadows) || reads_any(end, wanted, shadows)
        }
        Expression::Sheet3DRef { reference, .. } => reads_any(reference, wanted, shadows),
        Expression::IndexAccess { target, index } => {
            reads_any(target, wanted, shadows) || reads_any(index, wanted, shadows)
        }
        Expression::ArrayLiteral { rows } => {
            rows.iter().flatten().any(|e| reads_any(e, wanted, shadows))
        }
        Expression::ListLiteral { elements } => elements.iter().any(|e| reads_any(e, wanted, shadows)),
        Expression::DictLiteral { entries } => entries
            .iter()
            .any(|(k, v)| reads_any(k, wanted, shadows) || reads_any(v, wanted, shadows)),
        Expression::SpillRef { cell, .. } => reads_any(cell, wanted, shadows),
        Expression::ImplicitIntersection { operand } => reads_any(operand, wanted, shadows),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ast(f: &str) -> Expression {
        parser::parse(f).expect("test formula parses")
    }

    fn names(f: &str) -> Vec<String> {
        let mut out = NameSet::default();
        collect_names(&ast(f), &mut out);
        let mut v: Vec<String> = out.into_iter().collect();
        v.sort();
        v
    }

    #[test]
    fn a_bare_name_is_an_edge() {
        assert_eq!(names("=RATE"), vec!["RATE".to_string()]);
        assert_eq!(names("=RATE*B2"), vec!["RATE".to_string()]);
    }

    #[test]
    fn a_plain_reference_is_not() {
        assert!(names("=A1+B2").is_empty());
        assert!(names("=SUM(A1:A10)").is_empty());
    }

    #[test]
    fn a_name_in_function_position_is_an_edge() {
        // `=myLambda(5)` parses as a Custom call; the callee is a NAME.
        assert_eq!(names("=myLambda(5)"), vec!["MYLAMBDA".to_string()]);
    }

    #[test]
    fn let_and_lambda_bindings_are_locals_not_names() {
        // The binding position AND the body reference are both the local `x`.
        assert!(names("=LET(x, 5, x+1)").is_empty());
        assert!(names("=LAMBDA(a, b, a+b)").is_empty());
        // ...but a real name used inside a LET body still counts.
        assert_eq!(names("=LET(x, 5, x*RATE)"), vec!["RATE".to_string()]);
    }

    #[test]
    fn an_undefined_name_still_earns_an_edge() {
        // The #NAME? cell has to be recalculated when the name is DEFINED.
        let mut nr: HashMap<String, NamedRange> = HashMap::new();
        assert!(!needs_name_resolution(&ast("=RATE"), &nr));
        assert_eq!(names("=RATE"), vec!["RATE".to_string()]);

        nr.insert(
            "RATE".to_string(),
            NamedRange {
                name: "RATE".to_string(),
                sheet_index: None,
                refers_to: "=$D$5".to_string(),
                comment: None,
                folder: None,
            },
        );
        assert!(needs_name_resolution(&ast("=RATE"), &nr));
    }

    #[test]
    fn the_gate_ignores_custom_functions_that_are_not_names() {
        // `ast_has_named_refs` answers TRUE for any Custom call, which would
        // make every JS UDF pay a tree clone on every evaluation.
        let nr: HashMap<String, NamedRange> = HashMap::new();
        assert!(crate::ast_has_named_refs(&ast("=MY_JS_UDF(A1)")));
        assert!(!needs_name_resolution(&ast("=MY_JS_UDF(A1)"), &nr));
    }

    /// `cell_reads_any_name` is the allocation-free twin of
    /// `collect_names(...).contains(...)`, and two walks that must agree are two
    /// walks that can drift. Pinned against each other over every shape either
    /// one treats specially.
    #[test]
    fn the_fast_predicate_agrees_with_the_collecting_walk() {
        for formula in [
            "=RATE",
            "=RATE*B2",
            "=A1+B2",
            "=SUM(SalesData)",
            "=myLambda(5)",
            "=LET(x, 5, x+1)",
            "=LET(rate, 5, rate*RATE)",
            "=LAMBDA(a, b, a+b)",
            "=IF(A1>0, RATE, OTHER)",
            "=SUM(Sheet2!A1:A9)",
            "=INDEX(SalesData, 2)",
            "={1,2,3}",
        ] {
            let tree = ast(formula);
            let mut collected = NameSet::default();
            collect_names(&tree, &mut collected);

            let cell = engine::Cell::new_formula_with_ast(tree);
            for probe in ["RATE", "SALESDATA", "MYLAMBDA", "OTHER", "X", "A", "NOPE"] {
                let mut wanted = NameSet::default();
                wanted.insert(probe.to_string());
                assert_eq!(
                    cell_reads_any_name(&cell, &wanted),
                    collected.contains(probe),
                    "`{}` vs probe {}: the two name walks disagree",
                    formula,
                    probe
                );
            }
        }
    }

    #[test]
    fn edges_are_removed_when_a_formula_stops_using_a_name() {
        let mut deps = NameDependenciesMap::default();
        let mut dependents = NameDependentsMap::default();

        let mut first = NameSet::default();
        first.insert("RATE".to_string());
        update_name_dependencies((0, 0), first, &mut deps, &mut dependents);
        assert!(dependents.get("RATE").unwrap().contains(&(0, 0)));

        // The cell is retyped as `=B2` — no names at all.
        update_name_dependencies((0, 0), NameSet::default(), &mut deps, &mut dependents);
        assert!(dependents.get("RATE").is_none(), "an emptied bucket is dropped");
        assert!(deps.get(&(0, 0)).is_none());
    }

    // -----------------------------------------------------------------------
    // The repoint
    // -----------------------------------------------------------------------

    /// Render a formula after renaming `old` to `new`, or `None` when the walk
    /// reports nothing moved.
    fn renamed(formula: &str, old: &str, new: &str) -> Option<String> {
        let (out, changed) = rename_name_in_ast(&ast(formula), old, new);
        changed.then(|| format!("={}", engine::ast_render::render_formula_raw(&out)))
    }

    #[test]
    fn a_rename_repoints_every_reference_to_the_old_name() {
        assert_eq!(renamed("=RATE", "RATE", "Fee").as_deref(), Some("=Fee"));
        assert_eq!(
            renamed("=RATE*B2+SUM(RATE)", "RATE", "Fee").as_deref(),
            Some("=Fee*B2+SUM(Fee)"),
            "every occurrence, not the first one"
        );
    }

    #[test]
    fn a_rename_matches_the_old_name_without_regard_to_case() {
        // The registry is UPPERCASE-keyed and the lexer uppercases bare
        // identifiers, but a quoted or restamped tree can hold any spelling.
        assert_eq!(renamed("=rate*2", "RATE", "Fee").as_deref(), Some("=Fee*2"));
        assert_eq!(renamed("=Rate*2", "rate", "Fee").as_deref(), Some("=Fee*2"));
    }

    #[test]
    fn a_rename_leaves_every_other_name_alone() {
        assert_eq!(
            renamed("=RATE+OTHER", "RATE", "Fee").as_deref(),
            Some("=Fee+OTHER")
        );
        assert!(
            renamed("=OTHER*2", "RATE", "Fee").is_none(),
            "a formula naming nothing that moved must report unchanged, or every \
             cell in the workbook would be rewritten and recorded for undo"
        );
    }

    #[test]
    fn a_name_in_function_position_is_repointed_too() {
        // `=myLambda(5)` is a Custom call whose CALLEE is the name — a named
        // LAMBDA is renamed from the Name Manager like any other name, and
        // leaving the callee behind would turn the call into #NAME?.
        assert_eq!(
            renamed("=myLambda(5)", "MYLAMBDA", "Doubler").as_deref(),
            Some("=Doubler(5)")
        );
    }

    #[test]
    fn a_shadowed_let_or_lambda_parameter_is_not_repointed() {
        // The binding is a LOCAL that shadows the workbook name during
        // evaluation, so rewriting it would change what the formula COMPUTES.
        assert!(
            renamed("=LET(rate, 2, rate*10)", "RATE", "Fee").is_none(),
            "both the binding position and the body reference are the local"
        );
        assert!(
            renamed("=LAMBDA(rate, rate*2)", "RATE", "Fee").is_none(),
            "a LAMBDA parameter shadows the name in the body too"
        );
        // ...but a real reference beside the shadow still moves. (The binding
        // itself comes back from the lexer in capitals — restamping a LOCAL is
        // exactly what `restamp` refuses to do, and this walk inherits that.)
        assert_eq!(
            renamed("=LET(rate, 2, rate*RATE2)", "RATE2", "Fee").as_deref(),
            Some("=LET(RATE,2,RATE*Fee)")
        );
    }

    #[test]
    fn a_reference_already_spelled_the_new_way_reports_no_change() {
        // WHAT THIS CANNOT ASSERT, and the earlier version of it did: that
        // `=Total*2` and `=TOTAL*2` behave differently. They are the SAME TREE.
        // The lexer uppercases every bare identifier (core/parser/src/lexer.rs),
        // so both parse to `NamedRef { name: "TOTAL" }`, and no rule could give
        // one input two answers.
        assert_eq!(ast("=Total*2"), ast("=TOTAL*2"));

        // What DOES hold: a reference whose stored spelling already matches the
        // new name reports no change, so the walk records no undo entry that
        // would restore nothing. Only reachable when something put the
        // user-cased spelling there — `restamp_name_casing` on entry or reload.
        let mut already = ast("=TOTAL*2");
        let mut registry: HashMap<String, NamedRange> = HashMap::new();
        registry.insert("TOTAL".to_string(), NamedRange {
            name: "Total".to_string(),
            sheet_index: None,
            refers_to: "=$A$1".to_string(),
            comment: None,
            folder: None,
        });
        restamp_name_casing(&mut already, &registry);
        let (_, changed) = rename_name_in_ast(&already, "TOTAL", "Total");
        assert!(!changed, "a spelling that is already the new one has not moved");

        // And a spelling that HAS moved is rewritten.
        assert_eq!(
            renamed("=TOTAL*2", "TOTAL", "Total").as_deref(),
            Some("=Total*2")
        );
    }

    #[test]
    fn the_expanded_invoke_marker_is_never_renamed() {
        // `__INVOKE__` is the already-expanded named-LAMBDA marker, never a user
        // name. `collect_names` gives it no edge, so it must earn no rewrite —
        // rewriting it would destroy the call.
        assert!(renamed("=__INVOKE__(\"F\", 1)", "__INVOKE__", "Fee").is_none());
    }

    /// The repoint walk and the EDGE walk must agree cell for cell. A cell the
    /// edge counts as a reader but the repoint skips is a cell that recalculates
    /// to `#NAME?` the moment the name is renamed — which is the whole defect the
    /// repoint exists to remove. Pinned over every shape either one treats
    /// specially, in both directions.
    #[test]
    fn the_repoint_moves_exactly_what_the_edge_walk_counts_as_a_reader() {
        for formula in [
            "=RATE",
            "=RATE*B2",
            "=A1+B2",
            "=SUM(SalesData)",
            "=myLambda(5)",
            "=LET(x, 5, x+1)",
            "=LET(rate, 5, rate*RATE)",
            "=LAMBDA(a, b, a+b)",
            "=IF(A1>0, RATE, OTHER)",
            "=SUM(Sheet2!A1:A9)",
            "=INDEX(SalesData, 2)",
            "={1,2,3}",
            "=\"RATE\"",
        ] {
            let tree = ast(formula);
            let mut collected = NameSet::default();
            collect_names(&tree, &mut collected);

            for probe in ["RATE", "SALESDATA", "MYLAMBDA", "OTHER", "X", "A", "NOPE"] {
                let (_, changed) = rename_name_in_ast(&tree, probe, "RenamedZ");
                assert_eq!(
                    changed,
                    collected.contains(probe),
                    "`{}` vs probe {}: the repoint walk and the edge walk disagree \
                     about whether this formula reads the name",
                    formula,
                    probe
                );
            }
        }
    }

    /// The rewritten tree has to survive the renderer, because that is what the
    /// formula bar shows and what `.cala` saves. A cell stores only its AST
    /// (`engine::Cell` has no raw formula field), so the text is DERIVED — but a
    /// text that cannot be read back would come home from a reload as a value
    /// cell with an empty formula bar.
    ///
    /// STABILITY IS MEASURED THROUGH `restamp_name_casing`, because that is the
    /// product's actual reload path and the reason the AST may carry a spelling
    /// the lexer cannot reproduce. Rendering `=Fee*100` and re-parsing it gives
    /// `FEE` — the lexer uppercases every bare identifier — and `restamp` is
    /// what puts `Fee` back, on entry AND on load, from the one registry that
    /// knows how the name is spelled. A version of this test that omitted the
    /// restamp step asserted a property the product does not have and does not
    /// need, and it failed for that reason rather than finding a defect.
    #[test]
    fn the_repointed_tree_still_round_trips_through_the_renderer() {
        let mut registry: HashMap<String, NamedRange> = HashMap::new();
        registry.insert("FEE".to_string(), NamedRange {
            name: "Fee".to_string(),
            sheet_index: None,
            refers_to: "=$A$1".to_string(),
            comment: None,
            folder: None,
        });

        for formula in ["=RATE*100", "=SUM(RATE)+RATE", "=myLambda(RATE)"] {
            let (out, changed) = rename_name_in_ast(&ast(formula), "RATE", "Fee");
            assert!(changed, "`{}` should have moved", formula);
            let rendered = format!("={}", engine::ast_render::render_formula_raw(&out));
            let mut reparsed = parser::parse(&rendered)
                .unwrap_or_else(|e| panic!("`{}` rendered `{}` which does not lex: {}", formula, rendered, e));
            restamp_name_casing(&mut reparsed, &registry);
            assert_eq!(
                format!("={}", engine::ast_render::render_formula_raw(&reparsed)),
                rendered,
                "`{}` keeps changing every time it goes through the serialiser",
                formula
            );
        }
    }
}
