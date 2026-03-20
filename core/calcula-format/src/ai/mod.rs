//! FILENAME: core/calcula-format/src/ai/mod.rs
//! AI Context Serializer
//!
//! Produces concise, LLM-optimized text descriptions of spreadsheet content.
//! Used to build context for AI chat conversations about the workbook.

mod sheet_summary;
mod formula_patterns;
mod data_sampler;
mod context_builder;

pub use context_builder::{serialize_for_ai, AiSerializeOptions, SheetInput};
