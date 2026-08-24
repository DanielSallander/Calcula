//! FILENAME: core/engine/src/ast_render.rs
//! PURPOSE: Renders a formula AST back to a canonical formula string.
//! CONTEXT: This is the single canonical renderer for AST → string conversion.
//! Used by Cell::formula_string(), the formula bar, persistence (debug only),
//! and anywhere a formula needs to be displayed as text.
//!
//! RULES:
//! - Function names are uppercase (SUM, not sum)
//! - Whitespace is normalized (no user-typed whitespace preserved)
//! - Absolute reference markers ($) are preserved
//! - Sheet names with spaces or apostrophes are quoted

use parser::ast::{BinaryOperator, BuiltinFunction, Expression, TableSpecifier, UnaryOperator, Value};
use std::collections::HashMap;
use std::fmt::Write;

// ---------------------------------------------------------------------------
// OPERATOR PRECEDENCE
//
// The AST has no parenthesis node: `parse_primary`'s `Token::LParen` arm
// returns the inner expression and the grouping is gone. That is fine as long
// as the RENDERER puts the parentheses back wherever the tree binds more
// tightly than the flat text would. It did not, so `=(A1+B1)*C1` rendered
// `A1+B1*C1` — the formula bar showed a formula the user never typed, and
// because persistence stores the RENDERED text and re-parses it on load, the
// saved workbook came back computing a different number.
//
// These levels mirror the parser's descent chain exactly, lowest first:
//   parse_comparison -> parse_concatenation -> parse_additive
//     -> parse_multiplicative -> parse_unary -> parse_power -> parse_primary
// If that chain ever changes, these must change with it; the round-trip
// property test in this file is what enforces the pairing.
// ---------------------------------------------------------------------------

const PREC_COMPARE: u8 = 1;
const PREC_CONCAT: u8 = 2;
const PREC_ADD: u8 = 3;
const PREC_MUL: u8 = 4;
/// `^`. Now LOOSER than the prefix unaries, which is the reverse of what it was:
/// Excel's `=-2^2` is 4, so `parse_power` takes both operands from
/// `parse_unary`. These constants mirror the descent chain and had to be
/// renumbered with it.
const PREC_POWER: u8 = 5;
const PREC_UNARY: u8 = 6;
/// Excel's POSTFIX `%`, one rank tighter than the prefix unaries so `=-2%`
/// renders back with the negation outside.
const PREC_PERCENT: u8 = 7;
/// Excel's SPACE intersection operator, which binds tighter than `^` because the
/// reference operators bind before arithmetic. Renumbered `PREC_ATOM` when this
/// was added — the header states these mirror the parser's descent chain, so they
/// move with it, and leaving intersection sharing `PREC_ATOM` would render a
/// programmatically-built `Intersect(A1, Add(B1, C1))` without the parentheses it
/// needs to parse back the same way.
const PREC_INTERSECT: u8 = 8;
/// Anything that parses as a primary and can never need guarding.
const PREC_ATOM: u8 = 9;

fn binding_power(op: &BinaryOperator) -> u8 {
    match op {
        BinaryOperator::Equal
        | BinaryOperator::NotEqual
        | BinaryOperator::LessThan
        | BinaryOperator::GreaterThan
        | BinaryOperator::LessEqual
        | BinaryOperator::GreaterEqual => PREC_COMPARE,
        BinaryOperator::Concat => PREC_CONCAT,
        BinaryOperator::Add | BinaryOperator::Subtract => PREC_ADD,
        BinaryOperator::Multiply | BinaryOperator::Divide => PREC_MUL,
        BinaryOperator::Power => PREC_POWER,
        BinaryOperator::Intersect => PREC_INTERSECT,
    }
}

/// How tightly `expr` binds once rendered — i.e. the precedence level a reader
/// of the produced TEXT would assign to it.
fn precedence(expr: &Expression) -> u8 {
    match expr {
        Expression::BinaryOp { op, .. } => binding_power(op),
        // POSTFIX `%` binds tighter than a PREFIX `-`, so the two unary
        // spellings do not share a rank.
        Expression::UnaryOp { op: UnaryOperator::Percent, .. } => PREC_PERCENT,
        Expression::UnaryOp { .. } => PREC_UNARY,
        // A negative number literal renders with a leading `-`, so in text it
        // behaves exactly like a unary negation: `-5^2` would re-parse as
        // `-(5^2)`. The parser can never produce this node, but a script or a
        // constant-folding pass can.
        Expression::Literal(Value::Number(n)) if *n < 0.0 => PREC_UNARY,
        _ => PREC_ATOM,
    }
}

/// Append `child` as an operand, parenthesising it when the surrounding
/// position demands at least `min_prec` and the child binds looser than that.
fn render_child_into(child: &Expression, min_prec: u8, ctx: &mut RenderCtx<'_>, out: &mut String) {
    let guarded = precedence(child) < min_prec;
    if guarded {
        out.push('(');
    }
    render_into(child, ctx, out);
    if guarded {
        out.push(')');
    }
}

/// Byte spans of each sub-expression within the rendered text, keyed by the
/// child-index path from the root (`[]` is the whole formula, `[0]` the left
/// operand of a root binary op, and so on).
pub type SpanMap = HashMap<Vec<usize>, (usize, usize)>;

/// Rendering state threaded through [`render_into`].
///
/// `spans` is what makes this ONE renderer rather than three. The Evaluate
/// Formula dialog and the Formula Visualizer need to underline the
/// sub-expression they are about to evaluate, and each of them used to carry
/// its OWN AST->text walker to get the offsets -- walkers that had no
/// parenthesis guard (so `=(A1+B1)*C1` was SHOWN as `A1+B1*C1`) and their own
/// 224-arm function-name table ending in a `{:?}` catch-all, so 248 of the
/// enum's 472 functions were shown under their Rust variant name: `VLookup(`,
/// `StdevS(` for STDEV.S, `NormDist(` for NORM.DIST. Both walkers are deleted;
/// the offsets now come from the renderer that produces the text, so a
/// highlight cannot point at something the text does not say.
struct RenderCtx<'a> {
    collapse: bool,
    path: Vec<usize>,
    spans: Option<&'a mut SpanMap>,
}

impl RenderCtx<'_> {
    #[inline]
    fn tracking(&self) -> bool {
        self.spans.is_some()
    }
    /// Descend into child `idx`. A no-op when nobody asked for spans, so the
    /// hot path (persistence renders every formula in the workbook) pays
    /// nothing for the bookkeeping.
    #[inline]
    fn enter(&mut self, idx: usize) {
        if self.tracking() {
            self.path.push(idx);
        }
    }
    #[inline]
    fn leave(&mut self) {
        if self.tracking() {
            self.path.pop();
        }
    }
    #[inline]
    fn record(&mut self, start: usize, end: usize) {
        let path = self.path.clone();
        if let Some(spans) = self.spans.as_deref_mut() {
            spans.insert(path, (start, end));
        }
    }
}

