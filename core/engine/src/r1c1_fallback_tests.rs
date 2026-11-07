//! FILENAME: core/engine/src/r1c1_fallback_tests.rs
//! PURPOSE: Excel's R1C1 FALLBACK. A formula that DECLARES a cell-shaped
//! LET name or LAMBDA parameter (`A1`, `E5`, `XFD1048576`) cannot be read in A1
//! notation, so Excel reads the WHOLE formula in R1C1 notation: the declared
//! names are names, every other plain cell spelling is a NAME too (and, no
//! such name existing, #NAME?), and an R1C1 spelling (`R1C4`, `C4`, `R1`,
//! `RC4`) is the reference it means.
//!
//! [LIVE] Excel 16, lane legacystats 2026-11-05 (SCRATCH/legacystats/p2.json):
//! a fresh workbook, D1 = 10, D2 = 20, D3:D120 = 1000 + row, each formula typed
//! (`Formula2`) into column J of the row given, `Value2` read back:
//!
//!   J2  =LAMBDA(A1,A1)(B1)              #NAME?   (Calcula: B1's value)
//!   J4  =LAMBDA(A1,A1)(3)               3
//!   J5  =LET(A1,5,A1+1)                 6
//!   J6  =LET(A1,5,D1+1)                 #NAME?   (D1 is a name in R1C1)
//!   J7  =LET(A1,5,A1+D1)                #NAME?
//!   J9  =LAMBDA(E5,E5*2)(4)             8
//!   J10 =LET(E5,E5+1,E5)                #NAME?   (E5 is not yet bound in its own value)
//!   J11 =LET(XFD1048576,1,XFD1048576+1) 2
//!   J12 =LET(a1,5,a1+1)                 6
//!   J13 =LET(A1,5,R1C4)                 10       (R1C4 is D1)
//!   J14 =LET(A1,5,A1+R1C4)              15
//!   J17 =LET(A1,5,SUM(R1C4:R2C4))       30
//!   J18 =LET(A1,5,SUM(D1:D2))           #NAME?
//!   J20 =LET(A1,5,A1)+D1                #NAME?   (the WHOLE formula, not the LET's scope)
//!   J21 =LET(x,5,x+D1)                  15       (nothing cell-shaped declared: A1 notation)
//!   J22 =LET(A1,5,LAMBDA(y,y+A1)(1))    6
//!   J24 =LET(A1,5,INDIRECT("D1"))       10       (a text reference is still A1)
//!   J27 =LET(A1,5,RC4)                  1027     (this row, column 4)
//!   J29 =LAMBDA(A1,B2,A1+B2)(1,2)       3
//!   J33 =MAP(D1:D2,LAMBDA(A1,A1*2))     #NAME?
//!   J34 =LET(A1,5,SUM(C4))              125287   (C4 is column D)
//!   J37 =LET(A1,5,D:D)                  #NAME?   (D:D is two names)
//!   J40 =LET(A1,5,A1:A2)                #NAME?
//!   J41 =LET(A1,5,ISREF(D1))            FALSE
//!   J42 =LET(A1,5,IFERROR(D1,"err"))    "err"
//!   J44 =LET(A1,5,ERROR.TYPE(D1))       5
//!   J47 =LAMBDA(x,LET(A1,x,A1*D1))(2)   #NAME?
//!   J48 =LET(A1,5,R1C4+RC4)             1058
//!   J49 =LET(A1,5,D1)                   #NAME?
//!   J50 =LET(zz1,5,zz1+1)               6        (ZZ1 is a cell: column ZZ)
//!   J51 =LET(AAAA1,5,AAAA1+1)           6        (AAAA1 is no cell: a plain name)
//!
//! Refused at ENTRY [LIVE]: `=LAMBDA(R2,R2)(3)` (R2 is a reference in R1C1, so
//! no name), `=LET(A1,5,$D$1)` and `=LET(A1,5,1:1)` (no A1 spelling of these
//! in R1C1).

use crate::cell::{Cell, CellError};
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;
use crate::locale::LocaleSettings;

