//! FILENAME: core/engine/src/cell.rs
//! PURPOSE: Defines the fundamental data structures for a single spreadsheet cell.
//! CONTEXT: This file contains the `Cell` struct and `CellValue` enum.
//! It separates the user's input (formula) from the calculated result (value).
//! It is designed to be lightweight as millions of these instances may exist.
//!
//! PERFORMANCE: The AST is the canonical formula storage â€” it is parsed once
//! and never re-parsed on recalculation. It IS serialized: `Cell` derives
//! Serialize/Deserialize with no `skip` on `ast`, which is what lets the
//! AST-carrying undo snapshots (`script_grid_cells`) restore a formula exactly.
//! The `.cala` writer stores the rendered formula STRING instead and re-parses
//! on load, so the on-disk format does not depend on the AST's JSON shape.

use serde::{Deserialize, Serialize};
use crate::dependency_extractor::Expression;
use crate::style::{Color, UnderlineStyle};

/// Represents valid key types for Dict cells.
/// Follows Python conventions: strings, numbers, and booleans are hashable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum DictKey {
    Text(String),
    Number(f64),
    Boolean(bool),
}

/// Represents the possible errors a cell can hold (e.g., #DIV/0!)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum CellError {
    Div0,       // Division by zero
    Ref,        // Invalid reference
    Name,       // Unknown function name
    Value,      // Wrong type of argument
    NA,         // Value not available (#N/A)
    Circular,   // Circular dependency detected
    Conflict,   // Conflicting UI effects (e.g., two formulas setting same row height)
    Blocked,    // Code the user refused to run (denied/declined capability) â€” a
                // refused value, not a computation error. Transparency: the user
                // must see #BLOCKED! rather than a stale number or a generic error.
    /// A CALCULATION LIMIT was exceeded: the formula's work budget ran out
    /// (`core/engine/src/budget.rs`), it recursed past `MAX_LAMBDA_DEPTH`, or
    /// it asked for an array/string bigger than the engine will materialize.
    /// Displays as `#LIMIT!`.
    ///
    /// WHY A DISTINCT VARIANT, and not one of the ones above:
    /// - NOT `#VALUE!` (what the depth guard used to return): `#VALUE!` means
    ///   "an argument has the wrong type â€” fix the argument", and it already
    ///   carries Excel's `#NUM!`. Budget exhaustion means "this formula is too
    ///   expensive, or it never terminates â€” simplify it". Those send a user to
    ///   two different places, and the single most alarming failure in the
    ///   product must not be indistinguishable from a typo. It also has to be
    ///   COUNTABLE â€” error checking and the audit trail want to say "3 cells hit
    ///   the calculation limit", which needs a distinct value.
    /// - NOT `#CIRCULAR!`: that is graph-owned ("the dependency graph contains a
    ///   cycle") and iterative calculation keys off it, so a budget-exhausted
    ///   cell entering that path would be actively wrong.
    /// - NOT `#BLOCKED!`: that is a consent outcome, not a cost outcome.
    ///
    /// WHY `Limit` AND NOT `Timeout`: the deterministic trigger is WORK, not
    /// time. On a slow machine nothing timed out â€” the formula did too much,
    /// and a user could trivially falsify a "timeout" claim ("it only took two
    /// seconds"). `#LIMIT!` is also the right umbrella for the whole family:
    /// fuel exhaustion, the depth ceiling, and the size caps all mean "this
    /// formula exceeded a calculation limit".
    Limit,
    /// Excel's `#NULL!`: the intersection operator (a space between two ranges)
    /// found no overlapping cells.
    ///
    /// WHY IT EXISTS NOW, having been "deliberately absent" before: absence was
    /// only defensible while nothing could ever HOLD one. That was never true --
    /// `.xlsx` files store static `#NULL!` cells -- and the reader meant to
    /// carry them mangled every error through `format!("{:?}")` first, so the
    /// claim looked true because a second bug destroyed the evidence. With that
    /// reader fixed an imported `#NULL!` had exactly two possible fates: a
    /// variant of its own, or silent rewriting to `#VALUE!` on the way in.
    /// Excel parity settles it -- they are two different errors that send a
    /// user to two different places.
    Null,
    /// Excel's `#NUM!`: a numeric argument is outside the function's domain
    /// (`SQRT(-1)`, `LOG(0)`) or the result is too large to represent.
    ///
    /// Same history as [`CellError::Null`]. The evaluator PRODUCES this now:
    /// register S6 swept every numeric-domain guard in `evaluator.rs` and split
    /// the ones where Excel distinguishes "wrong TYPE of argument" (`#VALUE!`)
    /// from "a number this function cannot use, or a result too large to
    /// represent" (`#NUM!`). See `error_value_parity_tests`.
    Num,
    /// Excel's `#SPILL!`: a dynamic array cannot write its result because
    /// something occupies the cells it needs.
    ///
    /// WHY IT IS NOT `#VALUE!`, which is what a blocked array used to answer:
    /// the remedy has nothing to do with the formula. `#VALUE!` sends a user to
    /// inspect their arguments; every argument here is fine. The fix is to
    /// CLEAR THE CELLS IN THE WAY, and the user cannot be told to do that by an
    /// error that does not distinguish the case. It also has to be COUNTABLE --
    /// error checking and the audit trail want to say "4 arrays are blocked",
    /// which needs a value of its own, and Excel's own error-checking pane
    /// treats `#SPILL!` as its own class with a "Select Obstructing Cells"
    /// action.
    ///
    /// The cell value carries no message, so the OBSTRUCTION's address is
    /// reported alongside it: see `SpillBlock` in `commands/data.rs`, which
    /// records the first blocking cell and is what the error-checking
    /// explanation names.
    Spill,
}