/// Render a formula AST to its canonical string representation.
/// Does NOT include a leading '=' -- the caller adds it if needed for display.
///
/// The internal `__INVOKE__("Name", lambda, args...)` marker that name
/// resolution injects for user-defined (named `LAMBDA`) function calls is
/// collapsed back to the friendly `Name(args...)` so the formula bar shows the
/// authored call rather than the expanded LAMBDA. Use [`render_formula_raw`]
/// wherever the expanded form must be preserved (persistence / round-tripping).
pub fn render_formula(expr: &Expression) -> String {
    render_expr(expr, true)
}

/// Like [`render_formula`] but preserves the literal `__INVOKE__(...)` marker
/// instead of collapsing it to the friendly function name. Used by persistence
/// so the saved (and re-parsed-on-load) formula keeps the resolved form that
/// dependency extraction and evaluation rely on.
pub fn render_formula_raw(expr: &Expression) -> String {
    render_expr(expr, false)
}

/// The canonical text PLUS the byte span of every sub-expression.
///
/// The text is byte-identical to [`render_formula`] / [`render_formula_raw`] for
/// the same `collapse` flag -- it is produced by the same code -- which is the
/// property `spans_agree_with_the_canonical_text` pins.
pub fn render_with_spans(expr: &Expression, collapse: bool) -> (String, SpanMap) {
    let mut out = String::new();
    let mut spans = SpanMap::new();
    {
        let mut ctx = RenderCtx {
            collapse,
            path: Vec::new(),
            spans: Some(&mut spans),
        };
        render_into(expr, &mut ctx, &mut out);
    }
    (out, spans)
}

fn render_expr(expr: &Expression, collapse: bool) -> String {
    let mut out = String::new();
    let mut ctx = RenderCtx {
        collapse,
        path: Vec::new(),
        spans: None,
    };
    render_into(expr, &mut ctx, &mut out);
    out
}

/// THE renderer. Every AST->text surface in the product bottoms out here.
fn render_into(expr: &Expression, ctx: &mut RenderCtx<'_>, out: &mut String) {
    let start = out.len();

    match expr {
        Expression::Literal(val) => out.push_str(&render_value(val)),

        Expression::CellRef { sheet, col, row, col_absolute, row_absolute, .. } => {
            out.push_str(&render_sheet_prefix(sheet));
            if *col_absolute { out.push('$'); }
            out.push_str(col);
            if *row_absolute { out.push('$'); }
            out.push_str(&row.to_string());
        }

        Expression::Range { sheet, start: s, end: e, .. } => {
            out.push_str(&render_sheet_prefix(sheet));
            ctx.enter(0);
            render_no_sheet_into(s, ctx, out);
            ctx.leave();
            out.push(':');
            ctx.enter(1);
            render_no_sheet_into(e, ctx, out);
            ctx.leave();
        }

        Expression::ColumnRef { sheet, start_col, end_col, start_absolute, end_absolute, .. } => {
            out.push_str(&render_sheet_prefix(sheet));
            if *start_absolute { out.push('$'); }
            out.push_str(start_col);
            out.push(':');
            if *end_absolute { out.push('$'); }
            out.push_str(end_col);
        }

        Expression::RowRef { sheet, start_row, end_row, start_absolute, end_absolute, .. } => {
            out.push_str(&render_sheet_prefix(sheet));
            if *start_absolute { out.push('$'); }
            out.push_str(&start_row.to_string());
            out.push(':');
            if *end_absolute { out.push('$'); }
            out.push_str(&end_row.to_string());
        }

        Expression::BinaryOp { left, op, right } => {
            let p = binding_power(op);
            // EVERY binary operator is left-associative now, `^` included —
            // Excel folds equal priority left to right with no exception, so
            // `=2^3^2` is 64. The old special case existed because `^` was
            // right-associative and took its left operand from `parse_primary`;
            // both of those are gone.
            let (left_min, right_min) = (p, p + 1);
            ctx.enter(0);
            render_child_into(left, left_min, ctx, out);
            ctx.leave();
            let _ = write!(out, "{}", op);
            ctx.enter(1);
            render_child_into(right, right_min, ctx, out);
            ctx.leave();
        }

        // POSTFIX, and it has to be rendered before the prefix arm below or the
        // `%` would come out in front of its operand.
        Expression::UnaryOp { op: op @ UnaryOperator::Percent, operand } => {
            ctx.enter(0);
            render_child_into(operand, PREC_PERCENT, ctx, out);
            ctx.leave();
            let _ = write!(out, "{}", op);
        }

        Expression::UnaryOp { op, operand } => {
            // `parse_unary`'s operand is itself `parse_unary`, so a nested unary
            // or a `%` needs no parentheses; anything looser does.
            let _ = write!(out, "{}", op);
            ctx.enter(0);
            render_child_into(operand, PREC_UNARY, ctx, out);
            ctx.leave();
        }

        Expression::FunctionCall { func, args, .. } => {
            // Collapse the named-function invocation marker back to `Name(args)`
            // for display. The raw path (collapse == false) falls through and
            // renders the literal `__INVOKE__("Name", lambda, args)` form.
            let collapsed = (ctx.collapse && render_named_invoke_into(func, args, ctx, out))
                || render_trim_dots_into(func, args, ctx, out);
            if !collapsed {
                out.push_str(func.to_canonical_name());
                out.push('(');
                for (i, a) in args.iter().enumerate() {
                    if i > 0 { out.push(','); }
                    ctx.enter(i);
                    render_into(a, ctx, out);
                    ctx.leave();
                }
                out.push(')');
            }
        }

        Expression::NamedRef { name, .. } => out.push_str(name),

        Expression::Sheet3DRef { start_sheet, end_sheet, reference, .. } => {
            if needs_quoting(start_sheet) || needs_quoting(end_sheet) {
                // ONE pair of apostrophes wraps the whole `A:B` bookend pair, so
                // each half is escaped but not separately quoted.
                let _ = write!(
                    out,
                    "'{}:{}'!",
                    start_sheet.replace('\'', "''"),
                    end_sheet.replace('\'', "''")
                );
            } else {
                let _ = write!(out, "{}:{}!", start_sheet, end_sheet);
            }
            ctx.enter(0);
            render_into(reference, ctx, out);
            ctx.leave();
        }

        Expression::TableRef { table_name, specifier, .. } => {
            out.push_str(table_name);
            out.push_str(&render_table_specifier(specifier));
        }

        Expression::IndexAccess { target, index } => {
            // The subscript chain is parsed off a primary; the index sits inside
            // brackets and so needs no guarding.
            ctx.enter(0);
            render_child_into(target, PREC_ATOM, ctx, out);
            ctx.leave();
            out.push('[');
            ctx.enter(1);
            render_into(index, ctx, out);
            ctx.leave();
            out.push(']');
        }

        // Excel's ARRAY CONSTANT. `,` between columns, `;` between rows, and NO
        // space after either: this is the INVARIANT spelling that has to parse
        // back byte-identically, and `formula_locale` is what turns it into the
        // user's separators for display.
        Expression::ArrayLiteral { rows } => {
            out.push('{');
            for (r, row) in rows.iter().enumerate() {
                if r > 0 { out.push(';'); }
                for (c, e) in row.iter().enumerate() {
                    if c > 0 { out.push(','); }
                    // Step path stays row-major so the Evaluate-Formula walker
                    // can address a cell of the constant.
                    ctx.enter(r * row.len() + c);
                    render_into(e, ctx, out);
                    ctx.leave();
                }
            }
            out.push('}');
        }

        // COLLECT(...), not `{...}`. Braces are Excel's array constant now, so
        // rendering a List with them would round-trip it into an ARRAY — a
        // contained value silently becoming a spilling one.
        Expression::ListLiteral { elements } => {
            out.push_str("COLLECT(");
            for (i, e) in elements.iter().enumerate() {
                if i > 0 { out.push(','); }
                ctx.enter(i);
                render_into(e, ctx, out);
                ctx.leave();
            }
            out.push(')');
        }

        Expression::DictLiteral { entries } => {
            out.push('{');
            for (i, (k, v)) in entries.iter().enumerate() {
                if i > 0 { out.push_str(", "); }
                ctx.enter(i * 2);
                render_into(k, ctx, out);
                ctx.leave();
                out.push_str(": ");
                ctx.enter(i * 2 + 1);
                render_into(v, ctx, out);
                ctx.leave();
            }
            out.push('}');
        }

        // SpillRef and ImplicitIntersection give their operand the SAME path as
        // themselves: the evaluation walker treats each as a single indivisible
        // step, so there is no child step to highlight. Recording the parent
        // AFTER the child (below) is what makes the wider span win.
        Expression::SpillRef { cell, .. } => {
            render_child_into(cell, PREC_ATOM, ctx, out);
            out.push('#');
        }

        Expression::ImplicitIntersection { operand } => {
            // `@` takes a `parse_primary`, so its operand must be atom-level.
            out.push('@');
            render_child_into(operand, PREC_ATOM, ctx, out);
        }
    }

    let end = out.len();
    ctx.record(start, end);
}

