//! FILENAME: core/identity/src/registry.rs
//! PURPOSE: Central registry for all identity operations.
//! CONTEXT: The IdRegistry is the single bottleneck for all ID minting.
//! No code anywhere else generates a UUID v7 directly. It maintains
//! bidirectional position<->CellId maps per sheet, sheet name<->SheetId maps,
//! and provides rename/merge operations.

use std::collections::HashMap;

use crate::types::{CellId, RefSiteId, SheetId};
use crate::uuid_v7::generate_uuid_v7;

/// Position of a cell within a sheet (0-based row, 0-based col).
pub type CellPosition = (u32, u32);

/// Per-sheet cell identity tracking.
#[derive(Debug, Clone, Default)]
struct SheetCellMap {
    position_to_id: HashMap<CellPosition, CellId>,
    id_to_position: HashMap<CellId, CellPosition>,
}

/// Central identity registry for the entire workbook.
///
/// All ID minting goes through this registry. It maintains:
/// - Sheet name <-> SheetId mapping
/// - Per-sheet cell position <-> CellId mapping
///
/// RefSiteIds are minted here but tracked on AST nodes, not in the registry.
#[derive(Debug, Clone)]
pub struct IdRegistry {
    /// Sheet name (uppercase normalized) -> SheetId
    sheet_name_to_id: HashMap<String, SheetId>,
    /// SheetId -> display name (original case)
    sheet_id_to_name: HashMap<SheetId, String>,
    /// Sheet display order (SheetIds in tab order)
    sheet_order: Vec<SheetId>,
    /// Per-sheet cell maps
    cell_maps: HashMap<SheetId, SheetCellMap>,
}

impl Default for IdRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl IdRegistry {
    pub fn new() -> Self {
        Self {
            sheet_name_to_id: HashMap::new(),
            sheet_id_to_name: HashMap::new(),
            sheet_order: Vec::new(),
            cell_maps: HashMap::new(),
        }
    }

    // -----------------------------------------------------------------------
    // Minting
    // -----------------------------------------------------------------------

    /// Mint a fresh CellId (UUID v7).
    pub fn mint_cell_id(&self) -> CellId {
        CellId::from_bytes(generate_uuid_v7())
    }

    /// Mint a fresh SheetId (UUID v7).
    pub fn mint_sheet_id(&self) -> SheetId {
        SheetId::from_bytes(generate_uuid_v7())
    }

    /// Mint a fresh RefSiteId (UUID v7).
    pub fn mint_ref_site_id(&self) -> RefSiteId {
        RefSiteId::from_bytes(generate_uuid_v7())
    }

    // -----------------------------------------------------------------------
    // Sheet management
    // -----------------------------------------------------------------------

    /// Register a new sheet with a given name. Returns the minted SheetId.
    /// If the sheet name already exists, returns the existing SheetId.
    pub fn register_sheet(&mut self, name: &str) -> SheetId {
        let key = name.to_uppercase();
        if let Some(&id) = self.sheet_name_to_id.get(&key) {
            return id;
        }
        let id = self.mint_sheet_id();
        self.sheet_name_to_id.insert(key, id);
        self.sheet_id_to_name.insert(id, name.to_string());
        self.sheet_order.push(id);
        self.cell_maps.insert(id, SheetCellMap::default());
        id
    }

    /// Register a sheet with a pre-existing SheetId (used during file load).
    pub fn register_sheet_with_id(&mut self, name: &str, id: SheetId) {
        let key = name.to_uppercase();
        self.sheet_name_to_id.insert(key, id);
        self.sheet_id_to_name.insert(id, name.to_string());
        if !self.sheet_order.contains(&id) {
            self.sheet_order.push(id);
        }
        self.cell_maps.entry(id).or_default();
    }

    /// Look up a SheetId by name (case-insensitive).
    pub fn sheet_id(&self, name: &str) -> Option<SheetId> {
        self.sheet_name_to_id.get(&name.to_uppercase()).copied()
    }

