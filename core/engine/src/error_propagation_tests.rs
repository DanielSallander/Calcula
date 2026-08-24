//! FILENAME: core/engine/src/error_propagation_tests.rs
//! PURPOSE: An error ARGUMENT propagates out of the text family instead of
//!          being spelled out and consumed as data — plus the two ceilings and
//!          the one divergence that sit next to it.
//!
//! WHAT WAS SILENTLY WRONG. `EvalResult::as_text` renders an error as its
//! canonical literal, "#DIV/0!". Every text builtin reached its argument
//! through that method with no error guard, so an error did not fail the
//! formula — it became a seven-character STRING and the formula computed over
//! it. MEASURED before the fix, with J1 holding `#DIV/0!`:
//!
//!     =LEN(J1)                 => 7        (the length of "#DIV/0!")
//!     =LEN(1/0)                => 7
//!     =LEFT(1/0,2)             => "#D"
//!     =RIGHT(1/0,2)            => "0!"
//!     =REPLACE(1/0,1,1,"x")    => "xDIV/0!"
//!     =REPT(1/0,2)             => "#DIV/0!#DIV/0!"
//!     =CODE(1/0)               => 35       (the code point of '#')
//!     =ENCODEURL(1/0)          => "%23DIV%2F0%21"
//!     =TEXTJOIN(",",TRUE,1/0)  => ""       (the error was DROPPED outright)
//!     =EXACT(1/0,"x")          => FALSE
//!
//! Not one of those carries an error anywhere. A `#DIV/0!` five cells upstream
//! arrived downstream as a number that totals, charts, prints and exports like
//! any other — which is precisely the failure the error taxonomy exists to
//! prevent, arriving one layer below where anyone was looking for it.
//!
//! THE WRONG-ERROR CASES ARE JUST AS BAD AND WERE EASIER TO MISS. Several
//! functions did fail, but with `#VALUE!` — because `as_number` answers `None`
//! for an error — and `#VALUE!` sends the user to inspect the TEXT FUNCTION's
//! arguments rather than the division five cells upstream:
//!
//!     =FIND("a",1/0)  =>  #VALUE!      (Excel: #DIV/0!)
//!     =VALUE(1/0)     =>  #VALUE!      (Excel: #DIV/0!)
//!     =INDIRECT(1/0)  =>  #REF!        (Excel: #DIV/0!)
//!
//! ONE GUARD, NOT THIRTY COPIES. `text_arg!` / `arg_or_err!` in `evaluator.rs`
//! are the whole mechanism, and `every_text_argument_is_guarded_against_an_error`
//! below READS `evaluator.rs` at test time so a new text builtin that reaches
//! `as_text` bare fails the build rather than shipping the same defect again.
//!
//! THE EXEMPTIONS ARE LISTED, NOT ASSUMED. The functions whose job is to
//! INSPECT an error must keep receiving it, and each is asserted below.

use crate::cell::{Cell, CellError, CellValue};
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;

fn eval(formula: &str) -> EvalResult {
    let grid = Grid::new();
    let ast = parser::parse(formula).expect("formula parses");
    Evaluator::new(&grid).evaluate(&ast)
}

fn eval_on(grid: &Grid, formula: &str) -> EvalResult {
    let ast = parser::parse(formula).expect("formula parses");
    Evaluator::new(grid).evaluate(&ast)
}

/// A grid whose J1 holds a STORED `#DIV/0!`, which is how an error normally
/// reaches a text function in a real workbook — through a reference, not
/// through a division typed into the same formula.
fn grid_with_stored_error() -> Grid {
    let mut g = Grid::new();
    let mut cell = Cell::new();
    cell.value = CellValue::Error(CellError::Div0);
    g.set_cell(0, 9, cell);
    g
}

// ===========================================================================
// THE FAMILY
// ===========================================================================

