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
    /// Show a name spelled like a cell that no binder in scope binds QUOTED
    /// (the formula bar's spelling, [`render_cell_shaped_name`]).
    quote_names: bool,
    /// The LET names and LAMBDA parameters in scope at this point of the
    /// walk, so a name spelled like a cell that NONE of them binds is shown
    /// quoted ([`render_cell_shaped_name`]).
    bound: Vec<String>,
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

/// The reserved function name `resolve_names_in_ast` injects for a call to a
/// user-defined (named `LAMBDA`) function. Not a name a user formula can spell.
pub const NAMED_INVOKE_MARKER: &str = "__INVOKE__";

/// Render a formula AST to its canonical string representation.
/// Does NOT include a leading '=' -- the caller adds it if needed for display.
///
/// The internal `__INVOKE__("Name", lambda, args...)` marker that name
/// resolution injects for user-defined (named `LAMBDA`) function calls is
/// collapsed back to the friendly `Name(args...)` so the formula bar shows the
/// authored call rather than the expanded LAMBDA. Use [`render_formula_raw`]
/// wherever the expanded form must be preserved (persistence / round-tripping).
pub fn render_formula(expr: &Expression) -> String {
    render_expr_quoting(expr, true, true)
}

/// Like [`render_formula`] but preserves the literal `__INVOKE__(...)` marker
/// instead of collapsing it to the friendly function name. Used by persistence
/// so the saved (and re-parsed-on-load) formula keeps the resolved form that
/// dependency extraction and evaluation rely on.
pub fn render_formula_raw(expr: &Expression) -> String {
    render_expr_quoting(expr, false, false)
}

/// Collapse a PERSISTED formula string to the form the user sees.
///
/// The one string→string bridge between the two renderings above. Persistence
/// writes [`render_formula_raw`] (`SavedCell::from_cell` →
/// `Cell::formula_string_raw`) so the resolved `__INVOKE__("Name", lambda, …)`
/// marker round-trips into an AST evaluation can use. Anything that compares a
/// stored formula against a LIVE cell's `formula_string()` is therefore
/// comparing two spellings of one formula, and finds them different forever.
///
/// WHERE THAT BIT. A `.calp` subscriber's override ledger records the baseline
/// from the live cell (collapsed) and reads upstream from the published payload
/// (raw). A cell holding `=Double(5)`, where `Double` is a named LAMBDA, was a
/// PERMANENT conflict: every refresh re-reported it as "changed on both sides"
/// even when the publisher had not touched it, showed the internal marker to
/// the user as "theirs", and one click on "Take all theirs" discarded the
/// subscriber's edit for a cell nobody had edited. In the other direction a
/// subscriber who typed the publisher's exact formula never auto-cleared.
///
/// CHEAP BY CONSTRUCTION: the marker is a reserved name no user formula can
/// contain, so the substring test below skips the parse for every ordinary
/// formula. A text this cannot parse comes back UNCHANGED rather than empty —
/// a comparison against the original spelling is what the caller had before,
/// which is a worse answer than the collapse and a much better one than "".
pub fn collapse_formula_text(raw: &str) -> String {
    if !raw.contains(NAMED_INVOKE_MARKER) {
        return raw.to_string();
    }
    // Collapsed, but a name spelled like a cell stays BARE
    // (`render_cell_shaped_name`): the .xlsx writer reads this text and
    // writes such a name `_xlnm.D1`, which a quote would hide from it.
    match parser::parse(raw) {
        Ok(ast) => render_expr_quoting(&ast, true, false),
        Err(_) => raw.to_string(),
    }
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
            quote_names: collapse,
            bound: Vec::new(),
        };
        render_into(expr, &mut ctx, &mut out);
    }
    (out, spans)
}