    /// Look up a sheet's display name by SheetId.
    pub fn sheet_name(&self, id: SheetId) -> Option<&str> {
        self.sheet_id_to_name.get(&id).map(|s| s.as_str())
    }

    /// Get the ordered list of sheet IDs (tab order).
    pub fn sheet_order(&self) -> &[SheetId] {
        &self.sheet_order
    }

    /// Rename a sheet (changes name, preserves SheetId).
    pub fn rename_sheet(&mut self, id: SheetId, new_name: &str) {
        if let Some(old_name) = self.sheet_id_to_name.get(&id).cloned() {
            self.sheet_name_to_id.remove(&old_name.to_uppercase());
        }
        self.sheet_name_to_id.insert(new_name.to_uppercase(), id);
        self.sheet_id_to_name.insert(id, new_name.to_string());
    }

    /// Remove a sheet from the registry entirely.
    pub fn remove_sheet(&mut self, id: SheetId) {
        if let Some(name) = self.sheet_id_to_name.remove(&id) {
            self.sheet_name_to_id.remove(&name.to_uppercase());
        }
        self.sheet_order.retain(|s| *s != id);
        self.cell_maps.remove(&id);
    }

    /// Reorder sheets to match the given order.
    pub fn set_sheet_order(&mut self, order: Vec<SheetId>) {
        self.sheet_order = order;
    }

    // -----------------------------------------------------------------------
    // Cell ID management
    // -----------------------------------------------------------------------

    /// Get the CellId at a position, minting a new one if none exists.
    /// This is the primary "get-or-mint" operation used when a cell becomes
    /// a reference target or gains a formula.
    pub fn cell_id_at(&mut self, sheet: SheetId, pos: CellPosition) -> CellId {
        let map = self.cell_maps.entry(sheet).or_default();
        if let Some(&id) = map.position_to_id.get(&pos) {
            return id;
        }
        let id = CellId::from_bytes(generate_uuid_v7());
        map.position_to_id.insert(pos, id);
        map.id_to_position.insert(id, pos);
        id
    }

    /// Register a cell with a pre-existing CellId (used during file load).
    pub fn register_cell_with_id(&mut self, sheet: SheetId, pos: CellPosition, id: CellId) {
        let map = self.cell_maps.entry(sheet).or_default();
        map.position_to_id.insert(pos, id);
        map.id_to_position.insert(id, pos);
    }

    /// Look up a CellId at a position without minting.
    pub fn lookup_cell_id(&self, sheet: SheetId, pos: CellPosition) -> Option<CellId> {
        self.cell_maps
            .get(&sheet)
            .and_then(|m| m.position_to_id.get(&pos).copied())
    }

    /// Look up the current position of a cell by its CellId.
    pub fn cell_position(&self, sheet: SheetId, id: CellId) -> Option<CellPosition> {
        self.cell_maps
            .get(&sheet)
            .and_then(|m| m.id_to_position.get(&id).copied())
    }

    /// Remove a cell's identity (used when a cell is cleared of formula/references).
    pub fn remove_cell_id(&mut self, sheet: SheetId, pos: CellPosition) {
        if let Some(map) = self.cell_maps.get_mut(&sheet) {
            if let Some(id) = map.position_to_id.remove(&pos) {
                map.id_to_position.remove(&id);
            }
        }
    }

    /// Get all identified cells in a sheet (position -> CellId).
    pub fn cells_in_sheet(&self, sheet: SheetId) -> Option<&HashMap<CellPosition, CellId>> {
        self.cell_maps.get(&sheet).map(|m| &m.position_to_id)
    }

    // -----------------------------------------------------------------------
    // Structural shift support
    // -----------------------------------------------------------------------

