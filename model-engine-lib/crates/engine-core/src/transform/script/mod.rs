//! The **applied-steps script** — a text projection of a transformation
//! pipeline, and its parser back.
//!
//! This is the "Advanced Editor" surface: a table's
//! [`TransformStep`](crate::transform::TransformStep) list rendered as one
//! statement per step, editable as text, and compiled back to the same typed
//! steps. Power Query's Advanced Editor makes M text the stored form and treats
//! the step list as a view of it; this module deliberately inverts that.
//!
//! # Steps are canonical; the text is a projection
//!
//! [`render_script`] is generated on demand and [`parse_script`] runs before
//! anything is stored, so the model file, the cache identity and every
//! validation rule keep working on typed steps. Three concrete reasons, each
//! sufficient on its own:
//!
//! * [`pipeline_fingerprint`](crate::transform::pipeline_fingerprint) hashes the
//!   step JSON and is folded into the table's cache identity. If text were the
//!   stored form, re-indenting a `groupBy` block would change the fingerprint
//!   and invalidate every cached row on disk for a whitespace edit.
//! * [`TransformStep`](crate::transform::TransformStep) derives `Eq`, so the
//!   round trip can be asserted on the **structure**
//!   (`parse(render(s)) == s`) rather than on rendered bytes. Asserting
//!   rendered text is how a serializer and its parser drift apart while both
//!   look tested.
//! * Validation and schema derivation are defined over typed steps and read no
//!   rows. Text as the stored form would push a parser below that boundary and
//!   into every model load.
//!
//! The one thing that stays text is the thing that already was: the expression
//! sources of `filterRows` and `addColumn`. Structure typed, expression leaves
//! text — see [`crate::transform::parts`].
//!
//! # No new runtime
//!
//! The grammar can spell exactly the 17 step tags and nothing else. There is no
//! evaluation, no binding, no control flow, and no way to reach a capability: a
//! parsed script is a `Vec<TransformStep>` or an error. That is what keeps this
//! surface on the safe side of the decision that rejected embedding a scripting
//! language in the pipeline.
//!
//! # The round trip is one-directional
//!
//! `parse(render(steps)) == steps` is guaranteed and tested over every variant,
//! every field shape and hostile names. `render(parse(text)) == text` is **not**
//! and never will be: aliases normalize to canonical spellings, redundant
//! quoting is dropped, and options re-order to field-declaration order. The
//! pane is a rendered view you may edit, not a file you own.
//!
//! # Example
//!
//! ```rust
//! use engine_core::transform::{parse_script, render_script, TransformStep};
//!
//! let steps = vec![
//!     TransformStep::FilterRows { condition: "status <> \"cancelled\"".into() },
//!     TransformStep::RemoveColumns { columns: vec!["notes".into()] },
//! ];
//!
//! let text = render_script(&steps);
//! assert!(text.contains("filterRows = status <> \"cancelled\""));
//! assert_eq!(parse_script(&text).unwrap(), steps);
//! ```

mod lex;
mod parse;
mod render;
mod vocabulary;

#[cfg(test)]
mod tests;

pub use parse::{parse_placed_statement, parse_script, parse_statement, PlacedStep};
pub use render::{render_script, render_statement};
pub use vocabulary::{script_vocabulary, OptionSpec, ScriptVocabulary, StepVocabulary};

/// A syntax error in an applied-steps script, anchored to where it was read.
///
/// Positions are 1-based and address the **physical** line and column of the
/// source text, so a host can place a marker in the editor buffer without
/// re-deriving anything. A parse error is always a defect in the text; a step
/// that parses but cannot be applied is reported later, by
/// [`validate_steps`](crate::transform::validate_steps), against a step index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptError {
    /// What is wrong, phrased for the person editing the buffer.
    pub message: String,
    /// 1-based physical line.
    pub line: usize,
    /// 1-based column within that line.
    pub column: usize,
}

impl ScriptError {
    /// Create an error at a 1-based line and column.
    pub(crate) fn at(message: impl Into<String>, line: usize, column: usize) -> Self {
        Self {
            message: message.into(),
            line,
            column,
        }
    }
}

impl std::fmt::Display for ScriptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "line {}, column {}: {}",
            self.line, self.column, self.message
        )
    }
}

impl std::error::Error for ScriptError {}
