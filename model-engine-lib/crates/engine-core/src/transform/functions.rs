//! Which catalog functions a transformation step may actually call.
//!
//! An editor that offers `SUM` in a transform expression is lying: the step
//! refuses it. An editor that hides `LEFT` is merely unhelpful. So this answers
//! the question in the direction where being wrong is cheap — and it answers it
//! by **asking the allowlist**, never by restating it.
//!
//! # Derived, not declared
//!
//! For every name in the function catalog, this parses a small ladder of probe
//! calls and keeps the name only if one of them survives
//! [`parse_row_expression`](crate::transform::validate::parse_row_expression) —
//! the exact function a step's expression goes through. A function that no
//! probe fits is left out (under-offered, a nuisance); a function the allowlist
//! would refuse can never get in (over-offered, a lie). A new text function
//! appears here the day it appears in the catalog, with no list to update.
//!
//! The cost is one pass over the catalog, cached for the process.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use crate::catalog::function_catalog;
use crate::model::Column;
use crate::transform::validate::parse_row_expression;
use crate::types::DataType;

/// Argument lists to try, in order. Deliberately varied in both ARITY and
/// TYPE: several functions accept only a date, only text, or a bare
/// granularity keyword, and a ladder of numeric-only probes would quietly
/// drop them.
const PROBES: &[&str] = &[
    "()",
    "(txt)",
    "(num)",
    "(dte)",
    "(txt, num)",
    "(txt, txt)",
    "(num, num)",
    "(dte, dte)",
    "(dte, DAY)",
    "(num, txt)",
    "(txt, num, num)",
    "(txt, txt, txt)",
    "(num, num, num)",
    "(dte, num, DAY)",
    "(dte, dte, DAY)",
    "(txt, txt, num)",
    "(num, txt, txt)",
];

/// The probe schema: one column of each shape the ladder above names.
fn probe_schema() -> Vec<Column> {
    vec![
        Column::new("txt", DataType::String),
        Column::new("num", DataType::Float64),
        Column::new("dte", DataType::Date),
    ]
}

/// Every catalog function a transformation step's expression may call.
///
/// Sorted and de-duplicated. Computed once and cached.
pub fn row_level_function_names() -> &'static BTreeSet<String> {
    static NAMES: OnceLock<BTreeSet<String>> = OnceLock::new();
    NAMES.get_or_init(|| {
        let schema = probe_schema();
        function_catalog()
            .iter()
            .map(|function| function.name)
            .filter(|name| is_row_level(name, &schema))
            .map(|name| name.to_string())
            .collect()
    })
}

/// Whether ANY probe call of `name` parses as a row-level expression.
fn is_row_level(name: &str, schema: &[Column]) -> bool {
    PROBES
        .iter()
        .any(|probe| parse_row_expression("Probe", 0, schema, &format!("{name}{probe}")).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_families_a_cleanup_workload_needs_are_offered() {
        // Non-vacuity first, and the headline claim: the functions someone
        // reaches for when tidying a column are all reachable.
        let names = row_level_function_names();
        assert!(names.len() > 40, "only {} functions survived", names.len());
        for expected in [
            "LEFT",
            "RIGHT",
            "MID",
            "LEN",
            "TRIM",
            "UPPER",
            "LOWER",
            "SUBSTITUTE",
            "CONCATENATE",
            "FIND",
            "IF",
            "COALESCE",
            "ISBLANK",
            "ROUND",
            "ABS",
            "YEAR",
            "MONTH",
            "DAY",
        ] {
            assert!(names.contains(expected), "{expected} must be offered");
        }
    }

    #[test]
    fn nothing_offered_is_something_a_step_would_refuse() {
        // THE property, and the only direction that can lie to a user. Every
        // offered name is re-checked against the very function a step's
        // expression goes through.
        let schema = probe_schema();
        for name in row_level_function_names() {
            assert!(
                is_row_level(name, &schema),
                "{name} is offered but no probe of it is row-level"
            );
        }
    }

    #[test]
    fn aggregates_are_not_offered() {
        // The mistake this exists to prevent: a step computes one value per
        // row, so an aggregate is refused with "use a groupBy step". Offering
        // it in completion would be an invitation to that error.
        let names = row_level_function_names();
        for aggregate in [
            "SUM",
            "COUNT",
            "AVERAGE",
            "MIN",
            "MAX",
            "COUNTROWS",
            "DISTINCTCOUNT",
        ] {
            assert!(
                !names.contains(aggregate),
                "{aggregate} is an aggregation and must not be offered in a step"
            );
        }
    }

    #[test]
    fn model_scoped_functions_are_not_offered() {
        // A step runs before its table joins the model, so anything that needs
        // a relationship or a filter context is meaningless here.
        let names = row_level_function_names();
        for scoped in [
            "RELATED",
            "LOOKUPVALUE",
            "CALCULATE",
            "ALL",
            "FILTER",
            "RELATEDTABLE",
        ] {
            assert!(!names.contains(scoped), "{scoped} needs a finished model");
        }
    }

    #[test]
    fn the_answer_is_stable_across_calls() {
        assert_eq!(row_level_function_names(), row_level_function_names());
    }
}
