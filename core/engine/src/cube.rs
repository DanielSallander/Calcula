//! FILENAME: core/engine/src/cube.rs
//! PURPOSE: Engine-side types + helpers for the CUBE formula family
//! (CUBEVALUE, CUBEMEMBER, CUBESET, CUBESETCOUNT, CUBERANKEDMEMBER,
//!  CUBEMEMBERPROPERTY, CUBEKPIMEMBER) that query a Calcula BI model.
//!
//! CONTEXT: The formula evaluator is synchronous but CUBE functions need async
//! BI-model queries. Following the GETPIVOTDATA / UDF pre-fetch pattern, an async
//! pass in the app layer (app/src-tauri/src/bi/cube.rs) resolves every cube call
//! BEFORE the synchronous recalc and hands the evaluator a `CubePrefetch`.
//!
//! This module is PURE: it knows nothing about BI connections or queries — only
//! the resolved data the evaluator serves, and the SHARED syntactic helpers that
//! keep the pre-pass and the evaluator in exact agreement on call keys. Because
//! both sides compute lookup keys through `cube_call_key` here, the evaluator's
//! job reduces to "resolve key, look up pre-fetched result" — all intelligence
//! lives in the async pre-pass.
//!
//! ## The cube-object cell duality
//! A `=CUBEMEMBER(...)` / `=CUBESET(...)` cell DISPLAYS a caption but carries an
//! underlying member/set object. Another cube formula that references the cell
//! (e.g. `=CUBEVALUE("Sales", B2)`) uses the member/set it holds, not the caption.
//! `CubePrefetch.bindings` records those per-cell objects so a `CellRef` argument
//! resolves to the right member/set.

use crate::cell::CellError;
use crate::coord::col_to_index;
use crate::dependency_extractor::{BuiltinFunction, Expression, Value};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Whether a cube object is a single member/tuple or a set of members.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CubeBindingKind {
    Member,
    Set,
}

/// A cube object carried by a cell that holds CUBEMEMBER / CUBESET /
/// CUBERANKEDMEMBER / CUBEKPIMEMBER. The cell displays `caption`, but cube
/// formulas that reference the cell use the member/set it carries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CubeBinding {
    /// The connection (model) this object belongs to.
    pub connection: String,
    /// Single member/tuple, or a set of members.
    pub kind: CubeBindingKind,
    /// Canonical member-expression (for a member) or set identity (for a set)
    /// used when this cell is referenced as an argument to another cube function.
    pub expression: String,
    /// Text shown in the cell.
    pub caption: String,
    /// For a set: the resolved, ordered member expressions. Empty for a member.
    #[serde(default)]
    pub members: Vec<String>,
    /// A precomputed scalar carried by this member (e.g. a KPI value/goal/status).
    /// CUBEVALUE returns it when this member is used without an explicit measure.
    #[serde(default)]
    pub scalar: Option<f64>,
}

/// The pre-fetched result of one cube call, keyed in `CubePrefetch.results` by
/// the call signature produced by `cube_call_key`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum CubeCallResult {
    /// A scalar number (CUBEVALUE, CUBESETCOUNT, a numeric property/KPI value).
    Number(f64),
    /// A text value (a string property).
    Text(String),
    /// A cube object (CUBEMEMBER / CUBESET / CUBERANKEDMEMBER / CUBEKPIMEMBER):
    /// the caption to display. (The cell's binding lives in `CubePrefetch.bindings`.)
    Object { caption: String },
    /// An error to surface in the cell.
    Error(CubeError),
}

/// Errors a cube call can produce, mapped to spreadsheet cell errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CubeError {
    /// Unknown connection name -> #NAME?
    Name,
    /// Malformed member/set expression or bad argument -> #VALUE!
    Value,
    /// Member / measure / KPI not found, or no data / connection offline -> #N/A
    NotAvailable,
    /// Bad reference (e.g. CUBERANKEDMEMBER rank out of range) -> #REF!
    Reference,
}

impl CubeError {
    pub fn to_cell_error(self) -> CellError {
        match self {
            CubeError::Name => CellError::Name,
            CubeError::Value => CellError::Value,
            CubeError::NotAvailable => CellError::NA,
            CubeError::Reference => CellError::Ref,
        }
    }
}

/// All cube data pre-fetched for one synchronous recalc.
///
/// Keys in both maps are JSON-friendly strings so the whole struct serializes
/// across the Tauri IPC boundary (a `HashMap` with a tuple key would not).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CubePrefetch {
    /// Per-cell bindings keyed by `cell_key(row, col)` (0-based grid coords) for
    /// every cell whose formula yields a cube object. Lets a `CellRef` argument
    /// in another cube formula resolve to the member/set the referenced cell holds.
    pub bindings: HashMap<String, CubeBinding>,
    /// Pre-fetched results keyed by `cube_call_key`.
    pub results: HashMap<String, CubeCallResult>,
}