/// EVERY TEXT FUNCTION, one case each, against a `#DIV/0!` argument.
///
/// The list is deliberately long and deliberately flat: the defect was not one
/// function getting it wrong, it was TWENTY-EIGHT functions each having its own
/// copy of an unguarded coercion. A per-function assertion is what makes a
/// future omission name itself.
#[test]
fn an_error_argument_propagates_out_of_every_text_function() {
    let cases: &[&str] = &[
        // --- the core text family --------------------------------------
        "=LEN(1/0)",
        "=LEFT(1/0,2)",
        "=RIGHT(1/0,2)",
        "=MID(1/0,1,2)",
        "=TRIM(1/0)",
        "=UPPER(1/0)",
        "=LOWER(1/0)",
        "=PROPER(1/0)",
        "=CLEAN(1/0)",
        "=SUBSTITUTE(1/0,\"a\",\"b\")",
        "=REPLACE(1/0,1,1,\"x\")",
        "=REPT(1/0,2)",
        "=CONCAT(1/0)",
        "=CONCATENATE(1/0)",
        "=TEXTJOIN(\",\",TRUE,1/0)",
        "=FIND(\"a\",1/0)",
        "=SEARCH(\"a\",1/0)",
        "=EXACT(1/0,\"x\")",
        "=TEXT(1/0,\"0\")",
        "=CODE(1/0)",
        "=UNICODE(1/0)",
        "=ENCODEURL(1/0)",
        "=TEXTBEFORE(1/0,\"a\")",
        "=TEXTAFTER(1/0,\"a\")",
        "=TEXTSPLIT(1/0,\",\")",
        // --- text -> value conversions ---------------------------------
        "=VALUE(1/0)",
        "=NUMBERVALUE(1/0)",
        "=DATEVALUE(1/0)",
        "=TIMEVALUE(1/0)",
        "=ARABIC(1/0)",
        "=DECIMAL(1/0,16)",
        "=BIN2DEC(1/0)",
        "=HEX2DEC(1/0)",
        "=OCT2DEC(1/0)",
        // --- functions that read a TEXT argument as a name or a unit ----
        "=INDIRECT(1/0)",
        "=CELL(1/0)",
        "=CONVERT(1,1/0,\"m\")",
        "=DATEDIF(1,2,1/0)",
    ];
    for formula in cases {
        assert_eq!(
            eval(formula),
            EvalResult::Error(CellError::Div0),
            "{formula} did not propagate its error argument"
        );
    }
}

/// THE ARGUMENT THAT IS NOT THE FIRST ONE. Every case above puts the error in
/// slot 0, and a guard written only for "the text argument" would pass all of
/// them while leaving the delimiters, the replacement strings and the counts
/// unguarded.
#[test]
fn an_error_in_a_later_argument_propagates_too() {
    let cases: &[&str] = &[
        "=SUBSTITUTE(\"abc\",1/0,\"b\")",
        "=SUBSTITUTE(\"abc\",\"a\",1/0)",
        "=REPLACE(\"abc\",1,1,1/0)",
        "=FIND(1/0,\"abc\")",
        "=SEARCH(1/0,\"abc\")",
        "=EXACT(\"x\",1/0)",
        "=TEXTBEFORE(\"abc\",1/0)",
        "=TEXTAFTER(\"abc\",1/0)",
        "=TEXTSPLIT(\"a,b\",1/0)",
        "=TEXTSPLIT(\"a,b\",\",\",1/0)",
        "=TEXTJOIN(1/0,TRUE,\"a\")",
        "=CONCAT(\"a\",1/0)",
        "=CONCATENATE(\"a\",1/0)",
        "=TEXT(1,1/0)",
        // NUMERIC parameters of text functions. `as_number` answers None for an
        // error, so each of these used to be #VALUE! — a real failure reported
        // with the wrong cause, which sends the user to the wrong cell.
        "=LEFT(\"abc\",1/0)",
        "=RIGHT(\"abc\",1/0)",
        "=MID(\"abc\",1/0,1)",
        "=MID(\"abc\",1,1/0)",
        "=REPT(\"a\",1/0)",
        "=REPLACE(\"abc\",1/0,1,\"x\")",
        "=REPLACE(\"abc\",1,1/0,\"x\")",
        "=SUBSTITUTE(\"aaa\",\"a\",\"b\",1/0)",
        "=FIND(\"a\",\"abc\",1/0)",
        "=SEARCH(\"a\",\"abc\",1/0)",
        "=DECIMAL(\"FF\",1/0)",
    ];
    for formula in cases {
        assert_eq!(
            eval(formula),
            EvalResult::Error(CellError::Div0),
            "{formula} did not propagate the error in its later argument"
        );
    }
}

