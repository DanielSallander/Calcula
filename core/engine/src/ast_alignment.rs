//! FILENAME: core/engine/src/ast_alignment.rs
//! PURPOSE: Structural alignment of formula ASTs across edits.
//! CONTEXT: When a user edits a formula, the new string is parsed into a fresh
//! AST (with RefSiteId::ZERO on all nodes). This module aligns the new AST
//! against the previous AST to inherit stable reference-site IDs for nodes
//! that structurally match, and mints fresh IDs for new/changed nodes.
//!
//! ALGORITHM:
//! 1. Walk both trees in lockstep.
//! 2. If old and new are the same variant, inherit the old ref_site_id.
//! 3. For compound nodes (BinaryOp, FunctionCall), recursively align children.
//! 4. If variants differ (structural mismatch), mint fresh IDs on the new node.
//! 5. Heavy refactors (most of the formula rewritten) naturally reset most IDs.
//!    This is correct behavior: a substantially rewritten formula expresses
//!    different intent and should be treated as new references.

use identity::{IdRegistry, RefSiteId};
use parser::ast::Expression;

/// Align a newly-parsed AST against a previous AST, inheriting ref_site_ids
/// where nodes structurally match and minting fresh IDs where they don't.
///
/// After this call, every reference-bearing node in `new_ast` will have a
/// non-zero RefSiteId (either inherited or freshly minted).
pub fn align_ast(old: &Expression, new: &mut Expression, registry: &mut IdRegistry) {
    match (old, new) {
        // ---------------------------------------------------------------
        // Reference-bearing nodes: inherit ID if variant matches
        // ---------------------------------------------------------------
        (
            Expression::CellRef { ref_site_id: old_id, .. },
            Expression::CellRef { ref_site_id: new_id, .. },
        ) => {
            *new_id = *old_id;
        }

        (
            Expression::Range { ref_site_id: old_id, start: old_start, end: old_end, .. },
            Expression::Range { ref_site_id: new_id, start: new_start, end: new_end, .. },
        ) => {
            *new_id = *old_id;
            // Range endpoints are CellRefs with their own IDs — align them too
            align_ast(old_start, new_start, registry);
            align_ast(old_end, new_end, registry);
        }

        (
            Expression::ColumnRef { ref_site_id: old_id, .. },
            Expression::ColumnRef { ref_site_id: new_id, .. },
        ) => {
            *new_id = *old_id;
        }

        (
            Expression::RowRef { ref_site_id: old_id, .. },
            Expression::RowRef { ref_site_id: new_id, .. },
        ) => {
            *new_id = *old_id;
        }

        (
            Expression::NamedRef { ref_site_id: old_id, .. },
            Expression::NamedRef { ref_site_id: new_id, .. },
        ) => {
            *new_id = *old_id;
        }

        (
            Expression::Sheet3DRef { ref_site_id: old_id, reference: old_inner, .. },
            Expression::Sheet3DRef { ref_site_id: new_id, reference: new_inner, .. },
        ) => {
            *new_id = *old_id;
            align_ast(old_inner, new_inner, registry);
        }

        (
            Expression::TableRef { ref_site_id: old_id, .. },
            Expression::TableRef { ref_site_id: new_id, .. },
        ) => {
            *new_id = *old_id;
        }

        (
            Expression::SpillRef { ref_site_id: old_id, cell: old_cell },
            Expression::SpillRef { ref_site_id: new_id, cell: new_cell },
        ) => {
            *new_id = *old_id;
            align_ast(old_cell, new_cell, registry);
        }

        // ---------------------------------------------------------------
        // FunctionCall: inherit call-site ID, align args positionally
        // ---------------------------------------------------------------
        (
            Expression::FunctionCall { ref_site_id: old_id, args: old_args, .. },
            Expression::FunctionCall { ref_site_id: new_id, args: new_args, .. },
        ) => {
            *new_id = *old_id;
            let common_len = old_args.len().min(new_args.len());
            for i in 0..common_len {
                align_ast(&old_args[i], &mut new_args[i], registry);
            }
            // Args beyond old's length: mint fresh IDs
            for arg in new_args.iter_mut().skip(old_args.len()) {
                mint_all_ids(arg, registry);
            }
        }

        // ---------------------------------------------------------------
        // Structural nodes: recurse into children
        // ---------------------------------------------------------------
        (
            Expression::BinaryOp { left: old_left, right: old_right, .. },
            Expression::BinaryOp { left: new_left, right: new_right, .. },
        ) => {
            align_ast(old_left, new_left, registry);
            align_ast(old_right, new_right, registry);
        }

        (
            Expression::UnaryOp { operand: old_op, .. },
            Expression::UnaryOp { operand: new_op, .. },
        ) => {
            align_ast(old_op, new_op, registry);
        }

        (
            Expression::IndexAccess { target: old_t, index: old_i },
            Expression::IndexAccess { target: new_t, index: new_i },
        ) => {
            align_ast(old_t, new_t, registry);
            align_ast(old_i, new_i, registry);
        }

        (
            Expression::ListLiteral { elements: old_elems },
            Expression::ListLiteral { elements: new_elems },
        ) => {
            let common_len = old_elems.len().min(new_elems.len());
            for i in 0..common_len {
                align_ast(&old_elems[i], &mut new_elems[i], registry);
            }
            for elem in new_elems.iter_mut().skip(old_elems.len()) {
                mint_all_ids(elem, registry);
            }
        }

        (
            Expression::DictLiteral { entries: old_entries },
            Expression::DictLiteral { entries: new_entries },
        ) => {
            let common_len = old_entries.len().min(new_entries.len());
            for i in 0..common_len {
                align_ast(&old_entries[i].0, &mut new_entries[i].0, registry);
                align_ast(&old_entries[i].1, &mut new_entries[i].1, registry);
            }
            for entry in new_entries.iter_mut().skip(old_entries.len()) {
                mint_all_ids(&mut entry.0, registry);
                mint_all_ids(&mut entry.1, registry);
            }
        }

        (
            Expression::ImplicitIntersection { operand: old_op },
            Expression::ImplicitIntersection { operand: new_op },
        ) => {
            align_ast(old_op, new_op, registry);
        }

        // Literals: no IDs, nothing to align
        (Expression::Literal(_), Expression::Literal(_)) => {}

        // ---------------------------------------------------------------
        // Structural mismatch: different variants at same position.
        // Mint fresh IDs on everything in the new subtree.
        // ---------------------------------------------------------------
        (_, new_expr) => {
            mint_all_ids(new_expr, registry);
        }
    }
}

