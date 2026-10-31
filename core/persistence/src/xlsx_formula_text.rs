//! FILENAME: core/persistence/src/xlsx_formula_text.rs
//!
//! The formula TEXT an .xlsx file carries, as Excel spells it.
//!
//! Calcula keeps a formula as its canonical text (`LAMBDA(x,x+1)(2)`), and
//! persists a call to a named LAMBDA in its RESOLVED form
//! (`__INVOKE__("Double",LAMBDA(x,x*2),D4)`, see
//! `engine::ast_render::NAMED_INVOKE_MARKER`). Excel spells a file's formulas
//! differently in two ways the export must follow, or Excel refuses to open the
//! whole workbook:
//!
//! * A LAMBDA's and a LET's parameter names carry `_xlpm.`, at the declaration
//!   AND at every use inside the call, a parameter called as a function
//!   included. [LIVE] Excel 16 saves `=LAMBDA(x,x+1)(2)` as
//!   `_xlfn.LAMBDA(_xlpm.x,_xlpm.x+1)(2)`, `=LET(a,5,b,a*2,a+b)` as
//!   `_xlfn.LET(_xlpm.a,5,_xlpm.b,_xlpm.a*2,_xlpm.a+_xlpm.b)`,
//!   `=LAMBDA(f,f(2))(LAMBDA(x,x*3))` as
//!   `_xlfn.LAMBDA(_xlpm.f,_xlpm.f(2))(_xlfn.LAMBDA(_xlpm.x,_xlpm.x*3))`, and a
//!   parameter that shares a function's name (`=LET(sum,3,sum+1)`) as
//!   `_xlpm.sum`. [LIVE] Excel 16 REFUSES to open a file whose `<f>` reads
//!   `_xlfn.LAMBDA(x,x)` ("Unable to get the Open property"); the same file with
//!   `_xlpm.x` opens. The reader strips the prefix again
//!   (`xlsx_reader::strip_future_function_prefixes`). Every use is written in
//!   the DECLARED spelling, as Excel writes it (`LET(Ab,1,AB)` ->
//!   `_xlpm.Ab+_xlpm.Ab`), and only a token Calcula's lexer reads as a NAME
//!   can be one (see [`Kind`]): an error literal, a number's exponent, a
//!   reference, a sheet, a table never is.
//! * A call to a named LAMBDA is the call the user wrote (`Double(D4)`): the
//!   `__INVOKE__` marker is Calcula's own and no other reader knows it.
//!
//! * An INLINE LAMBDA call is the call the user wrote too: Calcula stores
//!   `=LAMBDA(x,x+1)(2)` as `__INVOKE__(LAMBDA(x,x+1),2)`, and [LIVE] Excel 16
//!   showed `#NAME?` for that text; its own file reads
//!   `_xlfn.LAMBDA(_xlpm.x,_xlpm.x+1)(2)`.
//! * A cell-shaped LET / LAMBDA name (`A1`, `E5`, `SUM2`, `LOG10`) is a
//!   parameter like any other ([LIVE] `_xlfn.LET(_xlpm.A1,5,_xlpm.A1+1)`), and
//!   in a range whose other half is such a parameter, a plain cell is written
//!   `_xlnm.` ([LIVE] `LET(E5,2,SUM(E5:E6))` is saved `SUM(_xlpm.E5:_xlnm.E6)`,
//!   `LET(E5,2,SUM(E4:E5))` as `SUM(_xlnm.E4:_xlpm.E5)`).
//! * An optional LAMBDA parameter `[y]` is declared `_xlop.y` and used as
//!   `_xlpm.y` ([LIVE] `_xlfn.LAMBDA(_xlpm.x,_xlop.y,..ISOMITTED(_xlpm.y)..)`).
//! * A LET name is in scope only AFTER its own value ([LIVE]
//!   `=LET(Rate,Rate*2,Rate)` is saved `_xlfn.LET(_xlpm.Rate,Rate*2,_xlpm.Rate)`),
//!   and a plain cell spelled like a cell-shaped name the formula declares,
//!   outside that name's scope, is `_xlnm.` ([LIVE] `=LET(E5,E5+1,E5)` is
//!   saved `_xlfn.LET(_xlpm.E5,_xlnm.E5+1,_xlpm.E5)`).
//! * A bare `C` or `R`, or another R1C1-shaped name (`RC`, `R2C`, `R1C1`,
//!   `RC[-1]`), that is no parameter is an R1C1 reference to Excel, which
//!   never keeps one in a file: [LIVE] `=C+1` in J13 is saved `J:J+1`,
//!   `=SUM(R)` in J14 `SUM(14:14)`, `=RC*0` in J29 `J29*0`, `=R1C1*0`
//!   `$A$1*0`, `=RC[-1]*0` in J13 `I13*0`, and `=LET(a,1,SUM(A:C)+a)` in J2
//!   `SUM(_xlpm.a:J:J)`. Excel REFUSED a file with the R1C1 text, so the
//!   export writes the A1 reference for the cell the formula sits in
//!   ([`excel_formula_text`] takes the cell). A defined name has no cell: it
//!   is left out and reported ([`unwritable_reason`]).
//! * Typed operators a file spells as functions: the trim reference
//!   (`A1:.A5`, `A1.:A5`, `A1.:.A5`, a column range `A:.C`, a row range
//!   `1:.3`) is `_xlfn._TRO_TRAILING(A1:A5)` / `_TRO_LEADING` / `_TRO_ALL`,
//!   the spill operator `A1#` is `_xlfn.ANCHORARRAY(A1)`, the implicit
//!   intersection `@x` is `_xlfn.SINGLE(x)`, a structured this-row
//!   `Table1[@Col]` is `Table1[[#This Row],[Col]]`, and a `#` in a structured
//!   reference's column name is escaped `'#` ([LIVE] all Excel 16's own; it
//!   REFUSED the trim, spill and unescaped `#` texts and read `Table1[@Col]`
//!   from a file as `#REF!`).
//! * A formula Excel cannot hold at all -- a LET / LAMBDA parameter named
//!   like a built-in and called with an arity the built-in refuses
//!   ([`Unwritable`]) -- is written as its cell's value alone, and the loss
//!   reported (`XlsxExportLosses::formulas`).
//!
//! [`calcula_formula_text`] is the reader's inverse: each of those spellings
//! back to Calcula's typed syntax, then the prefixes stripped.
//!
//! The future-function prefix (`_xlfn.`) of a CELL formula is the library's
//! (`rust_xlsxwriter::Formula::new`); a DEFINED NAME's formula gets none from
//! the library, so [`escape_defined_name_formulas`] borrows the library's own
//! escaping for it ([LIVE] Excel 16 saves a name `=LAMBDA(n,n+1)` as
//! `_xlfn.LAMBDA(_xlpm.n,_xlpm.n+1)` and `=XLOOKUP(..)` as `_xlfn.XLOOKUP(..)`).
//! The library's table has no `_TRO_*`, and it copies any text that already
//! holds `_xlfn.` unescaped, so a formula with a trim reference is escaped
//! through the same borrowed route first ([`library_formula`]).

use crate::PersistenceError;

/// The real-path table against live Excel's own file text.
#[cfg(test)]
#[path = "xlsx_formula_text_live_table.rs"]
mod live_table;

/// The prefix Excel gives a LAMBDA / LET parameter name in a file.
const PARAMETER_PREFIX: &str = "_xlpm.";

/// The prefix Excel gives an OPTIONAL LAMBDA parameter where it is declared.
const OPTIONAL_PREFIX: &str = "_xlop.";

/// The prefix Excel gives a plain cell in a range whose other half is a
/// cell-shaped parameter.
const CELL_NAME_PREFIX: &str = "_xlnm.";

/// Excel's file functions for the trim-reference operator, by which side is
/// trimmed: (name, leading dot, trailing dot).
const TRIM_OPERATORS: [(&str, bool, bool); 3] =
    [("_TRO_LEADING", true, false), ("_TRO_TRAILING", false, true), ("_TRO_ALL", true, true)];

/// A formula's text as an .xlsx `<f>` (or `<definedName>`) carries it, before
/// the library's future-function escaping: no leading `=`, a LAMBDA call
/// (named or inline) as the user wrote it, every LAMBDA / LET parameter
/// prefixed, and the typed operators in their file spelling (see the module
/// doc). `anchor` is the cell the formula sits in, 0-based `(row, col)`, for a
/// bare `C` / `R`; a defined name passes `None`.
pub(crate) fn excel_formula_text(formula: &str, anchor: Option<(u32, u32)>) -> String {
    let clean = formula.strip_prefix('=').unwrap_or(formula);
    let collapsed = engine::ast_render::collapse_formula_text(clean);
    let collapsed = collapsed.strip_prefix('=').unwrap_or(&collapsed);
    file_text(collapsed, anchor).0
}

/// One token's class: the classes Calcula's own lexer (`parser::lexer`)
/// distinguishes, with a reference the parser would build from several of
/// them kept as ONE token. Only a [`Kind::Name`] can ever be a parameter, so
/// everything the parser reads as something else -- a string, an error
/// literal, a boolean, a number with its exponent, a cell or column
/// reference, a quoted sheet, a structured reference -- is out of the scan's
/// reach by construction rather than by a case-by-case exception.
///
/// The grammar is a mirror, not a call: the lexer reports no source spans and
/// folds every identifier to upper case, and the export must copy the text
/// byte for byte. `the_scan_reads_every_name_as_calculas_lexer_does` diffs
/// the two over the whole live-Excel table, so a drift fails the build.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    /// An identifier the parser reads as a NAME (the lexer's `Identifier` when
    /// it is no reference): a function, a defined name, a sheet, a table, a
    /// parameter. `Q1.Sales`, `_x`, `\x`, `ö` and `_xlfn.LET` are one each.
    Name,
    /// `TRUE` / `FALSE`, any case (the lexer's `Boolean`).
    Boolean,
    /// A whole reference that holds no name: a cell (`A1`, `$A$1`, `A$1`,
    /// `$A1`), a column range with a `$` (`$B:$B`, `$A:C`), or any column
    /// range that follows a sheet (`Sheet1!B:B`).
    Reference,
    /// A number, its exponent included (`1E5`, `2.5E+2`, `1e-3`, `.5`).
    Number,
    /// A string literal, `""` escapes included.
    Text,
    /// A quoted sheet name, `''` escapes included (`'My Sheet'`).
    QuotedSheet,
    /// A bracketed run, nested, `'` escaping the next character: a structured
    /// reference's body (`[Col]`, `[@Col]`, `[[#This Row],[Col]]`,
    /// `[#Headers]`) or an external book (`[1]`).
    Bracket,
    /// An error literal, any case (`#N/A`, `#div/0!`, `#NAME?`).
    ErrorLiteral,
    /// A run of whitespace -- between two references, Excel's intersection
    /// operator (`SUM(a b)`).
    Space,
    /// `(` `)` `,` `{` `}` `;` `!` `:` -- one character.
    Punct(char),
    /// Any other single character: an operator, `$`, `@`, `#`, `%`, `.`.
    Other,
}

#[derive(Debug, Clone, Copy)]
struct Token {
    kind: Kind,
    start: usize,
    end: usize,
}

/// The lexer's `is_letter`: what starts (and continues) an identifier.
fn is_letter(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || c == '\\' || (!c.is_ascii() && c.is_alphabetic())
}

/// Error literals Excel writes that Calcula's lexer does not list (it holds
/// Excel's classic eight plus Calcula's own, `parser::lexer::ERROR_LITERALS`).
/// [LIVE] Excel 16 refuses to TYPE `#SPILL!` or `#CALC!` into a formula, but a
/// file may carry any of these, and each must stay one token.
const EXCEL_ONLY_ERROR_LITERALS: [&str; 7] =
    ["#GETTING_DATA", "#CALC!", "#FIELD!", "#CONNECT!", "#BUSY!", "#UNKNOWN!", "#EXTERNAL!"];

/// The byte length of the error literal starting at byte `at` (its `#`), the
/// longest that matches, any case.
fn error_literal_len(formula: &str, at: usize) -> Option<usize> {
    parser::lexer::ERROR_LITERALS
        .iter()
        .chain(EXCEL_ONLY_ERROR_LITERALS.iter())
        .filter(|lit| formula.get(at..at + lit.len()).is_some_and(|head| head.eq_ignore_ascii_case(lit)))
        .map(|lit| lit.len())
        .max()
}

/// Excel's last column (XFD) and last row.
const MAX_COLUMN: u32 = 16_384;
const MAX_ROW: u32 = 1_048_576;

/// `$?LETTERS` at `i`: the index after it, when the letters name a column (1
/// to 3 ASCII letters, at most XFD), and whether it had a `$`.
fn column_part(chars: &[(usize, char)], i: usize) -> Option<(usize, bool)> {
    let mut at = i;
    let dollar = chars.get(at).map(|&(_, c)| c) == Some('$');
    if dollar {
        at += 1;
    }
    let start = at;
    let mut column = 0u32;
    while let Some(&(_, c)) = chars.get(at) {
        if !c.is_ascii_alphabetic() || at - start == 3 {
            break;
        }
        column = column * 26 + (c.to_ascii_uppercase() as u32 - 'A' as u32 + 1);
        at += 1;
    }
    (at > start && column <= MAX_COLUMN).then_some((at, dollar))
}

