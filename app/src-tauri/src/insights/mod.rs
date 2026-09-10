//! FILENAME: app/src-tauri/src/insights/mod.rs
// PURPOSE: The insights subsystem: turning a range, or a semantic model, into
//          statements a reader can act on. This file declares the modules and
//          nothing else.
// CONTEXT: The split down the middle of this directory is the design.
//
//          `strategy/` is the only part a person AUTHORS by hand, so it is the
//          only part whose file format is validated, version-checked and
//          refused when wrong. Everything else COMPUTES: `region` decides what
//          to look at, `model` plans and runs the queries a measure needs,
//          `report` writes the answer down, and `wire` is the one place that
//          knows both the core crate's fact shape and the TypeScript seam's.
//
//          The statistics themselves are not here at all. They live in
//          `core/insights`, which depends only on `engine` — so a trend test
//          seeds a `Vec<f64>` and runs in milliseconds, and no change to the
//          BI engine's DataFusion tree can break it.

pub mod commands;
pub mod describe;
pub mod model;
pub mod model_commands;
pub mod region;
pub mod report;
pub mod strategy;
pub mod usage;
pub mod wire;