/// Mint fresh RefSiteIds on all reference-bearing nodes in an expression tree.
/// Used for:
/// - New formulas (no prior AST to align against)
/// - Subtrees that don't match the old AST structurally
pub fn mint_all_ids(expr: &mut Expression, registry: &mut IdRegistry) {
    match expr {
        Expression::CellRef { ref_site_id, .. } => {
            *ref_site_id = registry.mint_ref_site_id();
        }
        Expression::Range { ref_site_id, start, end, .. } => {
            *ref_site_id = registry.mint_ref_site_id();
            mint_all_ids(start, registry);
            mint_all_ids(end, registry);
        }
        Expression::ColumnRef { ref_site_id, .. } => {
            *ref_site_id = registry.mint_ref_site_id();
        }
        Expression::RowRef { ref_site_id, .. } => {
            *ref_site_id = registry.mint_ref_site_id();
        }
        Expression::NamedRef { ref_site_id, .. } => {
            *ref_site_id = registry.mint_ref_site_id();
        }
        Expression::Sheet3DRef { ref_site_id, reference, .. } => {
            *ref_site_id = registry.mint_ref_site_id();
            mint_all_ids(reference, registry);
        }
        Expression::TableRef { ref_site_id, .. } => {
            *ref_site_id = registry.mint_ref_site_id();
        }
        Expression::SpillRef { ref_site_id, cell } => {
            *ref_site_id = registry.mint_ref_site_id();
            mint_all_ids(cell, registry);
        }
        Expression::FunctionCall { ref_site_id, args, .. } => {
            *ref_site_id = registry.mint_ref_site_id();
            for arg in args.iter_mut() {
                mint_all_ids(arg, registry);
            }
        }
        Expression::BinaryOp { left, right, .. } => {
            mint_all_ids(left, registry);
            mint_all_ids(right, registry);
        }
        Expression::UnaryOp { operand, .. } => {
            mint_all_ids(operand, registry);
        }
        Expression::IndexAccess { target, index } => {
            mint_all_ids(target, registry);
            mint_all_ids(index, registry);
        }
        Expression::ListLiteral { elements } => {
            for elem in elements.iter_mut() {
                mint_all_ids(elem, registry);
            }
        }
        Expression::DictLiteral { entries } => {
            for (k, v) in entries.iter_mut() {
                mint_all_ids(k, registry);
                mint_all_ids(v, registry);
            }
        }
        Expression::ImplicitIntersection { operand } => {
            mint_all_ids(operand, registry);
        }
        Expression::Literal(_) => {}
    }
}