fn sheet() -> Grid {
    let mut grid = Grid::new();
    grid.set_cell(0, 3, Cell::new_number(10.0));
    grid.set_cell(1, 3, Cell::new_number(20.0));
    for row in 3..=120u32 {
        grid.set_cell(row - 1, 3, Cell::new_number(1000.0 + f64::from(row)));
    }
    grid.set_cell(0, 1, Cell::new_number(7.0));
    grid
}

/// The formula as the host takes it from the formula bar into J<row>: typed
/// (`typed_entry`), then R1C1 names resolved against the entry cell. `None`
/// when the entry is refused (kept as text).
fn entered(formula: &str, row: u32) -> Option<Cell> {
    let mut cell = crate::typed_entry::parse_cell_input(formula, &LocaleSettings::from_locale_id("en-US"));
    let mut ast = cell.get_ast()?.clone();
    parser::resolve_r1c1_names(&mut ast, row - 1, 9, &|_| false);
    cell = Cell::new_formula_with_ast(ast);
    Some(cell)
}

/// What the cell shows: a one-element array is its element (MAP over the
/// #NAME? of a range of names answers `{#NAME?}`, which the cell shows as
/// Excel's #NAME?).
fn value_of(cell: &Cell) -> EvalResult {
    let grid = sheet();
    match Evaluator::new(&grid).evaluate(cell.get_ast().expect("a formula")) {
        EvalResult::Array(items) if items.len() == 1 => match items.into_iter().next().unwrap() {
            EvalResult::Array(inner) if inner.len() == 1 => inner.into_iter().next().unwrap(),
            single => single,
        },
        other => other,
    }
}

/// Typed, then STORED and LOADED again (the text `.cala` keeps, re-parsed),
/// both evaluations Excel's value.
fn check(formula: &str, row: u32, excel: EvalResult, wrong: &mut Vec<String>) {
    let Some(cell) = entered(formula, row) else {
        wrong.push(format!("  J{row} {formula}: refused at entry; Excel accepts it ({excel:?})"));
        return;
    };
    let typed = value_of(&cell);
    if typed != excel {
        wrong.push(format!("  J{row} {formula}: Excel {excel:?}, Calcula {typed:?}"));
    }
    let stored = format!("={}", cell.formula_string().expect("a formula"));
    let loaded = value_of(&Cell::new_formula(stored.clone()));
    if loaded != excel {
        wrong.push(format!("  J{row} {formula}: stored as {stored}, which loads to {loaded:?}; Excel {excel:?}"));
    }
}

fn n(v: f64) -> EvalResult {
    EvalResult::Number(v)
}

fn name() -> EvalResult {
    EvalResult::Error(CellError::Name)
}

