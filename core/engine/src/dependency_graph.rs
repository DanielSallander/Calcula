//! FILENAME: core/engine/src/dependency_graph.rs
//! PURPOSE: Implements the Directed Acyclic Graph (DAG) for tracking cell dependencies.
//! CONTEXT: This module is the heart of the spreadsheet's recalculation engine.
//! It tracks which cells depend on which other cells (precedents/dependents),
//! detects circular references, and computes the correct evaluation order
//! using topological sorting.
//!
//! TERMINOLOGY:
//! - Precedents: Cells that a formula cell references (its inputs).
//!   If A3 = A1 + A2, then A1 and A2 are precedents of A3.
//! - Dependents: Cells that reference a given cell (reverse lookup).
//!   If A3 = A1 + A2, then A3 is a dependent of A1 and A2.
//!
//! USAGE:
//! 1. When a cell's formula is set/changed, call `set_dependencies()` with the
//!    cell's coordinate and its extracted precedents.
//! 2. When a cell value changes, call `get_recalc_order()` to get the list of
//!    cells that need recalculation in the correct order.
//! 3. Use `would_create_cycle()` to check before committing a formula change.

use std::collections::{HashMap, HashSet, VecDeque};
use crate::coord::CellCoord;

/// Error type for cycle detection.
#[derive(Debug, Clone, PartialEq)]
pub struct CycleError {
    /// The cells involved in the cycle, in order.
    pub cycle_path: Vec<CellCoord>,
}

impl std::fmt::Display for CycleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Circular reference detected: ")?;
        for (i, coord) in self.cycle_path.iter().enumerate() {
            if i > 0 {
                write!(f, " -> ")?;
            }
            write!(f, "({}, {})", coord.0, coord.1)?;
        }
        Ok(())
    }
}

impl std::error::Error for CycleError {}

/// The Dependency Graph tracks relationships between cells.
/// It maintains both forward (precedents) and reverse (dependents) mappings
/// for efficient lookups in either direction.
#[derive(Debug, Default)]
pub struct DependencyGraph {
    /// For each cell, the set of cells it directly depends on (its precedents).
    /// If A3 = A1 + A2, then precedents[A3] = {A1, A2}.
    precedents: HashMap<CellCoord, HashSet<CellCoord>>,

    /// For each cell, the set of cells that directly depend on it (its dependents).
    /// If A3 = A1 + A2, then dependents[A1] contains A3, and dependents[A2] contains A3.
    dependents: HashMap<CellCoord, HashSet<CellCoord>>,
}

impl DependencyGraph {
    /// Creates a new, empty dependency graph.
    pub fn new() -> Self {
        DependencyGraph {
            precedents: HashMap::new(),
            dependents: HashMap::new(),
        }
    }

    /// Sets the dependencies for a cell, replacing any previous dependencies.
    /// This updates both the precedents and dependents mappings.
    ///
    /// # Arguments
    /// * `cell` - The cell whose dependencies are being set.
    /// * `new_precedents` - The set of cells this cell depends on.
    ///
    /// # Note
    /// This does NOT check for cycles. Use `would_create_cycle()` first if needed.
    pub fn set_dependencies(&mut self, cell: CellCoord, new_precedents: HashSet<CellCoord>) {
        // First, remove old dependencies
        self.clear_dependencies(cell);

        // Add new precedents for this cell
        if !new_precedents.is_empty() {
            // Update the dependents map: for each precedent, add this cell as a dependent
            for &prec in &new_precedents {
                self.dependents
                    .entry(prec)
                    .or_insert_with(HashSet::new)
                    .insert(cell);
            }

            // Store the precedents for this cell
            self.precedents.insert(cell, new_precedents);
        }
    }