impl CellError {
    /// THE ONE canonical Excel-style literal for this error.
    ///
    /// Every rendering, every wire format and every persisted form goes through
    /// this table and its inverse [`CellError::from_literal`]. Before it existed
    /// there were three competing spellings â€” the UDF bridge's canonical table,
    /// a `format!("#{:?}", e).to_uppercase()` fallback in `display_value` that
    /// produced "#DIV0" / "#NAME" / "#REF" (none of which are the Excel
    /// literals, and none of which parse back), and a `format!("{:?}", e)` in
    /// the persistence layer that wrote the Rust variant NAME into the file.
    /// Divergence between them is not cosmetic: a literal that does not
    /// round-trip becomes a DIFFERENT ERROR on reload.
    ///
    /// EVERY `#{Debug}` FALLBACK IN THE PRODUCT IS GONE — D7 (2026-08-09) took
    /// the app-side one, integration took the remaining three.
    /// `cell_error_display` — what the GRID actually paints — kept one, and
    /// therefore painted `#DIV0` / `#REF` / `#NAME` / `#VALUE` / `#CIRCULAR`,
    /// none of which are Excel's spelling and none of which `from_literal`
    /// parses back. It also painted `#PARSE`, an internal enum name; that
    /// variant no longer exists (see the enum).
    ///
    /// Pointing the grid here EXPOSED three surfaces that had been quietly
    /// agreeing with the wrong spelling, which is why this note names them:
    ///   - `Grid::get_cell_display_value` (Find/Replace) — searched `#DIV0`
    ///     while the grid painted `#DIV/0!`, so searching for the visible text
    ///     returned nothing;
    ///   - `format_value_for_ai` (the AI context serializer) — handed a model
    ///     `#DIV0`, a literal no surface displays;
    ///   - `saved_value_display` (`.calp` HTML export) — re-prefixed a '#' onto
    ///     a payload that already had one and published `##DIV/0!`.
    ///
    /// There is now exactly ONE spelling per variant on every surface: grid,
    /// formula bar, Find/Replace, error checking, AI context, UDF wire,
    /// `.cala`, `.calp` and the published HTML report.
    ///
    /// **Anything that renders a `CellError` must call this.** Reconstructing a
    /// literal from the variant name is how all four divergences started.
    pub fn as_literal(&self) -> &'static str {
        match self {
            // ---- The Excel literals, spelled EXACTLY as Excel spells them ---
            // Verified character by character against Excel's error set, which
            // is the tiebreaker for anything this table does not settle on its
            // own: #DIV/0! and #VALUE! and #REF! and #NULL! and #NUM! end in
            // "!", #NAME? ends in "?", and #N/A has no trailing punctuation at
            // all. #NULL! and #NUM! now have variants of their own: the old note
            // here said they were "deliberately absent" because nothing could
            // hold one, and cited the xlsx importer as the surface that
            // recognised them anyway. That was circular -- the importer mangled
            // every error through format!("{:?}") before anything could see it,
            // so the absence justified itself with a bug. Both directions are
            // now real; see the variants.
            CellError::Div0 => "#DIV/0!",
            CellError::Ref => "#REF!",
            CellError::Name => "#NAME?",
            CellError::Value => "#VALUE!",
            CellError::NA => "#N/A",
            CellError::Null => "#NULL!",
            CellError::Num => "#NUM!",
            CellError::Spill => "#SPILL!",
            // ---- Calcula-only states, following Excel's punctuation ---------
            // None of these three has an Excel counterpart, so Excel cannot
            // settle their spelling — but it does settle their SHAPE: an error
            // literal is "#WORD" + terminal punctuation. `#CONFLICT` was the
            // one variant written without it, which made it the odd one out on
            // every surface that lists them.
            CellError::Circular => "#CIRCULAR!",
            CellError::Conflict => "#CONFLICT!",
            CellError::Blocked => "#BLOCKED!",
            CellError::Limit => "#LIMIT!",
        }
    }

    /// Inverse of [`CellError::as_literal`]. Unrecognized text falls back to
    /// `Value`, matching the UDF bridge's contract with the JS side.
    pub fn from_literal(s: &str) -> CellError {
        match s.trim().to_uppercase().as_str() {
            "#DIV/0!" => CellError::Div0,
            "#REF!" => CellError::Ref,
            "#NAME?" => CellError::Name,
            "#VALUE!" => CellError::Value,
            "#N/A" => CellError::NA,
            "#NULL!" => CellError::Null,
            "#NUM!" => CellError::Num,
            "#SPILL!" => CellError::Spill,
            "#CIRCULAR!" => CellError::Circular,
            "#CONFLICT!" => CellError::Conflict,
            "#BLOCKED!" => CellError::Blocked,
            "#LIMIT!" => CellError::Limit,
            _ => CellError::Value,
        }
    }
}

