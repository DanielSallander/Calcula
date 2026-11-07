//! Per-measure semi-joins: a KEEP on a table that cannot be joined onto the
//! rows a measure aggregates without multiplying them (BUG-0763, BUG-0730).
//!
//! A KEEP's table is JOINED onto the measure's table only when the
//! relationship between them is KEY-SAFE from the measure's table
//! ([`is_key_safe`]): an active, equality-only relationship on whose MANY (or
//! one-to-one) side the measure's table sits, so each of its rows meets at
//! most one row of the KEEP's table. Every other relationship -- a
//! many-to-many cardinality (an equality bridge or a range), or a one-to-many
//! seen from the measure's ONE side -- would hand a LEFT JOIN several rows per
//! aggregated row and inflate every SUM / COUNT in the statement.
//!
//! Such a KEEP is applied as a SEMI-JOIN instead, scoped to the ONE measure
//! that carries it: a row counts for that measure when SOME row of the KEEP's
//! table satisfies every KEEP predicate on that table AND relates to the row
//! through the relationship -- never once per matching row, and never for the
//! other measures of the query. That is Power BI's filter propagation through
//! a relationship that has no "one" side. "A model relationship is limited
//! when there's no guaranteed 'one' side ... The relationship uses a
//! many-to-many cardinality type ... Table expansion never occurs for limited
//! relationships. Table joins are achieved by using INNER JOIN semantics, and
//! for this reason, blank virtual rows aren't added" (Microsoft, "Model
//! relationships in Power BI Desktop", Relationship evaluation). The filter
//! runs from the KEEP's table to the measure's table -- the direction Power
//! BI lets a many-to-many relationship filter in either way ("for
//! many-to-many relationships, cross filter direction can be from either one
//! of the tables, or from both tables", same article): the KEEP names the
//! filtered table, the measure the filtered-into one. A fact row filtered by a
//! bridge is counted once however many bridge rows match it ("Each customer
//! balance can represent the addition of multiple account balances, and so
//! the customer balances are non-additive" -- Microsoft, "Many-to-many
//! relationship guidance": the account's transactions count once for each
//! customer, never twice). For a one-to-many relationship the KEEP on the
//! many side reaches the one side the way `FILTER(<many table>, ...)` does
//! through the many table's expanded table: the one-side rows that SOME
//! qualifying many-side row relates to.
//!
//! The semi-join is a derived table LEFT JOINed on the measure table's own
//! relationship columns. It holds each qualifying key tuple ONCE (a `SELECT
//! DISTINCT`), so it can never multiply a row; the measure's conditional
//! aggregate tests it (`k0 IS NOT NULL`) and every other measure ignores it.
//! A relationship of ONE range condition (`fact.day <= dim.end`) uses the
//! cheaper boundary form instead: a row qualifies iff its value is on the
//! right side of the MAX / MIN of the qualifying rows' column, computed in a
//! one-row derived table. Until this module the local path rendered such a
//! KEEP as one predicate-FREE `EXISTS` in the statement's WHERE -- filtering
//! every measure by "has any related row" -- while the measure's own condition
//! still named the unjoined table, so the query failed ("No field named
//! tags.tag"); the multi-fact path LEFT JOINed the table and multiplied every
//! row (`many_to_many_tests`: a total of 125 answered 210).

use std::collections::HashMap;

use engine_core::compute::context::{EvaluationContext, ResolvedFilter};
use engine_core::compute::expression::Expression;
use engine_core::compute::sql_util::quote_ident_double;
use engine_core::model::{DataModel, JoinOperator, Relationship};

use crate::error::{QueryError, QueryResult};

use super::sql::build_condition_sql_with_conditions;

/// One derived table a statement LEFT / CROSS JOINs for a per-measure
/// semi-join. Identical semi-joins (the same table, relationship and
/// predicate) share one alias.
#[derive(Debug, Clone)]
pub(super) struct SemiJoin {
    /// Dedup key: the derived table's SQL plus how it is joined.
    key: String,
    /// The JOIN clause, with its leading space:
    /// ` LEFT JOIN (SELECT DISTINCT ...) AS __sj0 ON ...` or
    /// ` CROSS JOIN (SELECT MAX(...) ...) AS __sj0`.
    pub(super) join_sql: String,
}