/// SABOTAGE (legacystats-r1c1): the parser's fallback pass skipped -- fails
/// at J2 and every row after it: the cell-shaped binder is a cell reference
/// no LET binds, so `=LAMBDA(A1,A1)(B1)` and `=LET(A1,5,A1+1)` are #VALUE!
/// (what Calcula answered before) for Excel's #NAME? and 6.
/// SABOTAGE (legacystats-r1c1ref): `RC<n>` no longer resolved -- fails at
/// J27 / J48. SABOTAGE (legacystats-namesrange): `NAME:NAME` a parse error
/// again -- fails at the `R1C4:R2C4` rows ("refused at entry"). SABOTAGE
/// (legacystats-halves): two R1C1 range halves left as names -- fails at
/// `=SUM(R1C4:R2C4)`.
#[test]
fn a_formula_declaring_a_cell_shaped_name_is_read_in_r1c1() {
    let mut wrong = Vec::new();
    for (row, formula, excel) in [
        (2, "=LAMBDA(A1,A1)(B1)", name()),
        (4, "=LAMBDA(A1,A1)(3)", n(3.0)),
        (5, "=LET(A1,5,A1+1)", n(6.0)),
        (6, "=LET(A1,5,D1+1)", name()),
        (7, "=LET(A1,5,A1+D1)", name()),
        (9, "=LAMBDA(E5,E5*2)(4)", n(8.0)),
        (10, "=LET(E5,E5+1,E5)", name()),
        (11, "=LET(XFD1048576,1,XFD1048576+1)", n(2.0)),
        (12, "=LET(a1,5,a1+1)", n(6.0)),
        (13, "=LET(A1,5,R1C4)", n(10.0)),
        (14, "=LET(A1,5,A1+R1C4)", n(15.0)),
        (18, "=LET(A1,5,SUM(D1:D2))", name()),
        (20, "=LET(A1,5,A1)+D1", name()),
        (21, "=LET(x,5,x+D1)", n(15.0)),
        (22, "=LET(A1,5,LAMBDA(y,y+A1)(1))", n(6.0)),
        (24, "=LET(A1,5,INDIRECT(\"D1\"))", n(10.0)),
        (27, "=LET(A1,5,RC4)", n(1027.0)),
        (29, "=LAMBDA(A1,B2,A1+B2)(1,2)", n(3.0)),
        (30, "=LET(A1,1,A1)", n(1.0)),
        (33, "=MAP(D1:D2,LAMBDA(A1,A1*2))", name()),
        (34, "=LET(A1,5,SUM(C4))", n(125287.0)),
        (37, "=LET(A1,5,D:D)", name()),
        (40, "=LET(A1,5,A1:A2)", name()),
        (41, "=LET(A1,5,ISREF(D1))", EvalResult::Boolean(false)),
        (42, "=LET(A1,5,IFERROR(D1,\"err\"))", EvalResult::Text("err".to_string())),
        (44, "=LET(A1,5,ERROR.TYPE(D1))", n(5.0)),
        (45, "=LET(A1,5,A1)", n(5.0)),
        (46, "=LET(B2,5,B2)", n(5.0)),
        (47, "=LAMBDA(x,LET(A1,x,A1*D1))(2)", name()),
        (48, "=LET(A1,5,R1C4+RC4)", n(1058.0)),
        (49, "=LET(A1,5,D1)", name()),
        (50, "=LET(zz1,5,zz1+1)", n(6.0)),
        (51, "=LET(AAAA1,5,AAAA1+1)", n(6.0)),
        // SCRATCH/legacystats/p4.json and p5.json (rows of their own probes).
        // Spills D1:D2 (Excel's J9 read 10 before the next row was typed).
        (9, "=LET(A1,5,R1C4:R2C4)", EvalResult::Array(vec![n(10.0), n(20.0)])),
        (10, "=LET(A1,5,SUM(R1C4,R2C4))", n(30.0)),
        (11, "=LET(A1,5,SUM(C4:C4))", n(125287.0)),
        (15, "=LET(A1,5,B1+1)", name()),
        (16, "=LET(A1,5,b1+1)", name()),
        (17, "=LET(A1,LAMBDA(x,x+1),A1(2))", n(3.0)),
        (21, "=LET(XFE1,5,XFE1)", n(5.0)),
        (2, "=SUM(R1C4:R2C4)", n(30.0)),
        (5, "=LET(A1,5,SUM(R1C4:R2C4))", n(30.0)),
        (6, "=LET(A1,5,SUM(C4:C5))", n(125287.0)),
        (8, "=LET(A1,5,SUM(R1C4:D2))", name()),
    ] {
        check(formula, row, excel, &mut wrong);
    }
    assert!(wrong.is_empty(), "NOT EXCEL'S R1C1 FALLBACK ({}):\n{}", wrong.len(), wrong.join("\n"));
}

/// [LIVE] Excel 16 refuses each of these when typed: a reference R1C1 has no
/// spelling for (`$D$1`, the row range `1:1`), and a cell-shaped name that is
/// itself an R1C1 reference (`R2` is row 2 in R1C1, so no name).
///
/// SABOTAGE (legacystats-r1c1refuse): the entry check skipped -- fails at the
/// first formula, stored as a formula.
#[test]
fn a_reference_r1c1_cannot_spell_is_refused_in_such_a_formula() {
    for formula in ["=LET(A1,5,$D$1)", "=LET(A1,5,1:1)", "=LAMBDA(R2,R2)(3)", "=LET(A1,5,A$1)", "=LET(A1,5,$A1)", "=LET(C3,1,C3)", "=LET(RC4,1,RC4)"] {
        assert!(entered(formula, 19).is_none(), "{formula} must be refused at entry, as Excel refuses it");
        // A workbook that already holds one still opens with it.
        assert!(Cell::new_formula(formula.to_string()).get_ast().is_some(), "{formula}: a stored one still loads");
    }
    // Without a cell-shaped declaration nothing changes.
    for formula in ["=LET(x,5,$D$1)", "=LET(x,5,SUM(1:1))", "=LAMBDA(x,x)(3)", "=LET(R1C,1,1)", "=LET(R1C1,5,R1C1)", "=LET(A1,5,R1C4)"] {
        assert!(entered(formula, 19).is_some(), "{formula} must be accepted");
    }
}

