//! FILENAME: core/identity/src/defined_name_case.rs
//! PURPOSE: When two DEFINED NAMES are the same name -- Excel's rule, measured
//!          live -- and the lookup key every defined-name map is built from.
//!
//! IT IS NOT THE SHEET-NAME RULE. Excel compares sheet names character by
//! character (`sheet_name_case`: `Straße` and `STRASSE` are two sheets), but it
//! compares defined names linguistically and WITHOUT the equal-length gate, so a
//! ligature equals its letters [LIVE, Excel 16, 2026-10-30, sv-SE regional
//! settings, fresh workbook, `Names.Add` of the second spelling REPLACES the
//! first and `Names.Count` stays 1; a cell `=STRASSE` evaluates to the name
//! defined as `Straße` and Excel rewrites it to `=Straße`]:
//!
//!   * ONE NAME: `Straße` / `STRASSE` / `STRAẞE` / `straße`, `qæ` / `qae`,
//!     `qœ` / `qoe`, `qĳ` / `qij`, `qǆ` / `qdž`, `qﬁ` / `qfi`, `qﬀ` / `qff`,
//!     `qþ` / `qth`, and every row of [`EXCEL_DEFINED_NAME_EXPANSIONS`] against
//!     its letters (59 pairs, all one name). Plus every case pair the sheet-name
//!     table folds (`Ärende` / `ärende`, `qς` / `qΣ`, `qǄ` / `qǆ`, the Kelvin
//!     sign, full-width `Ａ` / `ａ`).
//!   * TWO NAMES: `qi` / `qİ`, `qı` / `qI`, `qµ` / `qμ`, `qſ` / `qs`, the
//!     Angstrom sign / `qå`, `qŉ` / `qʼn`, `qaa` / `qå`, `qae` / `qä` -- the same
//!     answers as the sheet-name table.
//!
//! The comparison is `CompareStringEx(sv-SE, NORM_IGNORECASE)` (it agreed with
//! Excel on all 27 mixed pairs above), and the expansion table below is every BMP
//! letter whose sort key equals that of a string of two or three ASCII letters
//! (a scan of all 18,278 candidates), each row then confirmed in Excel. LET and
//! LAMBDA parameter names do NOT follow it: `=LET(straße,5,STRAẞE)` is 5 but
//! `=LET(straße,5,STRASSE)` is #NAME? [LIVE] -- a LET name is compared by the
//! lexer's per-character fold.
//!
//! WHAT IS DELIBERATELY LEFT OUT, as in `sheet_name_case`: one-to-one
//! equalities that are not case (a modifier letter `ᴬ` against `A`, a kana
//! repeat mark against `q`) and canonical-equivalence (a combining accent against
//! the precomposed letter, which Excel also treats as one name). Those are
//! sort-table artefacts of the user's LOCALE, and a document's name lookups must
//! not change with the machine that opens it.

use crate::sheet_name_case::fold_sheet_name_char;

/// `(character, its letters)` for every letter Excel's defined-name comparison
/// treats as equal to a string of letters, sorted by character. The letters are
/// already folded (uppercase), so a key is built by pushing them as they are.
/// Generated from the scan and live probe in the module note; do not edit by
/// hand -- a row added here is a pair of names Excel was never asked about.
pub static EXCEL_DEFINED_NAME_EXPANSIONS: [(char, &str); 59] = [
    ('\u{C6}', "AE"), ('\u{DE}', "TH"), ('\u{DF}', "SS"), ('\u{E6}', "AE"), ('\u{FE}', "TH"),
    ('\u{132}', "IJ"), ('\u{133}', "IJ"), ('\u{152}', "OE"), ('\u{153}', "OE"),
    ('\u{1C4}', "D\u{17D}"), ('\u{1C5}', "D\u{17D}"), ('\u{1C6}', "D\u{17D}"),
    ('\u{1C7}', "LJ"), ('\u{1C8}', "LJ"), ('\u{1C9}', "LJ"),
    ('\u{1CA}', "NJ"), ('\u{1CB}', "NJ"), ('\u{1CC}', "NJ"),
    ('\u{1F1}', "DZ"), ('\u{1F2}', "DZ"), ('\u{1F3}', "DZ"),
    ('\u{238}', "DB"), ('\u{239}', "QP"), ('\u{2A9}', "FN"), ('\u{2AA}', "LS"), ('\u{2AB}', "LZ"),
    ('\u{1D01}', "AE"), ('\u{1D02}', "AE"), ('\u{1D2D}', "AE"), ('\u{1D46}', "AE"),
    ('\u{1E9E}', "SS"), ('\u{1EFA}', "LL"), ('\u{1EFB}', "LL"),
    ('\u{A732}', "AA"), ('\u{A733}', "AA"), ('\u{A734}', "AO"), ('\u{A735}', "AO"),
    ('\u{A736}', "AU"), ('\u{A737}', "AU"), ('\u{A738}', "AV"), ('\u{A739}', "AV"),
    ('\u{A73A}', "AV"), ('\u{A73B}', "AV"), ('\u{A73C}', "AY"), ('\u{A73D}', "AY"),
    ('\u{A74E}', "OO"), ('\u{A74F}', "OO"), ('\u{A760}', "VY"), ('\u{A761}', "VY"),
    ('\u{A764}', "TH"), ('\u{A765}', "TH"), ('\u{A766}', "TH"), ('\u{A767}', "TH"),
    ('\u{FB00}', "FF"), ('\u{FB01}', "FI"), ('\u{FB02}', "FL"), ('\u{FB03}', "FFI"),
    ('\u{FB04}', "FFL"), ('\u{FB06}', "ST"),
];