/// EXCEL'S TIE-BREAK: the LEFT-MOST error wins.
///
/// Worth pinning because it is the one rule a guard can satisfy accidentally
/// and lose on the next refactor: it holds only while arguments are evaluated
/// in order and the first guard returns immediately. Hoisting an argument
/// "for clarity" reverses it, and the result is still an error — just the
/// wrong one, pointing at the wrong cell.
#[test]
fn the_left_most_error_argument_is_the_one_that_wins() {
    assert_eq!(eval("=FIND(1/0,NA())"), EvalResult::Error(CellError::Div0));
    assert_eq!(eval("=FIND(NA(),1/0)"), EvalResult::Error(CellError::NA));
    assert_eq!(eval("=EXACT(1/0,NA())"), EvalResult::Error(CellError::Div0));
    assert_eq!(eval("=EXACT(NA(),1/0)"), EvalResult::Error(CellError::NA));
    assert_eq!(eval("=CONCAT(NA(),1/0)"), EvalResult::Error(CellError::NA));
    assert_eq!(eval("=CONCAT(1/0,NA())"), EvalResult::Error(CellError::Div0));
    // MIXED KINDS: the text slot is left of the numeric slot, so the text
    // slot's error wins even though the numeric guard is the newer one.
    assert_eq!(eval("=LEFT(1/0,NA())"), EvalResult::Error(CellError::Div0));
    assert_eq!(eval("=LEFT(NA(),1/0)"), EvalResult::Error(CellError::NA));
    // AND THE OTHER ORDER, which is the case only the numeric guard can win:
    // REPLACE's start/count sit BETWEEN its two text arguments, so a NUMERIC
    // slot is the left-most error here. Without `arg_or_err!` this answered
    // `#VALUE!` — a real failure attributed to the wrong argument, sending the
    // user to inspect REPLACE instead of the division upstream.
    assert_eq!(
        eval("=REPLACE(\"abc\",1/0,1,NA())"),
        EvalResult::Error(CellError::Div0),
        "the left-most error is REPLACE's NUMERIC start argument"
    );
    assert_eq!(eval("=REPLACE(\"abc\",1,1/0,NA())"), EvalResult::Error(CellError::Div0));
}

/// AN ERROR REACHED THROUGH A REFERENCE, which is how this actually happens.
///
/// Every case above types the division into the formula. A stored error takes
/// a different route into the evaluator (the cell's VALUE, not a computed
/// result), and it is the route a real workbook uses: the `#DIV/0!` is in the
/// data, and the text formula is the innocent-looking cell three columns over.
#[test]
fn a_stored_error_reached_through_a_reference_propagates_the_same_way() {
    let g = grid_with_stored_error();
    for formula in ["=LEN(J1)", "=UPPER(J1)", "=LEFT(J1,2)", "=CONCAT(J1)", "=J1&\"x\""] {
        assert_eq!(
            eval_on(&g, formula),
            EvalResult::Error(CellError::Div0),
            "{formula} over a STORED error did not propagate"
        );
    }
    // THE CONTROL: the same formulas over ordinary data still compute. Without
    // this the test above is satisfied by a function that refuses everything.
    let mut ok = Grid::new();
    ok.set_cell(0, 9, Cell::new_text("abc".to_string()));
    assert_eq!(eval_on(&ok, "=LEN(J1)"), EvalResult::Number(3.0));
    assert_eq!(eval_on(&ok, "=UPPER(J1)"), EvalResult::Text("ABC".to_string()));
    assert_eq!(eval_on(&ok, "=LEFT(J1,2)"), EvalResult::Text("ab".to_string()));
}

