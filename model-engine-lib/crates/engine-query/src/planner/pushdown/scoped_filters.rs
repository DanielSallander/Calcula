//! Scoped (level-tagged) filter resolution and contested-filter
//! classification.
//!
//! A request filter is **contested** when some requested measure's
//! `CLEAR`/`RESET`/`CLEAREXCEPT` range covers the filter's level. Contested
//! filters cannot be baked into fetch-time WHERE (the rows would be gone
//! before any measure could evaluate without them), so the planner withholds
//! them from every fetch and hands them to the local executor, which applies
//! them **per measure** as conditional-aggregation conditions — the
//! REMOVEFILTERS semantics the fail-closed guard previously refused
//! outright. Uncontested filters keep today's fetch-time path exactly.

use engine_connectors::traits::InValueKind;
use engine_connectors::{FilterCondition, FilterOperator, InFilterCondition};
use engine_core::compute::context::{ContextResolver, EvaluationContext, LEVEL_MAX, LEVEL_SLICER};
use engine_core::compute::expression::{expand_measure_refs, ComparisonOp};
use engine_core::model::DataModel;
use engine_core::types::DataType;

use crate::error::{QueryError, QueryResult};
use crate::request::{is_blank_member_label, QueryRequest, TotalsMode};

/// A query-level filter that some requested measure clears at (or above) its
/// level. Withheld from every fetch's WHERE; the local executor applies it
/// per measure — measures whose clear range covers [`Self::level`] evaluate
/// without it, every other measure gets it as a conditional-aggregation
/// condition, and the result's row domain keeps only groups with at least
/// one row matching every contested filter.
#[derive(Debug, Clone)]
pub struct ContestedFilter {
    /// The owning model table (resolved, unambiguous).
    pub table: String,
    /// The filtered column on that table.
    pub column: String,
    /// The filter's level (1 = ordinary slicer, 2..=9 = pinned).
    pub level: u8,
    /// The predicate applied for measures that do NOT clear this filter.
    pub predicate: ContestedPredicate,
}

/// The predicate shape of a [`ContestedFilter`].
#[derive(Debug, Clone)]
pub enum ContestedPredicate {
    /// A scalar comparison (`column op value`).
    Compare {
        /// The comparison operator.
        operator: ComparisonOp,
        /// The value (string representation).
        value: String,
    },
    /// An IN-list (`column IN (values)`); an empty list matches nothing.
    InList {
        /// The values to keep.
        values: Vec<String>,
        /// Also keep the rows where the column is NULL -- a scoped IN-list
        /// that named the BLANK member (`crate::request::BLANK_MEMBER_LABEL`).
        include_null: bool,
    },
}

/// The classification result: what stays on the fetch path and what the
/// LocalAggregation plan must carry for per-measure application.
#[derive(Debug, Default)]
pub(super) struct ScopedFilterPlan {
    /// Uncontested scoped scalar filters: (owner tables, condition), attached
    /// to each owner's fetch exactly like a legacy `request.filters` entry.
    pub fetch_scalar: Vec<(Vec<String>, FilterCondition)>,
    /// Uncontested scoped IN filters: (owner tables, rendered condition).
    pub fetch_in: Vec<(Vec<String>, InFilterCondition)>,
    /// Indexes into `request.filters` to WITHHOLD from fetches (contested).
    pub withheld_legacy_filters: Vec<usize>,
    /// Indexes into `request.in_filters` to withhold (contested).
    pub withheld_legacy_in: Vec<usize>,
    /// The contested filters the LocalAggregation plan carries.
    pub contested: Vec<ContestedFilter>,
}

fn filter_op_to_comparison(op: FilterOperator) -> ComparisonOp {
    match op {
        FilterOperator::Equal => ComparisonOp::Equal,
        FilterOperator::NotEqual => ComparisonOp::NotEqual,
        FilterOperator::GreaterThan => ComparisonOp::GreaterThan,
        FilterOperator::GreaterThanOrEqual => ComparisonOp::GreaterThanOrEqual,
        FilterOperator::LessThan => ComparisonOp::LessThan,
        FilterOperator::LessThanOrEqual => ComparisonOp::LessThanOrEqual,
    }
}

