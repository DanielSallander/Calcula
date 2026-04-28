//! FILENAME: app/src-tauri/src/ribbon_filter/mod.rs
//! PURPOSE: Ribbon Filter module — Power BI-style filter pane in the ribbon.

pub mod types;
pub mod commands;
#[cfg(test)]
mod tests;

pub use types::*;
pub use commands::*;