    /// Clears all dependencies for a cell.
    /// Call this when a cell becomes a literal value or is cleared.
    ///
    /// # Arguments
    /// * `cell` - The cell whose dependencies should be cleared.
    pub fn clear_dependencies(&mut self, cell: CellCoord) {
        // Get the old precedents, if any
        if let Some(old_precs) = self.precedents.remove(&cell) {
            // Remove this cell from each precedent's dependents set
            for prec in old_precs {
                if let Some(deps) = self.dependents.get_mut(&prec) {
                    deps.remove(&cell);
                    // Clean up empty sets
                    if deps.is_empty() {
                        self.dependents.remove(&prec);
                    }
                }
            }
        }
    }

    /// Returns the direct precedents of a cell (cells it directly references).
    ///
    /// # Arguments
    /// * `cell` - The cell to query.
    ///
    /// # Returns
    /// A reference to the set of precedents, or None if the cell has no precedents.
    pub fn get_precedents(&self, cell: CellCoord) -> Option<&HashSet<CellCoord>> {
        self.precedents.get(&cell)
    }

    /// Returns the direct dependents of a cell (cells that directly reference it).
    ///
    /// # Arguments
    /// * `cell` - The cell to query.
    ///
    /// # Returns
    /// A reference to the set of dependents, or None if no cells depend on this cell.
    pub fn get_dependents(&self, cell: CellCoord) -> Option<&HashSet<CellCoord>> {
        self.dependents.get(&cell)
    }

    /// Checks if setting the given dependencies for a cell would create a cycle.
    /// This performs a DFS from each new precedent to see if we can reach the cell.
    ///
    /// # Arguments
    /// * `cell` - The cell whose dependencies would be changed.
    /// * `new_precedents` - The proposed new precedents.
    ///
    /// # Returns
    /// `true` if adding these dependencies would create a cycle, `false` otherwise.
    pub fn would_create_cycle(&self, cell: CellCoord, new_precedents: &HashSet<CellCoord>) -> bool {
        // A cell depending on itself is a trivial cycle
        if new_precedents.contains(&cell) {
            return true;
        }

        // Check if any precedent can reach the cell through existing dependencies
        // We use DFS to follow the precedent chains
        for &prec in new_precedents {
            if self.can_reach(prec, cell) {
                return true;
            }
        }

        false
    }

    /// Checks if `start` can reach `target` by following precedent chains.
    /// This is used for cycle detection: if precedent P can reach cell C,
    /// then C depending on P would create a cycle.
    fn can_reach(&self, start: CellCoord, target: CellCoord) -> bool {
        let mut visited = HashSet::new();
        let mut stack = vec![start];

        while let Some(current) = stack.pop() {
            if current == target {
                return true;
            }

            if visited.contains(&current) {
                continue;
            }
            visited.insert(current);

            // Follow precedent chain (what does `current` depend on?)
            if let Some(precs) = self.precedents.get(&current) {
                for &prec in precs {
                    if !visited.contains(&prec) {
                        stack.push(prec);
                    }
                }
            }
        }

        false
    }

    /// Gets all cells that need recalculation when a cell's value changes,
    /// returned in topological order (dependencies before dependents).
    ///
    /// # Arguments
    /// * `changed` - The cell whose value changed.
    ///
    /// # Returns
    /// - `Ok(Vec<CellCoord>)` - The cells to recalculate, in order.
    ///   The changed cell itself is NOT included; only its dependents.
    /// - `Err(CycleError)` - If a cycle is detected.
    pub fn get_recalc_order(&self, changed: CellCoord) -> Result<Vec<CellCoord>, CycleError> {
        // First, collect all cells that are affected (transitive dependents)
        let affected = self.get_all_dependents(changed);

        if affected.is_empty() {
            return Ok(Vec::new());
        }

        // Now perform a topological sort on the affected cells
        self.topological_sort(&affected)
    }