/// Renders `TRIMRANGE(range, k, k)` back as the dotted range the user typed —
/// `A1.:.A8` — and returns true. Returns false for every other shape, so the
/// caller renders the function call normally.
///
/// WHY RENDER IT BACK. The parser lowers the `.` operator to this call, which
/// is what keeps the two spellings from drifting; the cost is that without
/// this, a user who typed `=A1:.A8` would find `=TRIMRANGE(A1:A8,2,2)` in the
/// formula bar the next time they opened the cell. Excel keeps the dots, and
/// a formula that rewrites itself on being looked at is its own defect.
///
/// The shape it matches — three arguments, both codes equal, both in 1..=3 — is
/// exactly what the parser emits. An explicit `TRIMRANGE(A1:A8,3,3)` matches it
/// too and comes back as dots. That collision is accepted deliberately: the two
/// forms mean the same thing, and preserving the spelling users actually type
/// is worth more than preserving the one they can also spell out.
fn render_trim_dots_into(
    func: &BuiltinFunction,
    args: &[Expression],
    ctx: &mut RenderCtx<'_>,
    out: &mut String,
) -> bool {
    if *func != BuiltinFunction::TrimRange || args.len() != 3 {
        return false;
    }
    let code = match (&args[1], &args[2]) {
        (Expression::Literal(Value::Number(r)), Expression::Literal(Value::Number(c)))
            if r == c && (*r == 1.0 || *r == 2.0 || *r == 3.0) => *r as u8,
        _ => return false,
    };
    // The argument must BE a reference, not merely render with a colon in it.
    // Without this, `TRIMRANGE(SORT(A1:A8),3,3)` rendered `SORT(A1.:.A8)` --
    // the dots landed on the inner range and the formula said something the
    // AST never did. `Range` covers the whole-axis spellings too, since a
    // `ColumnRef`/`RowRef` renders as `A:A` / `1:1`.
    if !matches!(
        args[0],
        Expression::Range { .. }
            | Expression::ColumnRef { .. }
            | Expression::RowRef { .. }
            | Expression::Sheet3DRef { .. }
    ) {
        return false;
    }

    let start = out.len();
    ctx.enter(0);
    render_into(&args[0], ctx, out);
    ctx.leave();

    // The LAST colon, not the first: in a 3-D reference (`Sheet1:Sheet3!A1:A8`)
    // the first one joins the sheets and the dots belong to the cells. A range
    // always has one — if this rendered to something without a colon it is not
    // a range, and the function form is the honest way to show it.
    let Some(colon) = out[start..].rfind(':').map(|i| start + i) else {
        out.truncate(start);
        return false;
    };
    if code & 2 != 0 {
        out.insert(colon + 1, '.');
    }
    if code & 1 != 0 {
        out.insert(colon, '.');
    }
    true
}

/// If `func`/`args` are the named-function invocation marker
/// `__INVOKE__("Name", lambda, arg1, ...)`, append `Name(arg1, ...)` and return
/// true. Returns false for the inline-lambda shape `__INVOKE__(lambda, args)`
/// (no leading name literal) and for any non-invoke call, so the caller renders
/// those normally.
fn render_named_invoke_into(
    func: &BuiltinFunction,
    args: &[Expression],
    ctx: &mut RenderCtx<'_>,
    out: &mut String,
) -> bool {
    let BuiltinFunction::Custom(name) = func else { return false; };
    if name != "__INVOKE__" || args.len() < 2 {
        return false;
    }
    // Named form only: args[0] is the display-name string literal, args[1] is
    // the resolved LAMBDA, args[2..] are the call arguments.
    let Expression::Literal(Value::String(fn_name)) = &args[0] else { return false; };
    out.push_str(fn_name);
    out.push('(');
    for (j, a) in args[2..].iter().enumerate() {
        if j > 0 { out.push(','); }
        // The path stays the TRUE AST index so a span keys to the same node the
        // evaluation walker names, even though the display hides args 0 and 1.
        ctx.enter(j + 2);
        render_into(a, ctx, out);
        ctx.leave();
    }
    out.push(')');
    true
}

