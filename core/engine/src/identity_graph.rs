//! FILENAME: core/engine/src/identity_graph.rs
//! PURPOSE: Identity-keyed dependency graph using (SheetId, CellId) vertices.
//! CONTEXT: This graph operates on stable identities rather than coordinates.
//! It coexists with the coordinate-based DependencyGraph during the transition
//! period. The coordinate graph handles recalculation; this graph handles
//! identity operations (rename, merge, override anchoring).
//!
//! The key benefit: structural shifts (row/col insert/delete) do NOT touch
//! this graph at all — only the IdRegistry's position maps are updated.
//! The graph's edges are stable across structural changes.

use std::collections::{HashMap, HashSet, VecDeque};
use identity::{CellId, SheetId};

/// A vertex in the identity graph: a cell identified by (sheet, cell_id).
pub type IdentityVertex = (SheetId, CellId);

/// Error type for cycle detection in the identity graph.
#[derive(Debug, Clone, PartialEq)]
pub struct IdentityCycleError {
    pub cycle_path: Vec<IdentityVertex>,
}

impl std::fmt::Display for IdentityCycleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Circular reference detected in identity graph: ")?;
        for (i, (sheet, cell)) in self.cycle_path.iter().enumerate() {
            if i > 0 { write!(f, " -> ")?; }
            write!(f, "({}, {})", sheet, cell)?;
        }
        Ok(())
    }
}

impl std::error::Error for IdentityCycleError {}

/// Identity-keyed dependency graph.
///
/// Vertices are `(SheetId, CellId)` — stable across structural shifts.
/// Cross-sheet dependencies are first-class (no separate maps needed).
///
/// Also tracks whole-column and whole-row dependencies which can't be
/// expressed as cell-level edges.
#[derive(Debug, Default)]
pub struct IdentityGraph {
    /// For each cell, the set of cells it directly depends on.
    precedents: HashMap<IdentityVertex, HashSet<IdentityVertex>>,
    /// Reverse map: for each cell, the set of cells that depend on it.
    dependents: HashMap<IdentityVertex, HashSet<IdentityVertex>>,
    /// Cells that depend on entire columns: (sheet, col_index) -> set of dependent cells.
    column_dependents: HashMap<(SheetId, u32), HashSet<IdentityVertex>>,
    /// Cells that depend on entire rows: (sheet, row_index) -> set of dependent cells.
    row_dependents: HashMap<(SheetId, u32), HashSet<IdentityVertex>>,
}

impl IdentityGraph {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the cell-level dependencies for a vertex.
    pub fn set_dependencies(
        &mut self,
        cell: IdentityVertex,
        new_precedents: HashSet<IdentityVertex>,
    ) {
        self.clear_dependencies(cell);

        if !new_precedents.is_empty() {
            for &prec in &new_precedents {
                self.dependents.entry(prec).or_default().insert(cell);
            }
            self.precedents.insert(cell, new_precedents);
        }
    }

    /// Clear all dependencies for a vertex.
    pub fn clear_dependencies(&mut self, cell: IdentityVertex) {
        if let Some(old_precs) = self.precedents.remove(&cell) {
            for prec in old_precs {
                if let Some(deps) = self.dependents.get_mut(&prec) {
                    deps.remove(&cell);
                    if deps.is_empty() {
                        self.dependents.remove(&prec);
                    }
                }
            }
        }
    }

    /// Set column-level dependencies for a vertex.
    pub fn set_column_dependencies(
        &mut self,
        cell: IdentityVertex,
        columns: HashSet<(SheetId, u32)>,
    ) {
        // Remove old column deps for this cell
        self.column_dependents.retain(|_, deps| {
            deps.remove(&cell);
            !deps.is_empty()
        });
        // Add new
        for col_key in columns {
            self.column_dependents.entry(col_key).or_default().insert(cell);
        }
    }

    /// Set row-level dependencies for a vertex.
    pub fn set_row_dependencies(
        &mut self,
        cell: IdentityVertex,
        rows: HashSet<(SheetId, u32)>,
    ) {
        self.row_dependents.retain(|_, deps| {
            deps.remove(&cell);
            !deps.is_empty()
        });
        for row_key in rows {
            self.row_dependents.entry(row_key).or_default().insert(cell);
        }
    }

    /// Get direct precedents.
    pub fn get_precedents(&self, cell: IdentityVertex) -> Option<&HashSet<IdentityVertex>> {
        self.precedents.get(&cell)
    }

    /// Get direct dependents.
    pub fn get_dependents(&self, cell: IdentityVertex) -> Option<&HashSet<IdentityVertex>> {
        self.dependents.get(&cell)
    }

    /// Get all cells that depend on a column.
    pub fn get_column_dependents(&self, sheet: SheetId, col: u32) -> Option<&HashSet<IdentityVertex>> {
        self.column_dependents.get(&(sheet, col))
    }