/// Represents the calculated result or raw data within a cell.
///
/// List and Dict variants use Box<Vec<...>> to keep the enum small (~24 bytes).
/// Normal scalar cells pay zero cost for the existence of these variants â€”
/// the heap allocation only happens when a List or Dict is actually created.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum CellValue {
    Empty,
    Number(f64),
    Text(String),
    Boolean(bool),
    Error(CellError),
    /// An ordered collection of values (Python-style list).
    /// Created via COLLECT() or curly-brace literal syntax.
    List(Box<Vec<CellValue>>),
    /// A key-value collection (Python-style dict).
    /// Uses Vec to preserve insertion order. Created via DICT() function.
    Dict(Box<Vec<(DictKey, CellValue)>>),
}

/// A single run of text with optional formatting overrides.
/// When a cell has rich_text, the display value is composed of these runs
/// instead of the plain display string. Each run carries its own formatting
/// that overrides the cell's base style for that segment of text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RichTextRun {
    /// The text content of this run.
    pub text: String,
    /// Override: bold (None = inherit from cell style).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    /// Override: italic.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    /// Override: underline style.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub underline: Option<UnderlineStyle>,
    /// Override: strikethrough.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strikethrough: Option<bool>,
    /// Override: font size in points.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u8>,
    /// Override: font family name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    /// Override: text color.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<Color>,
    /// Superscript rendering (reduced size, raised baseline).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub superscript: bool,
    /// Subscript rendering (reduced size, lowered baseline).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub subscript: bool,
}

impl RichTextRun {
    /// Create a plain text run with no formatting overrides.
    pub fn plain(text: String) -> Self {
        RichTextRun {
            text,
            bold: None,
            italic: None,
            underline: None,
            strikethrough: None,
            font_size: None,
            font_family: None,
            color: None,
            superscript: false,
            subscript: false,
        }
    }
}

/// The atomic unit of the spreadsheet.
///
/// The AST is the canonical storage for formulas. String form is derived
/// on demand via `formula_string()`. Plain data cells have `ast: None`.
/// Reference-site IDs on AST nodes survive formula edits via structural
/// alignment (see ast_alignment.rs).
#[derive(Debug, Serialize, Deserialize)]
pub struct Cell {
    /// The formula AST. `None` for non-formula cells (numbers, text, etc.).
    /// This is the canonical representation â€” the string form is derived.
    pub ast: Option<Box<Expression>>,
    pub value: CellValue,
    pub style_index: usize,
    /// Rich text runs for partial formatting within the cell.
    /// When present, the cell's display text is composed of these runs
    /// instead of the plain value string. Each run can override
    /// bold, italic, color, font, superscript, subscript, etc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rich_text: Option<Vec<RichTextRun>>,
}

impl Clone for Cell {
    fn clone(&self) -> Self {
        Cell {
            ast: self.ast.clone(),
            value: self.value.clone(),
            style_index: self.style_index,
            rich_text: self.rich_text.clone(),
        }
    }
}

impl Cell {
    pub fn new() -> Self {
        Cell {
            ast: None,
            value: CellValue::Empty,
            style_index: 0,
            rich_text: None,
        }
    }