/// Model tables owning a column with this name (case-sensitive `column()`
/// lookup, matching the legacy attach heuristic).
fn owner_tables(model: &DataModel, column: &str) -> Vec<String> {
    model
        .tables()
        .iter()
        .filter(|t| t.column(column).is_ok())
        .map(|t| t.name().to_string())
        .collect()
}

/// Whether every owner of `column` types it as `t` (per `is`).
fn owners_type_column_as(
    model: &DataModel,
    owners: &[String],
    column: &str,
    is: fn(&DataType) -> bool,
) -> bool {
    owners.iter().all(|t| {
        model
            .table(t)
            .ok()
            .and_then(|tbl| tbl.column(column).ok())
            .is_some_and(|c| is(c.data_type()))
    })
}

/// A scoped IN-list's values, and whether they name the BLANK member.
///
/// A host lists a column's blank member -- its NULL rows, and on a text column
/// its empty-string rows too, which a list shows as ONE item -- with the label
/// [`crate::request::BLANK_MEMBER_LABEL`] (`(blank)`, any ASCII case). A
/// selection naming it arrives here verbatim, and `column IN ('(blank)')`
/// matches no NULL row: a PINNED slicer that kept the blank member silently
/// dropped the blank rows. So the label becomes `include_null`; on a TEXT
/// column the empty string joins the list (and the label stays, so a literal
/// `(blank)` value still matches itself); on any other column the label is
/// dropped -- it is not a value there, and rendering it would turn an integer
/// list non-sargable or fail a numeric cast.
fn blank_member_split(
    model: &DataModel,
    owners: &[String],
    column: &str,
    values: &[String],
) -> (Vec<String>, bool) {
    if !values.iter().any(|v| is_blank_member_label(v)) {
        return (values.to_vec(), false);
    }
    let is_text = owners_type_column_as(model, owners, column, |t| matches!(t, DataType::String));
    let mut out: Vec<String> = if is_text {
        values.to_vec()
    } else {
        values.iter().filter(|v| !is_blank_member_label(v)).cloned().collect()
    };
    if is_text && !out.iter().any(String::is_empty) {
        out.push(String::new());
    }
    (out, true)
}

/// Render an IN-list with integer-kind inference for integer columns
/// (mirrors the planner's `in_filter_condition`), reading the BLANK member
/// label ([`blank_member_split`]).
fn scoped_in_condition(
    model: &DataModel,
    owners: &[String],
    column: &str,
    values: &[String],
) -> InFilterCondition {
    let is_integer =
        owners_type_column_as(model, owners, column, |t| matches!(t, DataType::Int32 | DataType::Int64));
    let (values, include_null) = blank_member_split(model, owners, column, values);
    let mut cond = InFilterCondition::text(column, values);
    cond.include_null = include_null;
    if is_integer {
        cond.kind = InValueKind::Integer;
    }
    cond
}

/// Resolve every requested measure's evaluation context once. Unresolvable
/// measures are skipped — the normal path reports them.
fn resolve_measure_contexts(
    request: &QueryRequest,
    model: &DataModel,
) -> Vec<(String, EvaluationContext)> {
    let mut out = Vec::new();
    for m_name in &request.measures {
        let Ok(measure) = model.measure(m_name) else {
            continue;
        };
        let Ok(expanded) = expand_measure_refs(measure.expression(), model) else {
            continue;
        };
        let Ok((_, ctx)) = ContextResolver::new(model).resolve(&expanded) else {
            continue;
        };
        out.push((m_name.clone(), ctx));
    }
    out
}

/// The first measure whose clear range covers `(table, column)` at `level`,
/// if any — the definition of "contested".
fn contesting_measure<'a>(
    contexts: &'a [(String, EvaluationContext)],
    table: &str,
    column: &str,
    level: u8,
) -> Option<&'a str> {
    contexts
        .iter()
        .find(|(_, ctx)| ctx.clears_query_filter_ci(table, column, level))
        .map(|(name, _)| name.as_str())
}

