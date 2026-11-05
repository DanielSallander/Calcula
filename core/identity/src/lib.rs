//! FILENAME: core/identity/src/lib.rs
//! PURPOSE: Stable identity system for Calcula.
//! CONTEXT: Provides UUID v7 types (CellId, SheetId, RefSiteId), a centralized
//! IdRegistry for minting and tracking IDs, and operations like rename/merge.
//! This crate has no dependencies on engine, parser, or persistence — all of
//! those depend on it.

pub mod defined_name_case;
pub mod defined_name_syntax;
pub mod registry;
pub mod sheet_name_case;
pub mod types;
pub mod uuid_v7;

pub use defined_name_case::{defined_name_key, defined_names_equal};
pub use defined_name_syntax::{is_valid_defined_name, MAX_DEFINED_NAME_CHARS};
pub use registry::IdRegistry;
pub use sheet_name_case::{fold_sheet_name_char, position_of_sheet_name, sheet_name_key, sheet_names_equal};
pub use types::{CellId, EntityId, RefSiteId, SheetId};
pub use uuid_v7::generate_uuid_v7;
