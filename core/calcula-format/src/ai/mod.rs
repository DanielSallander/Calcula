//! FILENAME: core/calcula-format/src/ai/mod.rs
//! AI Context Serializer
//!
//! Produces concise, LLM-optimized text descriptions of spreadsheet content.
//! Used to build context for AI chat conversations about the workbook.

mod sheet_summary;
mod formula_patterns;
mod data_sampler;
mod context_builder;

/// Offline formula evaluation — the oracle the AI measurement programme grades
/// against. PUBLIC, unlike the modules above: the `eval-formulas` example binary
/// and the generated pattern library both drive it from outside this crate.
pub mod formula_verify;

/// Asserts the checked-in measurement corpora against this engine. Test-only:
/// the corpora are large and belong in no shipped binary.
#[cfg(test)]
mod corpus_tests;

pub use context_builder::{serialize_for_ai, AiSerializeOptions, SheetInput};
pub use formula_verify::{
    compare, evaluate_fixture, seed_cell, seed_value, EvalOutcome, ExpectKind, Expectation,
    FixtureCell, FormulaJob, FormulaOutcome, MatchVerdict, ValueKind,
};
