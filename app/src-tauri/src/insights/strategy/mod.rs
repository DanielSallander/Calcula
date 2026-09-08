//! FILENAME: app/src-tauri/src/insights/strategy/mod.rs
// PURPOSE: Per-measure business metadata that steers the insights engine, plus
//          the validator, the static overlap checker and the layered resolver.
// CONTEXT: THE GOVERNING INVARIANT OF THIS WHOLE SUBTREE, and it is visible in
//          the types rather than trusted to reviewers:
//
//              STRUCTURED FIELDS may influence WHICH facts are generated and how
//              they RANK. PROSE may influence WORDING only.
//              RULES ANNOTATE FACTS. THEY NEVER GENERATE THEM.
//
//          `Rule` therefore carries an `AttributeSet` (see types.rs) that has no
//          field capable of asserting a value: it can override interpretation
//          attributes, suppress fact kinds and reweight ranking, and that is the
//          complete list. Nothing a consultant writes in a strategy file can put
//          a number in front of a reader that the model did not compute. The two
//          free-text fields on the document (`MeasureStrategy::context` and
//          `PeriodAnnotation::note`) reach the narrative layer and nothing else.
//
//          The second load-bearing property is that a strategy file is REFUSED
//          rather than half-applied. Scopes range over finite declared members,
//          so rule overlap is decidable by enumeration (overlap.rs) instead of
//          being discovered by a reader who wonders why one region says the
//          opposite of another.

pub mod facts;
/// The checked-in fixtures, run against the real resolver. Tests only.
#[cfg(test)]
mod fixture_tests;
pub mod infer;
pub mod overlap;
pub mod resolve;
pub mod types;
pub mod validate;

pub use facts::facts_from_model;
pub use infer::infer;
pub use overlap::{check_overlaps, scope_intersection, specificity, Conflict};
pub use resolve::{
    point_from_scope, resolve, Applied, AttrSource, KpiFacts, MeasureFacts, ModelFacts,
    ResolvedMeasure, ScopePoint, Suppression, TableFacts,
};
pub use types::*;
pub use validate::{is_refused, judge, run_inline_tests, validate, Finding, Severity, TestOutcome};