/// AN ERROR *INSIDE* A JOINED RANGE, which neither guard above can catch: a
/// range argument evaluates to an `Array`, never to an `Error`, so a check on
/// the argument itself sails straight past it.
///
/// This was the worst of the set because the two collectors failed DIFFERENTLY
/// on the same data. TEXTJOIN's value branch carried `EvalResult::Error(_) =>
/// {}` — "skip errors in TEXTJOIN" — so the error VANISHED and the joined text
/// came back one field short, silently renumbering every position after it.
/// CONCAT's range branch pushed `e.as_literal()`, so the string "#DIV/0!"
/// appeared glued between two real fields as though the user had typed it.
#[test]
fn an_error_cell_inside_a_joined_range_propagates() {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_text("a".to_string()));
    let mut bad = Cell::new();
    bad.value = CellValue::Error(CellError::Div0);
    g.set_cell(1, 0, bad);
    g.set_cell(2, 0, Cell::new_text("c".to_string()));

    assert_eq!(
        eval_on(&g, "=TEXTJOIN(\",\",TRUE,A1:A3)"),
        EvalResult::Error(CellError::Div0),
        "TEXTJOIN dropped the error cell and returned a short join"
    );
    assert_eq!(
        eval_on(&g, "=CONCAT(A1:A3)"),
        EvalResult::Error(CellError::Div0),
        "CONCAT glued the error's literal spelling into the result"
    );

    // THE CONTROL, and it is what stops the fix from being "refuse every
    // range": the same shape without the error still joins, in both spellings
    // and in both orientations (the engine represents a ROW as an array of
    // arrays, which is how `=CONCAT({1,2,3})` once answered the empty string).
    let mut clean = Grid::new();
    clean.set_cell(0, 0, Cell::new_text("a".to_string()));
    clean.set_cell(1, 0, Cell::new_text("b".to_string()));
    clean.set_cell(2, 0, Cell::new_text("c".to_string()));
    assert_eq!(
        eval_on(&clean, "=TEXTJOIN(\",\",TRUE,A1:A3)"),
        EvalResult::Text("a,b,c".to_string())
    );
    assert_eq!(
        eval_on(&clean, "=CONCAT(A1:A3)"),
        EvalResult::Text("abc".to_string())
    );
}

// ===========================================================================
// THE EXEMPTIONS
// ===========================================================================

/// THE FUNCTIONS THAT EXIST TO INSPECT AN ERROR MUST KEEP RECEIVING ONE.
///
/// A propagating guard applied without thought turns every one of these into
/// the error it was asked to describe, and the damage is total: `IFERROR` is
/// the single most common way a spreadsheet handles a failure, and an `IFERROR`
/// that propagates is an `IFERROR` that does nothing at all. None of them
/// reaches `as_text`, so none needed changing — this test exists so that a
/// future "sweep the rest of the file" cannot quietly take them with it.
#[test]
fn the_error_inspectors_are_exempt_and_still_see_the_error() {
    assert_eq!(eval("=ISERROR(1/0)"), EvalResult::Boolean(true));
    assert_eq!(eval("=ISERR(1/0)"), EvalResult::Boolean(true));
    assert_eq!(eval("=ISERR(NA())"), EvalResult::Boolean(false)); // #N/A is the exception
    assert_eq!(eval("=ISNA(NA())"), EvalResult::Boolean(true));
    assert_eq!(eval("=ISNA(1/0)"), EvalResult::Boolean(false));
    assert_eq!(eval("=IFERROR(1/0,\"ok\")"), EvalResult::Text("ok".to_string()));
    assert_eq!(eval("=IFNA(NA(),\"ok\")"), EvalResult::Text("ok".to_string()));
    assert_eq!(eval("=ERROR.TYPE(1/0)"), EvalResult::Number(2.0));
    // N and TYPE are listed as exemptions because they are DOCUMENTED to look
    // at an error: TYPE answers 16 ("error value") and N passes an error
    // through unchanged rather than coercing it to 0.
    assert_eq!(eval("=TYPE(1/0)"), EvalResult::Number(16.0));
    assert_eq!(eval("=N(1/0)"), EvalResult::Error(CellError::Div0));
    // The IS* type predicates answer FALSE for an error rather than becoming
    // one — an error is not text and not a number.
    assert_eq!(eval("=ISTEXT(1/0)"), EvalResult::Boolean(false));
    assert_eq!(eval("=ISNUMBER(1/0)"), EvalResult::Boolean(false));
}

/// VALUETOTEXT AND ARRAYTOTEXT ARE THE FAMILY'S OTHER DELIBERATE EXEMPTION:
/// their documented job is to render whatever value they are given as text, an
/// error included, so they are the one place where an error's LITERAL is the
/// right answer rather than a laundered one.
///
/// AND VALUETOTEXT WAS STILL LEAKING A RUST IDENTIFIER. Round 1 removed
/// `format!("{:?}", e)` from `EvalResult::as_text`; VALUETOTEXT had its own
/// private copy of that spelling and was missed, so `=VALUETOTEXT(1/0)`
/// produced the text "Div0" and `=VALUETOTEXT(NA())` produced "NA" — Rust
/// enum variant names, on a cell, in a shipped product.
#[test]
fn valuetotext_renders_the_excel_literal_never_the_rust_variant_name() {
    assert_eq!(eval("=VALUETOTEXT(1/0)"), EvalResult::Text("#DIV/0!".to_string()));
    assert_eq!(eval("=VALUETOTEXT(NA())"), EvalResult::Text("#N/A".to_string()));
    // Not merely "not the variant name" — the exact Excel spelling, so a
    // half-fix producing "#Div0" would still fail.
    for bad in ["Div0", "NA", "Value", "Limit"] {
        assert_ne!(
            eval("=VALUETOTEXT(1/0)"),
            EvalResult::Text(bad.to_string()),
            "VALUETOTEXT rendered a Rust identifier"
        );
    }
    // ARRAYTOTEXT joins the same way, error cells included.
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(1.0));
    let mut bad = Cell::new();
    bad.value = CellValue::Error(CellError::Div0);
    g.set_cell(1, 0, bad);
    assert_eq!(
        eval_on(&g, "=ARRAYTOTEXT(A1:A2)"),
        EvalResult::Text("1, #DIV/0!".to_string())
    );
}

