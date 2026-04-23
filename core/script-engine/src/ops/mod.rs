//! FILENAME: core/script-engine/src/ops/mod.rs
//! PURPOSE: Op module declarations for the script engine.
//! CONTEXT: Each module registers functions on the global Calcula object
//! that bridge JavaScript calls to Rust spreadsheet operations.

pub mod application;
pub mod bookmarks;
pub mod cells;
pub mod extended;
pub mod sheets;
pub mod utility;
pub mod worksheet_props;
