//! FILENAME: app/src-tauri/src/slicer/mod.rs
//! PURPOSE: Slicer module — visual filter controls for Tables and PivotTables.

pub mod types;
pub mod commands;
pub mod computed;
#[cfg(test)]
mod tests;

pub use types::*;
pub use commands::*;
pub use computed::*;