/// Check whether all reference-bearing nodes in an expression tree have
/// non-zero RefSiteIds. Useful for assertions in tests.
pub fn all_ids_assigned(expr: &Expression) -> bool {
    match expr {
        Expression::CellRef { ref_site_id, .. }
        | Expression::ColumnRef { ref_site_id, .. }
        | Expression::RowRef { ref_site_id, .. }
        | Expression::NamedRef { ref_site_id, .. }
        | Expression::TableRef { ref_site_id, .. } => {
            !ref_site_id.is_zero()
        }
        Expression::Range { ref_site_id, start, end, .. } => {
            !ref_site_id.is_zero() && all_ids_assigned(start) && all_ids_assigned(end)
        }
        Expression::Sheet3DRef { ref_site_id, reference, .. } => {
            !ref_site_id.is_zero() && all_ids_assigned(reference)
        }
        Expression::SpillRef { ref_site_id, cell } => {
            !ref_site_id.is_zero() && all_ids_assigned(cell)
        }
        Expression::FunctionCall { ref_site_id, args, .. } => {
            !ref_site_id.is_zero() && args.iter().all(all_ids_assigned)
        }
        Expression::BinaryOp { left, right, .. } => {
            all_ids_assigned(left) && all_ids_assigned(right)
        }
        Expression::UnaryOp { operand, .. } => all_ids_assigned(operand),
        Expression::IndexAccess { target, index } => {
            all_ids_assigned(target) && all_ids_assigned(index)
        }
        Expression::ListLiteral { elements } => {
            elements.iter().all(all_ids_assigned)
        }
        Expression::DictLiteral { entries } => {
            entries.iter().all(|(k, v)| all_ids_assigned(k) && all_ids_assigned(v))
        }
        Expression::ImplicitIntersection { operand } => all_ids_assigned(operand),
        Expression::Literal(_) => true,
    }
}

/// Collect all RefSiteIds from an expression tree (for testing/debugging).
pub fn collect_ref_site_ids(expr: &Expression) -> Vec<RefSiteId> {
    let mut ids = Vec::new();
    collect_ids_recursive(expr, &mut ids);
    ids
}

