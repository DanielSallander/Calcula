//! FILENAME: core/pivot-engine/src/lib.rs
//! Pivot Table subsystem for Calcula.
//!
//! This crate provides the pivot table calculation engine as a standalone
//! module, separate from the core spreadsheet engine. It depends on `engine`
//! only for shared types (CellValue, CellCoord, Grid).
//!
//! Layers:
//! - `definition`: Serializable configuration (what the pivot table IS)
//! - `cache`: High-performance internal representation (HOW we compute)
//! - `view`: Renderable output for the frontend (WHAT we display)
//! - `engine`: Calculation engine (HOW we calculate)

pub mod definition;
pub mod cache;
pub mod view;
pub mod engine;

pub use definition::*;
pub use cache::*;
pub use view::*;
pub use engine::{
    calculate_pivot, drill_down,
    format_date_level_name, date_to_cache_value, record_value_at,
};