/// NEW-r1c1-leftovers (a), lane formc: a plain cell spelling behind a SHEET is
/// that sheet's NAME in a formula read in R1C1 -- [LIVE] Excel 16
/// (SCRATCH/formc/p1.json, p2.json) `=LET(A1,2,Sheet2!A1)` #NAME? with the
/// formula bar at `Sheet2!'A1'`, `='Sheet2'!A1` the same, the 3-D
/// `=LET(A1,2,SUM(Sheet1:Sheet2!A1))` #NAME?, `=LET(A1,2,Sheet2!A1+A1)`
/// #NAME?, `=LET(A1,2,ISREF(Sheet2!A1))` FALSE. Calcula read the cell.
#[test]
fn a_sheet_qualified_cell_spelling_is_that_sheets_name_in_r1c1() {
    let mut wrong = Vec::new();
    for (row, formula, excel) in [
        (231, "=LET(A1,2,Sheet2!A1)", name()),
        (233, "=LET(A1,2,'Sheet2'!A1)", name()),
        (232, "=LET(A1,2,SUM(Sheet1:Sheet2!A1))", name()),
        (80, "=LET(A1,2,Sheet2!A1+A1)", name()),
        (79, "=LET(A1,2,SUM(Sheet2!A1:A1))", name()),
        (234, "=LET(A1,2,SUM(Sheet2!D:D))", name()),
        (81, "=LET(A1,2,ISREF(Sheet2!A1))", EvalResult::Boolean(false)),
    ] {
        check(formula, row, excel, &mut wrong);
    }
    assert!(wrong.is_empty(), "NOT EXCEL'S R1C1 READING ({}):\n{}", wrong.len(), wrong.join("\n"));
    // The formula keeps its spelling (the lexer folds a bare sheet name; the
    // host restamps the workbook's casing) -- with the NAME quoted behind the
    // sheet, as Excel shows it (BUG-0739 [LIVE, lane formula p1.json:
    // `=LET(A1,2,Sheet2!'A1')`]; this asserted the bare spelling while a quote
    // after `!` did not parse back). The stored text stays bare.
    let cell = entered("=LET(A1,2,Sheet2!A1)", 231).expect("accepted");
    assert_eq!(cell.formula_string().as_deref(), Some("LET(A1,2,SHEET2!'A1')"));
    assert_eq!(cell.formula_string_raw().as_deref(), Some("LET(A1,2,SHEET2!A1)"));
}