    /// Get all cells that depend on a row.
    pub fn get_row_dependents(&self, sheet: SheetId, row: u32) -> Option<&HashSet<IdentityVertex>> {
        self.row_dependents.get(&(sheet, row))
    }

    /// Get all transitive dependents (BFS).
    pub fn get_all_dependents(&self, cell: IdentityVertex) -> HashSet<IdentityVertex> {
        let mut result = HashSet::new();
        let mut queue = VecDeque::new();

        if let Some(deps) = self.dependents.get(&cell) {
            for &dep in deps {
                queue.push_back(dep);
            }
        }

        while let Some(current) = queue.pop_front() {
            if result.contains(&current) { continue; }
            result.insert(current);
            if let Some(deps) = self.dependents.get(&current) {
                for &dep in deps {
                    if !result.contains(&dep) {
                        queue.push_back(dep);
                    }
                }
            }
        }
        result
    }

    /// Get recalculation order via topological sort (Kahn's algorithm).
    pub fn get_recalc_order(&self, changed: IdentityVertex) -> Result<Vec<IdentityVertex>, IdentityCycleError> {
        let affected = self.get_all_dependents(changed);
        if affected.is_empty() { return Ok(Vec::new()); }

        let mut in_degree: HashMap<IdentityVertex, usize> = HashMap::new();
        for &cell in &affected {
            in_degree.insert(cell, 0);
        }
        for &cell in &affected {
            if let Some(precs) = self.precedents.get(&cell) {
                for &prec in precs {
                    if affected.contains(&prec) {
                        *in_degree.get_mut(&cell).unwrap() += 1;
                    }
                }
            }
        }

        let mut queue: VecDeque<IdentityVertex> = in_degree
            .iter()
            .filter(|(_, &deg)| deg == 0)
            .map(|(&cell, _)| cell)
            .collect();

        let mut result = Vec::with_capacity(affected.len());
        while let Some(cell) = queue.pop_front() {
            result.push(cell);
            if let Some(deps) = self.dependents.get(&cell) {
                for &dep in deps {
                    if let Some(deg) = in_degree.get_mut(&dep) {
                        *deg -= 1;
                        if *deg == 0 { queue.push_back(dep); }
                    }
                }
            }
        }

        if result.len() != affected.len() {
            let cycle_cells: Vec<IdentityVertex> = in_degree
                .iter()
                .filter(|(_, &deg)| deg > 0)
                .map(|(&cell, _)| cell)
                .collect();
            return Err(IdentityCycleError { cycle_path: cycle_cells });
        }

        Ok(result)
    }

    /// Rename a vertex: rekey all edges from old to new.
    pub fn rename_vertex(&mut self, old: IdentityVertex, new: IdentityVertex) {
        if let Some(precs) = self.precedents.remove(&old) {
            for &prec in &precs {
                if let Some(deps) = self.dependents.get_mut(&prec) {
                    deps.remove(&old);
                    deps.insert(new);
                }
            }
            self.precedents.insert(new, precs);
        }

        if let Some(deps) = self.dependents.remove(&old) {
            for &dep in &deps {
                if let Some(precs) = self.precedents.get_mut(&dep) {
                    precs.remove(&old);
                    precs.insert(new);
                }
            }
            self.dependents.insert(new, deps);
        }
    }

    /// Merge two vertices: redirect all edges from absorbed to survivor.
    pub fn merge_vertices(&mut self, absorbed: IdentityVertex, survivor: IdentityVertex) {
        if let Some(absorbed_precs) = self.precedents.remove(&absorbed) {
            for &prec in &absorbed_precs {
                if let Some(deps) = self.dependents.get_mut(&prec) {
                    deps.remove(&absorbed);
                    deps.insert(survivor);
                }
            }
            let survivor_precs = self.precedents.entry(survivor).or_default();
            for prec in absorbed_precs { survivor_precs.insert(prec); }
        }

        if let Some(absorbed_deps) = self.dependents.remove(&absorbed) {
            for &dep in &absorbed_deps {
                if let Some(precs) = self.precedents.get_mut(&dep) {
                    precs.remove(&absorbed);
                    precs.insert(survivor);
                }
            }
            let survivor_deps = self.dependents.entry(survivor).or_default();
            for dep in absorbed_deps { survivor_deps.insert(dep); }
        }
    }

    /// Remove a vertex and all its edges.
    pub fn remove_vertex(&mut self, cell: IdentityVertex) {
        self.clear_dependencies(cell);
        // Also remove as a dependent source
        if let Some(deps) = self.dependents.remove(&cell) {
            for dep in deps {
                if let Some(precs) = self.precedents.get_mut(&dep) {
                    precs.remove(&cell);
                }
            }
        }
    }

    /// Remove all vertices for a sheet.
    pub fn remove_sheet(&mut self, sheet: SheetId) {
        let cells_to_remove: Vec<IdentityVertex> = self.precedents.keys()
            .chain(self.dependents.keys())
            .filter(|(s, _)| *s == sheet)
            .copied()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();

        for cell in cells_to_remove {
            self.remove_vertex(cell);
        }

        self.column_dependents.retain(|(s, _), _| *s != sheet);
        self.row_dependents.retain(|(s, _), _| *s != sheet);
    }