/// The tables (lowercase model names) whose registered rows the REQUEST
/// restricts -- a filter or slicer on the table, a role predicate, or keys
/// propagated into it from another filtered table. A USERELATIONSHIP over an
/// unsafe relationship to a table NOT in the set restricts nothing
/// ([`take_semi_joins`]).
pub(super) type RequestFiltered = std::collections::HashSet<String>;

/// Can `table` be JOINED onto the rows of `fact_model_name` without
/// multiplying them? True for an active equality relationship on whose many
/// (or one-to-one) side `fact_model_name` sits; false for many-to-many and
/// range relationships, for a one-to-many seen from its one side, and when the
/// two tables have no active relationship.
pub(super) fn is_key_safe(model: &DataModel, fact_model_name: &str, table: &str) -> bool {
    model
        .find_relationship(fact_model_name, table)
        .is_ok_and(|rel| rel.lookup_safe_from(fact_model_name))
}

/// The SQL every semi-join of a statement appends after its own JOINs.
pub(super) fn semi_join_sql(semi_joins: &[SemiJoin]) -> String {
    semi_joins.iter().map(|s| s.join_sql.as_str()).collect()
}

/// The tables a KEEP condition reads, as written (qualified references only).
fn condition_tables(cond: &Expression) -> Vec<&str> {
    let mut tables: Vec<&str> = Vec::new();
    for (table, _) in cond.qualified_column_references() {
        if !tables.iter().any(|t| t.eq_ignore_ascii_case(table)) {
            tables.push(table);
        }
    }
    tables
}

/// The relationship one of the measure's USERELATIONSHIP overrides activates
/// between the measure's table and `table`, if any.
pub(super) fn override_relationship<'m>(
    ctx: &EvaluationContext,
    model: &'m DataModel,
    fact_model_name: &str,
    table: &str,
) -> Option<&'m Relationship> {
    ctx.relationship_overrides.iter().find_map(|name| {
        model.relationship(name).ok().filter(|rel| {
            (rel.from_table().eq_ignore_ascii_case(fact_model_name)
                && rel.to_table().eq_ignore_ascii_case(table))
                || (rel.to_table().eq_ignore_ascii_case(fact_model_name)
                    && rel.from_table().eq_ignore_ascii_case(table))
        })
    })
}

/// Does one of the measure's USERELATIONSHIP overrides connect the measure's
/// table and `table` through a relationship that can be JOINed onto the
/// measure's table (`join_safe_from`)? Such a table is served by the
/// override's aliased join (`build_override_alias_map`), never by a
/// semi-join. An override through any other relationship (many-to-many,
/// range, a one-to-many seen from its one side) IS a semi-join of the measure
/// that carries it ([`take_semi_joins`]).
fn overridden(
    ctx: &EvaluationContext,
    model: &DataModel,
    fact_model_name: &str,
    table: &str,
) -> bool {
    override_relationship(ctx, model, fact_model_name, table)
        .is_some_and(|rel| rel.join_safe_from(fact_model_name))
}

/// Each relationship condition as `(fact column, dimension column, operator
/// read fact-first)`: `fact.c op dim.d`.
fn fact_first_conditions<'r>(
    rel: &'r Relationship,
    fact_model_name: &str,
) -> Vec<(&'r str, &'r str, JoinOperator)> {
    let fact_is_from = rel.from_table().eq_ignore_ascii_case(fact_model_name);
    rel.conditions()
        .iter()
        .map(|c| {
            if fact_is_from {
                (c.from_column(), c.to_column(), c.operator())
            } else {
                (c.to_column(), c.from_column(), c.operator().flipped())
            }
        })
        .collect()
}

