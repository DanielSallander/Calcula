//! FILENAME: core/script-engine/src/ops/mod.rs
//! PURPOSE: Op module declarations + the ONE sheet-key resolver every op with
//! a sheet parameter goes through.
//! CONTEXT: Each module registers functions on the global Calcula object
//! that bridge JavaScript calls to Rust spreadsheet operations. Sheet
//! parameters accept a 0-based index OR a sheet name (exact match first, then
//! a UNIQUE case-insensitive match) and THROW a JS error on a miss — a silent
//! no-op here meant a script kept running and wrote to the wrong sheet.

use rquickjs::{Ctx, Value};

use crate::types::ScriptContext;

pub mod application;
pub mod bookmarks;
pub mod canonical_model;
pub mod cells;
pub mod extended;
pub mod model;
pub mod sheets;
pub mod text;
pub mod utility;
pub mod worksheet_props;

/// Format sheet names for an error message: `"Alpha", "Beta"`.
pub(crate) fn sheet_names_for_error(names: &[String]) -> String {
    if names.is_empty() {
        return "(none)".to_string();
    }
    names
        .iter()
        .map(|n| format!("\"{}\"", n))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Resolve a sheet NAME to its 0-based index: exact match first, then a
/// UNIQUE match by Excel's sheet-name case rule (`identity::sheet_names_equal`,
/// the rule every other sheet lookup uses -- full `to_lowercase` merged the
/// Angstrom sign with `å` and split final `ς` from `σ`). The Err lists the
/// workbook's sheet names so the script author sees what WOULD have matched.
/// Twin of `resolveSheetName` in app/src/api/scriptHost/worker/canonicalModel.ts.
pub(crate) fn resolve_sheet_name(names: &[String], name: &str) -> Result<usize, String> {
    if let Some(i) = names.iter().position(|n| n == name) {
        return Ok(i);
    }
    let matches: Vec<usize> = names
        .iter()
        .enumerate()
        .filter(|(_, n)| identity::sheet_names_equal(n, name))
        .map(|(i, _)| i)
        .collect();
    match matches.as_slice() {
        [only] => Ok(*only),
        [] => Err(format!(
            "No sheet named \"{}\". Sheets in this workbook: {}",
            name,
            sheet_names_for_error(names)
        )),
        _ => Err(format!(
            "Sheet name \"{}\" is ambiguous: it case-insensitively matches more than one sheet. Sheets in this workbook: {}",
            name,
            sheet_names_for_error(names)
        )),
    }
}

/// Resolve a REQUIRED number|string sheet key to a valid 0-based index.
/// Throws a JS error on any miss: unknown/ambiguous name, negative,
/// fractional, or out-of-range index, or a non-number/non-string value.
pub(crate) fn resolve_sheet_key<'js>(
    ctx: &Ctx<'js>,
    sc: &ScriptContext,
    key: &Value<'js>,
) -> rquickjs::Result<usize> {
    if let Some(s) = key.as_string() {
        let name = s.to_string()?;
        return resolve_sheet_name(&sc.sheet_names, &name)
            .map_err(|msg| rquickjs::Exception::throw_message(ctx, &msg));
    }
    let count = sc.grids.len();
    if let Some(n) = key.as_number() {
        if n.fract() == 0.0 && n >= 0.0 && (n as usize) < count {
            return Ok(n as usize);
        }
        return Err(rquickjs::Exception::throw_message(
            ctx,
            &format!(
                "Sheet index {} is out of range (the workbook has {} sheet(s)). Sheets: {}",
                n,
                count,
                sheet_names_for_error(&sc.sheet_names)
            ),
        ));
    }
    Err(rquickjs::Exception::throw_message(
        ctx,
        &format!(
            "Sheet must be a 0-based index or a sheet name. Sheets: {}",
            sheet_names_for_error(&sc.sheet_names)
        ),
    ))
}

/// Resolve an OPTIONAL number|string sheet key. Absent, `null`, `undefined`,
/// or a negative number all mean "the active sheet" (the long-standing
/// `sheetIndex = -1` convention); anything else resolves like
/// [`resolve_sheet_key`], throwing on a miss.
pub(crate) fn resolve_opt_sheet_key<'js>(
    ctx: &Ctx<'js>,
    sc: &ScriptContext,
    key: Option<&Value<'js>>,
) -> rquickjs::Result<usize> {
    match key {
        None => Ok(sc.active_sheet),
        Some(v) if v.is_undefined() || v.is_null() => Ok(sc.active_sheet),
        Some(v) => {
            if let Some(n) = v.as_number() {
                if n < 0.0 {
                    return Ok(sc.active_sheet);
                }
            }
            resolve_sheet_key(ctx, sc, v)
        }
    }
}

#[cfg(test)]
mod sheet_name_rule_tests {
    use super::resolve_sheet_name;

    /// A script's sheet name resolves by Excel's case rule, the one the engine
    /// and the worker realm use: the Angstrom sign is NOT `å` (full lowercasing
    /// merged them), and `σ` IS the capital sigma of `QΣ` (full lowercasing
    /// applies the final-sigma rule, `QΣ` -> `qς`, and split them). Excel
    /// answered both pairs live (core/identity/src/sheet_name_case.rs).
    #[test]
    fn a_script_sheet_name_resolves_by_excels_case_rule() {
        let names = vec!["\u{e5}".to_string(), "Q\u{3a3}".to_string(), "\u{c4}rende".to_string()];
        assert!(
            resolve_sheet_name(&names, "\u{212b}").is_err(),
            "the Angstrom sign named the a-ring sheet, which Excel keeps apart"
        );
        assert_eq!(
            resolve_sheet_name(&names, "Q\u{3c3}"),
            Ok(1),
            "sigma did not find the capital-sigma sheet, which Excel calls the same name"
        );
        assert_eq!(resolve_sheet_name(&names, "\u{e4}RENDE"), Ok(2));
    }
}