/// NEW-r1c1-leftovers (c), lane formc: R1C1's RELATIVE references are read in
/// any formula, A1 mode included. [LIVE] Excel 16 (SCRATCH/formc/p2.json,
/// p3.json; D3:D120 = 1000 + row): `=RC[-6]*1` in J82 is stored `=D82*1`,
/// `=R[-1]C[-6]*1` in J83 `=D82*1`, `=SUM(C[-6])` `=SUM(D:D)`,
/// `=SUM(R[-1]C[-6]:R[1]C[-6])` in J86 `=SUM(D85:D87)`, `=SUM(C[-6]:C[-5])`
/// `=SUM(D:E)`, `=r[-1]c[-6]*1` in J99 `=D98*1`, `=LET(A1,5,R[-1]C4)` in J248
/// `=LET(A1,5,$D247)`, `=LET(A1,5,R1C[-6])` `=LET(A1,5,D$1)`,
/// `=LET(A1,5,SUM(R[-2]:R[-1]))` in J252 `=LET(A1,5,SUM(250:251))`; an offset
/// wraps round the sheet (`=ROW(R[-500]C)` in J444 1048520, `=COLUMN(RC[-20])`
/// in J446 16374). Calcula could not parse `R[-1]C4` at all and read `RC[-6]`
/// as a structured reference.
#[test]
fn r1c1_relative_offsets_are_read_in_any_formula() {
    let mut wrong = Vec::new();
    for (row, formula, shown, excel) in [
        (82, "=RC[-6]*1", "=D82*1", n(1082.0)),
        (83, "=R[-1]C[-6]*1", "=D82*1", n(1082.0)),
        (84, "=SUM(C[-6])", "=SUM(D:D)", n(125287.0)),
        (86, "=SUM(R[-1]C[-6]:R[1]C[-6])", "=SUM(D85:D87)", n(3258.0)),
        (87, "=SUM(C[-6]:C[-5])", "=SUM(D:E)", n(125287.0)),
        // [LIVE] formc p2.json J88 shows the binder as typed (lane formd).
        (88, "=LET(x,1,x+RC[-6])", "=LET(x,1,x+D88)", n(1089.0)),
        (99, "=r[-1]c[-6]*1", "=D98*1", n(1098.0)),
        (50, "=R[+1]C4*1", "=$D51*1", n(1051.0)),
        (50, "=LET(A1,5,R[-1]C4)", "=LET(A1,5,$D49)", n(1049.0)),
        (50, "=LET(A1,5,R[-1]C4+A1)", "=LET(A1,5,$D49+A1)", n(1054.0)),
        (245, "=LET(A1,5,R1C[-6])", "=LET(A1,5,D$1)", n(10.0)),
        (52, "=LET(A1,5,SUM(R[-2]:R[-1]))", "=LET(A1,5,SUM(50:51))", n(2101.0)),
        (444, "=ROW(R[-500]C)", "=ROW(J1048520)", n(1048520.0)),
        (446, "=COLUMN(RC[-20])", "=COLUMN(XET446)", n(16374.0)),
        (447, "=ROW(R[-1048575]C)", "=ROW(J448)", n(448.0)),
        (98, "=R0C1*1", "=R0C1*1", name()),
    ] {
        let Some(cell) = entered(formula, row) else {
            wrong.push(format!("  J{row} {formula}: refused at entry; Excel holds {shown}"));
            continue;
        };
        let bar = format!("={}", cell.formula_string().expect("a formula"));
        if bar != shown {
            wrong.push(format!("  J{row} {formula}: Calcula shows {bar}, Excel {shown}"));
        }
        let got = value_of(&cell);
        if got != excel {
            wrong.push(format!("  J{row} {formula}: Excel {excel:?}, Calcula {got:?}"));
        }
    }
    // The FULLY relative ones inside a formula read in R1C1 evaluate right at
    // entry (their A1 text reloading as a name is the open part of (b)).
    for (row, formula, excel) in [
        (102, "=LET(A1,5,LET(B1,1,B1+RC[-6]))", n(1103.0)),
        (103, "=LET(A1,5,LAMBDA(x,x+R[-1]C[-6])(1))", n(1103.0)),
        (40, "=LET(A1,5,A1+RC[-6])", n(1045.0)),
    ] {
        match entered(formula, row) {
            Some(cell) if value_of(&cell) == excel => {}
            Some(cell) => wrong.push(format!("  J{row} {formula}: Excel {excel:?}, Calcula {:?}", value_of(&cell))),
            None => wrong.push(format!("  J{row} {formula}: refused at entry")),
        }
    }
    assert!(wrong.is_empty(), "NOT EXCEL'S R1C1 OFFSETS ({}):\n{}", wrong.len(), wrong.join("\n"));
}

/// [LIVE] Excel 16 refuses these at entry (SCRATCH/formc/p2.json): an offset
/// no smaller than the sheet, a space or a fraction in the brackets, and an
/// offset whose head is a LET / LAMBDA name of the formula.
#[test]
fn an_r1c1_offset_excel_cannot_hold_is_refused_at_entry() {
    for formula in [
        "=R[-1048577]C*1",
        "=R[2147483647]C*1",
        "=RC[16384]*1",
        "=R[ -1]C*1",
        "=R[1.5]C*1",
        "=LET(c,5,c[1])",
        "=LET(rc,5,rc[-1])",
        "=LAMBDA(c,c[1])(5)",
        "=LET(R,5,R[-1]C4)",
    ] {
        assert!(entered(formula, 20).is_none(), "{formula} must be refused at entry, as Excel refuses it");
    }
}

