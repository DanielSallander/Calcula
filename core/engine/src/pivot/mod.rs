//! Pivot Table subsystem for Calcula.
//!
//! This module provides three distinct layers:
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
pub use engine::{calculate_pivot, drill_down};