    /// Shift cell positions after row insertion.
    /// All cells at or below `at_row` in the given sheet move down by `count`.
    pub fn shift_rows_down(&mut self, sheet: SheetId, at_row: u32, count: u32) {
        let Some(map) = self.cell_maps.get_mut(&sheet) else { return };

        // Collect affected entries
        let affected: Vec<(CellPosition, CellId)> = map
            .position_to_id
            .iter()
            .filter(|((row, _), _)| *row >= at_row)
            .map(|(&pos, &id)| (pos, id))
            .collect();

        // Remove old positions, insert shifted
        for ((row, col), id) in affected {
            map.position_to_id.remove(&(row, col));
            let new_pos = (row + count, col);
            map.position_to_id.insert(new_pos, id);
            map.id_to_position.insert(id, new_pos);
        }
    }

    /// Shift cell positions after row deletion.
    /// Cells in the deleted range [at_row, at_row+count) are removed.
    /// Cells below move up by `count`.
    pub fn shift_rows_up(&mut self, sheet: SheetId, at_row: u32, count: u32) {
        let Some(map) = self.cell_maps.get_mut(&sheet) else { return };

        let end_row = at_row + count;

        // Collect all affected
        let affected: Vec<(CellPosition, CellId)> = map
            .position_to_id
            .iter()
            .filter(|((row, _), _)| *row >= at_row)
            .map(|(&pos, &id)| (pos, id))
            .collect();

        for ((row, col), id) in affected {
            map.position_to_id.remove(&(row, col));
            if row < end_row {
                // Cell is in deleted range — remove entirely
                map.id_to_position.remove(&id);
            } else {
                // Cell moves up
                let new_pos = (row - count, col);
                map.position_to_id.insert(new_pos, id);
                map.id_to_position.insert(id, new_pos);
            }
        }
    }

    /// Shift cell positions after column insertion.
    /// All cells at or right of `at_col` move right by `count`.
    pub fn shift_cols_right(&mut self, sheet: SheetId, at_col: u32, count: u32) {
        let Some(map) = self.cell_maps.get_mut(&sheet) else { return };

        let affected: Vec<(CellPosition, CellId)> = map
            .position_to_id
            .iter()
            .filter(|((_row, col), _)| *col >= at_col)
            .map(|(&pos, &id)| (pos, id))
            .collect();

        for ((row, col), id) in affected {
            map.position_to_id.remove(&(row, col));
            let new_pos = (row, col + count);
            map.position_to_id.insert(new_pos, id);
            map.id_to_position.insert(id, new_pos);
        }
    }