/// `$?DIGITS` at `i`: the index after it, when the digits name a row.
fn row_part(chars: &[(usize, char)], i: usize) -> Option<usize> {
    let mut at = i;
    if chars.get(at).map(|&(_, c)| c) == Some('$') {
        at += 1;
    }
    let start = at;
    let mut row = 0u64;
    while let Some(&(_, c)) = chars.get(at) {
        if !c.is_ascii_digit() {
            break;
        }
        row = (row * 10 + c.to_digit(10).unwrap_or(0) as u64).min(u64::from(u32::MAX));
        at += 1;
    }
    (at > start && (1..=u64::from(MAX_ROW)).contains(&row)).then_some(at)
}

/// Whether the lexer's identifier rule continues at `at`: a letter or digit,
/// or a `.` with a letter or digit after it (`Q1.Sales`; a `.` before `:` is
/// the trim-reference operator, `A1.:B10`).
fn continues_a_name(chars: &[(usize, char)], at: usize) -> bool {
    let is_part = |i: usize| chars.get(i).is_some_and(|&(_, c)| is_letter(c) || c.is_ascii_digit());
    is_part(at) || (chars.get(at).map(|&(_, c)| c) == Some('.') && is_part(at + 1))
}

/// Whether the reference that would end at `at` really ends there: no name
/// continues (`A1B`, `A1.x`, `R1C1` are names) and no call opens (`LOG10(`).
fn ends_a_reference(chars: &[(usize, char)], at: usize) -> bool {
    !continues_a_name(chars, at) && !matches!(chars.get(at).map(|&(_, c)| c), Some('(') | Some('$'))
}

/// The index after a whole reference starting at `i`, which is then ONE
/// [`Kind::Reference`] token. [LIVE] Excel 16 saves `=LET(a,5,$A$1+a)` as
/// `_xlfn.LET(_xlpm.a,5,$A$1+_xlpm.a)`, and likewise `A$1`, `$A1`,
/// `Sheet1!$X$1`, `$B:$B`, `$B:B` and `Sheet1!B:B` beside a parameter of the
/// same letter, untouched.
///
/// A BARE `L:L` (no `$`, no sheet) is not decided here: whether it is a
/// column range or a parameter's range depends on the scope, so it is left as
/// `Name : Name` to [`mark_parameters`].
fn reference_end(chars: &[(usize, char)], i: usize, after_bang: bool) -> Option<usize> {
    let (column_end, column_dollar) = column_part(chars, i)?;
    if let Some(row_end) = row_part(chars, column_end) {
        return ends_a_reference(chars, row_end).then_some(row_end);
    }
    if chars.get(column_end).map(|&(_, c)| c) != Some(':') {
        return None;
    }
    let (second_end, second_dollar) = column_part(chars, column_end + 1)?;
    let whole = (column_dollar || second_dollar || after_bang) && ends_a_reference(chars, second_end);
    whole.then_some(second_end)
}

/// The index after the lexer's number starting at `i` (a digit, or a `.`
/// before one): digits with at most one `.`, then an exponent only when a
/// digit follows its `E` and optional sign -- `1E5` is one number, `1E` is
/// the number `1` and the name `E`.
fn number_end(chars: &[(usize, char)], i: usize) -> usize {
    let at_char = |k: usize| chars.get(k).map(|&(_, c)| c);
    let mut at = i;
    let mut dot = false;
    while let Some(c) = at_char(at) {
        if c.is_ascii_digit() {
            at += 1;
        } else if c == '.' && !dot {
            dot = true;
            at += 1;
        } else {
            break;
        }
    }
    if matches!(at_char(at), Some('e') | Some('E')) {
        let mut look = at + 1;
        if matches!(at_char(look), Some('+') | Some('-')) {
            look += 1;
        }
        if at_char(look).is_some_and(|c| c.is_ascii_digit()) {
            while at_char(look).is_some_and(|c| c.is_ascii_digit()) {
                look += 1;
            }
            at = look;
        }
    }
    at
}

/// Split a formula into its tokens (see [`Kind`]).
fn tokenize(formula: &str) -> Vec<Token> {
    let chars: Vec<(usize, char)> = formula.char_indices().collect();
    let end_of = |i: usize| chars.get(i).map(|&(at, _)| at).unwrap_or(formula.len());
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let (start, c) = chars[i];
        let first = i;
        let kind = if c.is_whitespace() {
            while i < chars.len() && chars[i].1.is_whitespace() {
                i += 1;
            }
            Kind::Space
        } else if c == '"' || c == '\'' {
            // A quoted run; a doubled quote is an escaped one.
            i += 1;
            while i < chars.len() {
                if chars[i].1 == c {
                    if chars.get(i + 1).map(|&(_, n)| n) == Some(c) {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            if c == '"' {
                Kind::Text
            } else {
                Kind::QuotedSheet
            }
        } else if c == '[' {
            // A bracketed run, nested; `'` escapes the next character there.
            let mut depth = 0usize;
            while i < chars.len() {
                match chars[i].1 {
                    '\'' => i += 1,
                    '[' => depth += 1,
                    ']' => {
                        depth -= 1;
                        if depth == 0 {
                            i += 1;
                            break;
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
            Kind::Bracket
        } else if let Some(len) = (c == '#').then(|| error_literal_len(formula, start)).flatten() {
            while i < chars.len() && chars[i].0 < start + len {
                i += 1;
            }
            Kind::ErrorLiteral
        } else if let Some(end) = (c == '$' || c.is_ascii_alphabetic())
            .then(|| reference_end(&chars, i, i > 0 && chars[i - 1].1 == '!'))
            .flatten()
        {
            i = end;
            Kind::Reference
        } else if c.is_ascii_digit() || (c == '.' && chars.get(i + 1).is_some_and(|&(_, n)| n.is_ascii_digit())) {
            i = number_end(&chars, i);
            Kind::Number
        } else if is_letter(c) {
            i += 1;
            while continues_a_name(&chars, i) {
                i += if chars[i].1 == '.' { 2 } else { 1 };
            }
            let word = &formula[start..end_of(i)];
            if word.eq_ignore_ascii_case("TRUE") || word.eq_ignore_ascii_case("FALSE") {
                Kind::Boolean
            } else {
                Kind::Name
            }
        } else if matches!(c, '(' | ')' | ',' | '{' | '}' | ';' | '!' | ':') {
            i += 1;
            Kind::Punct(c)
        } else {
            i += 1;
            Kind::Other
        };
        debug_assert!(i > first);
        tokens.push(Token { kind, start, end: end_of(i) });
    }
    tokens
}

/// The index of the token closing the bracket opened at `open` (`(` or `{`),
/// or `tokens.len()` when the text ends first.
fn matching_close(tokens: &[Token], open: usize) -> usize {
    let mut depth = 0usize;
    for (at, token) in tokens.iter().enumerate().skip(open) {
        match token.kind {
            Kind::Punct('(') | Kind::Punct('{') => depth += 1,
            Kind::Punct(')') | Kind::Punct('}') => {
                depth -= 1;
                if depth == 0 {
                    return at;
                }
            }
            _ => {}
        }
    }
    tokens.len()
}

/// The argument token ranges of the call whose `(` is at `open` and whose `)`
/// is at `close`: split on the commas at the call's own depth.
fn arguments(tokens: &[Token], open: usize, close: usize) -> Vec<(usize, usize)> {
    let mut args = Vec::new();
    let mut depth = 0usize;
    let mut start = open + 1;
    for at in open + 1..close {
        match tokens[at].kind {
            Kind::Punct('(') | Kind::Punct('{') => depth += 1,
            Kind::Punct(')') | Kind::Punct('}') => depth = depth.saturating_sub(1),
            Kind::Punct(',') if depth == 0 => {
                args.push((start, at));
                start = at + 1;
            }
            _ => {}
        }
    }
    if start < close || !args.is_empty() {
        args.push((start, close));
    }
    args
}

/// How an argument declares a LET name or a LAMBDA parameter.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Declared {
    /// A name (`x`).
    Name,
    /// A cell-shaped name (`A1`, `E5`, `SUM2`): [LIVE] Excel 16 accepts it and
    /// saves `=LET(A1,5,A1+1)` as `_xlfn.LET(_xlpm.A1,5,_xlpm.A1+1)` (= 6).
    Cell,
    /// An optional LAMBDA parameter `[y]`, which a file declares `_xlop.y`.
    Optional,
}

/// The token an argument declares a parameter with (whitespace around it
/// allowed): a lone name, a lone cell-shaped reference, or -- where `optional`
/// allows it, a LAMBDA's parameter list -- a lone `[name]`.
fn declaration(formula: &str, tokens: &[Token], (start, end): (usize, usize), optional: bool) -> Option<(usize, Declared)> {
    let mut found = None;
    for at in start..end {
        let kind = tokens[at].kind;
        if kind == Kind::Space {
            continue;
        }
        if found.is_some() {
            return None;
        }
        let spelled = text(formula, &tokens[at]);
        found = Some(match kind {
            Kind::Name => (at, Declared::Name),
            Kind::Reference if is_cell_shaped(spelled) => (at, Declared::Cell),
            Kind::Bracket if optional && optional_name(spelled).is_some() => (at, Declared::Optional),
            _ => return None,
        });
    }
    found
}

/// Whether a [`Kind::Reference`] token is one plain cell (`E5`), not `$E$5`
/// and not a column range.
fn is_cell_shaped(reference: &str) -> bool {
    !reference.contains('$') && !reference.contains(':')
}

/// The name inside an optional parameter's brackets (`[y]` -> `y`).
fn optional_name(bracket: &str) -> Option<&str> {
    let inner = bracket.strip_prefix('[')?.strip_suffix(']')?;
    let mut chars = inner.chars();
    let first = chars.next()?;
    (is_letter(first) && chars.all(|c| is_letter(c) || c.is_ascii_digit() || c == '.')).then_some(inner)
}

/// `text` without `prefix`, matched without regard to case.
fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    text.get(..prefix.len()).filter(|head| head.eq_ignore_ascii_case(prefix)).map(|_| &text[prefix.len()..])
}

fn text<'a>(formula: &'a str, token: &Token) -> &'a str {
    &formula[token.start..token.end]
}

/// What the file text holds for one token: text before it, the token's own
/// text or a replacement, and text after it.
#[derive(Debug, Clone, Default)]
struct Edit {
    before: String,
    replace: Option<String>,
    after: String,
}

/// The text with every edit applied.
fn apply_edits(formula: &str, tokens: &[Token], edits: &[Edit]) -> String {
    let mut out = String::with_capacity(formula.len() + 16);
    for (token, edit) in tokens.iter().zip(edits) {
        out.push_str(&edit.before);
        match &edit.replace {
            Some(replacement) => out.push_str(replacement),
            None => out.push_str(text(formula, token)),
        }
        out.push_str(&edit.after);
    }
    out
}

/// A parameter's use as a file writes it.
fn parameter(spelling: &str) -> String {
    format!("{}{}", PARAMETER_PREFIX, spelling)
}

/// The column letters of a 0-based column index (`9` -> `J`).
fn column_letters(col: u32) -> String {
    let mut n = col + 1;
    let mut letters = Vec::new();
    while n > 0 {
        letters.push((b'A' + ((n - 1) % 26) as u8) as char);
        n = (n - 1) / 26;
    }
    letters.iter().rev().collect()
}

/// A name with Excel's `_xlpm.` storage prefix taken off, if it has one.
fn bare_name(name: &str) -> &str {
    match name.get(..PARAMETER_PREFIX.len()) {
        Some(head) if head.eq_ignore_ascii_case(PARAMETER_PREFIX) => &name[PARAMETER_PREFIX.len()..],
        _ => name,
    }
}

/// Whether two names are one to Excel, which ignores case (`ö` is `Ö`).
fn same_name(a: &str, b: &str) -> bool {
    a.chars().flat_map(char::to_lowercase).eq(b.chars().flat_map(char::to_lowercase))
}

/// The parameter `name` refers to in `scope` -- the innermost declaration,
/// by its DECLARED spelling, which [LIVE] Excel 16 gives every use:
/// `=LET(Ab,1,AB+ab)` is saved `_xlfn.LET(_xlpm.Ab,1,_xlpm.Ab+_xlpm.Ab)`.
fn lookup<'s>(scope: &'s [String], name: &str) -> Option<&'s String> {
    let bare = bare_name(name);
    scope.iter().rev().find(|declared| same_name(declared, bare))
}

/// Whether `name` is a bare column (1 to 3 ASCII letters, at most XFD).
fn is_column_name(name: &str) -> bool {
    let chars: Vec<(usize, char)> = name.char_indices().collect();
    column_part(&chars, 0).is_some_and(|(end, dollar)| !dollar && end == chars.len())
}

/// The LAMBDA / LET a name calls, its `_xlfn.` prefix (if already there) aside.
fn binder(name: &str) -> Option<&'static str> {
    let bare = name.strip_prefix("_xlfn.").unwrap_or(name);
    if bare.eq_ignore_ascii_case("LAMBDA") {
        Some("LAMBDA")
    } else if bare.eq_ignore_ascii_case("LET") {
        Some("LET")
    } else {
        None
    }
}

