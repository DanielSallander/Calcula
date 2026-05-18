//! FILENAME: core/identity/src/lib.rs
//! PURPOSE: Stable identity system for Calcula.
//! CONTEXT: Provides UUID v7 types (CellId, SheetId, RefSiteId), a centralized
//! IdRegistry for minting and tracking IDs, and operations like rename/merge.
//! This crate has no dependencies on engine, parser, or persistence — all of
//! those depend on it.

pub mod registry;
pub mod types;
pub mod uuid_v7;

pub use registry::IdRegistry;
pub use types::{CellId, RefSiteId, SheetId};
pub use uuid_v7::generate_uuid_v7;