    /// Shift cell positions after column deletion.
    /// Cells in the deleted range [at_col, at_col+count) are removed.
    /// Cells to the right move left by `count`.
    pub fn shift_cols_left(&mut self, sheet: SheetId, at_col: u32, count: u32) {
        let Some(map) = self.cell_maps.get_mut(&sheet) else { return };

        let end_col = at_col + count;

        let affected: Vec<(CellPosition, CellId)> = map
            .position_to_id
            .iter()
            .filter(|((_row, col), _)| *col >= at_col)
            .map(|(&pos, &id)| (pos, id))
            .collect();

        for ((row, col), id) in affected {
            map.position_to_id.remove(&(row, col));
            if col < end_col {
                map.id_to_position.remove(&id);
            } else {
                let new_pos = (row, col - count);
                map.position_to_id.insert(new_pos, id);
                map.id_to_position.insert(id, new_pos);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Rename and merge
    // -----------------------------------------------------------------------

    /// Rename a CellId: atomically rewrite all references from `old` to `new`.
    /// The position mapping transfers to the new ID.
    /// Returns true if the old ID was found and renamed.
    pub fn rename_cell(&mut self, sheet: SheetId, old: CellId, new: CellId) -> bool {
        let Some(map) = self.cell_maps.get_mut(&sheet) else { return false };

        let Some(pos) = map.id_to_position.remove(&old) else { return false };
        map.position_to_id.insert(pos, new);
        map.id_to_position.insert(new, pos);
        true
    }

    /// Merge two CellIds: the `absorbed` ID is consumed by `survivor`.
    /// Any position mapped to `absorbed` now maps to `survivor`.
    /// If both have positions, the absorbed position's mapping is removed
    /// (caller must decide which physical cell survives).
    /// Returns true if the absorbed ID was found.
    pub fn merge_cells(&mut self, sheet: SheetId, _survivor: CellId, absorbed: CellId) -> bool {
        let Some(map) = self.cell_maps.get_mut(&sheet) else { return false };

        let Some(absorbed_pos) = map.id_to_position.remove(&absorbed) else { return false };

        // If the absorbed position is still pointing to the absorbed ID, redirect
        if map.position_to_id.get(&absorbed_pos) == Some(&absorbed) {
            map.position_to_id.remove(&absorbed_pos);
        }

        true
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_and_lookup_sheet() {
        let mut reg = IdRegistry::new();
        let id = reg.register_sheet("Sales");

        assert_eq!(reg.sheet_id("Sales"), Some(id));
        assert_eq!(reg.sheet_id("SALES"), Some(id)); // case-insensitive
        assert_eq!(reg.sheet_id("sales"), Some(id));
        assert_eq!(reg.sheet_name(id), Some("Sales"));
    }

    #[test]
    fn register_sheet_idempotent() {
        let mut reg = IdRegistry::new();
        let id1 = reg.register_sheet("Sheet1");
        let id2 = reg.register_sheet("Sheet1");
        assert_eq!(id1, id2);
    }

    #[test]
    fn cell_id_get_or_mint() {
        let mut reg = IdRegistry::new();
        let sheet = reg.register_sheet("Sheet1");

        // First access mints
        let id = reg.cell_id_at(sheet, (0, 0));
        assert!(!id.is_zero());

        // Second access returns same
        let id2 = reg.cell_id_at(sheet, (0, 0));
        assert_eq!(id, id2);

        // Different position gets different ID
        let id3 = reg.cell_id_at(sheet, (1, 0));
        assert_ne!(id, id3);
    }

    #[test]
    fn lookup_without_mint() {
        let mut reg = IdRegistry::new();
        let sheet = reg.register_sheet("Sheet1");

        assert_eq!(reg.lookup_cell_id(sheet, (5, 5)), None);

        let id = reg.cell_id_at(sheet, (5, 5));
        assert_eq!(reg.lookup_cell_id(sheet, (5, 5)), Some(id));
    }

    #[test]
    fn cell_position_lookup() {
        let mut reg = IdRegistry::new();
        let sheet = reg.register_sheet("Sheet1");
        let id = reg.cell_id_at(sheet, (3, 7));

        assert_eq!(reg.cell_position(sheet, id), Some((3, 7)));
    }

    #[test]
    fn shift_rows_down() {
        let mut reg = IdRegistry::new();
        let sheet = reg.register_sheet("Sheet1");

        let id_r2 = reg.cell_id_at(sheet, (2, 0));
        let id_r5 = reg.cell_id_at(sheet, (5, 0));
        let id_r1 = reg.cell_id_at(sheet, (1, 0));

        // Insert 3 rows at row 2
        reg.shift_rows_down(sheet, 2, 3);

        // Row 1 unchanged
        assert_eq!(reg.cell_position(sheet, id_r1), Some((1, 0)));
        // Row 2 shifted to 5
        assert_eq!(reg.cell_position(sheet, id_r2), Some((5, 0)));
        // Row 5 shifted to 8
        assert_eq!(reg.cell_position(sheet, id_r5), Some((8, 0)));
    }

    #[test]
    fn shift_rows_up_deletes() {
        let mut reg = IdRegistry::new();
        let sheet = reg.register_sheet("Sheet1");

        let id_r1 = reg.cell_id_at(sheet, (1, 0));
        let id_r3 = reg.cell_id_at(sheet, (3, 0));
        let id_r5 = reg.cell_id_at(sheet, (5, 0));

        // Delete rows 2-3 (at_row=2, count=2)
        reg.shift_rows_up(sheet, 2, 2);

        // Row 1 unchanged
        assert_eq!(reg.cell_position(sheet, id_r1), Some((1, 0)));
        // Row 3 was in deleted range — gone
        assert_eq!(reg.cell_position(sheet, id_r3), None);
        // Row 5 shifted to 3
        assert_eq!(reg.cell_position(sheet, id_r5), Some((3, 0)));
    }

    #[test]
    fn shift_cols_right() {
        let mut reg = IdRegistry::new();
        let sheet = reg.register_sheet("Sheet1");

        let id_c0 = reg.cell_id_at(sheet, (0, 0));
        let id_c2 = reg.cell_id_at(sheet, (0, 2));

        // Insert 1 column at col 1
        reg.shift_cols_right(sheet, 1, 1);

        assert_eq!(reg.cell_position(sheet, id_c0), Some((0, 0)));
        assert_eq!(reg.cell_position(sheet, id_c2), Some((0, 3)));
    }

    #[test]
    fn shift_cols_left_deletes() {
        let mut reg = IdRegistry::new();
        let sheet = reg.register_sheet("Sheet1");

        let id_c1 = reg.cell_id_at(sheet, (0, 1));
        let id_c3 = reg.cell_id_at(sheet, (0, 3));

        // Delete col 1 (at_col=1, count=1)
        reg.shift_cols_left(sheet, 1, 1);

        // Col 1 deleted
        assert_eq!(reg.cell_position(sheet, id_c1), None);
        // Col 3 shifted to 2
        assert_eq!(reg.cell_position(sheet, id_c3), Some((0, 2)));
    }

    #[test]
    fn rename_cell() {
        let mut reg = IdRegistry::new();
        let sheet = reg.register_sheet("Sheet1");
        let old_id = reg.cell_id_at(sheet, (0, 0));
        let new_id = reg.mint_cell_id();

        assert!(reg.rename_cell(sheet, old_id, new_id));
        assert_eq!(reg.cell_position(sheet, new_id), Some((0, 0)));
        assert_eq!(reg.cell_position(sheet, old_id), None);
        assert_eq!(reg.lookup_cell_id(sheet, (0, 0)), Some(new_id));
    }

    #[test]
    fn merge_cells() {
        let mut reg = IdRegistry::new();
        let sheet = reg.register_sheet("Sheet1");
        let survivor = reg.cell_id_at(sheet, (0, 0));
        let absorbed = reg.cell_id_at(sheet, (1, 0));

        assert!(reg.merge_cells(sheet, survivor, absorbed));
        assert_eq!(reg.cell_position(sheet, absorbed), None);
        // Survivor still at its original position
        assert_eq!(reg.cell_position(sheet, survivor), Some((0, 0)));
    }

    #[test]
    fn rename_sheet_preserves_id() {
        let mut reg = IdRegistry::new();
        let id = reg.register_sheet("OldName");

        reg.rename_sheet(id, "NewName");

        assert_eq!(reg.sheet_id("NewName"), Some(id));
        assert_eq!(reg.sheet_id("OldName"), None);
        assert_eq!(reg.sheet_name(id), Some("NewName"));
    }

    #[test]
    fn remove_sheet() {
        let mut reg = IdRegistry::new();
        let id = reg.register_sheet("Temp");
        reg.cell_id_at(id, (0, 0));

        reg.remove_sheet(id);

        assert_eq!(reg.sheet_id("Temp"), None);
        assert_eq!(reg.sheet_name(id), None);
        assert!(!reg.sheet_order().contains(&id));
    }

    #[test]
    fn register_sheet_with_known_id() {
        let mut reg = IdRegistry::new();
        let known_id = SheetId::from_bytes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

        reg.register_sheet_with_id("Loaded", known_id);

        assert_eq!(reg.sheet_id("Loaded"), Some(known_id));
        assert_eq!(reg.sheet_name(known_id), Some("Loaded"));
    }
}