/// Append a CellRef without its sheet prefix (for Range start/end endpoints).
fn render_no_sheet_into(expr: &Expression, ctx: &mut RenderCtx<'_>, out: &mut String) {
    match expr {
        Expression::CellRef { col, row, col_absolute, row_absolute, .. } => {
            let start = out.len();
            if *col_absolute { out.push('$'); }
            out.push_str(col);
            if *row_absolute { out.push('$'); }
            out.push_str(&row.to_string());
            let end = out.len();
            ctx.record(start, end);
        }
        _ => render_into(expr, ctx, out),
    }
}

/// Longest PLAIN decimal rendering a numeric literal may have before the
/// renderer switches to scientific notation.
///
/// Rust's `Display` for `f64` never uses an exponent, so `format!("{}", 1e300)`
/// is a **301-character** string of digits — and this renderer's output is not
/// only what the formula bar shows, it is what `.cala` STORES and re-parses.
/// `=1E300*A1` therefore round-tripped as a 301-digit literal, and `=1E-300`
/// as a 302-character one, in the file and on screen.
///
/// 20 is chosen so that nothing human-scale moves: the widest ordinary value —
/// an exact integer just under the `1e15` fast path, or a 17-digit
/// `1e16`-scale number — stays plain, and only genuinely absurd expansions
/// switch. Excel likewise spells extreme magnitudes with an exponent.
const MAX_PLAIN_LITERAL_LEN: usize = 20;

fn render_value(val: &Value) -> String {
    match val {
        Value::Number(n) => {
            if *n == (*n as i64) as f64 && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                // `{:E}` produces `1E300` / `1.5E-7`, which this crate's lexer
                // reads back as one number token (its exponent rule accepts a
                // bare, `+` or `-` exponent), so the round trip that
                // persistence depends on is preserved.
                let plain = format!("{}", n);
                if plain.len() > MAX_PLAIN_LITERAL_LEN {
                    format!("{:E}", n)
                } else {
                    plain
                }
            }
        }
        // A `"` inside the text is written `""` -- the escape the lexer reads
        // back. Without it a string carrying a quote rendered to text that does
        // not re-parse, and was lost on save/reload.
        Value::String(s) => format!("\"{}\"", s.replace('"', "\"\"")),
        Value::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        // Verbatim: the parser stored the CANONICAL spelling (the lexer
        // uppercases), so this re-lexes to the same literal and the round trip
        // is a fixed point.
        Value::Error(e) => e.clone(),
        // AN OMITTED ARGUMENT RENDERS AS NOTHING, which is the only spelling
        // that re-parses to the same call: `IF(TRUE,,5)` keeps its three
        // arguments because the empty slot between the commas is still there.
        // Rendering anything at all here -- `0`, `""` -- would show the user a
        // formula they never typed, and because `.cala` STORES this text and
        // re-parses it on load, the workbook would come back computing a
        // different number (`=VLOOKUP(x,t,2,)` is exact match; the `""` it would
        // have become is `#VALUE!`).
        Value::Blank => String::new(),
    }
}

fn render_sheet_prefix(sheet: &Option<String>) -> String {
    match sheet {
        Some(name) => format!("{}!", quote_sheet_name(name)),
        None => String::new(),
    }
}

/// A sheet name as it must appear in formula text: bare when it lexes as a
/// plain identifier, otherwise wrapped in apostrophes with every embedded
/// apostrophe DOUBLED -- the escape `read_quoted_identifier` already reads.
///
/// The old rule quoted only names containing a space or an apostrophe, and it
/// never doubled. Both halves lost data. `John's` was emitted as
/// `'John's'!A1`, which does not lex; `Q1-2026` and `2026` were emitted
/// bare, which lexes as arithmetic. `repair_all_formulas` turns a formula that
/// fails to re-parse into a plain value, so renaming a sheet to any such name
/// silently destroyed every formula that referred to it.
pub fn quote_sheet_name(name: &str) -> String {
    if is_bare_sheet_name(name) {
        name.to_string()
    } else {
        format!("'{}'", name.replace('\'', "''"))
    }
}

/// True when `name` can be written without apostrophes: identifier-shaped, and
/// not itself a cell reference (a bare `A1` would lex as one).
fn is_bare_sheet_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    // A reference-SHAPED name (`A1`, `ZZ100`) needs no quoting: the trailing
    // `!` is what tells the lexer this is a sheet, and `=A1!B2` parses with
    // sheet `A1`. Quoting them would have been harmless in isolation but it
    // also captures `Sheet1`, `Sheet2`, `Q1` -- the DEFAULT sheet names -- and
    // would have re-quoted the formula text of essentially every existing
    // workbook for nothing.
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

fn needs_quoting(name: &str) -> bool {
    !is_bare_sheet_name(name)
}

/// Render a TableSpecifier to its bracket notation.
///
/// Every arm must emit text the PARSER READS BACK AS THE SAME SPECIFIER. Three
/// of them did not, and because `SavedCell::from_cell` stores this text and
/// `to_cell` feeds it to `Cell::new_formula` — which stores an unparseable
/// formula as a TEXT VALUE (`cell.rs`) — the failure was silent corruption of
/// the saved file, not an error anyone saw:
///
///   * `SpecialColumn` emitted `Sales[#Data],Revenue`, which re-parses as TWO
///     arguments (`Sales[#Data]` and a NamedRef `Revenue`). `=SUM(...)` over it
///     silently changed from one column to the whole table body plus an
///     undefined name — a different NUMBER, with no warning.
///   * `ColumnRange` emitted `Sales[a]:[b]` and `ThisRowRange` emitted
///     `Sales[@a]:[@b]`; neither parses at all (there is no generic postfix `:`
///     after a table ref), so reopening the file replaced the formula with its
///     own mangled text.
///
/// The forms below are Excel's (ECMA-376 structured references): the column
/// part of a multi-part specifier is ALWAYS itself bracketed, and the whole
/// thing sits inside one outer bracket pair. `parse_nested_bracket_specifier`
/// is the matching reader; `render_then_parse_is_a_fixed_point` pins the pair.
/// Puts Excel's `'` escapes back on a column name.
///
/// THE OTHER HALF OF THE OPAQUE BRACKET BODY. Now that the parser reads a
/// bracket body as characters, a name carrying `[`, `]` or `'` renders to text
/// that would re-parse as STRUCTURE unless it is escaped -- a column called
/// `Cost [USD]` would come back as a nested specifier, and because the renderer's
/// output is what `.cala` stores and re-parses, that is a formula silently
/// changing meaning across a save. A leading `#` or `@` needs the same
/// protection for the same reason: they are what select the special-region and
/// this-row forms, and only in first position.
fn escape_column_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for (i, ch) in name.chars().enumerate() {
        let needs = match ch {
            '\'' | '[' | ']' => true,
            '#' | '@' => i == 0,
            _ => false,
        };
        if needs {
            out.push('\'');
        }
        out.push(ch);
    }
    out
}

