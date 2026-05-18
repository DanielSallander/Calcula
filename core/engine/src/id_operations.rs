//! FILENAME: core/engine/src/id_operations.rs
//! PURPOSE: Orchestrated identity operations that touch the IdRegistry.
//! CONTEXT: rename_cell and merge_cells need to update the registry's
//! position maps. When the dependency graph is rekeyed to (SheetId, CellId)
//! (future work), these operations will also update dep graph edges.
//!
//! Currently the dep graph uses CellCoord = (u32, u32) and is maintained
//! separately in the Tauri layer. The rename/merge APIs here operate on
//! the registry only. The dep graph rename_vertex/merge_vertices methods
//! exist on DependencyGraph and will be called by the Tauri layer.

use identity::{CellId, IdRegistry, SheetId};

/// Rename a CellId in the registry.
/// Returns true if the old ID was found and renamed.
pub fn rename_cell_id(
    registry: &mut IdRegistry,
    sheet: SheetId,
    old_id: CellId,
    new_id: CellId,
) -> bool {
    registry.rename_cell(sheet, old_id, new_id)
}

/// Merge two CellIds in the registry: the absorbed ID is consumed by survivor.
/// Returns true if the absorbed ID was found.
pub fn merge_cell_ids(
    registry: &mut IdRegistry,
    sheet: SheetId,
    survivor: CellId,
    absorbed: CellId,
) -> bool {
    registry.merge_cells(sheet, survivor, absorbed)
}