/// The renderer with its two display choices: collapse the named-invoke
/// marker, and quote a name spelled like a cell that nothing binds
/// ([`render_cell_shaped_name`]; the formula bar only).
fn render_expr_quoting(expr: &Expression, collapse: bool, quote_names: bool) -> String {
    let mut out = String::new();
    let mut ctx = RenderCtx {
        collapse,
        path: Vec::new(),
        spans: None,
        quote_names,
        bound: Vec::new(),
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

        // `Sheet2!A1` in a formula read in R1C1 is that sheet's NAME, held as
        // the range of the name with itself (`parser::apply_r1c1_fallback`):
        // written back the way it was typed, one name behind its sheet.
        Expression::Range { sheet: sheet @ Some(_), start: s, end: e, .. }
            if matches!(
                (s.as_ref(), e.as_ref()),
                (Expression::NamedRef { name: a, .. }, Expression::NamedRef { name: b, .. })
                    if a.eq_ignore_ascii_case(b) && is_cell_spelling(a)
            ) =>
        {
            out.push_str(&render_sheet_prefix(sheet));
            // Bare, not Excel's `Sheet2!'A1'`: a quote after `!` does not
            // parse back (`render_cell_shaped_name`).
            if let Expression::NamedRef { name, .. } = s.as_ref() {
                ctx.bound.push(name.clone());
            }
            ctx.enter(0);
            render_into(s, ctx, out);
            ctx.leave();
            if matches!(s.as_ref(), Expression::NamedRef { .. }) {
                ctx.bound.pop();
            }
        }

        Expression::Range { sheet, start: s, end: e, .. } => {
            out.push_str(&render_sheet_prefix(sheet));
            // A name half is quoted only where the parser reads a quote back
            // as a range half: never behind a sheet (`Sheet2!D1:D2`, a range
            // of names in R1C1 -- a quote after `!` names no sheet), and the
            // END only after a quoted START (`'D1':'D2'`, `'D1':X1`; `X1:D2`
            // and `$D$1:D2` stay bare, and the R1C1 fallback reads their
            // names). A half left bare counts as bound for this range.
            let depth = ctx.bound.len();
            let start_quoted = sheet.is_none()
                && matches!(s.as_ref(), Expression::NamedRef { name, .. }
                    if ctx.quote_names
                        && parser::parser::is_cell_spelling(name)
                        && !ctx.bound.iter().any(|b| b.eq_ignore_ascii_case(name)));
            let bare_halves: Vec<&Expression> = if sheet.is_some() {
                vec![s.as_ref(), e.as_ref()]
            } else if !start_quoted {
                vec![e.as_ref()]
            } else {
                Vec::new()
            };
            for half in bare_halves {
                if let Expression::NamedRef { name, .. } = half {
                    ctx.bound.push(name.clone());
                }
            }
            ctx.enter(0);
            render_no_sheet_into(s, ctx, out);
            ctx.leave();
            out.push(':');
            ctx.enter(1);
            // `Sheet1!A1:Sheet1!A3` keeps its second qualifier, as Excel's
            // formula bar does (BUG-0646): the parser stores it on the end
            // corner. A corner without one renders bare, as it always has.
            if matches!(e.as_ref(), Expression::CellRef { sheet: Some(_), .. }) && sheet.is_some() {
                render_into(e, ctx, out);
            } else {
                render_no_sheet_into(e, ctx, out);
            }
            ctx.leave();
            ctx.bound.truncate(depth);
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
                || render_inline_invoke_into(func, args, ctx, out)
                || render_trim_dots_into(func, args, ctx, out);
            if !collapsed {
                out.push_str(func.to_canonical_name());
                out.push('(');
                // The binders in scope, by the parser's rule
                // (`parser::parser::apply_r1c1_fallback`): a LAMBDA parameter
                // in the body, a LET name in every LATER argument -- never in
                // its own value. A binder slot itself is its name, never shown
                // quoted.
                let depth = ctx.bound.len();
                let last = args.len().saturating_sub(1);
                let is_let = *func == BuiltinFunction::Let && args.len() >= 3;
                if *func == BuiltinFunction::Lambda {
                    for a in &args[..last] {
                        if let Expression::NamedRef { name, .. } = a {
                            ctx.bound.push(name.clone());
                        }
                    }
                }
                let mut pending: Option<String> = None;
                for (i, a) in args.iter().enumerate() {
                    if i > 0 { out.push(','); }
                    let let_binder = match a {
                        Expression::NamedRef { name, .. } if is_let && i < last && i % 2 == 0 => Some(name.clone()),
                        _ => None,
                    };
                    if let Some(name) = &let_binder {
                        ctx.bound.push(name.clone());
                    }
                    ctx.enter(i);
                    render_into(a, ctx, out);
                    ctx.leave();
                    if let Some(name) = let_binder {
                        ctx.bound.pop();
                        pending = Some(name);
                    } else if is_let && i < last && i % 2 == 1 {
                        if let Some(name) = pending.take() {
                            ctx.bound.push(name);
                        }
                    }
                }
                ctx.bound.truncate(depth);
                out.push(')');
            }
        }

        Expression::NamedRef { name, .. } => render_cell_shaped_name(name, ctx, out),

        Expression::Sheet3DRef { start_sheet, end_sheet, reference, .. } => {
            if !sheet_range_renders_bare(start_sheet, end_sheet) {
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
            // A name behind the span (`Sheet1:Sheet2!A1`, read in R1C1) stays
            // bare: a quote after `!` would not parse back.
            let depth = ctx.bound.len();
            let halves: Vec<&Expression> = match reference.as_ref() {
                Expression::Range { start, end, .. } => vec![start.as_ref(), end.as_ref()],
                other => vec![other],
            };
            for half in halves {
                if let Expression::NamedRef { name, .. } = half {
                    ctx.bound.push(name.clone());
                }
            }
            ctx.enter(0);
            render_into(reference, ctx, out);
            ctx.leave();
            ctx.bound.truncate(depth);
        }

        // The WHOLE table shows as its bare name in the formula bar (DISPLAY
        // ONLY, `quote_names`) and is stored `Tbl[]`, Excel's own file text
        // [LIVE, lane namese: `=ROWS(Tbl[])` shows `=ROWS(Tbl)`, is filed
        // `ROWS(Tbl[])`]. The bare name reads back through the host's
        // bare-table rule; the stored text needs no table registry to read.
        Expression::TableRef { table_name, specifier: TableSpecifier::Whole, .. }
            if ctx.quote_names && !table_name.is_empty() =>
        {
            out.push_str(table_name);
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
    if name != NAMED_INVOKE_MARKER || args.len() < 2 {
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

/// If `func`/`args` are the INLINE invocation `__INVOKE__(callee, args...)` --
/// the parser's spelling of `LAMBDA(x,x*2)(5)`, whose callee is a function
/// call -- append Excel's spelling `callee(args...)` and return true.
///
/// Lane formc (2026-11-05): this rendered the marker itself, so the formula
/// bar (`commands/utils.rs` builds the cell's formula from `formula_string`),
/// the AI's formula context and Find & Replace showed `=__INVOKE__(LAMBDA(x,
/// x*2),5)` for what [LIVE] Excel 16 shows as `=LAMBDA(x,x*2)(5)`. The
/// spelling parses back to the identical tree (`expr(args)` after a call IS
/// the invocation), so the raw form for persistence renders it too. The NAMED
/// shape (`__INVOKE__("Name", lambda, args)`) is not this: its first argument
/// is a text, never a call.
fn render_inline_invoke_into(
    func: &BuiltinFunction,
    args: &[Expression],
    ctx: &mut RenderCtx<'_>,
    out: &mut String,
) -> bool {
    let BuiltinFunction::Custom(name) = func else { return false; };
    if name != NAMED_INVOKE_MARKER || args.is_empty() {
        return false;
    }
    if !matches!(args[0], Expression::FunctionCall { .. }) {
        return false;
    }
    ctx.enter(0);
    render_into(&args[0], ctx, out);
    ctx.leave();
    out.push('(');
    for (j, a) in args[1..].iter().enumerate() {
        if j > 0 { out.push(','); }
        ctx.enter(j + 1);
        render_into(a, ctx, out);
        ctx.leave();
    }
    out.push(')');
    true
}

/// Letters then digits (`A1`, `zz9`): a name spelled like a cell, which exists
/// only in a formula read in R1C1.
fn is_cell_spelling(name: &str) -> bool {
    let letters = name.chars().take_while(|c| c.is_ascii_alphabetic()).count();
    letters > 0 && letters < name.len() && name[letters..].chars().all(|c| c.is_ascii_digit())
}

/// Append a CellRef without its sheet prefix (for Range start/end endpoints).
/// A NAME SPELLED LIKE A CELL THAT NO LET / LAMBDA IN SCOPE BINDS IS SHOWN
/// QUOTED, as Excel's formula bar shows it, so it cannot be mistaken for the
/// reference it looks like.
///
/// [LIVE, Excel 16, 2026-11-05, rev-parse probe B, `Range.Formula2` read back]
/// `=D1+LET(A1,5,A1)` shows `='D1'+LET(A1,5,A1)`, `=SUM(D1:D2,LAMBDA(a1,a1)(1))`
/// `=SUM('D1':'D2',LAMBDA(a1,a1)(1))`, `=LET(A1,5,A1+INDEX(T1,1,1))`
/// `=LET(A1,5,A1+INDEX('T1',1,1))` and `=LET(n,5,LAMBDA(n1,n1+n)(1))+D1`
/// `...+'D1'`, while a binder and every use of it in its scope stay bare
/// (`LET(A1,5,A1)`). Such a name exists only in a formula Excel reads in R1C1
/// (`parser::parser::apply_r1c1_fallback`), where it is #NAME?.
///
/// DISPLAY ONLY (`quote_names`: [`render_formula`], and the collapsed
/// [`render_with_spans`]): the raw text persistence writes keeps the bare
/// spelling, which reads back as the same name (the formula still declares
/// the binder), and so does [`collapse_formula_text`], whose text the .xlsx
/// writer turns into Excel's file text (`_xlnm.D1`). The parser reads the
/// quoted spelling back as the same name.
fn render_cell_shaped_name(name: &str, ctx: &mut RenderCtx<'_>, out: &mut String) {
    let quoted = ctx.quote_names
        && parser::parser::is_cell_spelling(name)
        && !ctx.bound.iter().any(|b| b.eq_ignore_ascii_case(name));
    if quoted {
        out.push('\'');
        out.push_str(name);
        out.push('\'');
    } else {
        out.push_str(name);
    }
}

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
        // A DELETED sheet (`parser::ast::REF_ERROR_SHEET`): Excel writes `#REF!`
        // where the sheet was, unquoted -- `=#REF!A1`, `=SUM(#REF!A1:A3)`. The
        // parser reads that spelling back to the same marker.
        Some(name) if name == parser::ast::REF_ERROR_SHEET => "#REF!".to_string(),
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

/// True when `name` can be written without apostrophes: it lexes as ONE plain
/// identifier (`read_identifier` in the parser's lexer), and nothing else.
///
/// Identifier-SHAPED is not enough, and the difference lost formulas: the
/// lexer reads `TRUE` / `FALSE` (any case) as BOOLEAN literals, and it takes a
/// `.` into an identifier only when a letter, digit or `_` follows it (a
/// trailing dot is the trim-reference operator). So a sheet named `True`,
/// `Q1.` or `a..b` rendered bare produced text that does not parse --
/// `every_sheet_name_survives_render_then_parse_in_every_reference_shape`.
///
/// AND EXCEL WOULD WRITE IT BARE TOO. Excel [LIVE, Excel 16, 2026-10-31,
/// relocref/probe-quote*.ps1: a sheet of each name, `Range.Formula` read back]
/// writes a non-ASCII LETTER bare (`=Översikt!A1`, `=Straße!A1`, `=Å1!A1`,
/// `=中文!A1` -- the lexer reads every one of them), and QUOTES two shapes this
/// rule used to leave bare:
///   * a name that IS a cell address in range: `'A1'`, `'Q1'`, `'x1'`,
///     `'XFD1048576'`, `'A01'` -- but `XFE1`, `AAAA1`, `A0`, `XFD1048577`
///     bare;
///   * a name that STARTS with an R1C1 reference: `'R'`, `'C'`, `'RC'`,
///     `'R2'`, `'C3'`, `'R1C1'`, `'R1x'`, `'RC1x'`, `'R1Ö'`, `'C16385'` -- but
///     `Rx`, `RCx`, `RR`, `R0`, `C0`, `R1048577` and `R1.x` bare.
/// `Sheet1` is neither, so the default names stay bare, as in Excel.
fn is_bare_sheet_name(name: &str) -> bool {
    let chars: Vec<char> = name.chars().collect();
    // The lexer's letter class (`is_letter`, core/parser/src/lexer.rs), minus
    // the `\` a sheet name cannot hold.
    let letter = |c: char| c.is_ascii_alphabetic() || c == '_' || (!c.is_ascii() && c.is_alphabetic());
    match chars.first() {
        Some(c) if letter(*c) => {}
        _ => return false,
    }
    for (i, c) in chars.iter().enumerate() {
        match c {
            c if letter(*c) || c.is_ascii_digit() => {}
            // The lexer's own continuation rule for a dot.
            '.' => match chars.get(i + 1) {
                Some(next) if letter(*next) || next.is_ascii_digit() => {}
                _ => return false,
            },
            _ => return false,
        }
    }
    // The words the lexer turns into something other than an identifier.
    if name.eq_ignore_ascii_case("TRUE") || name.eq_ignore_ascii_case("FALSE") {
        return false;
    }
    !is_a1_cell_shaped(name) && !starts_with_r1c1_reference(name)
}

/// Is `name` exactly an A1 cell address on the sheet (column A..XFD, row
/// 1..1048576, leading zeros allowed)? Excel quotes such a sheet name.
fn is_a1_cell_shaped(name: &str) -> bool {
    let letters = name.chars().take_while(|c| c.is_ascii_alphabetic()).count();
    let digits = &name[letters..];
    if !(1..=3).contains(&letters) || digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let col = name[..letters]
        .chars()
        .fold(0u32, |n, c| n * 26 + (c.to_ascii_uppercase() as u32 - 'A' as u32 + 1));
    let row = digits.trim_start_matches('0').parse::<u64>().unwrap_or(0);
    col <= 16_384 && (1..=1_048_576).contains(&row)
}

/// Does `name` begin with an R1C1 reference -- `R`, `C` or `RC` alone, or
/// `R<n>`, `C<n>`, `R<n>C`, `RC<n>`, `R<n>C<m>` followed by anything but a
/// `.`? Excel quotes such a sheet name (measured shapes in
/// [`is_bare_sheet_name`]): a row number must be 1..1048576, a column number
/// any positive number (`C16385` is quoted too).
fn starts_with_r1c1_reference(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if matches!(upper.as_str(), "R" | "C" | "RC") {
        return true;
    }
    let bytes = upper.as_bytes();
    let mut i = 0;
    let digits_at = |from: usize| bytes[from..].iter().take_while(|b| b.is_ascii_digit()).count();
    let number = |from: usize, len: usize| upper[from..from + len].trim_start_matches('0').parse::<u64>().unwrap_or(0);
    let mut has_number = false;
    if bytes.first() == Some(&b'R') {
        i = 1;
        let n = digits_at(i);
        if n > 0 {
            if !(1..=1_048_576).contains(&number(i, n)) {
                return false;
            }
            has_number = true;
            i += n;
        }
    }
    if bytes.get(i) == Some(&b'C') {
        i += 1;
        let n = digits_at(i);
        if n > 0 {
            if number(i, n) == 0 {
                return false;
            }
            has_number = true;
            i += n;
        }
    }
    has_number && bytes.get(i) != Some(&b'.')
}

/// May a 3-D reference's bookend PAIR be written without apostrophes?
///
/// Each name being bare is necessary and not sufficient: the pair is read by
/// the parser's RANGE grammar first, so `A1:Other!B2` is the range `A1:OTHER`
/// (and fails), and `N:Q1!B2` likewise -- a sheet named like a cell or a
/// column is only safe bare when the parser's 3-D branch is the one that
/// fires. Rather than copy that grammar here (a copy drifts), the bare
/// candidate is PARSED: bare only when it reads back as a 3-D reference to
/// the same two sheets. Rare enough (a 3-D reference) that the parse is free.
fn sheet_range_renders_bare(start: &str, end: &str) -> bool {
    if !is_bare_sheet_name(start) || !is_bare_sheet_name(end) {
        return false;
    }
    match parser::parse(&format!("={}:{}!A1", start, end)) {
        Ok(Expression::Sheet3DRef { start_sheet, end_sheet, .. }) => {
            // Excel's sheet-name rule, not ASCII case: a bare non-ASCII name
            // reads back folded per character (`ÖVERSIKT`).
            identity::sheet_names_equal(&start_sheet, start) && identity::sheet_names_equal(&end_sheet, end)
        }
        _ => false,
    }
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
        // `Tbl[]`: the stored spelling of the whole table (the formula bar
        // shows the bare name -- see `render_into`).
        TableSpecifier::Whole => "[]".to_string(),
        TableSpecifier::Headers => "[#Headers]".to_string(),
        TableSpecifier::Totals => "[#Totals]".to_string(),
        // The two special-item PAIRS Excel accepts, in the order it stores them
        // (BUG-0643: the second item was rendered as an escaped column `'#Data`).
        TableSpecifier::HeadersAndData | TableSpecifier::DataAndTotals => {
            format!("[{}]", special_items(spec))
        }
        TableSpecifier::SpecialColumn(special, col) => {
            // The special item(s) already carry their own brackets (`[#Data]`,
            // `[#Headers],[#Data]`), which is exactly the inner half Excel
            // wants; the column gets its own, and one more pair wraps the comma.
            format!(
                "[{},[{}]]",
                special_items(special),
                escape_column_name(col)
            )
        }
        TableSpecifier::SpecialColumnRange(special, start, end) => format!(
            "[{},[{}]:[{}]]",
            special_items(special),
            escape_column_name(start),
            escape_column_name(end)
        ),
    }
}

/// The bracketed special item(s) of a region, WITHOUT the outer pair a whole
/// specifier adds: `[#Data]`, `[#Headers],[#Data]`.
fn special_items(spec: &TableSpecifier) -> String {
    match spec {
        TableSpecifier::HeadersAndData => "[#Headers],[#Data]".to_string(),
        TableSpecifier::DataAndTotals => "[#Data],[#Totals]".to_string(),
        other => render_table_specifier(other),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// The formula bar quotes a name spelled like a cell that nothing binds
// (`render_cell_shaped_name`), and the quoted text reads back as that name.
#[cfg(test)]
#[path = "cell_shaped_name_render_tests.rs"]
mod cell_shaped_name_render_tests;

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
    /// literal, produced by the parser for `LAMBDA(...)(x)`) is not the named
    /// collapse: it renders as Excel spells an invocation, `callee(args)`
    /// (lane formc; it rendered the `__INVOKE__` marker before).
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
        assert_eq!(render_formula(&inline), "SUM(1)(5)");
        assert_eq!(render_formula_raw(&inline), "SUM(1)(5)");
    }

    /// The string→string bridge: PERSISTED text in, DISPLAYED text out.
    ///
    /// Persistence writes the raw marker so it re-parses to the resolved form;
    /// anything comparing a stored formula to a live cell's `formula_string()`
    /// is otherwise comparing two spellings of one formula and finding them
    /// different forever. That is what made a `.calp` subscriber's `=Double(5)`
    /// a permanent conflict.
    ///
    /// SABOTAGE: `render_formula(&ast)` -> `render_formula_raw(&ast)`.
    #[test]
    fn collapse_formula_text_brings_persisted_text_to_the_displayed_form() {
        // Exactly what `SavedCell.formula` holds for a cell authored as
        // `=Double(D4)` where `Double` is a named LAMBDA.
        let persisted = "__INVOKE__(\"Double\",LAMBDA(x,x*2),D4)";
        assert_eq!(collapse_formula_text(persisted), "Double(D4)");

        // ...and it agrees with what a LIVE cell reports, which is the whole
        // comparison this function exists to make possible. A `.calp`
        // subscriber's override records the live side and reads upstream from
        // the persisted side; without the collapse the two are never equal.
        let live = crate::cell::Cell::new_formula(persisted.to_string());
        assert_eq!(live.formula_string().as_deref(), Some("Double(D4)"));
        assert_eq!(collapse_formula_text(persisted), live.formula_string().unwrap());
    }

    /// An ordinary formula is returned unchanged and never parsed — the marker
    /// is a reserved name no user formula can contain, so the substring test is
    /// the whole cost for every workbook that has no named LAMBDA.
    ///
    /// SABOTAGE: drop the `contains(NAMED_INVOKE_MARKER)` early return; the
    /// second case then comes back re-rendered as `SUM(A1:A3)+1` — a different
    /// string for the same formula, which is exactly the class of drift this
    /// function exists to remove.
    #[test]
    fn collapse_formula_text_leaves_an_ordinary_formula_byte_identical() {
        assert_eq!(collapse_formula_text("A1+B2"), "A1+B2");
        assert_eq!(collapse_formula_text("sum( A1:A3 ) + 1"), "sum( A1:A3 ) + 1");
        // Unparseable text comes back as itself rather than as an empty string:
        // the caller's fallback is the original spelling, never nothing.
        assert_eq!(
            collapse_formula_text("__INVOKE__(\"Broken\","),
            "__INVOKE__(\"Broken\","
        );
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

    /// Excel's quoting, measured [LIVE, Excel 16, 2026-10-31,
    /// relocref/probe-quote*.ps1: a sheet of each name, `Range.Formula` read
    /// back]. This REPLACES the old assertion that `A1` and `ZZ100` render bare
    /// -- Excel writes `='A1'!A1` and `='ZZ100'!A1` -- and the ASCII-only rule
    /// that quoted every non-ASCII name Excel writes bare (`=Översikt!A1`).
    #[test]
    fn a_sheet_name_is_quoted_exactly_where_excel_quotes_it() {
        let bare = [
            "\u{d6}versikt", "Stra\u{df}e", "\u{c5}r2024", "\u{c5}B12", "\u{c5}1", "\u{e9}1", "\u{d6}A1",
            "\u{131}f", "\u{4e2d}\u{6587}", "\u{d6}R1C1", "A1\u{d6}", "x\u{e9}y", "\u{212a}elvin", "Sheet1", "XFE1",
            "AAAA1", "A0", "XFD1048577", "A1x", "A1B", "AB1C", "Rx", "Cx", "RCx", "Rab", "Cab", "RR", "CC", "R0",
            "C0", "R1048577", "R_1", "R1.x", "a.1", "A1.B", "R1.B", "Cr", "Sum", "A", "ABCD", "Data_2024", "_x",
        ];
        let quoted = [
            "A1", "ZZ100", "Q1", "x1", "Ra1", "XFD1", "XFD1048576", "A01", "R1C1", "R", "C", "RC", "r", "R2", "C3",
            "r2c", "R1", "C1", "RC1", "R1C", "R1x", "C1x", "R1C1x", "R1Cx", "RC1x", "RC2x", "R1_", "R01",
            "R1048576", "C16384", "C16385", "R1C16385", "R1\u{d6}", "TRUE", "FALSE", "1abc",
        ];
        let mut wrong = Vec::new();
        for name in bare {
            if quote_sheet_name(name) != name {
                wrong.push(format!("{name}: Excel writes it bare, Calcula {}", quote_sheet_name(name)));
            }
        }
        for name in quoted {
            if quote_sheet_name(name) != format!("'{name}'") {
                wrong.push(format!("{name}: Excel quotes it, Calcula {}", quote_sheet_name(name)));
            }
        }
        assert!(wrong.is_empty(), "disagrees with Excel:\n  {}", wrong.join("\n  "));
        // Every one of them reads back as its own sheet.
        for name in bare.iter().chain(quoted.iter()) {
            let formula = format!("={}!A1", quote_sheet_name(name));
            match parser::parse(&formula) {
                Ok(Expression::CellRef { sheet: Some(got), .. }) => assert!(
                    identity::sheet_names_equal(&got, name),
                    "`{formula}` read back as sheet `{got}`"
                ),
                other => panic!("`{formula}` -> {other:?}"),
            }
        }
    }

    #[test]
    fn a_bare_identifier_sheet_name_is_left_unquoted() {
        // The widened rule must not start quoting everything. In particular it
        // must not capture the DEFAULT sheet names, or every saved formula in
        // every existing workbook would be rewritten for no reason. (`A1` and
        // `ZZ100` used to be listed here; Excel quotes both -- see
        // `a_sheet_name_is_quoted_exactly_where_excel_quotes_it`.)
        for name in ["Sheet1", "Sheet2", "Data", "_hidden", "Q1_2026", "a.b"] {
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

    /// RENDER-THEN-PARSE IS A FIXED POINT FOR EVERY SHEET NAME, including the
    /// identifier-shaped ones the LEXER does not read as an identifier.
    ///
    /// `is_bare_sheet_name` asked only "is it identifier-shaped", and two
    /// families of identifier-shaped names are not identifiers to the lexer:
    ///   * `TRUE` / `FALSE` in any case lex as BOOLEAN literals, so a sheet
    ///     called `True` rendered `True!A1`, which does not parse;
    ///   * a `.` that nothing name-like follows is NOT part of an identifier
    ///     (it is the trim-reference operator), so `Q1.` and `a..b` rendered
    ///     bare and stopped at the dot.
    /// A rename to such a name (or a `.calp` collision rename onto one) made
    /// every formula that named the sheet unreadable; `repair_all_formulas`
    /// refuses the rename rather than corrupting the workbook, so the user
    /// simply could not use the name. Every reference shape carries the name,
    /// so each is checked, and so are both bookends of a 3-D reference.
    #[test]
    fn every_sheet_name_survives_render_then_parse_in_every_reference_shape() {
        let names = [
            "TRUE", "FALSE", "true", "False", "tRuE", "Q1.", "a.", "a..b", "x.1.", "Data", "Sheet1",
            "_hidden", "a.b", "a._b", "Q1.Sales", "A1", "R1C1", "SUM", "N",
        ];
        let cell = |sheet: Option<String>| Expression::CellRef {
            sheet,
            col: "A".to_string(),
            row: 1,
            col_absolute: false,
            row_absolute: false,
            ref_site_id: Default::default(),
        };
        let sheet_of = |expr: &Expression| -> Vec<String> {
            match expr {
                Expression::CellRef { sheet: Some(s), .. }
                | Expression::Range { sheet: Some(s), .. }
                | Expression::ColumnRef { sheet: Some(s), .. }
                | Expression::RowRef { sheet: Some(s), .. } => vec![s.clone()],
                Expression::Sheet3DRef { start_sheet, end_sheet, .. } => {
                    vec![start_sheet.clone(), end_sheet.clone()]
                }
                other => panic!("not a sheet reference: {:?}", other),
            }
        };
        for name in names {
            let shapes = vec![
                cell(Some(name.to_string())),
                Expression::Range {
                    sheet: Some(name.to_string()),
                    start: Box::new(cell(None)),
                    end: Box::new(Expression::CellRef {
                        sheet: None,
                        col: "B".to_string(),
                        row: 5,
                        col_absolute: true,
                        row_absolute: true,
                        ref_site_id: Default::default(),
                    }),
                    ref_site_id: Default::default(),
                },
                Expression::ColumnRef {
                    sheet: Some(name.to_string()),
                    start_col: "A".to_string(),
                    end_col: "C".to_string(),
                    start_absolute: false,
                    end_absolute: false,
                    ref_site_id: Default::default(),
                },
                Expression::RowRef {
                    sheet: Some(name.to_string()),
                    start_row: 2,
                    end_row: 4,
                    start_absolute: false,
                    end_absolute: false,
                    ref_site_id: Default::default(),
                },
                Expression::Sheet3DRef {
                    start_sheet: name.to_string(),
                    end_sheet: "Other".to_string(),
                    reference: Box::new(cell(None)),
                    ref_site_id: Default::default(),
                },
                Expression::Sheet3DRef {
                    start_sheet: "Other".to_string(),
                    end_sheet: name.to_string(),
                    reference: Box::new(cell(None)),
                    ref_site_id: Default::default(),
                },
            ];
            for shape in shapes {
                let rendered = render_formula_raw(&shape);
                let reparsed = parser::parse(&format!("={}", rendered)).unwrap_or_else(|e| {
                    panic!("sheet `{}` rendered `{}`, which does not parse: {:?}", name, rendered, e)
                });
                // A BARE name comes back upper-cased (the lexer's rule); a
                // quoted one keeps its spelling. Either way it is the SAME sheet.
                let want: Vec<String> = sheet_of(&shape).iter().map(|s| s.to_uppercase()).collect();
                let got: Vec<String> = sheet_of(&reparsed).iter().map(|s| s.to_uppercase()).collect();
                assert_eq!(got, want, "sheet `{}` rendered `{}` and read back as another sheet", name, rendered);
                // And the second trip changes nothing at all.
                assert_eq!(
                    render_formula_raw(&reparsed).to_uppercase(),
                    rendered.to_uppercase(),
                    "sheet `{}`: render is not a fixed point",
                    name
                );
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
            TableSpecifier::Whole,
            TableSpecifier::Headers,
            TableSpecifier::Totals,
            TableSpecifier::SpecialColumn(Box::new(TableSpecifier::DataRows), "REV".to_string()),
            // BUG-0643: the two special-item pairs, alone, with a column, and
            // with a column span -- and a span after a single special item.
            TableSpecifier::HeadersAndData,
            TableSpecifier::DataAndTotals,
            TableSpecifier::SpecialColumn(Box::new(TableSpecifier::HeadersAndData), "REV".to_string()),
            TableSpecifier::SpecialColumn(Box::new(TableSpecifier::DataAndTotals), "#n".to_string()),
            TableSpecifier::SpecialColumnRange(Box::new(TableSpecifier::Headers), "A".to_string(), "B".to_string()),
            TableSpecifier::SpecialColumnRange(
                Box::new(TableSpecifier::HeadersAndData),
                "A".to_string(),
                "B".to_string(),
            ),
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
            // BUG-0643 [LIVE, Excel 16, parser lane probe]: a SECOND special item
            // is a special item, never a column -- Excel's formula bar shows each
            // of these exactly so.
            "ROWS(TABLE3[[#Headers],[#Data]])",
            "ROWS(TABLE3[[#Data],[#Totals]])",
            "ROWS(TABLE3[[#Headers],[#Data],['#n]])",
            "SUM(TABLE4[[#Data],[#Totals],[p]])",
            "COLUMNS(TABLE4[[#Headers],[#Data],[p]:[q]])",
            "ROWS(TABLE4[[#Headers],[p]:[q]])",
        ] {
            let ast = parser::parse(source)
                .unwrap_or_else(|e| panic!("Excel spelling {} does not parse: {}", source, e));
            let rendered = render_formula_raw(&ast);
            assert_eq!(rendered, source, "{} did not round-trip", source);
        }
    }

    /// BUG-0643. Excel stores a reversed special pair in its own order and
    /// refuses the pairs it has no region for [LIVE, Excel 16: typed
    /// `Table1[[#Data],[#Headers]]` shows `Table1[[#Headers],[#Data]]`;
    /// `[[#Headers],[#Totals]]` and `[[#All],[#Data]]` are refused at entry].
    #[test]
    fn a_reversed_special_pair_is_stored_in_excels_order_and_an_impossible_one_is_refused() {
        let reversed = parser::parse("=ROWS(T[[#Data],[#Headers]])").expect("reversed pair parses");
        assert_eq!(render_formula_raw(&reversed), "ROWS(T[[#Headers],[#Data]])");
        let reversed = parser::parse("=ROWS(T[[#Totals],[#Data]])").expect("reversed pair parses");
        assert_eq!(render_formula_raw(&reversed), "ROWS(T[[#Data],[#Totals]])");
        assert!(parser::parse("=ROWS(T[[#Headers],[#Totals]])").is_err());
        assert!(parser::parse("=ROWS(T[[#All],[#Data]])").is_err());
        // An ESCAPED `#` is a column name, not a special item.
        match parser::parse("=T[[#Data],['#Totals]]").expect("parses") {
            Expression::TableRef { specifier, .. } => assert_eq!(
                specifier,
                TableSpecifier::SpecialColumn(Box::new(TableSpecifier::DataRows), "#Totals".to_string())
            ),
            other => panic!("not a table ref: {:?}", other),
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

    /// NEW-bare-table-name. [LIVE, Excel 16, lane namese, SCRATCH/namese/
    /// p1.txt] `=ROWS(Tbl[])` shows `=ROWS(Tbl)` and is filed `ROWS(Tbl[])`;
    /// `=ROWS(Tbl[#Data])` shows and is filed as typed.
    #[test]
    fn the_whole_table_shows_bare_and_is_stored_with_empty_brackets() {
        for (typed, shown, stored) in [
            ("=ROWS(Tbl[])", "ROWS(Tbl)", "ROWS(Tbl[])"),
            ("=ROWS(Tbl[ ])", "ROWS(Tbl)", "ROWS(Tbl[])"),
            ("=Tbl[]+0", "Tbl+0", "Tbl[]+0"),
            ("=ROWS(Tbl[#Data])", "ROWS(Tbl[#Data])", "ROWS(Tbl[#Data])"),
            ("=ROWS(Tbl[[#Data]])", "ROWS(Tbl[#Data])", "ROWS(Tbl[#Data])"),
        ] {
            let ast = parser::parse(typed).expect("parses");
            // The lexer folds a table name; the host restamps the table's own
            // casing (`table_deps::restamp_table_casing`), so compare folded.
            assert_eq!(render_formula(&ast).to_ascii_uppercase(), shown.to_ascii_uppercase(), "{} in the formula bar", typed);
            assert_eq!(render_formula_raw(&ast).to_ascii_uppercase(), stored.to_ascii_uppercase(), "{} as stored", typed);
            assert_eq!(
                parser::parse(&format!("={}", stored)).expect("the stored text parses back"),
                ast,
                "{}: the stored text reads back as the same reference",
                typed
            );
        }
    }
}
