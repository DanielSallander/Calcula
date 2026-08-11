//! FILENAME: app/src-tauri/src/error_display_tests.rs
//! PURPOSE: Pin the app-side error spelling against the engine's canonical one.
//!
//! CONTEXT: `cell_error_display`'s doc comment claimed for a long time that it
//! mirrored `Cell::display_value` "exactly". It did not, and by the time anyone
//! checked, the engine had moved to an explicit `CellError::as_literal` table
//! with no `#{Debug}` fallback at all. Nothing caught the drift because nothing
//! compared the two. These tests were written to MEASURE the divergence so the
//! owner could decide on it; D7 decided — adopt Excel's literals — and they now
//! pin the agreement instead.
//!
//! WHAT THEY GUARD NOW:
//!   * every variant renders the same string on both sides (a re-introduced
//!     `#{Debug}` arm, or a new variant that forgets one of the two tables,
//!     fails here rather than in a golden three weeks later);
//!   * `Limit` / `Blocked` / `Conflict` / `NA` keep their exact literals, which
//!     is a frontend requirement, not a style preference — see below;
//!   * the literal a variant renders as is the literal `from_literal` reads
//!     back, i.e. every variant survives a save/reload.

use engine::{Cell, CellError, CellValue};

/// Every `CellError` variant, with the ONE spelling both sides must produce.
///
/// The Excel five are Excel's literals character for character — Excel is the
/// project's tiebreaker, and it spells them `#DIV/0!`, `#REF!`, `#NAME?`,
/// `#VALUE!`, `#N/A`. (`#NULL!` and `#NUM!` are Excel errors with no engine
/// variant; they are deliberately NOT aliased onto one that exists.)
///
/// The Calcula four have no Excel counterpart, so Excel cannot settle their
/// spelling — but it settles their SHAPE, "#WORD" plus terminal punctuation,
/// which is why `#CONFLICT` became `#CONFLICT!`.
const SPELLINGS: &[(CellError, &str)] = &[
    // -- Excel's own, exactly as Excel spells them -------------------------
    (CellError::Div0, "#DIV/0!"),
    (CellError::Ref, "#REF!"),
    (CellError::Name, "#NAME?"),
    (CellError::Value, "#VALUE!"),
    (CellError::NA, "#N/A"),
    (CellError::Null, "#NULL!"),
    (CellError::Num, "#NUM!"),
    (CellError::Spill, "#SPILL!"),
    // -- Calcula-only states, following Excel's punctuation ----------------
    (CellError::Circular, "#CIRCULAR!"),
    (CellError::Conflict, "#CONFLICT!"),
    (CellError::Blocked, "#BLOCKED!"),
    (CellError::Limit, "#LIMIT!"),
];

fn engine_display(e: &CellError) -> String {
    let mut cell = Cell::new();
    cell.value = CellValue::Error(e.clone());
    cell.display_value()
}