// ===========================================================================
// THE INVENTORY GUARD — so a NEW text function cannot forget
// ===========================================================================

/// EVERY `as_text` REACHED FROM A BUILTIN IS EITHER GUARDED OR NAMED HERE.
///
/// WHY A SOURCE SCAN RATHER THAN MORE CASES. The defect was structural: the
/// unguarded spelling `self.evaluate(&args[0]).as_text()` is shorter than the
/// guarded one, reads correctly, and compiles — so every new text builtin
/// reproduced it, and no behavioural test can cover a function that does not
/// exist yet. This reads `evaluator.rs` at test time and fails on a `fn_*` that
/// reaches `as_text` without appearing on the reasoned list below, which turns
/// the next omission into a BUILD FAILURE naming the function.
///
/// The direction is deliberate: adding a function to the list requires writing
/// down why, next to the others, where a reviewer will see it.
#[test]
fn every_text_argument_is_guarded_against_an_error() {
    /// Functions that legitimately reach `as_text` on a value that may be an
    /// error, each with the reason it is not a defect.
    const EXEMPT: &[(&str, &str)] = &[
        ("as_text", "the method itself — it renders the literal by design"),
        ("text_or_error", "the guard; it calls as_text on the non-error arm"),
        ("eval_concat", "`&` — apply_binary_values already returned on either operand being an error"),
        ("fn_concatenate", "guards each argument with an explicit `if let Error` before coercing"),
        ("fn_text", "guards BOTH arguments explicitly at the top of the function"),
        ("fn_valuetotext", "documented value renderer — the deliberate exemption, tested above"),
        ("fn_arraytotext", "same; renders an array's members INCLUDING error cells"),
        ("fn_get_control_value", "already returns on an Error before this arm is reachable"),
        // The lookup and criteria comparers. These do NOT coerce a user's
        // ARGUMENT — they compare values that are already inside an array, and
        // Excel's rule for an error INSIDE a lookup range is not the rule for
        // an error ARGUMENT (an exact-match MATCH still finds its target in a
        // range that contains one). Changing them is a lookup-semantics
        // decision, deliberately out of this change's scope.
        ("xlookup_compare", "compares two values already inside a lookup array"),
        ("matches_criteria", "criteria comparison over range members"),
        ("fn_match", "lookup value and array members, not a coerced text argument"),
        ("fn_xmatch", "same as fn_match"),
        ("match_cached", "the pass cache's mirror of fn_match's comparison"),
        ("resolve_database_args", "reads DB header cells for name matching"),
    ];

    let src = include_str!("evaluator.rs");
    let mut current = "<none>";
    let mut in_tests = false;
    let mut offenders: Vec<String> = Vec::new();
    // Which exemptions were actually needed. A name left on the list after its
    // call site is guarded (or deleted) is a HOLE: the guard would wave through
    // a future unguarded `as_text` in a function that no longer deserves the
    // pass, and nothing would say so. This project has shipped exactly that
    // shape before — a suppression list that outlived its bug and blinded the
    // walker for months.
    let mut used: Vec<&str> = Vec::new();
    for (idx, line) in src.lines().enumerate() {
        // `evaluator.rs` carries several `#[cfg(test)]` modules at column 0.
        // Everything inside one is an ASSERTION about `as_text`, not a call
        // from a builtin, and the assertions are the point (this file's own
        // `an_error_coerced_to_text_is_its_literal_not_a_rust_variant_name`
        // calls `as_text` deliberately).
        if line == "#[cfg(test)]" {
            in_tests = true;
        } else if in_tests && line == "}" {
            // A module's closing brace at column 0. Production code that
            // follows a test module is scanned again rather than skipped for
            // the rest of the file.
            in_tests = false;
            continue;
        }
        if in_tests {
            continue;
        }
        // Track the enclosing method: every one is declared at exactly four
        // spaces of indentation inside an `impl` block.
        let trimmed = line.trim_start();
        if line.len() - trimmed.len() == 4 {
            if let Some(rest) = trimmed
                .strip_prefix("fn ")
                .or_else(|| trimmed.strip_prefix("pub fn "))
            {
                current = rest.split(['(', '<']).next().unwrap_or("<none>");
            }
        }
        // Comments and doc comments talk ABOUT `as_text` constantly; only real
        // calls count.
        if trimmed.starts_with("//") || trimmed.starts_with("///") {
            continue;
        }
        if !line.contains(".as_text()") {
            continue;
        }
        // Tests below the `mod tests` line are assertions, not builtins.
        if current.starts_with("test_") {
            continue;
        }
        if EXEMPT.iter().any(|(name, _)| *name == current) {
            if !used.contains(&current) {
                used.push(current);
            }
            continue;
        }
        offenders.push(format!("{}:{} in {}", "evaluator.rs", idx + 1, current));
    }
    let dead: Vec<&str> = EXEMPT
        .iter()
        .map(|(name, _)| *name)
        .filter(|name| !used.contains(name))
        .collect();
    assert!(
        dead.is_empty(),
        "these are exempted but no longer reach `as_text` — delete them from \
         EXEMPT, or the guard will wave through a future unguarded call in \
         them: {:?}",
        dead
    );
    assert!(
        offenders.is_empty(),
        "these reach `as_text` without propagating an error argument.\n\
         Use `text_arg!(self.evaluate(&args[n]))` instead — or, if the site is \
         genuinely meant to render an error as text, add it to EXEMPT above \
         WITH a reason:\n  {}",
        offenders.join("\n  ")
    );
}