/// What the scan learns beside the edits: the cell the formula sits in, the
/// cell-shaped names the formula declares anywhere, and why Excel could not
/// hold the formula at all, if it cannot.
struct Scan {
    anchor: Option<(u32, u32)>,
    /// Every cell-shaped LET / LAMBDA name the formula declares (`E5`), in
    /// scope or not: [LIVE] Excel 16 writes a plain cell of that spelling
    /// outside the name's scope `_xlnm.` (see [`mark_cell_names`]).
    declared_cells: Vec<String>,
    refused: Option<Unwritable>,
}

/// Why a formula has no text an .xlsx file can carry for Excel to open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Unwritable {
    /// A LET / LAMBDA parameter named like a built-in function, called with a
    /// number of arguments the built-in refuses (`LET(abs,LAMBDA(x,y,x+y),
    /// abs(1,2))`). [LIVE] Excel 16 reads a function-named call as the
    /// built-in, refuses to TYPE these, and refused every file holding one.
    BuiltinArity,
    /// A bare `C` / `R` or another R1C1-shaped name (`RC`, `R1C1`,
    /// `RC[-1]`) in a formula that is in no cell (a defined name): Excel
    /// reads it as relative to a cell, and a name has none.
    RelativeToNoCell,
}

/// Declare the parameter at token `p`: write it as a file declares it
/// (`_xlpm.x`, or `_xlop.y` for an optional one; an already-prefixed name
/// keeps its own prefix) and return its spelling, which the CALLER puts in
/// scope -- a LET name only after its own value (see [`mark_parameters`]).
fn declare(formula: &str, tokens: &[Token], (p, how): (usize, Declared), scan: &mut Scan, edits: &mut [Edit]) -> String {
    let raw = text(formula, &tokens[p]);
    let (prefix, spelling) = match how {
        Declared::Optional => (OPTIONAL_PREFIX, optional_name(raw).unwrap_or(raw)),
        _ => match strip_prefix_ci(raw, OPTIONAL_PREFIX) {
            Some(rest) => (OPTIONAL_PREFIX, rest),
            None => (PARAMETER_PREFIX, bare_name(raw)),
        },
    };
    edits[p].replace = Some(format!("{}{}", prefix, spelling));
    if how == Declared::Cell {
        scan.declared_cells.push(spelling.to_string());
    }
    spelling.to_string()
}

/// The arity a built-in function accepts, `(fewest, most)` (`None`: no
/// limit), from Calcula's own catalog -- its syntax strings, the single
/// source of truth the function dialog reads (`SUM(number1, [number2], ...)`
/// is one or more, `ROUND(number, num_digits)` exactly two, `PI()` none).
fn builtin_arity(name: &str) -> Option<(usize, Option<usize>)> {
    static TABLE: std::sync::OnceLock<std::collections::HashMap<String, (usize, Option<usize>)>> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        parser::BuiltinFunction::all_catalog_entries()
            .into_iter()
            .filter(|meta| !meta.is_alias)
            .filter_map(|meta| Some((meta.name.to_ascii_uppercase(), syntax_arity(meta.syntax)?)))
            .collect()
    });
    table.get(&name.to_ascii_uppercase()).copied()
}

/// `(fewest, most)` arguments of a catalog syntax string (see [`builtin_arity`]).
fn syntax_arity(syntax: &str) -> Option<(usize, Option<usize>)> {
    let inner = syntax.get(syntax.find('(')? + 1..syntax.rfind(')')?)?.trim();
    if inner.is_empty() {
        return Some((0, Some(0)));
    }
    let mut pieces = Vec::new();
    let (mut depth, mut start) = (0usize, 0usize);
    for (at, c) in inner.char_indices() {
        match c {
            '[' => depth += 1,
            ']' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                pieces.push(inner[start..at].trim());
                start = at + 1;
            }
            _ => {}
        }
    }
    pieces.push(inner[start..].trim());
    let fewest = pieces.iter().filter(|p| !p.starts_with('[') && !p.contains("...")).count();
    let most = (!pieces.iter().any(|p| p.contains("..."))).then_some(pieces.len());
    Some((fewest, most))
}

/// Excel's A1 text, for the cell at `anchor`, of an R1C1-shaped name: `R` /
/// `C` (this row / column), `RC`, `R2C`, `R1C1`, `RC[-1]`, `C[1]`. [LIVE]
/// Excel 16 reads each as an R1C1 reference even in A1 mode and saves it as
/// the A1 reference it means: in J29 `=RC*0` is `J29*0`, `=R1C1*0` `$A$1*0`,
/// `=R2C*0` `J$2*0`, `=R1C*0` `J$1*0`, in J13 `=RC[-1]*0` `I13*0`, `=C+1`
/// `J:J+1`, in J14 `=SUM(R)` `SUM(14:14)`. `RC1` is no such name: it is the
/// cell in column RC.
fn r1c1_reference(shape: &str, (row, col): (u32, u32)) -> Option<String> {
    // One axis: `R` / `C`, then digits (absolute) or `[k]` (relative) or
    // nothing (this row / column). Returns (absolute, 1-based index).
    fn axis(rest: &str, letter: char, here: u32) -> Option<(Option<(bool, i64)>, &str)> {
        let Some(after) = rest.strip_prefix(letter).or_else(|| rest.strip_prefix(letter.to_ascii_lowercase())) else {
            return Some((None, rest));
        };
        if let Some(inside) = after.strip_prefix('[') {
            let close = inside.find(']')?;
            let offset: i64 = inside[..close].parse().ok()?;
            return Some((Some((false, i64::from(here) + 1 + offset)), &inside[close + 1..]));
        }
        let digits = after.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 {
            return Some((Some((false, i64::from(here) + 1)), after));
        }
        Some((Some((true, after[..digits].parse().ok()?)), &after[digits..]))
    }
    let (r, rest) = axis(shape, 'R', row)?;
    let (c, rest) = axis(rest, 'C', col)?;
    if !rest.is_empty() || (r.is_none() && c.is_none()) {
        return None;
    }
    let in_range = |(_, n): (bool, i64), max: u32| (1..=i64::from(max)).contains(&n);
    let dollar = |absolute: bool| if absolute { "$" } else { "" };
    match (r, c) {
        (Some(r), Some(c)) if in_range(r, MAX_ROW) && in_range(c, MAX_COLUMN) => {
            Some(format!("{}{}{}{}", dollar(c.0), column_letters(c.1 as u32 - 1), dollar(r.0), r.1))
        }
        (Some(r), None) if in_range(r, MAX_ROW) => Some(format!("{d}{n}:{d}{n}", d = dollar(r.0), n = r.1)),
        (None, Some(c)) if in_range(c, MAX_COLUMN) => {
            let letters = column_letters(c.1 as u32 - 1);
            Some(format!("{d}{l}:{d}{l}", d = dollar(c.0), l = letters))
        }
        _ => None,
    }
}

/// Whether `shape` is R1C1-shaped (see [`r1c1_reference`]), whatever cell it
/// would sit in.
fn is_r1c1_shape(shape: &str) -> bool {
    r1c1_reference(shape, (0, 0)).is_some() || r1c1_reference(shape, (MAX_ROW - 1, MAX_COLUMN - 1)).is_some()
}

/// Write the R1C1-shaped name `shape` (one token, or a name and its `[k]`
/// bracket) as the anchor cell's A1 reference, into `edits[first]` (the rest
/// of `tokens_used` emptied). A formula in no cell cannot hold one.
fn write_r1c1(shape: &str, first: usize, tokens_used: usize, scan: &mut Scan, edits: &mut [Edit]) -> bool {
    if !is_r1c1_shape(shape) {
        return false;
    }
    match scan.anchor.and_then(|anchor| r1c1_reference(shape, anchor)) {
        Some(a1) => {
            edits[first].replace = Some(a1);
            for edit in &mut edits[first + 1..first + tokens_used] {
                edit.replace = Some(String::new());
            }
        }
        None => scan.refused = scan.refused.or(Some(Unwritable::RelativeToNoCell)),
    }
    true
}

/// The parameter a cell-shaped reference token (`E5`) names in `scope`.
fn cell_parameter<'s>(formula: &str, token: &Token, scope: &'s [String]) -> Option<&'s String> {
    let spelled = text(formula, token);
    (token.kind == Kind::Reference && is_cell_shaped(spelled)).then(|| lookup(scope, spelled)).flatten()
}

/// A range `X:Y` at `at` with a CELL-SHAPED parameter on either side
/// (`E5:E6` with `E5` in scope). [LIVE] Excel 16 writes the parameter
/// `_xlpm.` and the other half, when it is a plain cell, `_xlnm.`:
/// `=LET(E5,2,SUM(E5:E6))` is saved `SUM(_xlpm.E5:_xlnm.E6)`,
/// `=LET(E5,2,SUM(E4:E5))` `SUM(_xlnm.E4:_xlpm.E5)`, and with both halves
/// parameters `SUM(_xlpm.E5:_xlpm.E6)`. Returns the tokens consumed.
fn mark_cell_range(formula: &str, tokens: &[Token], at: usize, end: usize, scope: &[String], edits: &mut [Edit]) -> Option<usize> {
    let kind_at = |i: usize| (i < end).then(|| tokens[i].kind);
    if kind_at(at + 1) != Some(Kind::Punct(':')) || !matches!(kind_at(at + 2), Some(Kind::Reference) | Some(Kind::Name)) {
        return None;
    }
    // The second half must end the range (`E5:E6`, not `E5:INDEX(..)` or
    // `E5:Sheet2!..`).
    if matches!(kind_at(at + 3), Some(Kind::Punct('(')) | Some(Kind::Punct('!')) | Some(Kind::Bracket)) {
        return None;
    }
    let halves = [at, at + 2];
    if !halves.iter().any(|&h| cell_parameter(formula, &tokens[h], scope).is_some()) {
        return None;
    }
    for h in halves {
        let spelled = text(formula, &tokens[h]);
        if let Some(p) = lookup(scope, spelled).filter(|_| tokens[h].kind == Kind::Name || is_cell_shaped(spelled)) {
            edits[h].replace = Some(parameter(p));
        } else if tokens[h].kind == Kind::Reference && is_cell_shaped(spelled) {
            edits[h].replace = Some(format!("{}{}", CELL_NAME_PREFIX, spelled));
        }
    }
    Some(3)
}

/// A column range whose colon carries a trim dot (`A:.C`, `A.:C`, `A.:.C`)
/// starting at token `at`: the number of tokens it spans. Both halves are
/// columns then, never a parameter or R1C1's "this column": [LIVE] Excel 16
/// saves `=SUM(A:.C)` in J33 as `SUM(_xlfn._TRO_TRAILING(A:C))` (= 1665),
/// `=SUM(B:.R)` as `_TRO_TRAILING(B:R)` and `=SUM(C.:C)` as
/// `_TRO_LEADING(C:C)`; it refuses to TYPE one beside a parameter of the
/// first half's name (`=LET(a,1,SUM(A:.C)+a)`).
fn dotted_column_range(formula: &str, tokens: &[Token], at: usize, end: usize) -> Option<usize> {
    let name_at = |i: usize| (i < end && tokens[i].kind == Kind::Name).then(|| text(formula, &tokens[i]));
    let dot_at = |i: usize| i < end && is_other(formula, tokens, i, ".");
    let first = name_at(at)?;
    let mut i = at + 1;
    let lead = dot_at(i);
    if lead {
        i += 1;
    }
    if i >= end || tokens[i].kind != Kind::Punct(':') {
        return None;
    }
    i += 1;
    let trail = dot_at(i);
    if trail {
        i += 1;
    }
    let second = name_at(i)?;
    ((lead || trail) && is_column_name(first) && is_column_name(second)).then_some(i + 1 - at)
}