#[test]
fn the_app_and_the_engine_spell_every_error_the_same_way() {
    let mut wrong: Vec<String> = Vec::new();
    for (variant, expected) in SPELLINGS {
        let app_actual = crate::cell_error_display(variant);
        let engine_actual = engine_display(variant);
        let literal = variant.as_literal();
        if app_actual != *expected {
            wrong.push(format!(
                "{:?}: cell_error_display renders {:?}, this table says {:?}",
                variant, app_actual, expected
            ));
        }
        if engine_actual != *expected {
            wrong.push(format!(
                "{:?}: Cell::display_value renders {:?}, this table says {:?}",
                variant, engine_actual, expected
            ));
        }
        if literal != *expected {
            wrong.push(format!(
                "{:?}: CellError::as_literal is {:?}, this table says {:?}",
                variant, literal, expected
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "the canonical error spellings have moved:\n  {}\n\nThere is ONE \
         authority — CellError::as_literal in core/engine/src/cell.rs. If a \
         spelling genuinely changes, change it THERE, update this table, and \
         re-record the grid goldens that paint an error cell.",
        wrong.join("\n  ")
    );
}

#[test]
fn every_error_literal_survives_a_save_and_reload() {
    // `as_literal` is what the `.cala` / `.calp` writers persist and
    // `from_literal` is what reads it back, so a spelling that is not in BOTH
    // tables silently becomes a different error on reload. `#CONFLICT!` is the
    // one D7 moved, and it is exactly the shape of change that breaks this.
    for (variant, literal) in SPELLINGS {
        assert_eq!(
            CellError::from_literal(literal),
            *variant,
            "{:?} renders as {} but that literal reads back as {:?} — a cell \
             holding this error would change meaning on reload",
            variant,
            literal,
            CellError::from_literal(literal)
        );
    }
}

#[test]
fn the_four_the_frontend_would_collapse_keep_their_exact_literal() {
    // `Limit`, `Blocked`, `Conflict` and `NA` are load-bearing on the frontend:
    // `normalizeCellErrorLiteral` (app/src/api/formulaFunctions.ts) collapses
    // ANY literal it does not recognise into "#VALUE!", which would erase
    // exactly the distinction these variants exist to draw — `#LIMIT!` in
    // particular means "the number you are looking at was never computed".
    //
    // The old `#{Debug}` fallback would have dropped their punctuation
    // ("#LIMIT", "#CONFLICT"); it is gone, but the REQUIREMENT outlives the
    // implementation, so it is still pinned by name. Anything added to
    // CELL_ERROR_LITERALS on the frontend must match these strings byte for
    // byte.
    for (variant, literal) in [
        (CellError::Limit, "#LIMIT!"),
        (CellError::Blocked, "#BLOCKED!"),
        (CellError::NA, "#N/A"),
        (CellError::Conflict, "#CONFLICT!"),
        (CellError::Num, "#NUM!"),
        (CellError::Null, "#NULL!"),
        (CellError::Spill, "#SPILL!"),
    ] {
        assert_eq!(
            crate::cell_error_display(&variant),
            literal,
            "{:?} must render as {} — the frontend's normalizeCellErrorLiteral \
             collapses anything else to #VALUE!",
            variant,
            literal
        );
    }
}

#[test]
fn every_variant_is_accounted_for() {
    // THIS TEST USED TO LIE, and it is worth saying how, because the shape is
    // the reusable mistake. It compared SPELLINGS against a HAND-WRITTEN `all`
    // array in this same file, so "a new CellError that nobody adds here is a
    // new spelling nobody checked" held only for someone who added the variant
    // to `all`. `CellError::Null` and `CellError::Num` were added to the engine
    // for the .xlsx reader and appeared in NEITHER list, so both stayed the
    // same size and the assertion passed while two variants went unchecked --
    // a census that enumerates a copy of the thing rather than the thing.
    //
    // It now reads `cell.rs` at test time, exactly as the frontend's
    // `type-guards-exhaustive` drift guard does, so a variant can only escape
    // it by not existing.
    let cell_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../core/engine/src/cell.rs"),
    )
    .expect("core/engine/src/cell.rs is readable from the app crate");
    let start = cell_rs
        .find("pub fn as_literal")
        .expect("as_literal not found in core/engine/src/cell.rs");
    let body = &cell_rs[start..cell_rs[start..].find("
    }").unwrap() + start];

    let mut variants: Vec<String> = Vec::new();
    for line in body.lines() {
        let line = line.trim();
        if line.starts_with("//") {
            continue;
        }
        let Some(rest) = line.strip_prefix("CellError::") else {
            continue;
        };
        let Some((name, _)) = rest.split_once(" =>") else {
            continue;
        };
        if !name.chars().all(|c| c.is_ascii_alphanumeric()) {
            continue;
        }
        variants.push(name.to_string());
    }
    variants.sort();
    variants.dedup();
    assert!(
        variants.len() > 5,
        "parsed {} variants out of CellError::as_literal -- the Rust shape          changed and this census is reading nothing",
        variants.len()
    );

    let covered: Vec<String> = SPELLINGS
        .iter()
        .map(|(v, _)| format!("{:?}", v))
        .collect();
    let missing: Vec<&String> = variants.iter().filter(|v| !covered.contains(v)).collect();
    assert!(
        missing.is_empty(),
        "core/engine/src/cell.rs can put these errors in a cell and SPELLINGS          does not cover them: {:?}. Decide each one's literal (Excel's, if          Excel has one) and add a row",
        missing
    );
    assert_eq!(
        SPELLINGS.len(),
        variants.len(),
        "SPELLINGS has {} rows for {} CellError variants -- a row names a          variant that no longer exists",
        SPELLINGS.len(),
        variants.len()
    );
}

#[test]
fn no_literal_is_the_rust_variant_name() {
    // The defect this file exists for, stated directly: `#PARSE` reached the
    // grid because a `format!("#{:?}", e)` arm turned an internal enum name
    // into user-visible text. `CellError::Parse` has since been deleted (it was
    // never constructed: `Cell::new_formula` stores an unparseable formula as
    // TEXT, and the evaluate-formula surfaces answer `#SYNTAX!`), but the arm
    // is the reusable mistake, not the variant.
    for (variant, literal) in SPELLINGS {
        let debug_spelling = format!("#{:?}", variant).to_uppercase();
        assert_ne!(
            *literal, debug_spelling,
            "{:?} renders as {} — which is just its Rust variant name. That is \
             a `#{{Debug}}` arm, not a decision: give it a real literal.",
            variant, literal
        );
    }
}
