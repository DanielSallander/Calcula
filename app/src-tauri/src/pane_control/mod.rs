//! FILENAME: app/src-tauri/src/pane_control/mod.rs
//! PURPOSE: Pane Control module — general controls hosted in the Controls pane
//!          (buttons, sliders, dropdowns, checkboxes, custom scripted controls).
//! CONTEXT: Sits BESIDE ribbon filters (ribbon_filter module, untouched) in the
//!          same "Controls" pane strip: `PaneControl.order` shares the number
//!          space with `RibbonFilter.order`, names are unique case-insensitively
//!          across BOTH families, and GET.CONTROLVALUE reads both (plus named
//!          on-grid controls) via values::collect_control_values.

pub mod types;
pub mod commands;
pub mod values;

pub use types::*;
pub use commands::*;
pub use values::*;