/// The lookup key of a defined name: two names have the same key exactly when
/// Excel treats them as the same defined name (within the measured rule above).
/// Use it for EVERY map keyed by a defined name and every comparison of two
/// defined names; never `to_uppercase` (which keeps `Straße` apart from
/// `STRAẞE`, the spelling the lexer produces for a bare `Straße`, and merges
/// `qµ` with `qμ`) and never `sheet_name_key` (which keeps `Straße` apart from
/// `STRASSE`). An ASCII name's key is that name uppercased.
pub fn defined_name_key(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if c.is_ascii() {
            out.push(c.to_ascii_uppercase());
            continue;
        }
        match EXCEL_DEFINED_NAME_EXPANSIONS.binary_search_by(|(from, _)| from.cmp(&c)) {
            Ok(i) => out.push_str(EXCEL_DEFINED_NAME_EXPANSIONS[i].1),
            Err(_) => out.push(fold_sheet_name_char(c)),
        }
    }
    out
}

/// Whether two defined names are the same name, by Excel's rule.
pub fn defined_names_equal(a: &str, b: &str) -> bool {
    defined_name_key(a) == defined_name_key(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_expansion_table_is_sorted_and_its_letters_are_folded() {
        for w in EXCEL_DEFINED_NAME_EXPANSIONS.windows(2) {
            assert!(w[0].0 < w[1].0, "unsorted at {:?}", w[1].0);
        }
        for (c, letters) in EXCEL_DEFINED_NAME_EXPANSIONS.iter() {
            let refolded: String = letters.chars().map(fold_sheet_name_char).collect();
            assert_eq!(&refolded, letters, "the letters of {c:?} are not folded");
            assert!(letters.chars().count() >= 2, "{c:?} is not an expansion");
        }
    }

    /// The live answers in the module note, both directions.
    #[test]
    fn defined_names_follow_excels_measured_rule() {
        for (a, b) in [
            ("Straße", "STRASSE"),
            ("Straße", "STRA\u{1E9E}E"),
            ("Straße", "straße"),
            ("Ärende", "ärende"),
            ("q\u{3C2}", "q\u{3A3}"),
            ("q\u{212A}", "qk"),
            ("q\u{1C4}", "q\u{1C6}"),
            ("q\u{FF21}", "q\u{FF41}"),
            ("qæ", "qae"),
            ("qœ", "qoe"),
            ("q\u{133}", "qij"),
            ("q\u{1C6}", "qd\u{17E}"),
            ("q\u{FB01}", "qfi"),
            ("qþ", "qth"),
            ("qs\u{DF}", "q\u{DF}s"),
        ] {
            assert!(defined_names_equal(a, b), "{a:?} and {b:?} are ONE name in Excel");
        }
        for (a, b) in [
            ("qi", "q\u{130}"),
            ("q\u{131}", "qI"),
            ("q\u{B5}", "q\u{3BC}"),
            ("q\u{17F}", "qs"),
            ("q\u{212B}", "q\u{E5}"),
            ("q\u{2BC}n", "q\u{149}"),
            ("qaa", "q\u{E5}"),
            ("qae", "q\u{E4}"),
        ] {
            assert!(!defined_names_equal(a, b), "{a:?} and {b:?} are TWO names in Excel");
        }
    }
}