/// Write, in `tokens[start..end]`, every name that is a parameter in `scope`
/// (and every parameter a LAMBDA / LET in there declares) as the file spells
/// it, and every R1C1-shaped name that is none (`C`, `R`, `RC`, `RC[-1]`) as
/// the anchor cell's A1 reference.
fn mark_parameters(formula: &str, tokens: &[Token], start: usize, end: usize, scope: &[String], scan: &mut Scan, edits: &mut [Edit]) {
    let kind_at = |i: usize| (i < end).then(|| tokens[i].kind);
    let mut at = start;
    while at < end {
        let token = tokens[at];
        let previous = at.checked_sub(1).map(|p| tokens[p].kind);
        let next = kind_at(at + 1);
        if token.kind == Kind::Reference {
            // A cell-shaped parameter's use (`E5+1`), bare only: [LIVE] Excel
            // 16 refuses to TYPE `$E$5` beside a parameter `E5`, a sheet's
            // `Sheet1!E5` is no parameter (it is `_xlnm.` when a parameter of
            // that name exists, [`mark_cell_names`]), and the second half of a
            // range is decided with the first ([`mark_cell_range`]).
            if previous != Some(Kind::Punct('!')) && previous != Some(Kind::Punct(':')) {
                if let Some(consumed) = mark_cell_range(formula, tokens, at, end, scope, edits) {
                    at += consumed;
                    continue;
                }
                if let Some(p) = cell_parameter(formula, &token, scope) {
                    edits[at].replace = Some(parameter(p));
                }
            }
            at += 1;
            continue;
        }
        if token.kind != Kind::Name {
            at += 1;
            continue;
        }
        let name = text(formula, &token);
        if let Some(consumed) = dotted_column_range(formula, tokens, at, end) {
            at += consumed;
            continue;
        }
        // `Sheet1!x` names something on a sheet, `x!A1` IS a sheet, `x[Col]`
        // is a table, and in `x:y!A1` both are sheets. [LIVE] Excel 16 keeps
        // each untouched beside a parameter of the same name
        // (`Sheet1!A1+_xlpm.Sheet1`, `SUM(Table1[Col])+_xlpm.Table1`,
        // `SUM(Sheet1:Sheet2!A1)+_xlpm.Sheet2`).
        let three_d = next == Some(Kind::Punct(':'))
            && kind_at(at + 2) == Some(Kind::Name)
            && kind_at(at + 3) == Some(Kind::Punct('!'));
        // `RC[-1]`, `C[1]`: a name with a relative offset, R1C1's, unless a
        // name continues it (`R[1]C`, which Calcula cannot store).
        if next == Some(Kind::Bracket)
            && previous != Some(Kind::Punct('!'))
            && lookup(scope, name).is_none()
            && !matches!(kind_at(at + 2), Some(Kind::Name) | Some(Kind::Reference) | Some(Kind::Number))
        {
            let shape = format!("{}{}", name, text(formula, &tokens[at + 1]));
            if write_r1c1(&shape, at, 2, scan, edits) {
                at += 2;
                continue;
            }
        }
        let not_a_parameter = previous == Some(Kind::Punct('!'))
            || next == Some(Kind::Punct('!'))
            || next == Some(Kind::Bracket)
            || three_d;
        if next == Some(Kind::Punct('(')) && !not_a_parameter {
            let open = at + 1;
            let close = matching_close(tokens, open).min(end);
            let args = arguments(tokens, open, close);
            match binder(name) {
                Some("LAMBDA") => {
                    // LAMBDA(p1, p2, ..., body): every argument but the last is
                    // a parameter, a `[y]` an optional one.
                    let mut inner: Vec<String> = scope.to_vec();
                    if let Some((&body, params)) = args.split_last() {
                        for &param in params {
                            match declaration(formula, tokens, param, true) {
                                Some(declared) => {
                                    let spelling = declare(formula, tokens, declared, scan, edits);
                                    inner.push(spelling);
                                }
                                None => mark_parameters(formula, tokens, param.0, param.1, scope, scan, edits),
                            }
                        }
                        mark_parameters(formula, tokens, body.0, body.1, &inner, scan, edits);
                    }
                }
                Some(_) => {
                    // LET(n1, v1, n2, v2, ..., calculation): each name is in
                    // scope AFTER its own value. [LIVE] Excel 16 saves
                    // `=LET(Rate,Rate*2,Rate)` (Rate a defined name) as
                    // `_xlfn.LET(_xlpm.Rate,Rate*2,_xlpm.Rate)` (= 2) and
                    // `=LET(Dbl,Dbl(3),Dbl)` as `..,Dbl(3),..` (= 6).
                    let mut inner: Vec<String> = scope.to_vec();
                    let last = args.len().saturating_sub(1);
                    let mut pending: Option<String> = None;
                    for (index, &arg) in args.iter().enumerate() {
                        let declared = if index % 2 == 0 && index < last { declaration(formula, tokens, arg, false) } else { None };
                        match declared {
                            Some(declared) => pending = Some(declare(formula, tokens, declared, scan, edits)),
                            None => {
                                mark_parameters(formula, tokens, arg.0, arg.1, &inner, scan, edits);
                                if index % 2 == 1 {
                                    inner.extend(pending.take());
                                }
                            }
                        }
                    }
                }
                None => {
                    // An ordinary call -- or a parameter called as a function
                    // ([LIVE] `_xlpm.f(2)`). A built-in function's name before
                    // `(` is the function even beside a parameter of that name:
                    // [LIVE] Excel 16 saves `=LET(sum,3,SUM(sum,1))` as
                    // `SUM(_xlpm.sum,1)`, and Calcula's parser reads it so too
                    // (`BuiltinFunction::from_name`, a parameter call is `Custom`).
                    // Called with an arity the built-in refuses, it is no formula
                    // Excel can hold ([`Unwritable::BuiltinArity`]).
                    let builtin = !matches!(parser::BuiltinFunction::from_name(name), parser::BuiltinFunction::Custom(_));
                    match lookup(scope, name) {
                        Some(p) if !builtin => edits[at].replace = Some(parameter(p)),
                        Some(_) => {
                            let given = args.len();
                            let refused = builtin_arity(name)
                                .is_some_and(|(fewest, most)| given < fewest || most.is_some_and(|most| given > most));
                            if refused {
                                scan.refused = scan.refused.or(Some(Unwritable::BuiltinArity));
                            }
                        }
                        None => {}
                    }
                    mark_parameters(formula, tokens, open + 1, close, scope, scan, edits);
                }
            }
            at = close + 1;
            continue;
        }
        if not_a_parameter {
            at += 1;
            continue;
        }
        if previous != Some(Kind::Punct(':')) {
            if let Some(consumed) = mark_cell_range(formula, tokens, at, end, scope, edits) {
                at += consumed;
                continue;
            }
        }
        // A BARE column range `L:L`. [LIVE] Excel 16 reads it as a parameter's
        // range only when its FIRST half is a parameter: `=LET(b,2,SUM(B:B)*b)`
        // is saved `SUM(_xlpm.b:_xlpm.b)` (and shows #VALUE!), but
        // `=LET(b,2,SUM(A:B))` is saved `SUM(A:B)` and gives 165 -- the second
        // half alone never makes it a name. A second half `C` / `R` that is
        // no parameter is then R1C1's: [LIVE] `=LET(a,1,SUM(A:C)+a)` in J2 is
        // saved `SUM(_xlpm.a:J:J)`, and in J9 `SUM(A:R)` `SUM(_xlpm.a:9:9)`.
        if next == Some(Kind::Punct(':')) && kind_at(at + 2) == Some(Kind::Name) {
            let second = text(formula, &tokens[at + 2]);
            if is_column_name(name) && is_column_name(second) {
                if let Some(p) = lookup(scope, name) {
                    edits[at].replace = Some(parameter(p));
                    if let Some(q) = lookup(scope, second) {
                        edits[at + 2].replace = Some(parameter(q));
                    } else {
                        write_r1c1(second, at + 2, 1, scan, edits);
                    }
                }
                at += 3;
                continue;
            }
        }
        if let Some(p) = lookup(scope, name) {
            edits[at].replace = Some(parameter(p));
        } else if next != Some(Kind::Punct(':'))
            && (previous != Some(Kind::Punct(':')) || at.checked_sub(2).is_some_and(|p| p >= start && edits[p].replace.is_some()))
        {
            // A lone R1C1-shaped name ([LIVE] `=C+1` in J13 is saved `J:J+1`,
            // `=RC*0` in J29 `J29*0`), or the second half after a parameter
            // that is no column (`ab1:C`).
            write_r1c1(name, at, 1, scan, edits);
        }
        at += 1;
    }
}

/// A plain cell spelled like a cell-shaped LET / LAMBDA name the formula
/// declares, where that name is not in scope -- its own value, outside the
/// call, behind a sheet -- is written `_xlnm.`, as is a plain cell beside it
/// in a range. [LIVE] Excel 16 saves `=LET(E5,E5+1,E5)` as
/// `_xlfn.LET(_xlpm.E5,_xlnm.E5+1,_xlpm.E5)`, `=LET(A1,SUM(A1:A3),A1)` as
/// `SUM(_xlnm.A1:_xlnm.A3)`, `=LAMBDA(A1,A1*2)(A1+1)` as `..(_xlnm.A1+1)`
/// and `=LET(A1,1,SUM(Sheet1!A1)+A1)` as `SUM(Sheet1!_xlnm.A1)` (each shows
/// #NAME? in Excel itself).
fn mark_cell_names(formula: &str, tokens: &[Token], declared: &[String], edits: &mut [Edit]) {
    if declared.is_empty() {
        return;
    }
    let plain_cell = |i: usize, edits: &[Edit]| {
        tokens.get(i).is_some_and(|t| t.kind == Kind::Reference && is_cell_shaped(text(formula, t))) && edits[i].replace.is_none()
    };
    for at in 0..tokens.len() {
        if !plain_cell(at, edits) || !declared.iter().any(|d| same_name(d, text(formula, &tokens[at]))) {
            continue;
        }
        edits[at].replace = Some(format!("{}{}", CELL_NAME_PREFIX, text(formula, &tokens[at])));
        let colon = |i: usize| tokens.get(i).is_some_and(|t| t.kind == Kind::Punct(':'));
        for other in [at.checked_sub(2).filter(|&p| colon(p + 1)), colon(at + 1).then_some(at + 2)].into_iter().flatten() {
            if plain_cell(other, edits) {
                edits[other].replace = Some(format!("{}{}", CELL_NAME_PREFIX, text(formula, &tokens[other])));
            }
        }
    }
}

/// Where the reference ending at token `end` begins: its sheet (`Sheet1!`,
/// `'My Sheet'!`, a 3-D `Sheet1:Sheet3!`) and external book (`[1]`) included.
fn reference_start(tokens: &[Token], end: usize) -> usize {
    let kind = |i: usize| tokens.get(i).map(|t| t.kind);
    let mut start = end;
    if start >= 2 && kind(start - 1) == Some(Kind::Punct('!')) && matches!(kind(start - 2), Some(Kind::Name) | Some(Kind::QuotedSheet)) {
        start -= 2;
        if start >= 2 && kind(start - 1) == Some(Kind::Punct(':')) && matches!(kind(start - 2), Some(Kind::Name) | Some(Kind::QuotedSheet)) {
            start -= 2;
        }
        if start >= 1 && kind(start - 1) == Some(Kind::Bracket) {
            start -= 1;
        }
    }
    start
}

fn is_other(formula: &str, tokens: &[Token], at: usize, c: &str) -> bool {
    tokens.get(at).is_some_and(|t| t.kind == Kind::Other && text(formula, t) == c)
}

/// One half of a range: a reference or a name.
fn is_range_half(tokens: &[Token], at: usize) -> bool {
    tokens.get(at).is_some_and(|t| matches!(t.kind, Kind::Reference | Kind::Name))
}

/// The last token of the operand of an `@` that starts at `at`, and whether
/// that operand is a parenthesised group (whose own parentheses then serve
/// `SINGLE`'s call). `None` when the operand is no shape this knows.
fn intersection_operand(formula: &str, tokens: &[Token], at: usize) -> Option<(usize, bool)> {
    let kind = |i: usize| tokens.get(i).map(|t| t.kind);
    if kind(at) == Some(Kind::Punct('(')) {
        let close = matching_close(tokens, at);
        return (close < tokens.len()).then_some((close, true));
    }
    let mut k = at;
    if kind(k) == Some(Kind::Bracket) && matches!(kind(k + 1), Some(Kind::Name) | Some(Kind::QuotedSheet)) && kind(k + 2) == Some(Kind::Punct('!')) {
        k += 1;
    }
    if matches!(kind(k), Some(Kind::Name) | Some(Kind::QuotedSheet)) && kind(k + 1) == Some(Kind::Punct('!')) {
        k += 2;
    }
    if kind(k) == Some(Kind::Name) && kind(k + 1) == Some(Kind::Punct('(')) {
        let close = matching_close(tokens, k + 1);
        return (close < tokens.len()).then_some((close, false));
    }
    if kind(k) == Some(Kind::Bracket) {
        return Some((k, false));
    }
    if !is_range_half(tokens, k) {
        return None;
    }
    let mut end = k;
    // `A1:A3`, and the trim reference's dots around the colon (`A1:.A3`).
    let mut look = end + 1;
    if is_other(formula, tokens, look, ".") {
        look += 1;
    }
    if kind(look) == Some(Kind::Punct(':')) {
        let mut second = look + 1;
        if is_other(formula, tokens, second, ".") {
            second += 1;
        }
        if is_range_half(tokens, second) {
            end = second;
        }
    }
    if kind(end + 1) == Some(Kind::Bracket) {
        end += 1;
    }
    if is_other(formula, tokens, end + 1, "#") {
        end += 1;
    }
    Some((end, false))
}

/// A this-row structured reference in the long form a FILE must use: [LIVE]
/// Excel 16 saves `Table1[@Col]` as `Table1[[#This Row],[Col]]`,
/// `Table2[@[Q]]` as `Table2[[#This Row],[Q]]` and `Table2[@[P]:[Q]]` as
/// `Table2[[#This Row],[P]:[Q]]`, and reads the short form from a file as
/// `#REF!`. Calcula's own `[[@P]:[@Q]]` is the same range.
fn this_row_long_form(bracket: &str) -> Option<String> {
    let inner = bracket.strip_prefix('[')?.strip_suffix(']')?;
    if let Some(rest) = inner.strip_prefix('@') {
        if rest.is_empty() {
            return Some("[#This Row]".to_string());
        }
        if rest.starts_with('[') {
            return Some(format!("[[#This Row],{}]", rest));
        }
        return Some(format!("[[#This Row],[{}]]", rest));
    }
    let parts = bracket_groups(inner)?;
    match parts.as_slice() {
        [first, separator, second] if *separator == ":" && first.starts_with("[@") && second.starts_with("[@") => {
            Some(format!("[[#This Row],[{}:[{}]", &first[2..], &second[2..]))
        }
        _ => None,
    }
}