/// A SELF-TEST FOR THE SCAN ABOVE, because an inventory test that matches
/// nothing passes just as loudly as one that matches everything. It confirms
/// the scanner actually finds `as_text` call sites and actually attributes them
/// to the enclosing function — the two ways it could silently become a no-op.
#[test]
fn the_inventory_scan_is_actually_looking_at_something() {
    let src = include_str!("evaluator.rs");
    let calls = src
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            !t.starts_with("//") && l.contains(".as_text()")
        })
        .count();
    assert!(
        calls >= 15,
        "the scan found only {calls} `as_text` call sites; it has stopped seeing \
         the file (a rename, or a comment-stripping rule that ate everything)"
    );
    // And the enclosing-function tracker must resolve at least one KNOWN name,
    // or every offender would be attributed to "<none>" and the exemption list
    // would match nothing.
    assert!(
        src.contains("    pub fn as_text(&self) -> String {"),
        "the four-space `fn` declaration shape the scanner relies on has changed"
    );
}

// ===========================================================================
// THE 32,767-CHARACTER CEILING COUNTS CHARACTERS
// ===========================================================================

/// EXCEL'S CELL LIMIT IS 32,767 CHARACTERS, AND IT USED TO BE MEASURED IN BYTES.
///
/// TEXTJOIN's guard summed `p.len()`, which in Rust is a BYTE count. On this
/// Swedish-default product every å/ä/ö counts twice and every CJK character
/// three times, so a result Excel accepts was refused with `#VALUE!` — and the
/// threshold moved with the DATA rather than with its length, so the same
/// formula worked on one column and failed on the next.
///
/// This is round 1's own regression: that pass was chartered on byte-vs-
/// character and introduced the byte count in the very function it renamed the
/// constant for.
#[test]
fn the_cell_text_ceiling_counts_characters_not_bytes() {
    use crate::budget::MAX_CELL_TEXT_LEN;

    // 20,000 two-byte characters: 40,000 BYTES, 20,000 CHARACTERS. Comfortably
    // under Excel's ceiling, and refused outright before the fix.
    let mut swedish = Grid::new();
    swedish.set_cell(0, 0, Cell::new_text("ä".repeat(20_000)));
    match eval_on(&swedish, "=TEXTJOIN(\",\",TRUE,A1:A1)") {
        EvalResult::Text(t) => assert_eq!(t.chars().count(), 20_000),
        other => panic!("20,000 Swedish characters were refused: {:?}", other),
    }

    // 20,000 three-byte characters: 60,000 bytes — nearly TWICE the ceiling by
    // the old measure, so a fix that merely relaxed the constant would fail.
    let mut cjk = Grid::new();
    cjk.set_cell(0, 0, Cell::new_text("字".repeat(20_000)));
    match eval_on(&cjk, "=TEXTJOIN(\",\",TRUE,A1:A1)") {
        EvalResult::Text(t) => assert_eq!(t.chars().count(), 20_000),
        other => panic!("20,000 CJK characters were refused: {:?}", other),
    }

    // THE CEILING IS STILL A CEILING — the control that stops "count
    // characters" from becoming "count nothing". One character over, in
    // multi-byte text, is still `#VALUE!`.
    let mut over = Grid::new();
    over.set_cell(0, 0, Cell::new_text("ä".repeat(MAX_CELL_TEXT_LEN as usize + 1)));
    assert_eq!(
        eval_on(&over, "=TEXTJOIN(\",\",TRUE,A1:A1)"),
        EvalResult::Error(CellError::Value)
    );

    // ...and exactly AT the ceiling is allowed, in multi-byte text. Both sides
    // of the boundary, because an off-by-one is the only remaining way to be
    // wrong here.
    let mut at = Grid::new();
    at.set_cell(0, 0, Cell::new_text("ä".repeat(MAX_CELL_TEXT_LEN as usize)));
    match eval_on(&at, "=TEXTJOIN(\",\",TRUE,A1:A1)") {
        EvalResult::Text(t) => assert_eq!(t.chars().count() as u64, MAX_CELL_TEXT_LEN),
        other => panic!("a result exactly at the ceiling must be allowed, got {:?}", other),
    }

    // THE DELIMITERS ARE COUNTED IN CHARACTERS TOO, not just the parts. A
    // two-character multi-byte delimiter across many cells is enough to push a
    // result over on its own, and counting its BYTES would refuse a result that
    // fits.
    let mut many = Grid::new();
    for r in 0..1_000u32 {
        many.set_cell(r, 0, Cell::new_text("ä".to_string()));
    }
    match eval_on(&many, "=TEXTJOIN(\"åä\",TRUE,A1:A1000)") {
        // 1000 parts + 999 x 2 delimiter characters = 2,998 characters.
        EvalResult::Text(t) => assert_eq!(t.chars().count(), 1_000 + 999 * 2),
        other => panic!("a 2,998-character join was refused: {:?}", other),
    }
}