/// Register (or reuse) the semi-join of `table` under `predicate` and return
/// the condition that tests it for one row of the measure's table.
fn semi_join_flag(
    rel: &Relationship,
    model_table: &str,
    predicate: &str,
    fact_table: &str,
    fact_model_name: &str,
    semi_joins: &mut Vec<SemiJoin>,
) -> String {
    let table = model_table.to_lowercase();
    let conditions = fact_first_conditions(rel, fact_model_name);
    // A relationship of ONE range condition: the boundary form. `fact.c <=
    // dim.d` holds for SOME qualifying row iff `fact.c <= MAX(d)` over them
    // (`>=` / `>` read the MIN). A NULL boundary (no qualifying row) compares
    // NULL, which the conditional aggregate reads as FALSE.
    if let [(fact_col, dim_col, op)] = conditions.as_slice() {
        if *op != JoinOperator::Equal {
            let aggregate = op.boundary_aggregate();
            let derived = format!(
                "(SELECT {aggregate}({table}.{d}) AS \"__b\" FROM {table} WHERE {predicate})",
                d = quote_ident_double(dim_col)
            );
            let key = format!("CROSS {derived}");
            let alias = alias_for(&key, semi_joins, |alias| {
                format!(" CROSS JOIN {derived} AS {alias}")
            });
            return format!(
                "({fact_table}.{c} {} {alias}.\"__b\")",
                op.as_sql(),
                c = quote_ident_double(fact_col)
            );
        }
    }
    // Otherwise the DISTINCT qualifying key tuples, LEFT JOINed on the
    // measure table's own relationship columns. Equality keys are read off
    // the dimension alone; a relationship with a range condition needs the
    // measure table's values that satisfy it.
    let mut fact_keys: Vec<&str> = Vec::new();
    for (fact_col, _, _) in &conditions {
        if !fact_keys.contains(fact_col) {
            fact_keys.push(fact_col);
        }
    }
    let derived = if rel.is_equi_only() {
        let select: Vec<String> = conditions
            .iter()
            .enumerate()
            .map(|(i, (_, dim_col, _))| {
                format!("{table}.{} AS \"k{i}\"", quote_ident_double(dim_col))
            })
            .collect();
        format!(
            "(SELECT DISTINCT {} FROM {table} WHERE {predicate})",
            select.join(", ")
        )
    } else {
        let fact_is_from = rel.from_table().eq_ignore_ascii_case(fact_model_name);
        let on = rel.build_on_clause("__f", &table, fact_is_from);
        let select: Vec<String> = fact_keys
            .iter()
            .enumerate()
            .map(|(i, c)| format!("__f.{} AS \"k{i}\"", quote_ident_double(c)))
            .collect();
        format!(
            "(SELECT DISTINCT {} FROM {fact_table} AS __f JOIN {table} ON {on} WHERE {predicate})",
            select.join(", ")
        )
    };
    // The measure-table column each `k{i}` matches.
    let key_columns: Vec<&str> = if rel.is_equi_only() {
        conditions.iter().map(|(c, _, _)| *c).collect()
    } else {
        fact_keys.clone()
    };
    let key = format!("LEFT {derived} ON {}", key_columns.join(","));
    let alias = alias_for(&key, semi_joins, |alias| {
        let on: Vec<String> = key_columns
            .iter()
            .enumerate()
            .map(|(i, c)| format!("{fact_table}.{} = {alias}.\"k{i}\"", quote_ident_double(c)))
            .collect();
        format!(" LEFT JOIN {derived} AS {alias} ON {}", on.join(" AND "))
    });
    format!("({alias}.\"k0\" IS NOT NULL)")
}

/// The alias of the semi-join keyed `key`, registering it (built by `join`)
/// when it is new.
fn alias_for(
    key: &str,
    semi_joins: &mut Vec<SemiJoin>,
    join: impl FnOnce(&str) -> String,
) -> String {
    if let Some(i) = semi_joins.iter().position(|s| s.key == key) {
        return format!("__sj{i}");
    }
    let alias = format!("__sj{}", semi_joins.len());
    semi_joins.push(SemiJoin {
        key: key.to_string(),
        join_sql: join(&alias),
    });
    alias
}