/// The top-level pieces of a structured reference's inside: each `[..]` group
/// (with its brackets) and the text between them. `'` escapes the next
/// character. `None` when the brackets do not balance.
fn bracket_groups(inner: &str) -> Option<Vec<&str>> {
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut piece_start = 0usize;
    let mut chars = inner.char_indices();
    while let Some((at, c)) = chars.next() {
        match c {
            '\'' => {
                chars.next();
            }
            '[' => {
                if depth == 0 && at > piece_start {
                    parts.push(&inner[piece_start..at]);
                }
                if depth == 0 {
                    piece_start = at;
                }
                depth += 1;
            }
            ']' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    parts.push(&inner[piece_start..at + 1]);
                    piece_start = at + 1;
                }
            }
            _ => {}
        }
    }
    if depth != 0 {
        return None;
    }
    if piece_start < inner.len() {
        parts.push(&inner[piece_start..]);
    }
    Some(parts)
}

/// The typed operators a file spells as functions (see the module doc), and
/// an inline LAMBDA call's `__INVOKE__(lambda, args)` as `lambda(args)`.
fn operator_edits(formula: &str, tokens: &[Token], edits: &mut [Edit]) {
    for at in 0..tokens.len() {
        let token = tokens[at];
        let spelled = text(formula, &token);
        match token.kind {
            // `A1#` -> `ANCHORARRAY(A1)` ([LIVE] `SUM(_xlfn.ANCHORARRAY(A1))`,
            // `SUM(_xlfn.ANCHORARRAY(Sheet1!A1))`). The library adds `_xlfn.`.
            Kind::Other if spelled == "#" && at > 0 && is_range_half(tokens, at - 1) => {
                let start = reference_start(tokens, at - 1);
                edits[start].before.insert_str(0, "ANCHORARRAY(");
                edits[at].replace = Some(")".to_string());
            }
            // `@x` -> `SINGLE(x)` ([LIVE] `SUM(@A1:A3)` is saved
            // `SUM(_xlfn.SINGLE(A1:A3))`, `@INDEX(..)` `_xlfn.SINGLE(INDEX(..))`).
            Kind::Other if spelled == "@" => {
                if let Some((end, group)) = intersection_operand(formula, tokens, at + 1) {
                    if group {
                        edits[at].replace = Some("SINGLE".to_string());
                    } else {
                        edits[at].replace = Some("SINGLE(".to_string());
                        edits[end].after.push(')');
                    }
                }
            }
            // `A1:.A5` -> `_TRO_TRAILING(A1:A5)` (`_xlfn.` is added after the
            // library's escaping, [`prefix_trim_operators`]).
            Kind::Punct(':') if row_trim(formula, tokens, at, edits) => {}
            Kind::Punct(':') => {
                let lead = at >= 1 && is_other(formula, tokens, at - 1, ".");
                let trail = is_other(formula, tokens, at + 1, ".");
                if !lead && !trail {
                    continue;
                }
                let Some(left_end) = (if lead { at.checked_sub(2) } else { at.checked_sub(1) }) else { continue };
                let right = if trail { at + 2 } else { at + 1 };
                if !is_range_half(tokens, left_end) || !is_range_half(tokens, right) {
                    continue;
                }
                let Some(&(name, _, _)) = TRIM_OPERATORS.iter().find(|&&(_, l, t)| l == lead && t == trail) else { continue };
                let start = reference_start(tokens, left_end);
                edits[start].before.push_str(name);
                edits[start].before.push('(');
                if lead {
                    edits[at - 1].replace = Some(String::new());
                }
                if trail {
                    edits[at + 1].replace = Some(String::new());
                }
                edits[right].after.insert(0, ')');
            }
            // An inline LAMBDA call ([LIVE] `_xlfn.LAMBDA(_xlpm.x,_xlpm.x+1)(2)`).
            Kind::Name if spelled == engine::ast_render::NAMED_INVOKE_MARKER => {
                if tokens.get(at + 1).map(|t| t.kind) != Some(Kind::Punct('(')) {
                    continue;
                }
                let open = at + 1;
                let close = matching_close(tokens, open);
                if close >= tokens.len() {
                    continue;
                }
                let args = arguments(tokens, open, close);
                let Some(&(first_start, first_end)) = args.first() else { continue };
                // The NAMED shape (`__INVOKE__("Name", ..)`) is collapsed before
                // this; one that is left is not touched.
                let named = (first_start..first_end).any(|i| tokens[i].kind == Kind::Text);
                if named || first_start >= first_end {
                    continue;
                }
                edits[at].replace = Some(String::new());
                edits[open].replace = Some(String::new());
                match args.get(1) {
                    Some(&(second_start, _)) => edits[second_start - 1].replace = Some("(".to_string()),
                    None => edits[first_end - 1].after.push('('),
                }
            }
            Kind::Bracket if edits[at].replace.is_none() => {
                let escaped = escape_structured_reference(spelled);
                if let Some(long) = this_row_long_form(&escaped) {
                    edits[at].replace = Some(long);
                } else if escaped != spelled {
                    edits[at].replace = Some(escaped);
                }
            }
            _ => {}
        }
    }
}

/// A row-range trim reference at the colon `at` (`1:.3`, `1.:3`, `2.:.3`,
/// `$1:.$3`, `Sheet1!1:.3`), written `_TRO_*(1:3)`. Calcula's lexer reads a
/// row number's dot as part of the number (`.3`, `2.`), so the dots are
/// inside the number tokens here. [LIVE] Excel 16 saves `=SUM(1:.3)` as
/// `SUM(_xlfn._TRO_TRAILING(1:3))` (= 695), `=SUM(2.:.3)` as
/// `_xlfn._TRO_ALL(2:3)` and `=SUM(Sheet1!1:.3)` as
/// `_xlfn._TRO_TRAILING(Sheet1!1:3)`; it refused the typed text.
fn row_trim(formula: &str, tokens: &[Token], at: usize, edits: &mut [Edit]) -> bool {
    let number = |i: usize| tokens.get(i).filter(|t| t.kind == Kind::Number).map(|t| text(formula, t));
    let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    let Some(left) = at.checked_sub(1) else { return false };
    let Some(left_text) = number(left) else { return false };
    let mut right = at + 1;
    let mut dot_token = None;
    if is_other(formula, tokens, right, ".") && is_other(formula, tokens, right + 1, "$") {
        dot_token = Some(right);
        right += 1;
    }
    let dollar_right = is_other(formula, tokens, right, "$");
    if dollar_right {
        right += 1;
    }
    let Some(right_text) = number(right) else { return false };
    let lead = left_text.ends_with('.');
    let trail = dot_token.is_some() || (right_text.starts_with('.') && !dollar_right);
    let (left_digits, right_digits) = (left_text.trim_end_matches('.'), right_text.trim_start_matches('.'));
    if !(lead || trail) || !digits(left_digits) || !digits(right_digits) {
        return false;
    }
    let Some(&(name, _, _)) = TRIM_OPERATORS.iter().find(|&&(_, l, t)| l == lead && t == trail) else { return false };
    let first = if left >= 1 && is_other(formula, tokens, left - 1, "$") { left - 1 } else { left };
    let start = reference_start(tokens, first);
    edits[start].before.push_str(name);
    edits[start].before.push('(');
    edits[left].replace = Some(left_digits.to_string());
    edits[right].replace = Some(right_digits.to_string());
    if let Some(dot) = dot_token {
        edits[dot].replace = Some(String::new());
    }
    edits[right].after.insert(0, ')');
    true
}

/// The structured-reference specifiers, which start with `#` and are no
/// column name.
const TABLE_SPECIFIERS: [&str; 5] = ["#All", "#Data", "#Headers", "#Totals", "#This Row"];

/// A structured reference's bracket with every column name's `#` escaped
/// `'#`, as a file must spell it. Calcula keeps a column `x#y` as `[x#y]`
/// (its `'` / `[` / `]` escapes it keeps); [LIVE] Excel 16 saves
/// `=SUM(Table2[x'#y])` as `SUM(Table2[x'#y])` and `[@[x'#y]]` as
/// `[[#This Row],[x'#y]]`, and refused every file whose column name had a
/// bare `#`.
fn escape_structured_reference(bracket: &str) -> String {
    let Some(inner) = bracket.strip_prefix('[').and_then(|b| b.strip_suffix(']')) else {
        return bracket.to_string();
    };
    format!("[{}]", escape_structured_item(inner))
}

/// One structured-reference item's inside (see [`escape_structured_reference`]).
fn escape_structured_item(inner: &str) -> String {
    if inner.starts_with('[') {
        // `[[#All],[Col]]`, `[[@P]:[@Q]]`: each group on its own.
        let Some(parts) = bracket_groups(inner) else { return inner.to_string() };
        return parts
            .into_iter()
            .map(|part| if part.starts_with('[') { escape_structured_reference(part) } else { part.to_string() })
            .collect();
    }
    if let Some(rest) = inner.strip_prefix('@') {
        return format!("@{}", escape_structured_item(rest));
    }
    if TABLE_SPECIFIERS.iter().any(|s| s.eq_ignore_ascii_case(inner.trim())) {
        return inner.to_string();
    }
    let mut out = String::with_capacity(inner.len() + 2);
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                out.push(c);
                out.extend(chars.next());
            }
            '#' => out.push_str("'#"),
            _ => out.push(c),
        }
    }
    out
}

/// A formula's text in the spelling an .xlsx file carries (before the
/// future-function escaping; see the module doc).
fn file_text(formula: &str, anchor: Option<(u32, u32)>) -> (String, Option<Unwritable>) {
    let tokens = tokenize(formula);
    let mut edits = vec![Edit::default(); tokens.len()];
    let mut scan = Scan { anchor, declared_cells: Vec::new(), refused: None };
    mark_parameters(formula, &tokens, 0, tokens.len(), &[], &mut scan, &mut edits);
    mark_cell_names(formula, &tokens, &scan.declared_cells, &mut edits);
    operator_edits(formula, &tokens, &mut edits);
    (apply_edits(formula, &tokens, &edits), scan.refused)
}

/// Why Excel could not open a file holding `formula` (see [`Unwritable`]),
/// for the cell at `anchor` (`None`: a defined name); `None` when it can.
/// The writer then keeps the cell's value without its formula, or leaves
/// the name out, and tells the user (`XlsxExportLosses`).
pub(crate) fn unwritable_reason(formula: &str, anchor: Option<(u32, u32)>) -> Option<Unwritable> {
    let clean = formula.strip_prefix('=').unwrap_or(formula);
    let collapsed = engine::ast_render::collapse_formula_text(clean);
    file_text(collapsed.strip_prefix('=').unwrap_or(&collapsed), anchor).1
}

/// Prefix every LAMBDA / LET parameter name in `formula` with `_xlpm.`, as
/// Excel writes them, each use spelled as its declaration, and the typed
/// operators as a file spells them; for a formula in no cell. A name already
/// carrying the prefix keeps one.
#[cfg(test)]
pub(crate) fn with_parameter_prefixes(formula: &str) -> String {
    file_text(formula, None).0
}

/// The trim-operator call (`_TRO_ALL(`) at token `at`, if one is there.
fn trim_operator_at(formula: &str, tokens: &[Token], at: usize) -> Option<(&'static str, bool, bool)> {
    let token = tokens.get(at)?;
    if token.kind != Kind::Name || tokens.get(at + 1).map(|t| t.kind) != Some(Kind::Punct('(')) {
        return None;
    }
    let spelled = text(formula, token);
    let bare = strip_prefix_ci(spelled, "_xlfn.").unwrap_or(spelled);
    TRIM_OPERATORS.iter().copied().find(|&(name, _, _)| bare.eq_ignore_ascii_case(name))
}

/// Whether a file text calls a trim operator the library cannot escape.
fn has_trim_operator(text_: &str) -> bool {
    if !text_.contains("_TRO_") {
        return false;
    }
    let tokens = tokenize(text_);
    (0..tokens.len()).any(|at| trim_operator_at(text_, &tokens, at).is_some())
}

/// `_xlfn.` on every trim operator of an escaped text ([LIVE] Excel 16:
/// `SUM(_xlfn._TRO_TRAILING(A1:A5))`).
fn prefix_trim_operators(escaped: &str) -> String {
    if !has_trim_operator(escaped) {
        return escaped.to_string();
    }
    let tokens = tokenize(escaped);
    let mut edits = vec![Edit::default(); tokens.len()];
    for (at, edit) in edits.iter_mut().enumerate() {
        if let Some((name, _, _)) = trim_operator_at(escaped, &tokens, at) {
            edit.replace = Some(format!("_xlfn.{}", name));
        }
    }
    apply_edits(escaped, &tokens, &edits)
}