    /// Gets all transitive dependents of a cell (not including the cell itself).
    /// Uses BFS to traverse the dependent chains.
    fn get_all_dependents(&self, cell: CellCoord) -> HashSet<CellCoord> {
        let mut result = HashSet::new();
        let mut queue = VecDeque::new();

        // Start with direct dependents
        if let Some(deps) = self.dependents.get(&cell) {
            for &dep in deps {
                queue.push_back(dep);
            }
        }

        while let Some(current) = queue.pop_front() {
            if result.contains(&current) {
                continue;
            }
            result.insert(current);

            // Add this cell's dependents to the queue
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

    /// Performs a topological sort on a subset of cells using Kahn's algorithm.
    /// Returns the cells in an order where each cell comes after all its precedents.
    ///
    /// # Arguments
    /// * `cells` - The set of cells to sort.
    ///
    /// # Returns
    /// - `Ok(Vec<CellCoord>)` - The sorted cells.
    /// - `Err(CycleError)` - If a cycle is detected among the cells.
    fn topological_sort(&self, cells: &HashSet<CellCoord>) -> Result<Vec<CellCoord>, CycleError> {
        // Build in-degree map (only counting edges within the subset)
        let mut in_degree: HashMap<CellCoord, usize> = HashMap::new();
        for &cell in cells {
            in_degree.insert(cell, 0);
        }

        // Count in-degrees (precedents that are also in the subset)
        for &cell in cells {
            if let Some(precs) = self.precedents.get(&cell) {
                for &prec in precs {
                    if cells.contains(&prec) {
                        *in_degree.get_mut(&cell).unwrap() += 1;
                    }
                }
            }
        }

        // Initialize queue with cells that have no precedents in the subset
        let mut queue: VecDeque<CellCoord> = in_degree
            .iter()
            .filter(|(_, &deg)| deg == 0)
            .map(|(&cell, _)| cell)
            .collect();

        let mut result = Vec::with_capacity(cells.len());

        while let Some(cell) = queue.pop_front() {
            result.push(cell);

            // Decrease in-degree for all dependents in the subset
            if let Some(deps) = self.dependents.get(&cell) {
                for &dep in deps {
                    if let Some(deg) = in_degree.get_mut(&dep) {
                        *deg -= 1;
                        if *deg == 0 {
                            queue.push_back(dep);
                        }
                    }
                }
            }
        }

        // If we didn't process all cells, there's a cycle
        if result.len() != cells.len() {
            // Find cells that are part of the cycle (those still with non-zero in-degree)
            let cycle_cells: Vec<CellCoord> = in_degree
                .iter()
                .filter(|(_, &deg)| deg > 0)
                .map(|(&cell, _)| cell)
                .collect();

            // Try to reconstruct the cycle path for a better error message
            let cycle_path = self.find_cycle_path(&cycle_cells);
            return Err(CycleError { cycle_path });
        }

        Ok(result)
    }

    /// Attempts to find and return a cycle path for error reporting.
    /// Returns a simple list of cycle participants if exact path can't be found.
    fn find_cycle_path(&self, cycle_cells: &[CellCoord]) -> Vec<CellCoord> {
        if cycle_cells.is_empty() {
            return Vec::new();
        }

        let cell_set: HashSet<CellCoord> = cycle_cells.iter().cloned().collect();
        let start = cycle_cells[0];
        let mut path = vec![start];
        let mut current = start;

        // Follow precedents to trace the cycle
        for _ in 0..cycle_cells.len() {
            if let Some(precs) = self.precedents.get(&current) {
                // Find a precedent that's in the cycle
                if let Some(&next) = precs.iter().find(|p| cell_set.contains(p)) {
                    if next == start {
                        path.push(next); // Complete the cycle
                        return path;
                    }
                    if !path.contains(&next) {
                        path.push(next);
                        current = next;
                    } else {
                        // We've hit a cell we've seen, cycle found
                        path.push(next);
                        return path;
                    }
                } else {
                    break;
                }
            } else {
                break;
            }
        }

        // Fallback: just return the cells involved
        cycle_cells.to_vec()
    }

    /// Returns the total number of cells that have dependencies.
    pub fn formula_cell_count(&self) -> usize {
        self.precedents.len()
    }

    /// Returns the total number of dependency relationships.
    pub fn dependency_count(&self) -> usize {
        self.precedents.values().map(|v| v.len()).sum()
    }

    /// Clears the entire dependency graph.
    pub fn clear(&mut self) {
        self.precedents.clear();
        self.dependents.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coord(row: u32, col: u32) -> CellCoord {
        (row, col)
    }

    fn set_of(coords: &[CellCoord]) -> HashSet<CellCoord> {
        coords.iter().cloned().collect()
    }

    #[test]
    fn test_set_and_get_dependencies() {
        let mut graph = DependencyGraph::new();

        // A3 = A1 + A2
        let a1 = coord(0, 0);
        let a2 = coord(1, 0);
        let a3 = coord(2, 0);

        graph.set_dependencies(a3, set_of(&[a1, a2]));

        // Check precedents
        let precs = graph.get_precedents(a3).unwrap();
        assert!(precs.contains(&a1));
        assert!(precs.contains(&a2));
        assert_eq!(precs.len(), 2);

        // Check dependents
        let a1_deps = graph.get_dependents(a1).unwrap();
        assert!(a1_deps.contains(&a3));

        let a2_deps = graph.get_dependents(a2).unwrap();
        assert!(a2_deps.contains(&a3));
    }

    #[test]
    fn test_clear_dependencies() {
        let mut graph = DependencyGraph::new();

        let a1 = coord(0, 0);
        let a2 = coord(1, 0);
        let a3 = coord(2, 0);

        graph.set_dependencies(a3, set_of(&[a1, a2]));
        graph.clear_dependencies(a3);

        assert!(graph.get_precedents(a3).is_none());
        assert!(graph.get_dependents(a1).is_none());
        assert!(graph.get_dependents(a2).is_none());
    }

    #[test]
    fn test_update_dependencies() {
        let mut graph = DependencyGraph::new();

        let a1 = coord(0, 0);
        let a2 = coord(1, 0);
        let a3 = coord(2, 0);
        let b1 = coord(0, 1);

        // Initially A3 = A1 + A2
        graph.set_dependencies(a3, set_of(&[a1, a2]));

        // Change to A3 = B1
        graph.set_dependencies(a3, set_of(&[b1]));

        // A3 should now only depend on B1
        let precs = graph.get_precedents(a3).unwrap();
        assert_eq!(precs.len(), 1);
        assert!(precs.contains(&b1));

        // A1 and A2 should have no dependents
        assert!(graph.get_dependents(a1).is_none());
        assert!(graph.get_dependents(a2).is_none());

        // B1 should have A3 as dependent
        let b1_deps = graph.get_dependents(b1).unwrap();
        assert!(b1_deps.contains(&a3));
    }

    #[test]
    fn test_cycle_detection_self_reference() {
        let graph = DependencyGraph::new();
        let a1 = coord(0, 0);

        // A1 = A1 is a cycle
        assert!(graph.would_create_cycle(a1, &set_of(&[a1])));
    }

    #[test]
    fn test_cycle_detection_simple() {
        let mut graph = DependencyGraph::new();

        let a1 = coord(0, 0);
        let a2 = coord(1, 0);

        // A2 = A1
        graph.set_dependencies(a2, set_of(&[a1]));

        // Now if A1 = A2, that's a cycle
        assert!(graph.would_create_cycle(a1, &set_of(&[a2])));
    }

    #[test]
    fn test_cycle_detection_transitive() {
        let mut graph = DependencyGraph::new();

        let a1 = coord(0, 0);
        let a2 = coord(1, 0);
        let a3 = coord(2, 0);

        // A2 = A1
        graph.set_dependencies(a2, set_of(&[a1]));
        // A3 = A2
        graph.set_dependencies(a3, set_of(&[a2]));

        // If A1 = A3, that creates A1 -> A3 -> A2 -> A1 cycle
        assert!(graph.would_create_cycle(a1, &set_of(&[a3])));
    }

    #[test]
    fn test_no_false_positive_cycle() {
        let mut graph = DependencyGraph::new();

        let a1 = coord(0, 0);
        let a2 = coord(1, 0);
        let b1 = coord(0, 1);

        // A2 = A1
        graph.set_dependencies(a2, set_of(&[a1]));

        // B1 = A1 should NOT be a cycle
        assert!(!graph.would_create_cycle(b1, &set_of(&[a1])));

        // B1 = A2 should also NOT be a cycle
        assert!(!graph.would_create_cycle(b1, &set_of(&[a2])));
    }

    #[test]
    fn test_recalc_order_simple() {
        let mut graph = DependencyGraph::new();

        let a1 = coord(0, 0);
        let a2 = coord(1, 0);
        let a3 = coord(2, 0);

        // A2 = A1 (A2 depends on A1)
        graph.set_dependencies(a2, set_of(&[a1]));
        // A3 = A2 (A3 depends on A2)
        graph.set_dependencies(a3, set_of(&[a2]));

        // When A1 changes, we need to recalc A2 first, then A3
        let order = graph.get_recalc_order(a1).unwrap();
        assert_eq!(order.len(), 2);
        assert_eq!(order[0], a2); // A2 must come before A3
        assert_eq!(order[1], a3);
    }

    #[test]
    fn test_recalc_order_diamond() {
        let mut graph = DependencyGraph::new();

        //     A1
        //    /  \
        //   A2  A3
        //    \  /
        //     A4
        let a1 = coord(0, 0);
        let a2 = coord(1, 0);
        let a3 = coord(2, 0);
        let a4 = coord(3, 0);

        graph.set_dependencies(a2, set_of(&[a1]));
        graph.set_dependencies(a3, set_of(&[a1]));
        graph.set_dependencies(a4, set_of(&[a2, a3]));

        // When A1 changes
        let order = graph.get_recalc_order(a1).unwrap();
        assert_eq!(order.len(), 3);

        // A4 must come after both A2 and A3
        let a2_pos = order.iter().position(|&c| c == a2).unwrap();
        let a3_pos = order.iter().position(|&c| c == a3).unwrap();
        let a4_pos = order.iter().position(|&c| c == a4).unwrap();

        assert!(a4_pos > a2_pos);
        assert!(a4_pos > a3_pos);
    }

    #[test]
    fn test_recalc_order_no_dependents() {
        let graph = DependencyGraph::new();
        let a1 = coord(0, 0);

        // No dependents
        let order = graph.get_recalc_order(a1).unwrap();
        assert!(order.is_empty());
    }

    #[test]
    fn test_recalc_order_cycle_error() {
        let mut graph = DependencyGraph::new();

        let a1 = coord(0, 0);
        let a2 = coord(1, 0);

        // Manually create a cycle (bypassing would_create_cycle check)
        // This simulates a corrupted state or tests the detection in recalc
        graph.precedents.insert(a1, set_of(&[a2]));
        graph.precedents.insert(a2, set_of(&[a1]));
        graph.dependents.insert(a1, set_of(&[a2]));
        graph.dependents.insert(a2, set_of(&[a1]));

        // We need a third cell that depends on one of them to trigger the check
        let a3 = coord(2, 0);
        graph.precedents.insert(a3, set_of(&[a1]));
        graph.dependents.entry(a1).or_default().insert(a3);

        // Actually for cycle detection in topological sort, we need the cycle cells
        // to be in the affected set. Let's change the test:
        // When a1 changes, a2 is affected. And a2 depends on a1 which depends on a2.
        
        let result = graph.get_recalc_order(a1);
        // Should detect the cycle
        assert!(result.is_err());
    }

    #[test]
    fn test_counts() {
        let mut graph = DependencyGraph::new();

        let a1 = coord(0, 0);
        let a2 = coord(1, 0);
        let a3 = coord(2, 0);

        assert_eq!(graph.formula_cell_count(), 0);
        assert_eq!(graph.dependency_count(), 0);

        graph.set_dependencies(a2, set_of(&[a1]));
        graph.set_dependencies(a3, set_of(&[a1, a2]));

        assert_eq!(graph.formula_cell_count(), 2); // A2 and A3 have formulas
        assert_eq!(graph.dependency_count(), 3); // A2->A1, A3->A1, A3->A2
    }
}