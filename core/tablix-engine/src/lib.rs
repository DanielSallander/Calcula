//! FILENAME: core/tablix-engine/src/lib.rs
//! Tablix (Table/Matrix/List) subsystem for Calcula.
//!
//! This crate provides the tablix calculation engine as a standalone
//! module. It depends on `pivot-engine` for data caching, value interning,
//! and group-tree building, and on `engine` for shared types.
//!
//! Layers:
//! - `definition`: Serializable configuration (what the tablix IS)
//! - `view`: Renderable output for the frontend (WHAT we display)
//! - `engine`: Calculation engine (HOW we calculate)
//! - `conversion`: Pivot <-> Tablix state mapping

pub mod definition;
pub mod view;
pub mod engine;
pub mod conversion;

pub use definition::*;
pub use view::*;
pub use engine::calculate_tablix;
pub use conversion::{pivot_to_tablix, tablix_to_pivot, MigratedDetailField};