/// A file's formula text in Calcula's typed syntax, the inverse of
/// [`excel_formula_text`] for the reader: `_xlop.y` -> `[y]`, a cell's
/// `_xlnm.E6` -> `E6`, `_TRO_TRAILING(A1:A5)` -> `A1:.A5` (and the leading /
/// both forms), `ANCHORARRAY(A1)` -> `A1#`, `SINGLE(x)` -> `@x`, and
/// `[[#This Row],[Col]]` -> `[@Col]`; then the `_xlfn.` / `_xlpm.` prefixes
/// stripped ([`crate::xlsx_reader::strip_future_function_prefixes`]). An
/// argument that is no shape the typed operator can hold keeps the function
/// spelling.
pub(crate) fn calcula_formula_text(file: &str) -> String {
    let tokens = tokenize(file);
    let mut edits = vec![Edit::default(); tokens.len()];
    let kind = |i: usize| tokens.get(i).map(|t| t.kind);
    for at in 0..tokens.len() {
        let token = tokens[at];
        let spelled = text(file, &token);
        match token.kind {
            Kind::Name => {
                if let Some(rest) = strip_prefix_ci(spelled, OPTIONAL_PREFIX) {
                    edits[at].replace = Some(format!("[{}]", rest));
                    continue;
                }
                if let Some(rest) = strip_prefix_ci(spelled, CELL_NAME_PREFIX) {
                    let inner = tokenize(rest);
                    if inner.len() == 1 && inner[0].kind == Kind::Reference && is_cell_shaped(rest) {
                        edits[at].replace = Some(rest.to_string());
                    }
                    continue;
                }
                if kind(at + 1) != Some(Kind::Punct('(')) {
                    continue;
                }
                let open = at + 1;
                let close = matching_close(&tokens, open);
                if close >= tokens.len() {
                    continue;
                }
                let bare = strip_prefix_ci(spelled, "_xlfn.").unwrap_or(spelled);
                if let Some((_, lead, trail)) = trim_operator_at(file, &tokens, at) {
                    // The LAST colon at the call's own depth: in a 3-D
                    // reference the first joins the sheets.
                    let mut depth = 0usize;
                    let mut colon = None;
                    for i in open + 1..close {
                        match tokens[i].kind {
                            Kind::Punct('(') | Kind::Punct('{') => depth += 1,
                            Kind::Punct(')') | Kind::Punct('}') => depth = depth.saturating_sub(1),
                            Kind::Punct(':') if depth == 0 => colon = Some(i),
                            _ => {}
                        }
                    }
                    if let Some(colon) = colon {
                        edits[at].replace = Some(String::new());
                        edits[open].replace = Some(String::new());
                        edits[close].replace = Some(String::new());
                        let dotted = match (lead, trail) {
                            (true, true) => ".:.",
                            (true, false) => ".:",
                            _ => ":.",
                        };
                        edits[colon].replace = Some(dotted.to_string());
                    }
                } else if bare.eq_ignore_ascii_case("ANCHORARRAY") {
                    // Calcula's spill operator follows a cell, sheet included.
                    let last = close - 1;
                    if close > open + 1 && kind(last) == Some(Kind::Reference) && reference_start(&tokens, last) == open + 1 {
                        edits[at].replace = Some(String::new());
                        edits[open].replace = Some(String::new());
                        edits[close].replace = Some("#".to_string());
                    }
                } else if bare.eq_ignore_ascii_case("SINGLE") {
                    edits[at].replace = Some("@".to_string());
                    // An operand `@` holds as it is (a reference, a range, a
                    // name, a call, a table reference) loses the parentheses;
                    // anything else keeps them as its group.
                    let atom = close > open + 1
                        && intersection_operand(file, &tokens, open + 1).is_some_and(|(end, group)| !group && end == close - 1);
                    if atom {
                        edits[open].replace = Some(String::new());
                        edits[close].replace = Some(String::new());
                    }
                }
            }
            Kind::Bracket => {
                if let Some(short) = this_row_short_form(spelled) {
                    edits[at].replace = Some(short);
                }
            }
            _ => {}
        }
    }
    crate::xlsx_reader::strip_future_function_prefixes(&apply_edits(file, &tokens, &edits))
}

/// A file's long-form this-row reference in Calcula's spelling (the inverse
/// of [`this_row_long_form`]): `[[#This Row],[Col]]` -> `[@Col]`,
/// `[[#This Row],[P]:[Q]]` -> `[[@P]:[@Q]]`. `#This Row` in any case.
fn this_row_short_form(bracket: &str) -> Option<String> {
    let inner = bracket.strip_prefix('[')?.strip_suffix(']')?;
    let parts = bracket_groups(inner)?;
    let (first, rest) = parts.split_first()?;
    if !first.eq_ignore_ascii_case("[#This Row]") {
        return None;
    }
    match rest {
        [comma, column] if *comma == "," && column.starts_with('[') => Some(format!("[@{}]", &column[1..column.len() - 1])),
        [comma, start, colon, end] if *comma == "," && *colon == ":" && start.starts_with('[') && end.starts_with('[') => {
            Some(format!("[[@{}:[@{}]", &start[1..], &end[1..]))
        }
        _ => None,
    }
}

/// `rust_xlsxwriter::Formula::new` over a formula's file text, with the text's
/// own braces kept. The library takes a leading `{` and a trailing `}` for an
/// array formula's braces and strips each (`formula.rs`, 0.79.4), so an
/// array constant at either end of a formula was cut: `={1,2,3}` was written
/// `<f>1,2,3</f>` and `=B5:B7*{1;2;3}` as `<f>B5:B7*{1;2;3</f>`, and a name
/// `={1,2,3}` as `1,2,3` -- [LIVE] Excel 16 refused that whole workbook
/// (rev15A, round 16). Excel itself saves them whole ([LIVE] round 17:
/// `<f t="array" ref="D5:F5">{1,2,3}</f>`, `<f ..>B5:B7*{1;2;3}</f>`,
/// `<definedName name="Months">{1,2,3}</definedName>`), so the brace the
/// library strips is given to it to strip: one more at each end that has one.
///
/// A text with a trim operator is escaped through the borrowed route first
/// ([`escape_defined_name_formulas`]), which adds the `_xlfn.` the library's
/// table lacks; the library then copies the already-escaped text.
pub(crate) fn library_formula(text: &str) -> rust_xlsxwriter::Formula {
    if has_trim_operator(text) {
        if let Ok(mut escaped) = escape_defined_name_formulas(&[text.to_string()]) {
            if let Some(escaped) = escaped.pop() {
                return guarded_formula(&escaped);
            }
        }
    }
    guarded_formula(text)
}

/// `rust_xlsxwriter::Formula::new` with the text's own braces kept (see
/// [`library_formula`]).
fn guarded_formula(text: &str) -> rust_xlsxwriter::Formula {
    let mut guarded = String::with_capacity(text.len() + 2);
    if text.starts_with('{') {
        guarded.push('{');
    }
    guarded.push_str(text);
    if text.ends_with('}') {
        guarded.push('}');
    }
    rust_xlsxwriter::Formula::new(guarded)
}

/// Each defined name's formula with Excel's `_xlfn.` future-function prefixes,
/// which `Workbook::define_name` does not add (a CELL formula gets them from
/// `rust_xlsxwriter::Formula::new`). The library keeps its escaping private, so
/// it is borrowed: every formula that calls something is written into a
/// scratch worksheet, one per row, and read back from the `<f>` the library
/// wrote -- the library's own function table, which can never drift from the
/// cells' one. A formula with no call (a range, a constant, an array constant)
/// needs no prefix and is returned as it is; one with a call keeps its braces
/// ([`library_formula`]). A trim operator, which the table lacks, gets its
/// `_xlfn.` afterwards ([`prefix_trim_operators`]).
///
/// `formulas` are the texts [`excel_formula_text`] gives (no leading `=`).
pub(crate) fn escape_defined_name_formulas(formulas: &[String]) -> Result<Vec<String>, PersistenceError> {
    use std::io::Read;
    // Only a call can need a prefix. (A `(` inside a string or a quoted sheet
    // name merely sends the formula through the escaping, which leaves both
    // alone.)
    let needs_escaping: Vec<usize> = (0..formulas.len()).filter(|&i| formulas[i].contains('(')).collect();
    if needs_escaping.is_empty() {
        return Ok(formulas.to_vec());
    }
    let bad = |what: String| PersistenceError::InvalidFormat(format!("xlsx defined-name escaping: {}", what));
    let mut scratch = rust_xlsxwriter::Workbook::new();
    let sheet = scratch.add_worksheet();
    for (row, &index) in needs_escaping.iter().enumerate() {
        sheet
            .write_formula(row as u32, 0, guarded_formula(&formulas[index]))
            .map_err(|e| bad(e.to_string()))?;
    }
    let bytes = scratch.save_to_buffer().map_err(|e| bad(e.to_string()))?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| bad(e.to_string()))?;
    let mut xml = String::new();
    archive
        .by_name("xl/worksheets/sheet1.xml")
        .map_err(|e| bad(e.to_string()))?
        .read_to_string(&mut xml)?;
    let mut escaped = Vec::with_capacity(formulas.len());
    let mut rest = xml.as_str();
    while let Some(at) = rest.find("<f") {
        let after = &rest[at + 2..];
        // `<f>` or `<f t="array" ref="..">`, never another element.
        if !(after.starts_with('>') || after.starts_with(' ')) {
            rest = after;
            continue;
        }
        let open_end = after.find('>').ok_or_else(|| bad("unclosed <f>".to_string()))?;
        let body = &after[open_end + 1..];
        let close = body.find("</f>").ok_or_else(|| bad("unclosed <f>".to_string()))?;
        escaped.push(prefix_trim_operators(&unescape_xml_text(&body[..close])));
        rest = &body[close..];
    }
    if escaped.len() != needs_escaping.len() {
        return Err(bad(format!("{} formulas written, {} read back", needs_escaping.len(), escaped.len())));
    }
    let mut out = formulas.to_vec();
    for (index, text) in needs_escaping.into_iter().zip(escaped) {
        out[index] = text;
    }
    Ok(out)
}