    pub fn new_number(num: f64) -> Self {
        Cell {
            ast: None,
            value: CellValue::Number(num),
            style_index: 0,
            rich_text: None,
        }
    }

    pub fn new_text(text: String) -> Self {
        Cell {
            ast: None,
            value: CellValue::Text(text),
            style_index: 0,
            rich_text: None,
        }
    }

    pub fn new_formula(formula: String) -> Self {
        // Parse the string to AST. If parsing fails, store as text.
        match parser::parse(&formula) {
            Ok(ast) => Cell {
                ast: Some(Box::new(ast)),
                value: CellValue::Empty,
                style_index: 0,
                rich_text: None,
            },
            Err(_) => Cell {
                ast: None,
                value: CellValue::Text(formula),
                style_index: 0,
                rich_text: None,
            },
        }
    }

    /// Creates a new formula cell with a pre-parsed AST.
    pub fn new_formula_with_ast(ast: Expression) -> Self {
        Cell {
            ast: Some(Box::new(ast)),
            value: CellValue::Empty,
            style_index: 0,
            rich_text: None,
        }
    }

    pub fn new_boolean(value: bool) -> Self {
        Cell {
            ast: None,
            value: CellValue::Boolean(value),
            style_index: 0,
            rich_text: None,
        }
    }

    /// Returns true if this cell contains a formula.
    pub fn has_formula(&self) -> bool {
        self.ast.is_some()
    }

    /// Returns the formula as a string, rendered from the AST.
    /// Returns `None` for non-formula cells.
    ///
    /// Named user-defined (LAMBDA) function calls are shown in their friendly
    /// `Name(args)` form; the internal `__INVOKE__(...)` marker is collapsed.
    pub fn formula_string(&self) -> Option<String> {
        self.ast.as_ref().map(|ast| crate::ast_render::render_formula(ast))
    }

    /// Like [`Self::formula_string`] but preserves the raw, fully-resolved
    /// `__INVOKE__(...)` marker instead of collapsing it to the friendly
    /// function name. Persistence uses this so the saved formula re-parses to
    /// the resolved form that dependency extraction and evaluation rely on.
    pub fn formula_string_raw(&self) -> Option<String> {
        self.ast.as_ref().map(|ast| crate::ast_render::render_formula_raw(ast))
    }

    /// Returns a reference to the formula AST if this is a formula cell.
    pub fn get_ast(&self) -> Option<&Expression> {
        self.ast.as_ref().map(|b| b.as_ref())
    }

    /// Sets the formula AST for this cell.
    pub fn set_ast(&mut self, ast: Expression) {
        self.ast = Some(Box::new(ast));
    }

    /// Clears the formula (makes this a non-formula cell).
    pub fn clear_ast(&mut self) {
        self.ast = None;
    }

    // ---- Backward compatibility shims ----
    // These exist to ease migration. Callers should move to the new API.

    /// Legacy: returns the formula string. Use `formula_string()` instead.
    pub fn formula(&self) -> Option<String> {
        self.formula_string()
    }

    /// Legacy: sets the cached AST. Use `set_ast()` instead.
    pub fn set_cached_ast(&mut self, ast: Expression) {
        self.set_ast(ast);
    }

    /// Legacy: clears the cached AST. Use `clear_ast()` instead.
    pub fn clear_cached_ast(&mut self) {
        self.clear_ast();
    }

    /// Legacy: returns the cached AST. Use `get_ast()` instead.
    pub fn get_cached_ast(&self) -> Option<&Expression> {
        self.get_ast()
    }

    /// Returns the display value of the cell as a String.
    /// This is used for pivot tables and other features that need
    /// to show the cell's value as text.
    pub fn display_value(&self) -> String {
        match &self.value {
            CellValue::Empty => String::new(),
            CellValue::Number(n) => {
                // Format without unnecessary decimal places
                if n.fract() == 0.0 && n.abs() < 1e15 {
                    format!("{:.0}", n)
                } else {
                    format!("{}", n)
                }
            }
            CellValue::Text(s) => s.clone(),
            CellValue::Boolean(b) => {
                if *b { "TRUE" } else { "FALSE" }.to_string()
            }
            CellValue::Error(e) => e.as_literal().to_string(),
            CellValue::List(items) => format!("[List({})]", items.len()),
            CellValue::Dict(entries) => format!("[Dict({})]", entries.len()),
        }
    }
}

impl Default for Cell {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rich_text_run_plain() {
        let run = RichTextRun::plain("hello".to_string());
        assert_eq!(run.text, "hello");
        assert_eq!(run.bold, None);
        assert_eq!(run.italic, None);
        assert!(!run.superscript);
        assert!(!run.subscript);
    }