fn collect_ids_recursive(expr: &Expression, ids: &mut Vec<RefSiteId>) {
    match expr {
        Expression::CellRef { ref_site_id, .. }
        | Expression::ColumnRef { ref_site_id, .. }
        | Expression::RowRef { ref_site_id, .. }
        | Expression::NamedRef { ref_site_id, .. }
        | Expression::TableRef { ref_site_id, .. } => {
            ids.push(*ref_site_id);
        }
        Expression::Range { ref_site_id, start, end, .. } => {
            ids.push(*ref_site_id);
            collect_ids_recursive(start, ids);
            collect_ids_recursive(end, ids);
        }
        Expression::Sheet3DRef { ref_site_id, reference, .. } => {
            ids.push(*ref_site_id);
            collect_ids_recursive(reference, ids);
        }
        Expression::SpillRef { ref_site_id, cell } => {
            ids.push(*ref_site_id);
            collect_ids_recursive(cell, ids);
        }
        Expression::FunctionCall { ref_site_id, args, .. } => {
            ids.push(*ref_site_id);
            for arg in args {
                collect_ids_recursive(arg, ids);
            }
        }
        Expression::BinaryOp { left, right, .. } => {
            collect_ids_recursive(left, ids);
            collect_ids_recursive(right, ids);
        }
        Expression::UnaryOp { operand, .. } => {
            collect_ids_recursive(operand, ids);
        }
        Expression::IndexAccess { target, index } => {
            collect_ids_recursive(target, ids);
            collect_ids_recursive(index, ids);
        }
        Expression::ListLiteral { elements } => {
            for elem in elements {
                collect_ids_recursive(elem, ids);
            }
        }
        Expression::DictLiteral { entries } => {
            for (k, v) in entries {
                collect_ids_recursive(k, ids);
                collect_ids_recursive(v, ids);
            }
        }
        Expression::ImplicitIntersection { operand } => {
            collect_ids_recursive(operand, ids);
        }
        Expression::Literal(_) => {}
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use parser::ast::{BinaryOperator, BuiltinFunction, Value};

    fn make_cell_ref(col: &str, row: u32) -> Expression {
        Expression::CellRef {
            sheet: None,
            col: col.to_string(),
            row,
            col_absolute: false,
            row_absolute: false,
            ref_site_id: Default::default(),
        }
    }

    fn make_range(start_col: &str, start_row: u32, end_col: &str, end_row: u32) -> Expression {
        Expression::Range {
            sheet: None,
            start: Box::new(make_cell_ref(start_col, start_row)),
            end: Box::new(make_cell_ref(end_col, end_row)),
            ref_site_id: Default::default(),
        }
    }

    fn make_sum(args: Vec<Expression>) -> Expression {
        Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args,
            ref_site_id: Default::default(),
        }
    }

    #[test]
    fn mint_all_assigns_non_zero_ids() {
        let mut reg = IdRegistry::new();
        let mut expr = make_sum(vec![make_range("A", 1, "A", 10)]);

        assert!(!all_ids_assigned(&expr));
        mint_all_ids(&mut expr, &mut reg);
        assert!(all_ids_assigned(&expr));
    }

    #[test]
    fn align_preserves_ids_on_same_structure() {
        let mut reg = IdRegistry::new();

        // Old: =SUM(A1:A10)
        let mut old = make_sum(vec![make_range("A", 1, "A", 10)]);
        mint_all_ids(&mut old, &mut reg);
        let old_ids = collect_ref_site_ids(&old);

        // New: =SUM(A1:A10) — same structure
        let mut new = make_sum(vec![make_range("A", 1, "A", 10)]);
        align_ast(&old, &mut new, &mut reg);

        let new_ids = collect_ref_site_ids(&new);
        assert_eq!(old_ids, new_ids, "IDs should be preserved for identical structure");
    }

    #[test]
    fn align_preserves_ids_when_range_bounds_change() {
        let mut reg = IdRegistry::new();

        // Old: =SUM(A1:A10)
        let mut old = make_sum(vec![make_range("A", 1, "A", 10)]);
        mint_all_ids(&mut old, &mut reg);
        let old_ids = collect_ref_site_ids(&old);

        // New: =SUM(A1:A20) — same structure, different bounds
        let mut new = make_sum(vec![make_range("A", 1, "A", 20)]);
        align_ast(&old, &mut new, &mut reg);

        let new_ids = collect_ref_site_ids(&new);
        // SUM's call-site ID, Range ID, and endpoint CellRef IDs all inherited
        assert_eq!(old_ids, new_ids, "IDs should be preserved when bounds change");
    }

    #[test]
    fn align_mints_new_ids_for_structural_change() {
        let mut reg = IdRegistry::new();

        // Old: =A1+B1 (BinaryOp with two CellRefs)
        let mut old = Expression::BinaryOp {
            left: Box::new(make_cell_ref("A", 1)),
            op: BinaryOperator::Add,
            right: Box::new(make_cell_ref("B", 1)),
        };
        mint_all_ids(&mut old, &mut reg);
        let old_ids = collect_ref_site_ids(&old);

        // New: =SUM(A1:A10) (completely different structure)
        let mut new = make_sum(vec![make_range("A", 1, "A", 10)]);
        align_ast(&old, &mut new, &mut reg);

        let new_ids = collect_ref_site_ids(&new);
        assert!(all_ids_assigned(&new), "All new IDs should be assigned");
        // None of the new IDs should match old ones (different structure)
        for id in &new_ids {
            assert!(!old_ids.contains(id), "New IDs should be different from old");
        }
    }

    #[test]
    fn align_preserves_matched_args_mints_new_ones() {
        let mut reg = IdRegistry::new();

        // Old: =SUM(A1, B1)
        let mut old = make_sum(vec![make_cell_ref("A", 1), make_cell_ref("B", 1)]);
        mint_all_ids(&mut old, &mut reg);
        let old_ids = collect_ref_site_ids(&old);

        // New: =SUM(A1, B1, C1) — extra arg
        let mut new = make_sum(vec![
            make_cell_ref("A", 1),
            make_cell_ref("B", 1),
            make_cell_ref("C", 1),
        ]);
        align_ast(&old, &mut new, &mut reg);

        let new_ids = collect_ref_site_ids(&new);
        assert!(all_ids_assigned(&new), "All IDs should be assigned");
        // First 3 IDs (SUM call-site, A1, B1) should match
        assert_eq!(old_ids[0], new_ids[0], "SUM call-site ID preserved");
        assert_eq!(old_ids[1], new_ids[1], "A1 ID preserved");
        assert_eq!(old_ids[2], new_ids[2], "B1 ID preserved");
        // C1 should have a new ID
        assert!(!old_ids.contains(&new_ids[3]), "C1 should have a new ID");
    }

    #[test]
    fn align_literal_to_reference_mints_fresh() {
        let mut reg = IdRegistry::new();

        // Old: =42 (Literal)
        let old = Expression::Literal(Value::Number(42.0));

        // New: =A1 (CellRef — structural mismatch)
        let mut new = make_cell_ref("A", 1);
        align_ast(&old, &mut new, &mut reg);

        assert!(all_ids_assigned(&new), "CellRef should get a fresh ID");
    }

    #[test]
    fn mint_produces_unique_ids() {
        let mut reg = IdRegistry::new();
        let mut expr1 = make_cell_ref("A", 1);
        let mut expr2 = make_cell_ref("B", 2);

        mint_all_ids(&mut expr1, &mut reg);
        mint_all_ids(&mut expr2, &mut reg);

        let ids1 = collect_ref_site_ids(&expr1);
        let ids2 = collect_ref_site_ids(&expr2);
        assert_ne!(ids1[0], ids2[0], "Different nodes should get different IDs");
    }
}