/// XML character data back to text (the five predefined entities).
fn unescape_xml_text(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// [LIVE] Excel 16's own spellings (round 15 probe, sheet XML verbatim).
    #[test]
    fn lambda_and_let_parameters_get_excels_xlpm_prefix() {
        for (calcula, excel) in [
            ("LAMBDA(x,x+1)(2)", "LAMBDA(_xlpm.x,_xlpm.x+1)(2)"),
            ("LET(a,5,b,a*2,a+b)", "LET(_xlpm.a,5,_xlpm.b,_xlpm.a*2,_xlpm.a+_xlpm.b)"),
            ("LAMBDA(f,f(2))(LAMBDA(x,x*3))", "LAMBDA(_xlpm.f,_xlpm.f(2))(LAMBDA(_xlpm.x,_xlpm.x*3))"),
            ("LAMBDA(x,x)", "LAMBDA(_xlpm.x,_xlpm.x)"),
            ("LET(sum,3,sum+1)", "LET(_xlpm.sum,3,_xlpm.sum+1)"),
            ("MAP({1,2},LAMBDA(v,v*2))", "MAP({1,2},LAMBDA(_xlpm.v,_xlpm.v*2))"),
            ("LET(x,1,LAMBDA(y,x+y)(2))", "LET(_xlpm.x,1,LAMBDA(_xlpm.y,_xlpm.x+_xlpm.y)(2))"),
            ("LET(x,1,x+LET(x,2,x))", "LET(_xlpm.x,1,_xlpm.x+LET(_xlpm.x,2,_xlpm.x))"),
            // Excel's own file, read and written again: idempotent.
            ("_xlfn.LAMBDA(_xlpm.x,_xlpm.x)", "_xlfn.LAMBDA(_xlpm.x,_xlpm.x)"),
            // [LIVE] round 17: a BARE column range beside a parameter of the
            // same letter is the parameter's range to Excel itself
            // (`SUM(_xlpm.b:_xlpm.b)`, showing #VALUE!); `r` and `c` are
            // parameters like any other. Round 19 (deliberately changed from
            // `_xlpm.B:_xlpm.B`): [LIVE] Excel 16 writes every use in the
            // DECLARED spelling, so the halves are `_xlpm.b`.
            ("LET(b,2,SUM(B:B)*b)", "LET(_xlpm.b,2,SUM(_xlpm.b:_xlpm.b)*_xlpm.b)"),
            ("LET(r,2,r+1)", "LET(_xlpm.r,2,_xlpm.r+1)"),
            ("LET(c,2,c+1)", "LET(_xlpm.c,2,_xlpm.c+1)"),
        ] {
            assert_eq!(with_parameter_prefixes(calcula), excel, "for {}", calcula);
        }
    }

    /// Only a parameter is prefixed: not a cell reference, a name outside the
    /// call, a sheet-qualified name, a sheet, a string, a structured reference,
    /// or a number's exponent; and a LET's calculation that is one name is a
    /// USE, not a declaration.
    #[test]
    fn nothing_but_a_parameter_is_prefixed() {
        for (calcula, excel) in [
            ("SUM(A1:B2)+x", "SUM(A1:B2)+x"),
            ("LAMBDA(x,x+A1)(1)+x", "LAMBDA(_xlpm.x,_xlpm.x+A1)(1)+x"),
            ("LET(x,Sheet1!x,x)", "LET(_xlpm.x,Sheet1!x,_xlpm.x)"),
            ("LET(x,x!A1,x)", "LET(_xlpm.x,x!A1,_xlpm.x)"),
            ("LET(x,\"x\"&'x'!A1,x)", "LET(_xlpm.x,\"x\"&'x'!A1,_xlpm.x)"),
            ("LET(x,T[x],x&\"\"\"x\")", "LET(_xlpm.x,T[x],_xlpm.x&\"\"\"x\")"),
            ("LET(e,1E5,e)", "LET(_xlpm.e,1E5,_xlpm.e)"),
            ("LET(x,1,y)", "LET(_xlpm.x,1,y)"),
            ("LET(x,1,ROUND(x,0))", "LET(_xlpm.x,1,ROUND(_xlpm.x,0))"),
            ("CONCAT(\"LAMBDA(x,x)\",x)", "CONCAT(\"LAMBDA(x,x)\",x)"),
            // rev15A (round 16, CONFIRMED LIVE): the column of a whole cell
            // reference was prefixed when a parameter shared its letter --
            // `$_xlpm.A$1`, and Excel refused the workbook. [LIVE] Excel 16
            // (round 17) saves each of these with the reference untouched.
            ("LET(a,5,$A$1+a)", "LET(_xlpm.a,5,$A$1+_xlpm.a)"),
            ("LET(a,1,A$1+a)", "LET(_xlpm.a,1,A$1+_xlpm.a)"),
            ("LET(a,1,$A1+a)", "LET(_xlpm.a,1,$A1+_xlpm.a)"),
            ("LET(x,1,Sheet1!$X$1+x)", "LET(_xlpm.x,1,Sheet1!$X$1+_xlpm.x)"),
            ("LAMBDA(x,x*Sheet1!$X$1)(2)", "LAMBDA(_xlpm.x,_xlpm.x*Sheet1!$X$1)(2)"),
            ("LET(b,2,SUM(B5:B7)*b)", "LET(_xlpm.b,2,SUM(B5:B7)*_xlpm.b)"),
            ("LET(a,1,SUM($A$1:$A$3,A1:A3)+a)", "LET(_xlpm.a,1,SUM($A$1:$A$3,A1:A3)+_xlpm.a)"),
            // A column range with a `$`, or on a sheet, is a reference.
            ("LET(b,2,SUM($B:$B)*b)", "LET(_xlpm.b,2,SUM($B:$B)*_xlpm.b)"),
            ("LET(b,2,SUM($B:B)*b)", "LET(_xlpm.b,2,SUM($B:B)*_xlpm.b)"),
            ("LET(b,2,SUM(Sheet1!B:B)*b)", "LET(_xlpm.b,2,SUM(Sheet1!B:B)*_xlpm.b)"),
            ("LET(b,2,SUM('My Sheet'!B:B)*b)", "LET(_xlpm.b,2,SUM('My Sheet'!B:B)*_xlpm.b)"),
            // Row ranges hold no name; a function whose name looks like a
            // cell (`LOG10`) is a call, and a name that is no cell is a name.
            ("LET(a,1,SUM($1:$2,3:3)+a)", "LET(_xlpm.a,1,SUM($1:$2,3:3)+_xlpm.a)"),
            ("LET(log,100,LOG10(log))", "LET(_xlpm.log,100,LOG10(_xlpm.log))"),
            ("LET(abcd1,2,abcd1+XFE1)", "LET(_xlpm.abcd1,2,_xlpm.abcd1+XFE1)"),
            // Round 19: error literals Excel will not let a user TYPE ([LIVE]
            // Excel 16 refuses `=LET(spill,1,ISERROR(#SPILL!)+spill)` and the
            // `#CALC!` one) but a file can carry, and any case, stay whole.
            ("LET(spill,1,ISERROR(#SPILL!)+spill)", "LET(_xlpm.spill,1,ISERROR(#SPILL!)+_xlpm.spill)"),
            ("LET(calc,1,ISERROR(#CALC!)+calc)", "LET(_xlpm.calc,1,ISERROR(#CALC!)+_xlpm.calc)"),
            ("LET(data,1,ISERROR(#GETTING_DATA)+data)", "LET(_xlpm.data,1,ISERROR(#GETTING_DATA)+_xlpm.data)"),
            ("LET(div,1,IFERROR(1/0,#div/0!))", "LET(_xlpm.div,1,IFERROR(1/0,#div/0!))"),
            // A trim reference's dots end a reference and a name (`A1.:.B5`).
            // Round 20 (deliberately changed from `SUM(A1.:.B5)`): [LIVE] a
            // file spells it `_xlfn._TRO_ALL(A1:B5)`; the `_xlfn.` is added
            // after the library's escaping (`prefix_trim_operators`).
            ("LET(a,1,SUM(A1.:.B5)+a)", "LET(_xlpm.a,1,SUM(_TRO_ALL(A1:B5))+_xlpm.a)"),
            // A dotted name is one name, never a parameter plus a tail.
            ("LET(q,1,Q1.Sales+q)", "LET(_xlpm.q,1,Q1.Sales+_xlpm.q)"),
        ] {
            assert_eq!(with_parameter_prefixes(calcula), excel, "for {}", calcula);
        }
    }

    /// Round 19 (rev17, two MAJORs CONFIRMED LIVE: `#N/_xlpm.A` made Excel
    /// refuse the workbook, `SUM(A:_xlpm.B)` showed #NAME? where Excel gives
    /// 165). The scan was patched case by case three reviews running; it now
    /// reads the lexer's token classes, and this table holds every class
    /// beside a same-named parameter.
    ///
    /// Column 2 is Excel's own file: [LIVE] Excel 16 (xlpm2 probeA, round 19,
    /// fresh instance) took each formula typed into a new workbook -- Sheet1
    /// A1:C5 = 1..5 / 10..50 / 100..500, Table1 on H1:H90 (column `Col`),
    /// sheets Sheet2, `My Sheet` and `Översikt` -- saved it, and this is its
    /// `<f>` verbatim. Column 3, when not empty, is Calcula's export where
    /// Excel re-spells a token that is no name (`1E5` as `100000`, `#n/a` as
    /// `#N/A`) in this LITERAL text (the engine's stored text already holds
    /// `100000`); the prefixes then still agree name for name. [LIVE] Excel 16
    /// (probeB) opened Excel's file with every `<f>` replaced by Calcula's
    /// export text and computed 65 of the 66 cells to Excel's own value; the
    /// one that differed was the `[@Col]` row, which round 20 writes in the
    /// file's long form `[[#This Row],[Col]]` (`this_row_long_form`).
    ///
    /// Not here, because Excel cannot hold them ([LIVE] each refused when
    /// typed): `LET(r2,..)`, `LET(a.b,..)`. A bare `C` / `R` needs the cell the
    /// formula sits in, so its rows are in the real-path table
    /// (`xlsx_formula_text_live_table.rs`), which also drives every row through
    /// the text the engine really stores.
    const LIVE_EXCEL_TABLE: &[(&str, &str, &str)] = &[
            ("LET(a,1,IFERROR(1/0,#N/A))", "_xlfn.LET(_xlpm.a,1,IFERROR(1/0,#N/A))", ""),
            ("LET(n,1,IF(n,#N/A,0))", "_xlfn.LET(_xlpm.n,1,IF(_xlpm.n,#N/A,0))", ""),
            ("LAMBDA(a,IFNA(a,#N/A))(1)", "_xlfn.LAMBDA(_xlpm.a,_xlfn.IFNA(_xlpm.a,#N/A))(1)", ""),
            ("LET(div,1,IFERROR(1/0,#DIV/0!))", "_xlfn.LET(_xlpm.div,1,IFERROR(1/0,#DIV/0!))", ""),
            ("LET(name,1,IF(ISERROR(#NAME?),name,0))", "_xlfn.LET(_xlpm.name,1,IF(ISERROR(#NAME?),_xlpm.name,0))", ""),
            ("LET(value,1,ISERROR(#VALUE!)+value)", "_xlfn.LET(_xlpm.value,1,ISERROR(#VALUE!)+_xlpm.value)", ""),
            ("LET(ref,1,ISERROR(#REF!)+ref)", "_xlfn.LET(_xlpm.ref,1,ISERROR(#REF!)+_xlpm.ref)", ""),
            ("LET(num,1,ISERROR(#NUM!)+num)", "_xlfn.LET(_xlpm.num,1,ISERROR(#NUM!)+_xlpm.num)", ""),
            ("LET(null,1,ISERROR(#NULL!)+null)", "_xlfn.LET(_xlpm.null,1,ISERROR(#NULL!)+_xlpm.null)", ""),
            ("LET(a,1,ISERROR(#n/a)+a)", "_xlfn.LET(_xlpm.a,1,ISERROR(#N/A)+_xlpm.a)", "_xlfn.LET(_xlpm.a,1,ISERROR(#n/a)+_xlpm.a)"),
            ("LET(b,2,SUM(A:B))", "_xlfn.LET(_xlpm.b,2,SUM(A:B))", ""),
            ("LET(c,2,SUM(A:C)*c)", "_xlfn.LET(_xlpm.c,2,SUM(A:C)*_xlpm.c)", ""),
            ("LET(b,2,SUM(B:B)*b)", "_xlfn.LET(_xlpm.b,2,SUM(_xlpm.b:_xlpm.b)*_xlpm.b)", ""),
            ("LET(ab,2,SUM(AB:AB)+ab)", "_xlfn.LET(_xlpm.ab,2,SUM(_xlpm.ab:_xlpm.ab)+_xlpm.ab)", ""),
            ("LET(a,1,SUM(A:A)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlpm.a:_xlpm.a)+_xlpm.a)", ""),
            ("LET(b,2,SUM(A:B,b))", "_xlfn.LET(_xlpm.b,2,SUM(A:B,_xlpm.b))", ""),
            ("LET(e,2,1E5+e)", "_xlfn.LET(_xlpm.e,2,100000+_xlpm.e)", "_xlfn.LET(_xlpm.e,2,1E5+_xlpm.e)"),
            ("LET(e,2,1e-3*e)", "_xlfn.LET(_xlpm.e,2,0.001*_xlpm.e)", "_xlfn.LET(_xlpm.e,2,1e-3*_xlpm.e)"),
            ("LET(E,2,2.5E+2+E)", "_xlfn.LET(_xlpm.E,2,250+_xlpm.E)", "_xlfn.LET(_xlpm.E,2,2.5E+2+_xlpm.E)"),
            ("LET(e,2,e*1E2)", "_xlfn.LET(_xlpm.e,2,_xlpm.e*100)", "_xlfn.LET(_xlpm.e,2,_xlpm.e*1E2)"),
            ("LET(a,5,$A$1+a)", "_xlfn.LET(_xlpm.a,5,$A$1+_xlpm.a)", ""),
            ("LET(a,1,A$1+a)", "_xlfn.LET(_xlpm.a,1,A$1+_xlpm.a)", ""),
            ("LET(a,1,$A1+a)", "_xlfn.LET(_xlpm.a,1,$A1+_xlpm.a)", ""),
            ("LET(a,1,SUM($A$1:$A$3,A1:A3)+a)", "_xlfn.LET(_xlpm.a,1,SUM($A$1:$A$3,A1:A3)+_xlpm.a)", ""),
            ("LET(b,2,SUM($B:$B)*b)", "_xlfn.LET(_xlpm.b,2,SUM($B:$B)*_xlpm.b)", ""),
            ("LET(b,2,SUM($B:B)*b)", "_xlfn.LET(_xlpm.b,2,SUM($B:B)*_xlpm.b)", ""),
            ("LET(a,1,SUM($1:$2,3:3)+a)", "_xlfn.LET(_xlpm.a,1,SUM($1:$2,3:3)+_xlpm.a)", ""),
            ("LET(x,1,Sheet1!$X$1+x)", "_xlfn.LET(_xlpm.x,1,Sheet1!$X$1+_xlpm.x)", ""),
            ("LET(b,2,SUM(Sheet1!B:B)*b)", "_xlfn.LET(_xlpm.b,2,SUM(Sheet1!B:B)*_xlpm.b)", ""),
            ("LET(b,2,SUM('My Sheet'!B:B)*b)", "_xlfn.LET(_xlpm.b,2,SUM('My Sheet'!B:B)*_xlpm.b)", ""),
            ("LET(b,2,SUM('My Sheet'!A1:B2)*b)", "_xlfn.LET(_xlpm.b,2,SUM('My Sheet'!A1:B2)*_xlpm.b)", ""),
            ("LET(\u{f6},1,\u{d6}versikt!A1+\u{f6})", "_xlfn.LET(_xlpm.\u{f6},1,\u{d6}versikt!A1+_xlpm.\u{f6})", ""),
            ("LET(Sheet1,1,Sheet1!A1+Sheet1)", "_xlfn.LET(_xlpm.Sheet1,1,Sheet1!A1+_xlpm.Sheet1)", ""),
            ("LET(Sheet2,1,SUM(Sheet1:Sheet2!A1)+Sheet2)", "_xlfn.LET(_xlpm.Sheet2,1,SUM(Sheet1:Sheet2!A1)+_xlpm.Sheet2)", ""),
            ("LET(Col,1,SUM(Table1[Col])+Col)", "_xlfn.LET(_xlpm.Col,1,SUM(Table1[Col])+_xlpm.Col)", ""),
            // Round 20: the export now writes the file's long form itself
            // (`this_row_long_form`), so this row is Excel's text verbatim.
            ("LET(Col,1,Table1[@Col]+Col)", "_xlfn.LET(_xlpm.Col,1,Table1[[#This Row],[Col]]+_xlpm.Col)", ""),
            ("LET(h,1,ROWS(Table1[#Headers])+h)", "_xlfn.LET(_xlpm.h,1,ROWS(Table1[#Headers])+_xlpm.h)", ""),
            ("LET(Table1,1,SUM(Table1[Col])+Table1)", "_xlfn.LET(_xlpm.Table1,1,SUM(Table1[Col])+_xlpm.Table1)", ""),
            ("LET(r,2,r+1)", "_xlfn.LET(_xlpm.r,2,_xlpm.r+1)", ""),
            ("LET(c,2,c+1)", "_xlfn.LET(_xlpm.c,2,_xlpm.c+1)", ""),
            ("LET(rc,2,rc+1)", "_xlfn.LET(_xlpm.rc,2,_xlpm.rc+1)", ""),
            ("LET(rr,2,rr+1)", "_xlfn.LET(_xlpm.rr,2,_xlpm.rr+1)", ""),
            ("LET(R1C1,2,R1C1+1)", "_xlfn.LET(_xlpm.R1C1,2,_xlpm.R1C1+1)", ""),
            ("LAMBDA(f,f(2))(LAMBDA(x,x*3))", "_xlfn.LAMBDA(_xlpm.f,_xlpm.f(2))(_xlfn.LAMBDA(_xlpm.x,_xlpm.x*3))", ""),
            ("LET(f,LAMBDA(x,x+1),f(2))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.x,_xlpm.x+1),_xlpm.f(2))", ""),
            ("LET(sum,3,sum+1)", "_xlfn.LET(_xlpm.sum,3,_xlpm.sum+1)", ""),
            ("LET(sum,3,SUM(sum,1))", "_xlfn.LET(_xlpm.sum,3,SUM(_xlpm.sum,1))", ""),
            ("LET(log,100,LOG10(log))", "_xlfn.LET(_xlpm.log,100,LOG10(_xlpm.log))", ""),
            ("LET(abcd1,2,abcd1+XFE1)", "_xlfn.LET(_xlpm.abcd1,2,_xlpm.abcd1+XFE1)", ""),
            ("LET(_x,1,_x+1)", "_xlfn.LET(_xlpm._x,1,_xlpm._x+1)", ""),
            ("LET(a_b,1,a_b+1)", "_xlfn.LET(_xlpm.a_b,1,_xlpm.a_b+1)", ""),
            ("LET(\\x,1,\\x+1)", "_xlfn.LET(_xlpm.\\x,1,_xlpm.\\x+1)", ""),
            ("LET(x2y,1,x2y+1)", "_xlfn.LET(_xlpm.x2y,1,_xlpm.x2y+1)", ""),
            ("LET(a,1,SUM({1,2;3,4})+a)", "_xlfn.LET(_xlpm.a,1,SUM({1,2;3,4})+_xlpm.a)", ""),
            ("LET(a,1,SUM({1,2;3,4},a))", "_xlfn.LET(_xlpm.a,1,SUM({1,2;3,4},_xlpm.a))", ""),
            ("LET(a,A1:C1,b,B1:B5,SUM(a b))", "_xlfn.LET(_xlpm.a,A1:C1,_xlpm.b,B1:B5,SUM(_xlpm.a _xlpm.b))", ""),
            ("LET(x,1,x+LET(x,2,x))", "_xlfn.LET(_xlpm.x,1,_xlpm.x+_xlfn.LET(_xlpm.x,2,_xlpm.x))", ""),
            ("LET(x,1,LAMBDA(y,x+y)(2))", "_xlfn.LET(_xlpm.x,1,_xlfn.LAMBDA(_xlpm.y,_xlpm.x+_xlpm.y)(2))", ""),
            ("LET(x,1,LAMBDA(x,x*10)(2)+x)", "_xlfn.LET(_xlpm.x,1,_xlfn.LAMBDA(_xlpm.x,_xlpm.x*10)(2)+_xlpm.x)", ""),
            ("LET(x,\"x\",x&\"x\"\"x\")", "_xlfn.LET(_xlpm.x,\"x\",_xlpm.x&\"x\"\"x\")", ""),
            ("LET(t,TRUE,AND(t,TRUE))", "_xlfn.LET(_xlpm.t,TRUE,AND(_xlpm.t,TRUE))", ""),
            ("LET(Ab,1,AB+ab)", "_xlfn.LET(_xlpm.Ab,1,_xlpm.Ab+_xlpm.Ab)", ""),
            ("LET(p,50%,p*2)", "_xlfn.LET(_xlpm.p,50%,_xlpm.p*2)", ""),
            ("LET(x,1,SUM(A1:B2)+x)", "_xlfn.LET(_xlpm.x,1,SUM(A1:B2)+_xlpm.x)", ""),
            ("MAP({1,2},LAMBDA(v,v*2))", "_xlfn.MAP({1,2},_xlfn.LAMBDA(_xlpm.v,_xlpm.v*2))", ""),
            ("LET(a,1,b,a+1,a+b)", "_xlfn.LET(_xlpm.a,1,_xlpm.b,_xlpm.a+1,_xlpm.a+_xlpm.b)", ""),
    ];

    /// The names a file text carries `_xlpm.` on, in order.
    fn prefixed_names(text: &str) -> Vec<String> {
        text.split(PARAMETER_PREFIX)
            .skip(1)
            .map(|rest| rest.chars().take_while(|&c| is_letter(c) || c.is_ascii_digit()).collect())
            .collect()
    }

    /// Every table row's export text exactly as a cell's `<f>` carries it: the
    /// parameter prefixes, then the library's future-function escaping.
    fn calcula_export_texts() -> Vec<String> {
        let texts: Vec<String> = LIVE_EXCEL_TABLE.iter().map(|&(input, _, _)| excel_formula_text(input, None)).collect();
        escape_defined_name_formulas(&texts).unwrap()
    }

    #[test]
    fn every_token_class_beside_a_same_named_parameter_is_saved_as_excel_saves_it() {
        let exported = calcula_export_texts();
        let mut wrong = Vec::new();
        for (&(input, excel, respelled), ours) in LIVE_EXCEL_TABLE.iter().zip(&exported) {
            let expected = if respelled.is_empty() { excel } else { respelled };
            if ours != expected {
                wrong.push(format!("  {}\n    Calcula: {}\n    Excel:   {}", input, ours, expected));
            }
            if !respelled.is_empty() {
                assert_eq!(prefixed_names(respelled), prefixed_names(excel), "the respelled row {} prefixes other names", input);
            }
        }
        assert!(wrong.is_empty(), "NOT EXCEL'S SPELLING:\n{}", wrong.join("\n"));
        // The live probe's input: each formula and Calcula's export text.
        if let Ok(dir) = std::env::var("CALCULA_XLSX_PROBE_DIR") {
            let rows: Vec<serde_json::Value> = LIVE_EXCEL_TABLE
                .iter()
                .zip(&exported)
                .map(|(&(input, _, _), ours)| serde_json::json!({ "input": input, "export": ours }))
                .collect();
            let _ = std::fs::write(
                std::path::Path::new(&dir).join("xlpm-table.json"),
                serde_json::to_string_pretty(&rows).unwrap(),
            );
        }
    }

    /// The scan's grammar is a mirror of Calcula's lexer (see [`Kind`]); this
    /// diffs the two over the whole table. Every formula is one Calcula holds
    /// (it parses), every token the scan calls a name is an identifier to the
    /// lexer, in order, and the error literals, booleans and strings are the
    /// lexer's own.
    #[test]
    fn the_scan_reads_every_name_as_calculas_lexer_does() {
        for &(input, _, _) in LIVE_EXCEL_TABLE {
            assert!(parser::parse(input).is_ok(), "Calcula cannot hold {}", input);
            let mut lexer = parser::Lexer::new(input);
            let (mut identifiers, mut errors, mut booleans, mut strings) = (Vec::new(), Vec::new(), 0, 0);
            loop {
                match lexer.next_token() {
                    parser::Token::EOF => break,
                    parser::Token::Identifier(name) => identifiers.push(name),
                    parser::Token::ErrorLiteral(error) => errors.push(error),
                    parser::Token::Boolean(_) => booleans += 1,
                    parser::Token::String(_) => strings += 1,
                    _ => {}
                }
            }
            let tokens = tokenize(input);
            let ours = |kind: Kind| -> Vec<String> {
                tokens.iter().filter(|t| t.kind == kind).map(|t| text(input, t).to_string()).collect()
            };
            let mut lexed = identifiers.iter();
            for name in ours(Kind::Name) {
                assert!(
                    lexed.any(|identifier| same_name(identifier, &name)),
                    "DRIFT: the scan reads `{}` in {} as a name the lexer does not (lexer: {:?})",
                    name,
                    input,
                    identifiers
                );
            }
            let our_errors: Vec<String> = ours(Kind::ErrorLiteral).iter().map(|e| e.to_ascii_uppercase()).collect();
            assert_eq!(our_errors, errors, "DRIFT: the error literals of {}", input);
            assert_eq!(ours(Kind::Boolean).len(), booleans, "DRIFT: the booleans of {}", input);
            assert_eq!(ours(Kind::Text).len(), strings, "DRIFT: the strings of {}", input);
        }
    }


    /// rev15A (round 16, CONFIRMED LIVE): the library strips a formula's
    /// leading `{` and trailing `}` as array-formula braces, so an array
    /// constant at either end was cut and a name `={1,2,3}` written `1,2,3`
    /// -- [LIVE] Excel 16 refused the file. Every brace survives.
    #[test]
    fn an_array_constant_at_either_end_keeps_its_braces() {
        let mut scratch = rust_xlsxwriter::Workbook::new();
        let sheet = scratch.add_worksheet();
        let texts = ["{1,2,3}", "B5:B7*{1;2;3}", "{\"a\",\"b\"}&SUM(1)", "SUM({1,2})", "{1}+{2}"];
        for (row, text) in texts.iter().enumerate() {
            sheet.write_formula(row as u32, 0, library_formula(text)).unwrap();
        }
        let bytes = scratch.save_to_buffer().unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut xml = String::new();
        std::io::Read::read_to_string(&mut archive.by_name("xl/worksheets/sheet1.xml").unwrap(), &mut xml).unwrap();
        for text in texts {
            let expected = format!("<f>{}</f>", text.replace('&', "&amp;").replace('"', "&quot;"));
            let expected_unquoted = format!("<f>{}</f>", text.replace('&', "&amp;"));
            assert!(
                xml.contains(&expected) || xml.contains(&expected_unquoted),
                "BRACES CUT: expected {} in {}",
                expected_unquoted,
                xml
            );
        }
    }

    /// A call to a named LAMBDA leaves as the call the user wrote, never as
    /// Calcula's internal `__INVOKE__` marker.
    #[test]
    fn a_named_lambda_call_is_exported_as_the_users_call() {
        assert_eq!(excel_formula_text("=__INVOKE__(\"Double\",LAMBDA(x,x*2),D4)", None), "Double(D4)");
        assert_eq!(excel_formula_text("=SUM(A1:A3)", None), "SUM(A1:A3)");
    }

    /// [LIVE] Excel 16 saves a defined name `=LAMBDA(n,n+1)` as
    /// `_xlfn.LAMBDA(_xlpm.n,_xlpm.n+1)`, `=XLOOKUP(..)` as `_xlfn.XLOOKUP(..)`.
    #[test]
    fn a_defined_names_formula_gets_excels_future_function_prefix() {
        let names = vec![
            excel_formula_text("=LAMBDA(n,n+1)", None),
            excel_formula_text("=XLOOKUP(2,{1,2},{10,20})", None),
            excel_formula_text("=Sheet1!$A$1:$B$5", None),
            excel_formula_text("=IF(A1<2,\"a&b\",\"<c>\")", None),
            // rev15A (round 16): array-constant names beside names with a
            // call -- [LIVE] Excel 16 saves `Months` as `{1,2,3}`.
            excel_formula_text("={1,2,3}", None),
            excel_formula_text("={\"a\",\"b\"}&SUM(1)", None),
            excel_formula_text("=XLOOKUP(2,{1,2},{10,20})+{1,2}", None),
        ];
        assert_eq!(
            escape_defined_name_formulas(&names).unwrap(),
            vec![
                "_xlfn.LAMBDA(_xlpm.n,_xlpm.n+1)".to_string(),
                "_xlfn.XLOOKUP(2,{1,2},{10,20})".to_string(),
                "Sheet1!$A$1:$B$5".to_string(),
                "IF(A1<2,\"a&b\",\"<c>\")".to_string(),
                "{1,2,3}".to_string(),
                "{\"a\",\"b\"}&SUM(1)".to_string(),
                "_xlfn.XLOOKUP(2,{1,2},{10,20})+{1,2}".to_string(),
            ]
        );
    }
}