impl CubePrefetch {
    pub fn binding_at(&self, row: u32, col: u32) -> Option<&CubeBinding> {
        self.bindings.get(&cell_key(row, col))
    }
    pub fn result(&self, key: &str) -> Option<&CubeCallResult> {
        self.results.get(key)
    }
    pub fn insert_binding(&mut self, row: u32, col: u32, binding: CubeBinding) {
        self.bindings.insert(cell_key(row, col), binding);
    }
}

/// Stable per-cell binding key (0-based row/col).
pub fn cell_key(row: u32, col: u32) -> String {
    format!("{}:{}", row, col)
}

/// Abstracts the two pieces of context needed to resolve a cube argument:
/// the per-cell cube bindings, and the plain display text of a referenced cell.
/// Implemented by BOTH the evaluator and the app-side pre-pass so they compute
/// identical call keys.
///
/// `Sync` is required so a `&dyn CubeResolver` is `Send` and can be held across
/// `.await` in the app-side async pre-pass (Tauri command futures must be Send).
pub trait CubeResolver: Sync {
    /// The cube object a cell carries, if any (0-based coords).
    fn binding_at(&self, row: u32, col: u32) -> Option<&CubeBinding>;
    /// The plain display text of a (non-cube) cell, if any (0-based coords).
    fn cell_text(&self, row: u32, col: u32) -> Option<String>;
}

/// Format a numeric literal argument deterministically (so the pre-pass and the
/// evaluator agree on keys). Integers print without a decimal point.
pub fn format_number_arg(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        // Trim to a stable representation.
        let s = format!("{}", n);
        s
    }
}

/// Resolve one cube argument expression to its canonical string form.
///
/// - string literal            -> the trimmed string
/// - number / boolean literal  -> a stable textual form
/// - cell reference            -> the referenced cell's binding expression, else
///                                its plain display text ("" for an empty cell)
/// - nested CUBEMEMBER/CUBESET  -> the nested call's member/set expression argument
///
/// Cross-sheet references are resolved against the current sheet (cube member
/// references are same-sheet in v1).
pub fn resolve_cube_arg(expr: &Expression, r: &dyn CubeResolver) -> Result<String, CubeError> {
    match expr {
        Expression::Literal(Value::String(s)) => Ok(s.trim().to_string()),
        Expression::Literal(Value::Number(n)) => Ok(format_number_arg(*n)),
        Expression::Literal(Value::Boolean(b)) => {
            Ok(if *b { "TRUE".to_string() } else { "FALSE".to_string() })
        }
        Expression::CellRef { col, row, .. } => {
            let r0 = row.saturating_sub(1);
            let c0 = col_to_index(col) as u32;
            if let Some(b) = r.binding_at(r0, c0) {
                Ok(b.expression.clone())
            } else if let Some(t) = r.cell_text(r0, c0) {
                Ok(t.trim().to_string())
            } else {
                Ok(String::new())
            }
        }
        Expression::FunctionCall { func, args, .. } => match func {
            // A nested member/set object is identified by its member/set
            // expression argument (args[1]). Nested ranked/KPI members are not
            // representable as a stable string — author those in their own cell.
            BuiltinFunction::CubeMember | BuiltinFunction::CubeSet => {
                if args.len() >= 2 {
                    resolve_cube_arg(&args[1], r)
                } else {
                    Err(CubeError::Value)
                }
            }
            _ => Err(CubeError::Value),
        },
        _ => Err(CubeError::Value),
    }
}

/// Field separator unlikely to appear in member expressions (ASCII unit separator).
const KEY_SEP: char = '\u{1f}';

/// Build the deterministic lookup key for a cube call. Both the async pre-pass
/// and the synchronous evaluator call THIS function with the same arguments and
/// resolver behaviour, guaranteeing their keys match.
///
/// The key is `FUNCNAME␟arg0␟arg1␟…` where each `argN` is `resolve_cube_arg`.
pub fn cube_call_key(
    func_name: &str,
    args: &[Expression],
    r: &dyn CubeResolver,
) -> Result<String, CubeError> {
    let mut key = String::from(func_name);
    for a in args {
        key.push(KEY_SEP);
        key.push_str(&resolve_cube_arg(a, r)?);
    }
    Ok(key)
}