/// Move a measure's KEEP filters and KEEP conditions on tables that are NOT
/// key-safe from `fact_model_name` out of `effective` / `conditions` and into
/// per-measure semi-joins (registered in `semi_joins`); return the conditions
/// that test them, to AND into the measure's conditional aggregate.
///
/// Left alone (joined or handled as before): the measure's own table, tables
/// the statement already joins for its GROUP BY (`joined_tables`, names
/// compared case-insensitively), tables a USERELATIONSHIP override of the
/// measure serves, key-safe tables, and tables with no active relationship.
/// Every predicate on one semi-joined table tests the SAME row of it (one
/// derived table per table), as DAX intersects filters on one table. A KEEP
/// condition reading a semi-joined table AND another table cannot be split
/// per table and is refused.
#[allow(clippy::too_many_arguments)]
pub(super) fn take_semi_joins(
    effective: &mut Vec<ResolvedFilter>,
    conditions: &mut Vec<Expression>,
    ctx: &EvaluationContext,
    model: &DataModel,
    fact_table: &str,
    fact_model_name: &str,
    joined_tables: &[&str],
    request_filtered: &RequestFiltered,
    semi_joins: &mut Vec<SemiJoin>,
) -> QueryResult<Vec<String>> {
    // Each candidate table with the relationship its semi-join runs through:
    // the measure's USERELATIONSHIP override when it has one to that table,
    // the active relationship otherwise.
    let mut candidates: Vec<(String, &Relationship)> = Vec::new();
    // A USERELATIONSHIP override through a relationship that cannot be JOINed
    // onto the measure's table (many-to-many, range, a one-to-many seen from
    // its one side) is a semi-join of THIS measure even with no KEEP on its
    // table: the measure reads the fact rows that SOME row of the (request
    // filtered) table relates to through the override -- and, when nothing
    // filters the table, every fact row (below). It used to be one
    // predicate-free EXISTS in the statement's WHERE, which filtered every
    // measure of the query, while a KEEP on the table named an alias the
    // statement never joined.
    for name in &ctx.relationship_overrides {
        let Ok(rel) = model.relationship(name) else {
            continue;
        };
        let table = if rel.from_table().eq_ignore_ascii_case(fact_model_name) {
            rel.to_table()
        } else if rel.to_table().eq_ignore_ascii_case(fact_model_name) {
            rel.from_table()
        } else {
            continue;
        };
        if rel.join_safe_from(fact_model_name)
            || candidates.iter().any(|(c, _)| c.eq_ignore_ascii_case(table))
        {
            continue;
        }
        if joined_tables.iter().any(|t| t.eq_ignore_ascii_case(table)) {
            return Err(QueryError::InvalidQuery(format!(
                "USERELATIONSHIP('{name}') reaches the group-by table '{table}' through a \
                 many-to-many, range or one-to-many relationship, which this query route cannot \
                 group through; request the measure on its own"
            )));
        }
        candidates.push((table.to_string(), rel));
    }
    let mut consider = |table: &str| {
        if table.eq_ignore_ascii_case(fact_model_name)
            || joined_tables.iter().any(|t| t.eq_ignore_ascii_case(table))
            || candidates.iter().any(|(c, _)| c.eq_ignore_ascii_case(table))
            || overridden(ctx, model, fact_model_name, table)
        {
            return;
        }
        if let Ok(rel) = model.find_relationship(fact_model_name, table) {
            if !rel.lookup_safe_from(fact_model_name) {
                candidates.push((table.to_string(), rel));
            }
        }
    };
    for f in effective.iter() {
        consider(&f.table);
    }
    for cond in conditions.iter() {
        for table in condition_tables(cond) {
            consider(table);
        }
    }

    let mut flags: Vec<String> = Vec::new();
    for (table, rel) in &candidates {
        let table = table.as_str();
        let (on_table, rest): (Vec<ResolvedFilter>, Vec<ResolvedFilter>) = effective
            .drain(..)
            .partition(|f| f.table.eq_ignore_ascii_case(table));
        *effective = rest;
        let mut table_conditions: Vec<Expression> = Vec::new();
        let mut kept: Vec<Expression> = Vec::new();
        for cond in conditions.drain(..) {
            let tables = condition_tables(&cond);
            if !tables.iter().any(|t| t.eq_ignore_ascii_case(table)) {
                kept.push(cond);
            } else if tables.len() == 1 {
                table_conditions.push(cond);
            } else {
                return Err(QueryError::InvalidQuery(format!(
                    "a KEEP condition compares a column of '{table}' with a column of another \
                     table ({}), but '{table}' is reached from '{fact_model_name}' through a \
                     many-to-many, range or one-to-many relationship, so the condition cannot be \
                     tested row by row on the local path; filter each table with its own KEEP \
                     predicate",
                    tables
                        .iter()
                        .filter(|t| !t.eq_ignore_ascii_case(table))
                        .copied()
                        .collect::<Vec<_>>()
                        .join(", ")
                )));
            }
        }
        *conditions = kept;
        // An override with no KEEP on its table: the rows the request leaves
        // of the table (its registered rows). With nothing filtering the
        // table the override restricts NOTHING: USERELATIONSHIP only chooses
        // the relationship a filter travels, and DAX propagates a filter from
        // a filtered table only (wave 4: ViaLabels read 105, the rows SOME
        // Labels row relates to, where DAX answers the plain 125).
        let predicate = if on_table.is_empty() && table_conditions.is_empty() {
            if !request_filtered.contains(&table.to_lowercase()) {
                continue;
            }
            "TRUE".to_string()
        } else {
            build_condition_sql_with_conditions(
                &on_table,
                &table_conditions,
                fact_table,
                fact_model_name,
                model,
                &HashMap::new(),
            )?
        };
        flags.push(semi_join_flag(
            rel,
            table,
            &predicate,
            fact_table,
            fact_model_name,
            semi_joins,
        ));
    }
    Ok(flags)
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_core::compute::expression::{compare, lit_str, qualified_col, ComparisonOp};
    use engine_core::model::{Cardinality, Column, JoinCondition, Table};
    use engine_core::types::DataType;

    fn model() -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("prod_id", DataType::Int64),
                        Column::new("day", DataType::Int64),
                        Column::new("amount", DataType::Float64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Tags",
                    vec![
                        Column::new("prod_id", DataType::Int64),
                        Column::new("tag", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Periods",
                    vec![
                        Column::new("start_day", DataType::Int64),
                        Column::new("end_day", DataType::Int64),
                        Column::new("label", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Deadlines",
                    vec![
                        Column::new("due", DataType::Int64),
                        Column::new("kind", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Product",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("name", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::with_conditions(
                "Sales_Tags",
                "Sales",
                "Tags",
                vec![JoinCondition::equal("prod_id", "prod_id")],
                Cardinality::ManyToMany,
            ))
            .add_relationship(Relationship::many_to_many(
                "Sales_Periods",
                "Sales",
                "Periods",
                vec![
                    JoinCondition::new("day", "start_day", JoinOperator::GreaterThanOrEqual),
                    JoinCondition::new("day", "end_day", JoinOperator::LessThanOrEqual),
                ],
            ))
            // Declared FROM the dimension: read fact-first it is `day <= due`.
            .add_relationship(Relationship::many_to_many(
                "Deadlines_Sales",
                "Deadlines",
                "Sales",
                vec![JoinCondition::new(
                    "due",
                    "day",
                    JoinOperator::GreaterThanOrEqual,
                )],
            ))
            .add_relationship(Relationship::many_to_one(
                "Sales_Product",
                "Sales",
                "prod_id",
                "Product",
                "id",
            ))
            .build()
            .unwrap()
    }

    fn take(
        model: &DataModel,
        fact: &str,
        effective: &mut Vec<ResolvedFilter>,
        conditions: &mut Vec<Expression>,
        semi_joins: &mut Vec<SemiJoin>,
    ) -> QueryResult<Vec<String>> {
        take_semi_joins(
            effective,
            conditions,
            &EvaluationContext::new(),
            model,
            &fact.to_lowercase(),
            fact,
            &[],
            &RequestFiltered::new(),
            semi_joins,
        )
    }

    #[test]
    fn key_safety_is_read_from_the_measures_table() {
        let m = model();
        assert!(
            is_key_safe(&m, "Sales", "Product"),
            "many-to-one from the fact"
        );
        assert!(
            !is_key_safe(&m, "Product", "Sales"),
            "one-to-many from the dimension"
        );
        assert!(
            !is_key_safe(&m, "Sales", "Tags"),
            "many-to-many equality bridge"
        );
        assert!(!is_key_safe(&m, "Sales", "Periods"), "range relationship");
        assert!(
            !is_key_safe(&m, "Tags", "Product"),
            "no relationship at all"
        );
    }

    #[test]
    fn an_equality_bridge_becomes_a_distinct_key_set() {
        let m = model();
        let mut effective = vec![
            ResolvedFilter::new("Tags", "tag", ComparisonOp::Equal, "red"),
            ResolvedFilter::new("Product", "name", ComparisonOp::Equal, "Bikes"),
        ];
        let mut conditions = Vec::new();
        let mut sj = Vec::new();
        let flags = take(&m, "Sales", &mut effective, &mut conditions, &mut sj).unwrap();
        assert_eq!(flags, vec!["(__sj0.\"k0\" IS NOT NULL)".to_string()]);
        assert_eq!(
            sj[0].join_sql,
            " LEFT JOIN (SELECT DISTINCT tags.\"prod_id\" AS \"k0\" FROM tags WHERE \
             tags.\"tag\" = 'red') AS __sj0 ON sales.\"prod_id\" = __sj0.\"k0\""
        );
        // The key-safe Product filter stays for the ordinary LEFT JOIN.
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].table, "Product");

        // The same KEEP on another measure reuses the derived table.
        let mut again = vec![ResolvedFilter::new(
            "Tags",
            "tag",
            ComparisonOp::Equal,
            "red",
        )];
        let flags = take(&m, "Sales", &mut again, &mut Vec::new(), &mut sj).unwrap();
        assert_eq!(flags, vec!["(__sj0.\"k0\" IS NOT NULL)".to_string()]);
        assert_eq!(sj.len(), 1);
    }

    #[test]
    fn a_range_relationship_reads_the_measure_tables_values_and_a_one_condition_range_its_boundary()
    {
        let m = model();
        let mut effective = vec![ResolvedFilter::new(
            "Periods",
            "label",
            ComparisonOp::Equal,
            "Q2",
        )];
        let mut conditions = vec![compare(
            qualified_col("Deadlines", "kind"),
            ComparisonOp::Equal,
            lit_str("hard"),
        )];
        let mut sj = Vec::new();
        let flags = take(&m, "Sales", &mut effective, &mut conditions, &mut sj).unwrap();
        assert!(effective.is_empty() && conditions.is_empty());
        assert_eq!(flags[0], "(__sj0.\"k0\" IS NOT NULL)");
        assert_eq!(
            sj[0].join_sql,
            " LEFT JOIN (SELECT DISTINCT __f.\"day\" AS \"k0\" FROM sales AS __f JOIN periods ON \
             __f.\"day\" >= periods.\"start_day\" AND __f.\"day\" <= periods.\"end_day\" WHERE \
             periods.\"label\" = 'Q2') AS __sj0 ON sales.\"day\" = __sj0.\"k0\""
        );
        // `due >= day`, read fact-first, is `day <= due`: the MAX boundary.
        assert_eq!(flags[1], "(sales.\"day\" <= __sj1.\"__b\")");
        assert!(sj[1].join_sql.starts_with(
            " CROSS JOIN (SELECT MAX(deadlines.\"due\") AS \"__b\" FROM deadlines WHERE "
        ));
    }

    #[test]
    fn a_keep_on_the_many_side_reaches_the_one_side_as_a_semi_join() {
        let m = model();
        let mut effective = vec![ResolvedFilter::new(
            "Sales",
            "amount",
            ComparisonOp::GreaterThan,
            "15",
        )];
        let mut sj = Vec::new();
        let flags = take(&m, "Product", &mut effective, &mut Vec::new(), &mut sj).unwrap();
        assert_eq!(flags, vec!["(__sj0.\"k0\" IS NOT NULL)".to_string()]);
        assert_eq!(
            sj[0].join_sql,
            " LEFT JOIN (SELECT DISTINCT sales.\"prod_id\" AS \"k0\" FROM sales WHERE \
             sales.\"amount\" > 15) AS __sj0 ON product.\"id\" = __sj0.\"k0\""
        );
    }

    #[test]
    fn a_condition_across_a_bridge_and_another_table_is_refused() {
        let m = model();
        let mut conditions = vec![compare(
            qualified_col("Tags", "tag"),
            ComparisonOp::Equal,
            qualified_col("Product", "name"),
        )];
        let err = take(
            &m,
            "Sales",
            &mut Vec::new(),
            &mut conditions,
            &mut Vec::new(),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("'Tags'") && err.contains("Product"), "{err}");
    }

    #[test]
    fn group_by_tables_and_overridden_tables_are_left_alone() {
        let m = model();
        let mut effective = vec![ResolvedFilter::new(
            "Tags",
            "tag",
            ComparisonOp::Equal,
            "red",
        )];
        let mut sj = Vec::new();
        let flags = take_semi_joins(
            &mut effective,
            &mut Vec::new(),
            &EvaluationContext::new(),
            &m,
            "sales",
            "Sales",
            &["tags"],
            &RequestFiltered::new(),
            &mut sj,
        )
        .unwrap();
        assert!(flags.is_empty() && sj.is_empty());
        assert_eq!(effective.len(), 1);

        // A USERELATIONSHIP override through a JOIN-safe relationship is the
        // override's aliased join, never a semi-join.
        let mut ctx = EvaluationContext::new();
        ctx.relationship_overrides.push("Sales_Product".into());
        let mut on_product = vec![ResolvedFilter::new(
            "Product",
            "name",
            ComparisonOp::Equal,
            "Bike",
        )];
        let flags = take_semi_joins(
            &mut on_product,
            &mut Vec::new(),
            &ctx,
            &m,
            "sales",
            "Sales",
            &[],
            &RequestFiltered::new(),
            &mut sj,
        )
        .unwrap();
        assert!(flags.is_empty() && sj.is_empty());
        assert_eq!(on_product.len(), 1);
    }

    /// A USERELATIONSHIP override through a many-to-many or range
    /// relationship is a semi-join of the measure that carries it -- with
    /// its KEEP on the table, or with the request-filtered rows of the table
    /// when it has none (and NO restriction when nothing filters the table)
    /// -- never a statement-wide EXISTS; and through one to a group-by table
    /// it is refused, not ignored.
    #[test]
    fn an_unsafe_override_is_a_semi_join_of_its_measure() {
        let m = model();
        let mut ctx = EvaluationContext::new();
        ctx.relationship_overrides.push("Sales_Tags".into());
        let mut effective = vec![ResolvedFilter::new(
            "Tags",
            "tag",
            ComparisonOp::Equal,
            "red",
        )];
        let mut sj = Vec::new();
        let flags = take_semi_joins(
            &mut effective,
            &mut Vec::new(),
            &ctx,
            &m,
            "sales",
            "Sales",
            &[],
            &RequestFiltered::new(),
            &mut sj,
        )
        .unwrap();
        assert!(effective.is_empty(), "the KEEP is consumed by the semi-join");
        assert_eq!(flags, vec!["(__sj0.\"k0\" IS NOT NULL)".to_string()]);
        assert!(sj[0].join_sql.contains("WHERE tags.\"tag\" = 'red'"), "{}", sj[0].join_sql);

        let mut ctx = EvaluationContext::new();
        ctx.relationship_overrides.push("Deadlines_Sales".into());
        // Nothing filters Deadlines: the override restricts nothing.
        let mut sj = Vec::new();
        let flags = take_semi_joins(
            &mut Vec::new(),
            &mut Vec::new(),
            &ctx,
            &m,
            "sales",
            "Sales",
            &[],
            &RequestFiltered::new(),
            &mut sj,
        )
        .unwrap();
        assert!(flags.is_empty() && sj.is_empty(), "{flags:?}");
        // A request filter on Deadlines: its registered rows restrict.
        let mut sj = Vec::new();
        let flags = take_semi_joins(
            &mut Vec::new(),
            &mut Vec::new(),
            &ctx,
            &m,
            "sales",
            "Sales",
            &[],
            &RequestFiltered::from(["deadlines".to_string()]),
            &mut sj,
        )
        .unwrap();
        // `due >= day` read fact-first is `day <= MAX(due)`.
        assert_eq!(flags, vec!["(sales.\"day\" <= __sj0.\"__b\")".to_string()]);
        assert!(sj[0].join_sql.contains("MAX(deadlines.\"due\")"), "{}", sj[0].join_sql);
        assert!(sj[0].join_sql.contains("WHERE TRUE"), "{}", sj[0].join_sql);

        let err = take_semi_joins(
            &mut Vec::new(),
            &mut Vec::new(),
            &ctx,
            &m,
            "sales",
            "Sales",
            &["deadlines"],
            &RequestFiltered::new(),
            &mut Vec::new(),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("USERELATIONSHIP('Deadlines_Sales')"), "{err}");
    }
}