pub fn render_table_specifier(spec: &TableSpecifier) -> String {
    match spec {
        TableSpecifier::Column(name) => format!("[{}]", escape_column_name(name)),
        // An EMPTY column name is the bare `[#This Row]` -- the formula's row
        // across the table, naming no column. It has no `@` spelling (`[@]` is a
        // parse error), and there was no arm for it at all: the parser aliased
        // `#This Row` to `DataRows`, so the formula bar and every saved `.cala`
        // re-spelled the user's own `[#This Row]` as `[#Data]` -- a reference to
        // one row coming back as a reference to the whole table body.
        TableSpecifier::ThisRow(name) if name.is_empty() => "[#This Row]".to_string(),
        TableSpecifier::ThisRow(name) => format!("[@{}]", escape_column_name(name)),
        TableSpecifier::ColumnRange(start, end) => format!(
            "[[{}]:[{}]]",
            escape_column_name(start),
            escape_column_name(end)
        ),
        TableSpecifier::ThisRowRange(start, end) => format!(
            "[[@{}]:[@{}]]",
            escape_column_name(start),
            escape_column_name(end)
        ),
        TableSpecifier::AllRows => "[#All]".to_string(),
        TableSpecifier::DataRows => "[#Data]".to_string(),
        TableSpecifier::Headers => "[#Headers]".to_string(),
        TableSpecifier::Totals => "[#Totals]".to_string(),
        TableSpecifier::SpecialColumn(special, col) => {
            // `render_table_specifier(special)` already carries its own outer
            // brackets (`[#Data]`), which is exactly the inner half Excel wants;
            // the column gets its own, and one more pair wraps the comma.
            format!(
                "[{},[{}]]",
                render_table_specifier(special),
                escape_column_name(col)
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use parser::ast::{BinaryOperator, BuiltinFunction};

    #[test]
    fn render_simple_cell_ref() {
        let expr = Expression::CellRef {
            sheet: None,
            col: "A".to_string(),
            row: 1,
            col_absolute: false,
            row_absolute: false,
            ref_site_id: Default::default(),
        };
        assert_eq!(render_formula(&expr), "A1");
    }

    #[test]
    fn render_absolute_cell_ref() {
        let expr = Expression::CellRef {
            sheet: None,
            col: "B".to_string(),
            row: 5,
            col_absolute: true,
            row_absolute: true,
            ref_site_id: Default::default(),
        };
        assert_eq!(render_formula(&expr), "$B$5");
    }

    #[test]
    fn render_cross_sheet_ref() {
        let expr = Expression::CellRef {
            sheet: Some("Sales Data".to_string()),
            col: "C".to_string(),
            row: 10,
            col_absolute: false,
            row_absolute: false,
            ref_site_id: Default::default(),
        };
        assert_eq!(render_formula(&expr), "'Sales Data'!C10");
    }

    #[test]
    fn render_range() {
        let expr = Expression::Range {
            sheet: None,
            start: Box::new(Expression::CellRef {
                sheet: None, col: "A".to_string(), row: 1,
                col_absolute: false, row_absolute: false,
                ref_site_id: Default::default(),
            }),
            end: Box::new(Expression::CellRef {
                sheet: None, col: "A".to_string(), row: 10,
                col_absolute: false, row_absolute: false,
                ref_site_id: Default::default(),
            }),
            ref_site_id: Default::default(),
        };
        assert_eq!(render_formula(&expr), "A1:A10");
    }

    #[test]
    fn render_function_call() {
        let expr = Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef {
                    sheet: None, col: "A".to_string(), row: 1,
                    col_absolute: false, row_absolute: false,
                    ref_site_id: Default::default(),
                }),
                end: Box::new(Expression::CellRef {
                    sheet: None, col: "A".to_string(), row: 10,
                    col_absolute: false, row_absolute: false,
                    ref_site_id: Default::default(),
                }),
                ref_site_id: Default::default(),
            }],
            ref_site_id: Default::default(),
        };
        assert_eq!(render_formula(&expr), "SUM(A1:A10)");
    }

    #[test]
    fn render_binary_op() {
        let expr = Expression::BinaryOp {
            left: Box::new(Expression::CellRef {
                sheet: None, col: "A".to_string(), row: 1,
                col_absolute: false, row_absolute: false,
                ref_site_id: Default::default(),
            }),
            op: BinaryOperator::Add,
            right: Box::new(Expression::CellRef {
                sheet: None, col: "B".to_string(), row: 1,
                col_absolute: false, row_absolute: false,
                ref_site_id: Default::default(),
            }),
        };
        assert_eq!(render_formula(&expr), "A1+B1");
    }

    #[test]
    fn render_literal() {
        assert_eq!(render_formula(&Expression::Literal(Value::Number(42.0))), "42");
        assert_eq!(render_formula(&Expression::Literal(Value::String("hello".to_string()))), "\"hello\"");
        assert_eq!(render_formula(&Expression::Literal(Value::Boolean(true))), "TRUE");
    }

    #[test]
    fn render_column_ref() {
        let expr = Expression::ColumnRef {
            sheet: None,
            start_col: "A".to_string(),
            end_col: "B".to_string(),
            start_absolute: true,
            end_absolute: false,
            ref_site_id: Default::default(),
        };
        assert_eq!(render_formula(&expr), "$A:B");
    }

    #[test]
    fn render_table_ref() {
        let expr = Expression::TableRef {
            table_name: "Sales".to_string(),
            specifier: TableSpecifier::Column("Revenue".to_string()),
            ref_site_id: Default::default(),
        };
        assert_eq!(render_formula(&expr), "Sales[Revenue]");
    }

    /// A named user-defined function call is stored resolved as the marker
    /// `__INVOKE__("Name", lambda, args...)`. Display must collapse it back to
    /// `Name(args...)` (the reported bug: the formula bar leaked the expanded
    /// `__INVOKE__(LAMBDA(...))`), while the raw renderer preserves it so
    /// persistence round-trips the resolved form.
    #[test]
    fn render_collapses_named_invoke() {
        let d4 = Expression::CellRef {
            sheet: None, col: "D".to_string(), row: 4,
            col_absolute: false, row_absolute: false,
            ref_site_id: Default::default(),
        };
        // args[1] is the resolved LAMBDA — the display path never inspects it,
        // so a placeholder literal stands in for it here.
        let invoke = Expression::FunctionCall {
            func: BuiltinFunction::Custom("__INVOKE__".to_string()),
            args: vec![
                Expression::Literal(Value::String("Double".to_string())),
                Expression::Literal(Value::Number(0.0)),
                d4,
            ],
            ref_site_id: Default::default(),
        };

        // Display collapses to the friendly call.
        assert_eq!(render_formula(&invoke), "Double(D4)");
        // Raw keeps the resolved marker (re-parseable, correct deps on load).
        let raw = render_formula_raw(&invoke);
        assert!(raw.starts_with("__INVOKE__(\"Double\","), "raw was: {}", raw);
        assert!(raw.ends_with(",D4)"), "raw was: {}", raw);
    }

    /// The inline-lambda shape `__INVOKE__(lambdaExpr, args)` (no leading name
    /// literal, produced by the parser for `LAMBDA(...)(x)`) must NOT collapse.
    #[test]
    fn render_does_not_collapse_inline_invoke() {
        let inline = Expression::FunctionCall {
            func: BuiltinFunction::Custom("__INVOKE__".to_string()),
            args: vec![
                // A non-string first arg marks the inline shape.
                Expression::FunctionCall {
                    func: BuiltinFunction::Sum,
                    args: vec![Expression::Literal(Value::Number(1.0))],
                    ref_site_id: Default::default(),
                },
                Expression::Literal(Value::Number(5.0)),
            ],
            ref_site_id: Default::default(),
        };
        assert_eq!(render_formula(&inline), "__INVOKE__(SUM(1),5)");
    }

    // -----------------------------------------------------------------------
    // ROUND-TRIP PROPERTY
    //
    // The AST has no parenthesis node, so the ONLY thing keeping a formula's
    // meaning intact across render -> re-parse is this renderer putting the
    // parentheses back. Persistence saves rendered text and re-parses it on
    // load, so a renderer that drops a grouping does not merely mis-display a
    // formula: it changes the number the workbook computes, silently, on the
    // next open.
    //
    // Nothing checked that before. Every renderer test above is a FLAT
    // expression, and the whole repo -- app, e2e, engine, parser -- never once
    // typed a grouped arithmetic expression, which is why `=(A1+B1)*C1`
    // rendering as `A1+B1*C1` survived. These two tests are the check that
    // makes the class unshippable: they enumerate the shapes rather than
    // sampling them.
    // -----------------------------------------------------------------------

    /// Every binary operator, at every precedence level the parser has.
    const OPS: [&str; 8] = ["+", "-", "*", "/", "^", "&", "=", "<"];

    fn round_trips(src: &str) -> Result<(), String> {
        let first = parser::parse(src).map_err(|e| format!("source did not parse: {:?}", e))?;
        let rendered = render_formula_raw(&first);
        let second = parser::parse(&format!("={}", rendered))
            .map_err(|e| format!("`{}` rendered `{}`, which does not parse: {:?}", src, rendered, e))?;
        if first != second {
            return Err(format!(
                "`{}` rendered `{}`, which re-parses to a DIFFERENT tree\n  before: {:?}\n  after:  {:?}",
                src, rendered, first, second
            ));
        }
        Ok(())
    }

    #[test]
    fn every_three_leaf_operator_pairing_survives_render_and_re_parse() {
        // Both associativity shapes for every ordered pair of operators. This
        // is the full cross-product of "parent binds tighter / looser / same"
        // against "child on the left / on the right", which is exactly the
        // matrix a precedence bug lives in.
        let mut failures = Vec::new();
        let mut checked = 0;
        for a in OPS {
            for b in OPS {
                for src in [
                    format!("=(A1{}B2){}C3", a, b),
                    format!("=A1{}(B2{}C3)", a, b),
                ] {
                    checked += 1;
                    if let Err(e) = round_trips(&src) {
                        failures.push(e);
                    }
                }
            }
        }
        assert_eq!(checked, 128, "the matrix must stay exhaustive");
        assert!(
            failures.is_empty(),
            "{} of {} groupings did not survive:\n{}",
            failures.len(),
            checked,
            failures.join("\n")
        );
    }

    #[test]
    fn unary_power_strings_and_sheet_names_survive_render_and_re_parse() {
        let cases = [
            // Unary negation against every precedence level.
            "=-(A1+B2)",
            "=-(A1*B2)",
            "=-(A1^B2)",
            "=-A1^B2",
            "=--A1",
            "=(-A1)^B2",
            // `^` is right-associative and takes its LEFT operand from
            // `parse_primary`, so a left-nested power must stay parenthesised.
            "=(A1^B2)^C3",
            "=A1^B2^C3",
            "=(A1*B2)^C3",
            // Same-precedence, right-hand side: the classic subtraction trap.
            "=A1-(B2-C3)",
            "=A1/(B2/C3)",
            "=A1&(B2&C3)",
            // Grouping nested inside a call argument.
            "=SUM((A1+B2)*C3,A1)",
            "=IF((A1+B2)>C3,\"y\",\"n\")",
            // Text literals carrying the delimiter.
            "=\"a\"\"b\"",
            "=\"\"\"quoted\"\"\"",
            "=A1&\"x\"\"y\"",
            // Sheet names that are not bare identifiers.
            "='My Sheet'!A1",
            "='John''s'!A1",
            "='Q1-2026'!A1",
            "='2026'!A1",
            "='A1'!B2",
            "=SUM('My Sheet'!A1:B2)",
        ];
        let failures: Vec<String> = cases
            .iter()
            .filter_map(|c| round_trips(c).err())
            .collect();
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    fn a_negative_number_literal_left_of_a_power_no_longer_needs_guarding() {
        // THIS TEST ASSERTED `(-5)^2` UNTIL THE PRECEDENCE MOVED, and the
        // parenthesis it demanded was load-bearing at the time: `^` used to take
        // its left operand from `parse_primary`, so a flat `-5^2` re-parsed as
        // `-(5^2)` and 25 became -25.
        //
        // `parse_power` now takes BOTH operands from `parse_unary`, because
        // Excel's `=-2^2` is 4 — negation binds tighter than `^`. Under that
        // rule `-5^2` re-parses as `(-5)^2` on its own, so the guard is dead
        // weight rather than protection. The property it existed to protect is
        // the one asserted here: the VALUE survives the round trip.
        let expr = Expression::BinaryOp {
            left: Box::new(Expression::Literal(Value::Number(-5.0))),
            op: BinaryOperator::Power,
            right: Box::new(Expression::Literal(Value::Number(2.0))),
        };
        let rendered = render_formula_raw(&expr);
        assert_eq!(rendered, "-5^2");

        let reparsed = parser::parse(&rendered).expect("rendered text must re-parse");
        let grid = crate::grid::Grid::new();
        assert_eq!(
            crate::evaluator::Evaluator::new(&grid).evaluate(&reparsed),
            crate::evaluator::EvalResult::Number(25.0),
            "`{}` must still be 25, not -25",
            rendered
        );
    }

    #[test]
    fn a_sheet_name_that_would_lex_as_something_else_is_quoted_and_escaped() {
        // `needs_quoting` used to ask only "does it contain a space or an
        // apostrophe". Each name here was emitted BARE or emitted with an
        // unescaped apostrophe, producing formula text that does not lex --
        // and `repair_all_formulas` turns a formula that fails to re-parse into
        // a plain value, so a rename to any of these silently destroyed every
        // formula that named the sheet.
        for name in ["Q1-2026", "2026", "John's", "a b", "Sales+", "x!y", "'", "a''b"] {
            let rendered = quote_sheet_name(name);
            assert!(
                rendered.starts_with('\'') && rendered.ends_with('\''),
                "`{}` must be quoted, got `{}`",
                name,
                rendered
            );
            let formula = format!("={}!A1", rendered);
            let parsed = parser::parse(&formula).unwrap_or_else(|e| {
                panic!("`{}` produced `{}`, which does not parse: {:?}", name, formula, e)
            });
            match parsed {
                Expression::CellRef { sheet: Some(got), .. } => assert_eq!(
                    got, name,
                    "`{}` rendered `{}` and read back as a different sheet",
                    name, rendered
                ),
                other => panic!("`{}` produced `{}` -> {:?}", name, formula, other),
            }
        }
    }

    #[test]
    fn a_bare_identifier_sheet_name_is_left_unquoted() {
        // The widened rule must not start quoting everything. In particular it
        // must not capture the DEFAULT sheet names, or every saved formula in
        // every existing workbook would be rewritten for no reason.
        for name in ["Sheet1", "Sheet2", "Data", "_hidden", "Q1_2026", "a.b", "A1", "ZZ100"] {
            assert_eq!(quote_sheet_name(name), name);
            // Bare names are upper-cased by the lexer (this predates the
            // change and `normalize_cross_sheet_refs` is what canonicalises
            // them); what matters is that the sheet survives the trip.
            let parsed = parser::parse(&format!("={}!A1", name)).expect("parses");
            match parsed {
                Expression::CellRef { sheet: Some(got), .. } => {
                    assert_eq!(got.to_uppercase(), name.to_uppercase())
                }
                other => panic!("`{}` -> {:?}", name, other),
            }
        }
    }

    /// EVERY `TableSpecifier` variant must render to text the parser reads back
    /// as the SAME specifier.
    ///
    /// Three of the nine did not, and the consequence was silent corruption of
    /// the saved file rather than an error: `SavedCell::from_cell` stores this
    /// text and `to_cell` feeds it to `Cell::new_formula`, which stores an
    /// UNPARSEABLE formula as a plain text value.
    ///
    ///   * `SpecialColumn` rendered `Sales[#Data],Revenue`, which re-parses
    ///     inside a call as TWO arguments -- `=SUM(Sales[[#Data],[Revenue]])`
    ///     came back as the sum of the whole table body plus an undefined name.
    ///     A different number, no warning.
    ///   * `ColumnRange` rendered `Sales[a]:[b]` and `ThisRowRange` rendered
    ///     `Sales[@a]:[@b]`; neither parses (there is no postfix `:` after a
    ///     table ref), so the formula was replaced by its own mangled text.
    ///
    /// Enumerating the variants is what makes this a census rather than the
    /// single-variant sample that was here before (`Sales[Revenue]` -- the one
    /// that worked).
    #[test]
    fn every_table_specifier_variant_survives_render_and_re_parse() {
        let variants = vec![
            TableSpecifier::Column("REV".to_string()),
            TableSpecifier::ThisRow("REV".to_string()),
            // The bare `[#This Row]`. Rendered `[#Data]` before it had an arm,
            // so this row of the census re-parsed as a DIFFERENT specifier.
            TableSpecifier::ThisRow(String::new()),
            TableSpecifier::ColumnRange("A".to_string(), "B".to_string()),
            TableSpecifier::ThisRowRange("A".to_string(), "B".to_string()),
            TableSpecifier::AllRows,
            TableSpecifier::DataRows,
            TableSpecifier::Headers,
            TableSpecifier::Totals,
            TableSpecifier::SpecialColumn(Box::new(TableSpecifier::DataRows), "REV".to_string()),
        ];

        for spec in variants {
            let expr = Expression::TableRef {
                table_name: "T".to_string(),
                specifier: spec.clone(),
                ref_site_id: Default::default(),
            };
            let text = render_formula_raw(&expr);

            let reparsed = parser::parse(&text).unwrap_or_else(|e| {
                panic!(
                    "{:?} rendered {:?}, which the parser cannot read: {}",
                    spec, text, e
                )
            });

            match &reparsed {
                Expression::TableRef { table_name, specifier, .. } => {
                    assert_eq!(table_name, "T", "table name changed for {:?}", spec);
                    assert_eq!(
                        specifier, &spec,
                        "{:?} rendered {:?} and came back as a DIFFERENT specifier",
                        spec, text
                    );
                }
                other => panic!(
                    "{:?} rendered {:?}, which re-parses as {:?} -- not a table ref \
                     at all (the comma form became two arguments)",
                    spec, text, other
                ),
            }

            // And the render must be a fixed point: render(parse(render(x))) == render(x).
            assert_eq!(
                render_formula_raw(&reparsed),
                text,
                "rendering is not a fixed point for {:?}",
                spec
            );
        }
    }

    /// A COLUMN NAME CARRYING THE STRUCTURAL CHARACTERS MUST SURVIVE A SAVE.
    ///
    /// The parser now reads a bracket body as CHARACTERS, so a name holding
    /// `[`, `]`, `#`, `@` or `'` renders to text that would re-parse as
    /// STRUCTURE unless the renderer escapes it -- `Cost [USD]` would come back
    /// as a nested specifier, and `#Rank` as the (unknown) region `#Rank`.
    /// Because this renderer's output is what `.cala` STORES and re-parses on
    /// load, an unescaped name is a formula changing meaning across a save,
    /// with no error at either end.
    ///
    /// The names that need NO escape are here as controls: if the escaper
    /// started quoting everything, `[Amount]` would render `['Amount]` and this
    /// test would still pass on the round trip -- so the rendered TEXT is
    /// asserted too.
    #[test]
    fn a_column_name_with_structural_characters_round_trips() {
        for name in [
            "Cost [USD]",
            "#Rank",
            "@Owner",
            "John's",
            "A:B",
            "Cost (USD)",
            "Sales%",
            "Profit-Loss",
        ] {
            let expr = Expression::TableRef {
                table_name: "T".to_string(),
                specifier: TableSpecifier::Column(name.to_string()),
                ref_site_id: Default::default(),
            };
            let text = render_formula_raw(&expr);
            let reparsed = parser::parse(&text)
                .unwrap_or_else(|e| panic!("`{}` rendered {:?}, which does not parse: {}", name, text, e));
            match reparsed {
                Expression::TableRef { specifier: TableSpecifier::Column(got), .. } => {
                    assert_eq!(got, name, "`{}` rendered {:?} and came back as `{}`", name, text, got)
                }
                other => panic!("`{}` rendered {:?}, which re-parses as {:?}", name, text, other),
            }
        }
        // CONTROL: a name needing no escape is rendered UNQUOTED. Without this
        // the test would pass on an escaper that quoted every character.
        assert_eq!(
            render_formula_raw(&Expression::TableRef {
                table_name: "T".to_string(),
                specifier: TableSpecifier::Column("Amount".to_string()),
                ref_site_id: Default::default(),
            }),
            "T[Amount]"
        );
    }

    /// Excel's own spellings must parse, and round-trip to themselves.
    #[test]
    fn excel_structured_reference_spellings_round_trip() {
        for source in [
            "SUM(SALES[[#Data],[REVENUE]])",
            "SUM(SALES[[REVENUE]:[COST]])",
            "SUM(SALES[[@REVENUE]:[@COST]])",
            "SUM(SALES[REVENUE])",
            "SUM(SALES[@REVENUE])",
            "SUM(SALES[#All])",
            "SUM(SALES[#Headers])",
            "SUM(SALES[#Totals])",
            "SUM(SALES[#This Row])",
        ] {
            let ast = parser::parse(source)
                .unwrap_or_else(|e| panic!("Excel spelling {} does not parse: {}", source, e));
            let rendered = render_formula_raw(&ast);
            assert_eq!(rendered, source, "{} did not round-trip", source);
        }
    }

    /// THE LONG SPELLING OF A THIS-ROW REFERENCE MUST RENDER AS THE SHORT ONE.
    ///
    /// `Sales[[#This Row],[REVENUE]]` and `Sales[@REVENUE]` are the same
    /// reference, so they must render to the same text -- and they must render
    /// to text that MEANS the same thing. The long form parsed to
    /// `SpecialColumn(DataRows, "REVENUE")` and rendered `SALES[[#Data],[REVENUE]]`:
    /// the reference widened from one cell to the whole data column, and the
    /// widened form is what `.cala` saved and the formula bar showed. Nothing
    /// failed -- `=SALES[[#This Row],[REVENUE]]*2` just answered with a number
    /// computed over every row instead of the formula's own.
    #[test]
    fn long_and_short_this_row_spellings_render_identically() {
        let long = parser::parse("SALES[[#This Row],[REVENUE]]").expect("long form parses");
        let short = parser::parse("SALES[@REVENUE]").expect("short form parses");

        assert_eq!(render_formula_raw(&long), "SALES[@REVENUE]");
        assert_eq!(render_formula_raw(&long), render_formula_raw(&short));
    }

    /// AN EXTREME NUMERIC LITERAL MUST NOT EXPAND TO 301 DIGITS.
    ///
    /// Rust's `Display` for `f64` has no exponent form, so `format!("{}", 1e300)`
    /// is a full 301-character decimal expansion. This renderer's output is not
    /// a debug string: it is what the formula bar shows AND what `.cala` writes
    /// and re-parses, so `=1E300*A1` was stored, displayed and reloaded as a
    /// 301-digit literal. Excel spells it `1E+300`.
    ///
    /// The round trip is the load-bearing half: the rendered text has to lex
    /// back to the SAME f64, or persistence changes the number.
    #[test]
    fn extreme_numeric_literals_render_in_scientific_notation() {
        for (source, expect_scientific) in [
            ("=1E300", true),
            ("=1E-300", true),
            ("=1.7976931348623157E308", true),
            // ... and the counterweight: nothing human-scale moves.
            ("=1000", false),
            ("=1E3", false),
            ("=0.001", false),
            ("=1E-9", false),
            ("=2.5", false),
            ("=123456789012345", false),
        ] {
            let ast = parser::parse(source).expect("parses");
            let rendered = render_formula_raw(&ast);
            assert!(
                rendered.len() <= 32,
                "{} rendered as {} characters: {}",
                source,
                rendered.len(),
                &rendered[..rendered.len().min(60)]
            );
            assert_eq!(
                rendered.contains('E'),
                expect_scientific,
                "{} rendered as {:?}",
                source,
                rendered
            );

            // THE ROUND TRIP. Persistence stores this text and re-parses it, so
            // a rendering that does not lex back to the same number silently
            // changes the workbook.
            let reparsed = parser::parse(&format!("={}", rendered))
                .unwrap_or_else(|e| panic!("{:?} does not re-parse: {}", rendered, e));
            assert_eq!(
                render_formula_raw(&reparsed),
                rendered,
                "{} is not a fixed point of the renderer",
                rendered
            );
        }
    }

    /// The exact bit pattern has to survive, not just the magnitude.
    #[test]
    fn scientific_rendering_preserves_the_exact_f64() {
        for n in [1e300_f64, 1e-300, 1.7976931348623157e308, 5e-324, 1.2345678901234567e250] {
            let ast = Expression::Literal(Value::Number(n));
            let rendered = render_formula_raw(&ast);
            let reparsed = parser::parse(&format!("={}", rendered)).expect("re-parses");
            match reparsed {
                Expression::Literal(Value::Number(back)) => assert_eq!(
                    back.to_bits(),
                    n.to_bits(),
                    "{:e} rendered as {:?} and came back as {:e}",
                    n,
                    rendered,
                    back
                ),
                other => panic!("{:e} rendered as {:?}, which re-parsed as {:?}", n, rendered, other),
            }
        }
    }
}