    #[test]
    fn test_rich_text_run_serialization_minimal() {
        // A plain run should serialize without optional fields
        let run = RichTextRun::plain("test".to_string());
        let json = serde_json::to_string(&run).unwrap();
        assert!(json.contains("\"text\":\"test\""));
        // Optional None fields should be skipped
        assert!(!json.contains("bold"));
        assert!(!json.contains("italic"));
        assert!(!json.contains("superscript"));
        assert!(!json.contains("subscript"));
    }

    #[test]
    fn test_rich_text_run_serialization_with_overrides() {
        let run = RichTextRun {
            text: "bold text".to_string(),
            bold: Some(true),
            italic: Some(false),
            underline: None,
            strikethrough: None,
            font_size: Some(14),
            font_family: None,
            color: Some(Color::new(255, 0, 0)),
            superscript: true,
            subscript: false,
        };
        let json = serde_json::to_string(&run).unwrap();
        assert!(json.contains("\"bold\":true"));
        assert!(json.contains("\"italic\":false"));
        assert!(json.contains("\"fontSize\":14"));
        assert!(json.contains("\"superscript\":true"));
        // subscript is false so should be skipped
        assert!(!json.contains("\"subscript\""));
        // underline is None so should be skipped
        assert!(!json.contains("\"underline\""));
    }

    #[test]
    fn test_rich_text_run_deserialization_camel_case() {
        let json = r#"{"text":"hi","bold":true,"fontSize":12,"superscript":true}"#;
        let run: RichTextRun = serde_json::from_str(json).unwrap();
        assert_eq!(run.text, "hi");
        assert_eq!(run.bold, Some(true));
        assert_eq!(run.font_size, Some(12));
        assert!(run.superscript);
        assert!(!run.subscript); // default
        assert_eq!(run.italic, None); // missing = None
    }

    #[test]
    fn test_rich_text_run_roundtrip() {
        let original = RichTextRun {
            text: "formatted".to_string(),
            bold: Some(true),
            italic: Some(true),
            underline: Some(UnderlineStyle::Single),
            strikethrough: Some(false),
            font_size: Some(18),
            font_family: Some("Arial".to_string()),
            color: Some(Color::new(0, 128, 255)),
            superscript: false,
            subscript: true,
        };
        let json = serde_json::to_string(&original).unwrap();
        let restored: RichTextRun = serde_json::from_str(&json).unwrap();
        assert_eq!(original, restored);
    }

    #[test]
    fn test_cell_with_rich_text() {
        let mut cell = Cell::new_text("Hello World".to_string());
        assert!(cell.rich_text.is_none());

        cell.rich_text = Some(vec![
            RichTextRun {
                text: "Hello ".to_string(),
                bold: Some(true),
                ..RichTextRun::plain(String::new())
            },
            RichTextRun::plain("World".to_string()),
        ]);

        assert_eq!(cell.rich_text.as_ref().unwrap().len(), 2);
        assert_eq!(cell.rich_text.as_ref().unwrap()[0].bold, Some(true));
        assert_eq!(cell.rich_text.as_ref().unwrap()[1].bold, None);
    }

    #[test]
    fn test_cell_clone_preserves_rich_text() {
        let mut cell = Cell::new_text("test".to_string());
        cell.rich_text = Some(vec![RichTextRun {
            text: "test".to_string(),
            superscript: true,
            ..RichTextRun::plain(String::new())
        }]);

        let cloned = cell.clone();
        assert!(cloned.rich_text.is_some());
        assert!(cloned.rich_text.as_ref().unwrap()[0].superscript);
    }

    #[test]
    fn test_cell_rich_text_serialization_roundtrip() {
        let mut cell = Cell::new_text("x2".to_string());
        cell.rich_text = Some(vec![
            RichTextRun::plain("x".to_string()),
            RichTextRun {
                text: "2".to_string(),
                superscript: true,
                ..RichTextRun::plain(String::new())
            },
        ]);

        let json = serde_json::to_string(&cell).unwrap();
        let restored: Cell = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.rich_text.as_ref().unwrap().len(), 2);
        assert!(restored.rich_text.as_ref().unwrap()[1].superscript);
    }

    #[test]
    fn test_cell_without_rich_text_no_field_in_json() {
        let cell = Cell::new_number(42.0);
        let json = serde_json::to_string(&cell).unwrap();
        // rich_text is None, so should not appear in JSON
        assert!(!json.contains("richText"));
    }
}