/// Classify every request filter (legacy and scoped) as fetch-time or
/// contested, validating scoped filters strictly (fail closed): unknown
/// levels, unknown tables/columns, ambiguous contested owners, contested
/// cross-column OR slicers, and contested filters under ROLLUP totals all
/// refuse with a precise error rather than silently misapplying a filter.
pub(super) fn classify_query_filters(
    request: &QueryRequest,
    model: &DataModel,
) -> QueryResult<ScopedFilterPlan> {
    let mut plan = ScopedFilterPlan::default();
    let contexts = resolve_measure_contexts(request, model);

    // Legacy scalar filters (level 1, column-name ownership).
    for (idx, f) in request.filters.iter().enumerate() {
        let owners = owner_tables(model, &f.column);
        let contested_owner: Vec<&String> = owners
            .iter()
            .filter(|t| contesting_measure(&contexts, t, &f.column, LEVEL_SLICER).is_some())
            .collect();
        if contested_owner.is_empty() {
            continue; // fetch-time, exactly as today
        }
        if owners.len() > 1 {
            return Err(QueryError::InvalidQuery(format!(
                "a measure clears filtered column '{}', but the column exists in more than one \
                 table ({}) so the filter cannot be attributed for per-measure removal; qualify \
                 the filter with its table (scoped filter) or rename the column",
                f.column,
                owners.join(", ")
            )));
        }
        plan.withheld_legacy_filters.push(idx);
        plan.contested.push(ContestedFilter {
            table: owners[0].clone(),
            column: f.column.clone(),
            level: LEVEL_SLICER,
            predicate: ContestedPredicate::Compare {
                operator: filter_op_to_comparison(f.operator),
                value: f.value.clone(),
            },
        });
    }

    // Legacy IN-list slicers (level 1).
    for (idx, f) in request.in_filters.iter().enumerate() {
        let owners = owner_tables(model, &f.column);
        let contested_owner: Vec<&String> = owners
            .iter()
            .filter(|t| contesting_measure(&contexts, t, &f.column, LEVEL_SLICER).is_some())
            .collect();
        if contested_owner.is_empty() {
            continue;
        }
        if owners.len() > 1 {
            return Err(QueryError::InvalidQuery(format!(
                "a measure clears sliced column '{}', but the column exists in more than one \
                 table ({}); use a scoped IN filter with an explicit table",
                f.column,
                owners.join(", ")
            )));
        }
        plan.withheld_legacy_in.push(idx);
        plan.contested.push(ContestedFilter {
            table: owners[0].clone(),
            column: f.column.clone(),
            level: LEVEL_SLICER,
            predicate: ContestedPredicate::InList {
                values: f.values.clone(),
                // A legacy (unscoped) IN-list is literal.
                include_null: false,
            },
        });
    }

    // Cross-column OR slicers: a disjunction cannot be dropped per measure
    // (removing one arm changes the whole predicate) — refuse when contested.
    for f in &request.or_filters {
        for owner in owner_tables(model, &f.column) {
            if let Some(m) = contesting_measure(&contexts, &owner, &f.column, LEVEL_SLICER) {
                return Err(QueryError::InvalidQuery(format!(
                    "measure '{m}' clears '{owner}[{}]', which the request restricts with a \
                     cross-column OR slicer; an OR slicer cannot be removed per measure — \
                     remove it from the request, or use CLEAR_INNER/RESET_INNER",
                    f.column
                )));
            }
        }
    }

    // Scoped scalar filters (explicit level, optional explicit table).
    for f in &request.scoped_filters {
        let owners =
            resolve_scoped_owners(model, f.table.as_deref(), &f.condition.column, f.level)?;
        let contested_owner: Vec<&String> = owners
            .iter()
            .filter(|t| contesting_measure(&contexts, t, &f.condition.column, f.level).is_some())
            .collect();
        if contested_owner.is_empty() {
            plan.fetch_scalar.push((owners, f.condition.clone()));
            continue;
        }
        if owners.len() > 1 {
            return Err(QueryError::InvalidQuery(format!(
                "a measure clears filtered column '{}' (level {}), but the column exists in more \
                 than one table ({}); give the scoped filter an explicit table",
                f.condition.column,
                f.level,
                owners.join(", ")
            )));
        }
        plan.contested.push(ContestedFilter {
            table: owners[0].clone(),
            column: f.condition.column.clone(),
            level: f.level,
            predicate: ContestedPredicate::Compare {
                operator: filter_op_to_comparison(f.condition.operator),
                value: f.condition.value.clone(),
            },
        });
    }

    // Scoped IN-list slicers.
    for f in &request.scoped_in_filters {
        let owners = resolve_scoped_owners(model, f.table.as_deref(), &f.filter.column, f.level)?;
        let contested_owner: Vec<&String> = owners
            .iter()
            .filter(|t| contesting_measure(&contexts, t, &f.filter.column, f.level).is_some())
            .collect();
        if contested_owner.is_empty() {
            let cond = scoped_in_condition(model, &owners, &f.filter.column, &f.filter.values);
            plan.fetch_in.push((owners, cond));
            continue;
        }
        if owners.len() > 1 {
            return Err(QueryError::InvalidQuery(format!(
                "a measure clears sliced column '{}' (level {}), but the column exists in more \
                 than one table ({}); give the scoped IN filter an explicit table",
                f.filter.column,
                f.level,
                owners.join(", ")
            )));
        }
        let (values, include_null) =
            blank_member_split(model, &owners, &f.filter.column, &f.filter.values);
        plan.contested.push(ContestedFilter {
            table: owners[0].clone(),
            column: f.filter.column.clone(),
            level: f.level,
            predicate: ContestedPredicate::InList { values, include_null },
        });
    }

    // Per-measure removal changes what a ROLLUP subtotal row would aggregate
    // in ways the local ROLLUP render does not express — refuse rather than
    // produce silently wrong subtotals.
    if !plan.contested.is_empty() && request.totals == TotalsMode::Rollup {
        return Err(QueryError::InvalidQuery(
            "a measure clears a request filter (per-measure removal) and the request asks for \
             ROLLUP totals; this combination is not supported yet — drop the totals mode or \
             the clearing measure"
                .into(),
        ));
    }

    Ok(plan)
}