/// THE ALLOCATION GUARD IS A DIFFERENT THING AND STAYS IN BYTES.
///
/// `MAX_TEXT_LEN` (1 MiB, `#LIMIT!`) exists to stop a single `String`
/// allocation from taking the process — REPT, CONCAT, CONCATENATE and `&`.
/// BYTES are the correct unit for it, because bytes are what the allocator
/// hands out; "characters" would under-count a CJK string threefold and let
/// through 3 MiB. The two ceilings must not be tidied into one.
#[test]
fn the_allocation_guard_stays_in_bytes_on_purpose() {
    use crate::budget::{MAX_CELL_TEXT_LEN, MAX_TEXT_LEN};
    assert_eq!(MAX_CELL_TEXT_LEN, 32_767, "Excel's cell limit is a parity fact");
    assert!(MAX_TEXT_LEN as u64 > MAX_CELL_TEXT_LEN);

    // REPT of a three-byte character, sized so the CHARACTER count is far under
    // the 1 MiB constant but the BYTE count is over it. It must still be
    // refused: this is the memory axis, not the parity axis.
    assert_eq!(
        eval("=REPT(\"字\",400000)"),
        EvalResult::Error(CellError::Limit),
        "the allocation guard must measure BYTES — 400,000 CJK characters is 1.2 MiB"
    );
    // The control: the same count of ASCII characters is 400 KB and computes.
    match eval("=REPT(\"x\",400000)") {
        EvalResult::Text(t) => assert_eq!(t.len(), 400_000),
        other => panic!("400 KB is under the allocation cap, got {:?}", other),
    }
}

// ===========================================================================
// A KNOWN, DATED DIVERGENCE FROM EXCEL — recorded, not fixed
// ===========================================================================