/// BUG-0739: an R1C1-ONLY spelling (`RC`, `R[-1]C`, `R1C1`, `RC[-9]`) makes
/// Excel read the WHOLE formula in R1C1, where a plain cell spelling is a NAME
/// -- shown quoted, and #NAME? -- and `RC4` is R1C1's column 4 of this row.
/// [LIVE, Excel 16, lane formd p1.json / p2.json and lane formula p1.json,
/// typed into column J; the rows are re-based onto this file's sheet.]
/// Calcula read each plain cell as the cell it spells. The STORED text keeps
/// the names quoted, so the formula loads back the same.
/// SABOTAGE (formula-r1c1whole): the fallback not triggered by an R1C1-only
/// spelling -- fails at `=R[-1]C+D5` (D5's value, not #NAME?).
#[test]
fn an_r1c1_only_spelling_reads_the_whole_formula_in_r1c1() {
    let mut wrong = Vec::new();
    for (row, formula, shown, excel) in [
        (60, "=R[-1]C+D5", "=J59+'D5'", name()),
        (60, "=R1C1+D5", "=$A$1+'D5'", name()),
        (60, "=D5+R[-1]C", "='D5'+J59", name()),
        (60, "=SUM(R[-1]C:D5)", "=SUM(J59:'D5')", name()),
        (60, "=R[-1]C+A1:A2", "=J59+'A1':'A2'", name()),
        (60, "=SUM(R[-1]C,A1)", "=SUM(J59,'A1')", name()),
        (51, "=SUM(R[-1]C4:D5)", "=SUM($D50:'D5')", name()),
        (60, "=R[-1]C+Sheet2!D5", "=J59+SHEET2!'D5'", name()),
        // RC4 is the cell in column 4 of this row once the formula is R1C1.
        (50, "=RC[-9]+RC4", "=A50+$D50", n(1050.0)),
        // CONTROLS: no R1C1-only spelling, A1 as before -- `RC:RC` is the
        // column RC [LIVE `=SUM(RC:RC)` 0], a bound `C` the binding.
        (60, "=SUM(RC:RC)", "=SUM(RC:RC)", n(0.0)),
        (60, "=LET(c,5,c+C)", "=LET(c,5,c+c)", n(10.0)),
        (60, "=D5+1", "=D5+1", n(1006.0)),
    ] {
        let Some(cell) = entered(formula, row) else {
            wrong.push(format!("  J{row} {formula}: refused at entry; Excel holds {shown}"));
            continue;
        };
        let bar = format!("={}", cell.formula_string().expect("a formula"));
        if bar != shown {
            wrong.push(format!("  J{row} {formula}: Calcula shows {bar}, Excel {shown}"));
        }
        let got = value_of(&cell);
        if got != excel {
            wrong.push(format!("  J{row} {formula}: Excel {excel:?}, Calcula {got:?}"));
        }
        // The text `.cala` stores loads back to the same value.
        let stored = format!("={}", cell.formula_string_raw().expect("a formula"));
        let loaded = value_of(&Cell::new_formula(stored.clone()));
        if loaded != excel {
            wrong.push(format!("  J{row} {formula}: stored as {stored}, which loads to {loaded:?}; Excel {excel:?}"));
        }
    }
    assert!(wrong.is_empty(), "NOT EXCEL'S WHOLE-FORMULA R1C1 READ ({}):\n{}", wrong.len(), wrong.join("\n"));
}

/// BUG-0739: such a formula cannot hold a `$` reference or a row range either
/// [LIVE, lane formd p2.json: `=R[-1]C+$D$5` and `=R[-1]C+SUM(1:1)` refused].
#[test]
fn an_r1c1_only_formula_refuses_what_r1c1_cannot_spell() {
    for formula in ["=R[-1]C+$D$5", "=R[-1]C+SUM(1:1)", "=RC+A$1"] {
        assert!(entered(formula, 20).is_none(), "{formula} must be refused at entry, as Excel refuses it");
    }
    // CONTROL: the same references without the R1C1 spelling are A1.
    assert!(entered("=D1+$D$5", 20).is_some());
}