/// Resolve a scoped filter's owner tables, strictly: an explicit table must
/// exist and carry the column; a table-less filter must own at least one
/// table; the level must be an expressible query-filter level (1..=9 — the
/// axis, level 0, is the group-by context, not a request filter).
fn resolve_scoped_owners(
    model: &DataModel,
    table: Option<&str>,
    column: &str,
    level: u8,
) -> QueryResult<Vec<String>> {
    if !(LEVEL_SLICER..=LEVEL_MAX).contains(&level) {
        return Err(QueryError::InvalidQuery(format!(
            "scoped filter on '{column}' has level {level}; request-filter levels are 1..={LEVEL_MAX}"
        )));
    }
    match table {
        Some(t) => {
            let model_table = model.table(t).map_err(|_| {
                QueryError::InvalidQuery(format!(
                    "scoped filter names unknown table '{t}' — a misapplied filter would \
                     silently widen the result, so this fails closed"
                ))
            })?;
            if model_table.column(column).is_err() {
                return Err(QueryError::InvalidQuery(format!(
                    "scoped filter names column '{column}' which does not exist in table '{t}'"
                )));
            }
            Ok(vec![model_table.name().to_string()])
        }
        None => {
            let owners = owner_tables(model, column);
            if owners.is_empty() {
                return Err(QueryError::InvalidQuery(format!(
                    "scoped filter on '{column}' matches no model table; a filter applying to \
                     nothing would silently widen the result, so this fails closed"
                )));
            }
            Ok(owners)
        }
    }
}