/// Canonical uppercase name for a cube `BuiltinFunction`, or `None` if the
/// function is not a cube function. Used by the app-side pre-pass to label calls.
pub fn cube_function_name(func: &BuiltinFunction) -> Option<&'static str> {
    Some(match func {
        BuiltinFunction::CubeValue => "CUBEVALUE",
        BuiltinFunction::CubeMember => "CUBEMEMBER",
        BuiltinFunction::CubeSet => "CUBESET",
        BuiltinFunction::CubeSetCount => "CUBESETCOUNT",
        BuiltinFunction::CubeRankedMember => "CUBERANKEDMEMBER",
        BuiltinFunction::CubeMemberProperty => "CUBEMEMBERPROPERTY",
        BuiltinFunction::CubeKpiMember => "CUBEKPIMEMBER",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dependency_extractor::Expression;

    /// A test resolver with a couple of seeded bindings + cell texts.
    struct TestResolver {
        bindings: HashMap<(u32, u32), CubeBinding>,
        texts: HashMap<(u32, u32), String>,
    }
    impl CubeResolver for TestResolver {
        fn binding_at(&self, row: u32, col: u32) -> Option<&CubeBinding> {
            self.bindings.get(&(row, col))
        }
        fn cell_text(&self, row: u32, col: u32) -> Option<String> {
            self.texts.get(&(row, col)).cloned()
        }
    }

    fn str_lit(s: &str) -> Expression {
        Expression::Literal(Value::String(s.to_string()))
    }
    fn num_lit(n: f64) -> Expression {
        Expression::Literal(Value::Number(n))
    }
    fn cell_ref(col: &str, row: u32) -> Expression {
        Expression::CellRef {
            sheet: None,
            col: col.to_string(),
            row,
            col_absolute: false,
            row_absolute: false,
            ref_site_id: Default::default(),
        }
    }

    fn empty_resolver() -> TestResolver {
        TestResolver { bindings: HashMap::new(), texts: HashMap::new() }
    }

    #[test]
    fn key_is_deterministic_for_literals() {
        let r = empty_resolver();
        let args = vec![str_lit("Sales"), str_lit("[Revenue]"), str_lit("Geo[Country]=Sweden")];
        let k1 = cube_call_key("CUBEVALUE", &args, &r).unwrap();
        let k2 = cube_call_key("CUBEVALUE", &args, &r).unwrap();
        assert_eq!(k1, k2);
        assert!(k1.starts_with("CUBEVALUE"));
        assert!(k1.contains("[Revenue]"));
    }

    #[test]
    fn cellref_resolves_via_binding() {
        // B2 (row 2 -> 0-based row 1, col B -> 1) holds a CUBEMEMBER object.
        let mut bindings = HashMap::new();
        bindings.insert(
            (1, 1),
            CubeBinding {
                connection: "Sales".into(),
                kind: CubeBindingKind::Member,
                expression: "Geo[Country]=Sweden".into(),
                caption: "Sweden".into(),
                members: vec![],
                scalar: None,
            },
        );
        let r = TestResolver { bindings, texts: HashMap::new() };

        // CUBEVALUE("Sales","[Revenue]",B2) must key on the BINDING expression,
        // identical to the literal form.
        let via_ref = cube_call_key(
            "CUBEVALUE",
            &[str_lit("Sales"), str_lit("[Revenue]"), cell_ref("B", 2)],
            &r,
        )
        .unwrap();
        let via_literal = cube_call_key(
            "CUBEVALUE",
            &[str_lit("Sales"), str_lit("[Revenue]"), str_lit("Geo[Country]=Sweden")],
            &r,
        )
        .unwrap();
        assert_eq!(via_ref, via_literal);
    }

    #[test]
    fn cellref_falls_back_to_plain_text() {
        let mut texts = HashMap::new();
        texts.insert((0, 0), "[Revenue]".to_string()); // A1 contains literal text
        let r = TestResolver { bindings: HashMap::new(), texts };
        let k = cube_call_key("CUBEVALUE", &[str_lit("Sales"), cell_ref("A", 1)], &r).unwrap();
        assert!(k.contains("[Revenue]"));
    }

    #[test]
    fn number_arg_is_stable() {
        assert_eq!(format_number_arg(1.0), "1");
        assert_eq!(format_number_arg(2.0), "2");
        assert_eq!(format_number_arg(2.5), "2.5");
        let r = empty_resolver();
        let k = cube_call_key("CUBERANKEDMEMBER", &[str_lit("Sales"), cell_ref("D", 1), num_lit(1.0)], &r);
        assert!(k.is_ok());
    }

    #[test]
    fn nested_cubemember_resolves_to_member_expr() {
        let r = empty_resolver();
        let nested = Expression::FunctionCall {
            func: BuiltinFunction::CubeMember,
            args: vec![str_lit("Sales"), str_lit("Geo[Country]=Sweden")],
            ref_site_id: Default::default(),
        };
        let via_nested =
            cube_call_key("CUBEVALUE", &[str_lit("Sales"), str_lit("[Revenue]"), nested], &r).unwrap();
        let via_literal = cube_call_key(
            "CUBEVALUE",
            &[str_lit("Sales"), str_lit("[Revenue]"), str_lit("Geo[Country]=Sweden")],
            &r,
        )
        .unwrap();
        assert_eq!(via_nested, via_literal);
    }

    #[test]
    fn cube_function_name_maps_only_cube_fns() {
        assert_eq!(cube_function_name(&BuiltinFunction::CubeValue), Some("CUBEVALUE"));
        assert_eq!(cube_function_name(&BuiltinFunction::Sum), None);
    }
}