    pub fn formula_cell_count(&self) -> usize { self.precedents.len() }
    pub fn dependency_count(&self) -> usize { self.precedents.values().map(|v| v.len()).sum() }

    pub fn clear(&mut self) {
        self.precedents.clear();
        self.dependents.clear();
        self.column_dependents.clear();
        self.row_dependents.clear();
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use identity::generate_uuid_v7;

    fn make_id() -> (SheetId, CellId) {
        (
            SheetId::from_bytes(generate_uuid_v7()),
            CellId::from_bytes(generate_uuid_v7()),
        )
    }

    fn make_sheet() -> SheetId {
        SheetId::from_bytes(generate_uuid_v7())
    }

    fn make_cell(sheet: SheetId) -> IdentityVertex {
        (sheet, CellId::from_bytes(generate_uuid_v7()))
    }

    #[test]
    fn basic_dependency_tracking() {
        let mut g = IdentityGraph::new();
        let s = make_sheet();
        let a = make_cell(s);
        let b = make_cell(s);
        let c = make_cell(s);

        // C depends on A and B
        let mut precs = HashSet::new();
        precs.insert(a);
        precs.insert(b);
        g.set_dependencies(c, precs);

        assert_eq!(g.get_precedents(c).unwrap().len(), 2);
        assert!(g.get_dependents(a).unwrap().contains(&c));
        assert!(g.get_dependents(b).unwrap().contains(&c));
    }

    #[test]
    fn recalc_order() {
        let mut g = IdentityGraph::new();
        let s = make_sheet();
        let a = make_cell(s);
        let b = make_cell(s);
        let c = make_cell(s);

        // B depends on A, C depends on B
        g.set_dependencies(b, [a].into());
        g.set_dependencies(c, [b].into());

        let order = g.get_recalc_order(a).unwrap();
        assert_eq!(order.len(), 2);
        assert_eq!(order[0], b);
        assert_eq!(order[1], c);
    }

    #[test]
    fn cross_sheet_deps() {
        let mut g = IdentityGraph::new();
        let s1 = make_sheet();
        let s2 = make_sheet();
        let a = make_cell(s1);
        let b = make_cell(s2);

        // B (sheet2) depends on A (sheet1)
        g.set_dependencies(b, [a].into());

        assert!(g.get_dependents(a).unwrap().contains(&b));
        let order = g.get_recalc_order(a).unwrap();
        assert_eq!(order, vec![b]);
    }

    #[test]
    fn rename_vertex() {
        let mut g = IdentityGraph::new();
        let s = make_sheet();
        let a = make_cell(s);
        let b = make_cell(s);
        let c = make_cell(s);

        g.set_dependencies(b, [a].into());

        // Rename a -> c
        g.rename_vertex(a, c);

        assert!(g.get_dependents(c).unwrap().contains(&b));
        assert!(g.get_dependents(a).is_none());
        assert!(g.get_precedents(b).unwrap().contains(&c));
    }

    #[test]
    fn merge_vertices() {
        let mut g = IdentityGraph::new();
        let s = make_sheet();
        let a = make_cell(s);
        let b = make_cell(s);
        let c = make_cell(s);

        // C depends on A and B
        g.set_dependencies(c, [a, b].into_iter().collect());

        // Merge B into A (A survives)
        g.merge_vertices(b, a);

        // C should now only depend on A
        let precs = g.get_precedents(c).unwrap();
        assert!(precs.contains(&a));
        assert!(!precs.contains(&b));
    }

    #[test]
    fn remove_sheet() {
        let mut g = IdentityGraph::new();
        let s1 = make_sheet();
        let s2 = make_sheet();
        let a = make_cell(s1);
        let b = make_cell(s1);
        let c = make_cell(s2);

        g.set_dependencies(b, [a].into());
        g.set_dependencies(c, [a].into());

        g.remove_sheet(s1);

        assert_eq!(g.formula_cell_count(), 1); // only c remains
        assert!(g.get_precedents(c).unwrap().is_empty() || g.get_precedents(c).is_none());
    }

    #[test]
    fn column_dependents() {
        let mut g = IdentityGraph::new();
        let s = make_sheet();
        let a = make_cell(s);

        g.set_column_dependencies(a, [(s, 0)].into());

        assert!(g.get_column_dependents(s, 0).unwrap().contains(&a));
    }

    #[test]
    fn clear_dependencies() {
        let mut g = IdentityGraph::new();
        let s = make_sheet();
        let a = make_cell(s);
        let b = make_cell(s);

        g.set_dependencies(b, [a].into());
        assert_eq!(g.formula_cell_count(), 1);

        g.clear_dependencies(b);
        assert_eq!(g.formula_cell_count(), 0);
        assert!(g.get_dependents(a).is_none());
    }
}