/// LEN COUNTS UNICODE SCALAR VALUES; EXCEL COUNTS UTF-16 CODE UNITS.
///
/// # This test pins a DIVERGENCE. It is not describing correct behaviour.
///
/// Dated 2026-08-24. They agree on everything in the Basic Multilingual Plane —
/// every Latin, Cyrillic, Greek, Hebrew, Arabic, Han, Hiragana and Katakana
/// character, which is to say all ordinary text in every language Calcula
/// ships for. They disagree on ASTRAL characters (U+10000 and above): emoji,
/// historic scripts, some rare CJK extensions, and mathematical alphanumerics.
///
///     =LEN("(emoji)")   Calcula: 1     Excel: 2
///
/// Excel's answer is 2 because its strings are UTF-16 and an astral character
/// occupies a surrogate PAIR. Calcula's answer is 1 because Rust's `chars()`
/// yields scalar values. One emoji is one thing a user can see and delete, so
/// Calcula's answer is arguably the better one — and it is SELF-CONSISTENT,
/// which matters more: LEN, LEFT, RIGHT, MID, FIND and REPLACE all count the
/// same units here, so `=LEFT(A1, LEN(A1)-1)` removes exactly one visible
/// character. Excel's own family is self-consistent in ITS units.
///
/// # Why it is not being changed in this batch
///
/// This project's standing rule is that Excel parity takes priority. Changing
/// it is nonetheless deferred DELIBERATELY, because the change is not local:
///
///   * every text builtin that counts or slices would have to move to UTF-16
///     code units together — LEN, LEFT, RIGHT, MID, FIND, SEARCH, REPLACE,
///     SUBSTITUTE's instance counting, TEXTBEFORE/TEXTAFTER, and CODE/UNICODE's
///     boundary handling. Moving them one at a time is strictly worse than
///     either endpoint: the two halves of `=LEFT(A1, FIND("x",A1)-1)` would
///     disagree and produce a wrong STRING rather than a wrong number.
///   * `LEFT`/`MID` would have to be able to split a surrogate pair, which
///     Rust's `String` cannot represent at all, so the engine would need its
///     own UTF-16-indexed string type or a lossy re-encode at every boundary.
///   * round 1 has just made the whole family consistently scalar-based, so
///     the divergence is currently in its most defensible state.
///
/// The decision this test records is therefore: KNOWN, ACCEPTED FOR NOW, and
/// costed. A future reader who measures `=LEN("(emoji)")` at 1 finds this
/// instead of filing it as a bug.
#[test]
fn len_counts_scalar_values_a_known_divergence_from_excels_utf16_units() {
    // U+1F600 GRINNING FACE — one scalar value, two UTF-16 code units.
    assert_eq!(
        eval("=LEN(\"\u{1F600}\")"),
        EvalResult::Number(1.0),
        "Calcula counts scalar values; Excel answers 2 here. See this test's header."
    );
    assert_eq!(eval("=LEN(\"a\u{1F600}b\")"), EvalResult::Number(3.0)); // Excel: 4

    // THE AGREEMENT, and it is the larger half of the story: every non-astral
    // character counts the same in both, including the ones Calcula's own
    // locale is full of. A reader must not come away thinking LEN is generally
    // unreliable.
    assert_eq!(eval("=LEN(\"åäö\")"), EvalResult::Number(3.0));
    assert_eq!(eval("=LEN(\"日本語\")"), EvalResult::Number(3.0));
    assert_eq!(eval("=LEN(\"Ω≈ç√\")"), EvalResult::Number(4.0));

    // SELF-CONSISTENCY is the property being preserved by NOT changing this,
    // so it is asserted rather than described: the slicing functions count the
    // same units LEN does, in the same string.
    assert_eq!(eval("=LEFT(\"\u{1F600}x\",1)"), EvalResult::Text("\u{1F600}".to_string()));
    assert_eq!(eval("=RIGHT(\"x\u{1F600}\",1)"), EvalResult::Text("\u{1F600}".to_string()));
    assert_eq!(eval("=MID(\"a\u{1F600}b\",2,1)"), EvalResult::Text("\u{1F600}".to_string()));
    // The composition users actually write: drop the last character.
    assert_eq!(
        eval("=LEFT(\"ab\u{1F600}\",LEN(\"ab\u{1F600}\")-1)"),
        EvalResult::Text("ab".to_string()),
        "LEN and LEFT must agree about what one character is, whatever unit they use"
    );
}
