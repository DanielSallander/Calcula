//! Expression → formula-text rendering (the DAX-like authoring syntax).
//!
//! The inverse of the measure parser: renders an [`Expression`] tree back to
//! the formula surface syntax (`SUM(Sales[Amount]) / COUNT(Sales[Id])`).
//! Complements the [`render`](super::render) module, which renders
//! Expression → SQL for *execution*: this module targets humans and editors
//! (formula bars, measure editors, lineage panels), so every variant —
//! including an unexpanded [`Expression::MeasureRef`], which the SQL
//! renderers reject — formats without error.
//!
//! Hosts (Calcula, Calcula Studio) use this to display stored expressions
//! back to the user; the output is designed to round-trip through the
//! formula parser.

use super::*;
use crate::compute::measure::Measure;

/// Convert an [`Expression`] back to a DAX-like formula string.
///
/// `table_name` is the context table for unqualified column references
/// (rendered in `Table[Column]` format). Qualified references keep their
/// own qualifier.
pub fn expression_to_formula(expr: &Expression, table_name: &str) -> String {
    format_expr(expr, table_name, Precedence::Lowest)
}

/// Convert a [`Measure`] to its formula string representation, using the
/// measure's own (inferred) fact table as the context table.
pub fn measure_to_formula(measure: &Measure) -> String {
    expression_to_formula(measure.expression(), measure.table())
}

#[derive(PartialEq, PartialOrd, Clone, Copy)]
enum Precedence {
    Lowest,
    Or,
    And,
    Comparison,
    Additive,       // + -
    Multiplicative, // * /
}

fn format_agg_name(op: &AggregateOp) -> &'static str {
    match op {
        AggregateOp::Sum => "SUM",
        AggregateOp::Count => "COUNT",
        AggregateOp::Average => "AVERAGE",
        AggregateOp::Min => "MIN",
        AggregateOp::Max => "MAX",
        AggregateOp::DistinctCount => "DISTINCTCOUNT",
        AggregateOp::CountRows => "COUNTROWS",
        AggregateOp::Median => "MEDIAN",
        AggregateOp::StdevSample => "STDEV.S",
        AggregateOp::StdevPop => "STDEV.P",
        AggregateOp::VarSample => "VAR.S",
        AggregateOp::VarPop => "VAR.P",
        AggregateOp::AnyValue => "ANYVALUE",
        AggregateOp::Mode => "MODE",
    }
}

fn format_column_pairs(pairs: &[(String, String)]) -> String {
    pairs
        .iter()
        .map(|(t, c)| format!("{t}[{c}]"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn format_clear_targets(targets: &[ClearTarget]) -> String {
    targets
        .iter()
        .map(|t| match t {
            ClearTarget::Column { table, column } => format!("{table}.{column}"),
            ClearTarget::Table(table) => table.clone(),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn format_comparison_op(op: &ComparisonOp) -> &'static str {
    match op {
        ComparisonOp::Equal => "=",
        ComparisonOp::NotEqual => "!=",
        ComparisonOp::GreaterThan => ">",
        ComparisonOp::GreaterThanOrEqual => ">=",
        ComparisonOp::LessThan => "<",
        ComparisonOp::LessThanOrEqual => "<=",
    }
}

fn format_scalar_function(func: &ScalarFunction) -> &'static str {
    match func {
        ScalarFunction::Abs => "ABS",
        ScalarFunction::Round => "ROUND",
        ScalarFunction::RoundUp => "ROUNDUP",
        ScalarFunction::RoundDown => "ROUNDDOWN",
        ScalarFunction::Int => "INT",
        ScalarFunction::Trunc => "TRUNC",
        ScalarFunction::Ceiling => "CEILING",
        ScalarFunction::Floor => "FLOOR",
        ScalarFunction::Mod => "MOD",
        ScalarFunction::Power => "POWER",
        ScalarFunction::Sqrt => "SQRT",
        ScalarFunction::Ln => "LN",
        ScalarFunction::Log10 => "LOG10",
        ScalarFunction::Sign => "SIGN",
        ScalarFunction::Exp => "EXP",
        ScalarFunction::Log => "LOG",
        ScalarFunction::Pi => "PI",
    }
}

fn format_text_function(func: &TextFunction) -> &'static str {
    match func {
        TextFunction::Upper => "UPPER",
        TextFunction::Lower => "LOWER",
        TextFunction::Trim => "TRIM",
        TextFunction::Left => "LEFT",
        TextFunction::Right => "RIGHT",
        TextFunction::Mid => "MID",
        TextFunction::Len => "LEN",
        TextFunction::Rept => "REPT",
        TextFunction::Concatenate => "CONCATENATE",
        TextFunction::CombineValues => "COMBINEVALUES",
        TextFunction::Find => "FIND",
        TextFunction::Search => "SEARCH",
        TextFunction::Replace => "REPLACE",
        TextFunction::Substitute => "SUBSTITUTE",
        TextFunction::Exact => "EXACT",
        TextFunction::Value => "VALUE",
        TextFunction::Fixed => "FIXED",
        TextFunction::Unichar => "UNICHAR",
        TextFunction::Unicode => "UNICODE",
        TextFunction::Ltrim => "LTRIM",
        TextFunction::Rtrim => "RTRIM",
        TextFunction::Lpad => "LPAD",
        TextFunction::Rpad => "RPAD",
        TextFunction::Reverse => "REVERSE",
        TextFunction::Split => "SPLIT",
        TextFunction::Format => "FORMAT",
        TextFunction::Contains => "CONTAINS",
        TextFunction::StartsWith => "STARTSWITH",
        TextFunction::EndsWith => "ENDSWITH",
        TextFunction::InitCap => "INITCAP",
    }
}

fn format_datetime_function(func: &DateTimeFunction) -> &'static str {
    match func {
        DateTimeFunction::Year => "YEAR",
        DateTimeFunction::Month => "MONTH",
        DateTimeFunction::Day => "DAY",
        DateTimeFunction::Quarter => "QUARTER",
        DateTimeFunction::Date => "DATE",
        DateTimeFunction::DateDiff => "DATEDIFF",
        DateTimeFunction::Today => "TODAY",
        DateTimeFunction::Now => "NOW",
        DateTimeFunction::DateAdd => "DATEADD",
        DateTimeFunction::DateTrunc => "DATE_TRUNC",
        DateTimeFunction::LastDay => "LAST_DAY",
        DateTimeFunction::EoMonth => "EOMONTH",
        DateTimeFunction::DayOfWeek => "DAYOFWEEK",
        DateTimeFunction::DayOfYear => "DAYOFYEAR",
        DateTimeFunction::WeekNum => "WEEKNUM",
        DateTimeFunction::DayName => "DAYNAME",
        DateTimeFunction::MonthName => "MONTHNAME",
        DateTimeFunction::MonthsBetween => "MONTHS_BETWEEN",
    }
}

fn format_expr(expr: &Expression, table: &str, parent_prec: Precedence) -> String {
    match expr {
        Expression::ColumnRef(name) => {
            format!("{table}[{name}]")
        }
        Expression::QualifiedColumnRef {
            table_or_var,
            column,
        } => {
            format!("{table_or_var}[{column}]")
        }
        Expression::TableRef(name) => name.clone(),
        Expression::LiteralFloat(v) => {
            format!("{v}")
        }
        Expression::LiteralInt(v) => {
            format!("{v}")
        }
        Expression::LiteralString(v) => {
            format!("\"{v}\"")
        }
        Expression::Blank => "BLANK()".to_string(),
        Expression::Aggregate { operation, operand } => {
            if matches!(operation, AggregateOp::CountRows) {
                "COUNTROWS()".to_string()
            } else {
                let inner = format_expr(operand, table, Precedence::Lowest);
                format!("{}({inner})", format_agg_name(operation))
            }
        }
        Expression::BinaryOp { left, op, right } => {
            let prec = match op {
                ArithmeticOp::Add | ArithmeticOp::Subtract => Precedence::Additive,
                ArithmeticOp::Multiply | ArithmeticOp::Divide => Precedence::Multiplicative,
            };
            let op_str = match op {
                ArithmeticOp::Add => "+",
                ArithmeticOp::Subtract => "-",
                ArithmeticOp::Multiply => "*",
                ArithmeticOp::Divide => "/",
            };
            let left_str = format_expr(left, table, prec);
            let right_str = format_expr(right, table, prec);

            let result = format!("{left_str} {op_str} {right_str}");

            if prec < parent_prec {
                format!("({result})")
            } else {
                result
            }
        }

        // --- Comparison and logical operators ---
        Expression::Comparison { left, op, right } => {
            let left_str = format_expr(left, table, Precedence::Comparison);
            let right_str = format_expr(right, table, Precedence::Comparison);
            let result = format!("{left_str} {} {right_str}", format_comparison_op(op));
            if Precedence::Comparison < parent_prec {
                format!("({result})")
            } else {
                result
            }
        }
        Expression::And(left, right) => {
            let left_str = format_expr(left, table, Precedence::And);
            let right_str = format_expr(right, table, Precedence::And);
            let result = format!("{left_str} AND {right_str}");
            if Precedence::And < parent_prec {
                format!("({result})")
            } else {
                result
            }
        }
        Expression::Or(left, right) => {
            let left_str = format_expr(left, table, Precedence::Or);
            let right_str = format_expr(right, table, Precedence::Or);
            let result = format!("{left_str} OR {right_str}");
            if Precedence::Or < parent_prec {
                format!("({result})")
            } else {
                result
            }
        }
        Expression::Not(inner) => {
            let inner_str = format_expr(inner, table, Precedence::And);
            format!("NOT {inner_str}")
        }
        Expression::Xor(left, right) => {
            let left_str = format_expr(left, table, Precedence::Lowest);
            let right_str = format_expr(right, table, Precedence::Lowest);
            format!("XOR({left_str}, {right_str})")
        }
        Expression::LiteralBool(b) => {
            if *b {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }

        // --- Conditionals ---
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            let cond = format_expr(condition, table, Precedence::Lowest);
            let then_s = format_expr(then_expr, table, Precedence::Lowest);
            let else_s = format_expr(else_expr, table, Precedence::Lowest);
            format!("IF({cond}, {then_s}, {else_s})")
        }
        Expression::Switch {
            expr: switch_expr,
            cases,
            default,
        } => {
            let mut parts = vec![format_expr(switch_expr, table, Precedence::Lowest)];
            for (val, result) in cases {
                parts.push(format_expr(val, table, Precedence::Lowest));
                parts.push(format_expr(result, table, Precedence::Lowest));
            }
            if let Some(def) = default {
                parts.push(format_expr(def, table, Precedence::Lowest));
            }
            format!("SWITCH({})", parts.join(", "))
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            let num = format_expr(numerator, table, Precedence::Lowest);
            let den = format_expr(denominator, table, Precedence::Lowest);
            if let Some(alt) = alternate {
                let alt_s = format_expr(alt, table, Precedence::Lowest);
                format!("DIVIDE({num}, {den}, {alt_s})")
            } else {
                format!("DIVIDE({num}, {den})")
            }
        }

        // --- Null handling ---
        Expression::IsBlank(inner) => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            format!("ISBLANK({inner_str})")
        }
        Expression::Coalesce(args) => {
            let parts: Vec<String> = args
                .iter()
                .map(|a| format_expr(a, table, Precedence::Lowest))
                .collect();
            format!("COALESCE({})", parts.join(", "))
        }

        // --- Scalar functions ---
        Expression::ScalarFunc { function, args } => {
            let parts: Vec<String> = args
                .iter()
                .map(|a| format_expr(a, table, Precedence::Lowest))
                .collect();
            format!("{}({})", format_scalar_function(function), parts.join(", "))
        }

        // --- Text functions ---
        Expression::TextFunc { function, args } => {
            let parts: Vec<String> = args
                .iter()
                .map(|a| format_expr(a, table, Precedence::Lowest))
                .collect();
            format!("{}({})", format_text_function(function), parts.join(", "))
        }

        // --- Context manipulation ---
        Expression::Keep {
            expr: inner,
            filters,
            variables,
            conditions,
            in_predicates,
        } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            let mut parts = Vec::new();
            for f in filters {
                parts.push(format!(
                    "{}.{} {} \"{}\"",
                    f.table,
                    f.column,
                    format_comparison_op(&f.operator),
                    f.value
                ));
            }
            for var in variables {
                parts.push(var.clone());
            }
            for cond in conditions {
                parts.push(format_expr(cond, table, Precedence::Lowest));
            }
            for pred in in_predicates {
                parts.push(format!(
                    "{}.{} IN {}.{}",
                    pred.table, pred.column, pred.var_name, pred.var_column
                ));
            }
            if parts.is_empty() {
                format!("KEEP({inner_str})")
            } else {
                format!("KEEP({inner_str}, {})", parts.join(", "))
            }
        }
        Expression::Clear {
            expr: inner,
            targets,
        } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            format!("CLEAR({inner_str}, {})", format_clear_targets(targets))
        }
        Expression::Reset { expr: inner } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            format!("RESET({inner_str})")
        }
        Expression::Traverse { expr: inner, path } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            let path_str = path.hops.join(" -> ");
            format!("TRAVERSE({inner_str}, {path_str})")
        }
        Expression::Using {
            expr: inner,
            context_name,
        } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            format!("USING({inner_str}, {context_name})")
        }
        Expression::ClearInner {
            expr: inner,
            targets,
        } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            format!("CLEARINNER({inner_str}, {})", format_clear_targets(targets))
        }
        Expression::ClearOuter {
            expr: inner,
            targets,
        } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            format!("CLEAROUTER({inner_str}, {})", format_clear_targets(targets))
        }
        Expression::ResetInner { expr: inner } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            format!("RESETINNER({inner_str})")
        }
        Expression::ResetOuter { expr: inner } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            format!("RESETOUTER({inner_str})")
        }
        // Legacy form of KEEP carrying only IN-membership predicates; format it
        // with the modern KEEP syntax so the output round-trips through the parser.
        Expression::KeepIn {
            expr: inner,
            predicates,
        } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            if predicates.is_empty() {
                format!("KEEP({inner_str})")
            } else {
                let parts: Vec<String> = predicates
                    .iter()
                    .map(|p| {
                        format!("{}.{} IN {}.{}", p.table, p.column, p.var_name, p.var_column)
                    })
                    .collect();
                format!("KEEP({inner_str}, {})", parts.join(", "))
            }
        }
        Expression::UseRelationship {
            expr: inner,
            relationship_name,
        } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            format!("USERELATIONSHIP({inner_str}, \"{relationship_name}\")")
        }

        // --- Window functions ---
        Expression::Window {
            inner,
            function,
            order_by,
            partition_by,
            frame,
        } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            let func_str = format_agg_name(function);
            let ob_str = format_column_pairs(order_by);
            let mut parts = vec![inner_str, func_str.to_string(), format!("ORDERBY({ob_str})")];
            if !partition_by.is_empty() {
                parts.push(format!("PARTITIONBY({})", format_column_pairs(partition_by)));
            }
            if let Some(f) = frame {
                let ft = |bt: &BoundaryType| match bt {
                    BoundaryType::Rel => "REL",
                    BoundaryType::Abs => "ABS",
                };
                parts.push(format!(
                    "ROWS({}, {}, {}, {})",
                    f.from,
                    ft(&f.from_type),
                    f.to,
                    ft(&f.to_type)
                ));
            }
            format!("WINDOW({})", parts.join(", "))
        }
        Expression::Offset {
            inner,
            delta,
            order_by,
            partition_by,
        } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            let ob_str = format_column_pairs(order_by);
            let mut parts = vec![inner_str, delta.to_string(), format!("ORDERBY({ob_str})")];
            if !partition_by.is_empty() {
                parts.push(format!("PARTITIONBY({})", format_column_pairs(partition_by)));
            }
            format!("OFFSET({})", parts.join(", "))
        }
        Expression::Index {
            inner,
            position,
            order_by,
            partition_by,
        } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            let ob_str = format_column_pairs(order_by);
            let mut parts = vec![inner_str, position.to_string(), format!("ORDERBY({ob_str})")];
            if !partition_by.is_empty() {
                parts.push(format!("PARTITIONBY({})", format_column_pairs(partition_by)));
            }
            format!("INDEX({})", parts.join(", "))
        }
        Expression::InList {
            expr: inner,
            values,
        } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            let vals: Vec<String> = values
                .iter()
                .map(|v| format_expr(v, table, Precedence::Lowest))
                .collect();
            format!("{inner_str} IN {{{}}}", vals.join(", "))
        }

        // --- Block / VAR-RETURN ---
        Expression::Block { bindings, result } => {
            let mut parts = Vec::new();
            for (name, binding_expr) in bindings {
                let val = format_expr(binding_expr, table, Precedence::Lowest);
                parts.push(format!("VAR {name} = {val}"));
            }
            let result_str = format_expr(result, table, Precedence::Lowest);
            parts.push(format!("RETURN {result_str}"));
            parts.join(" ")
        }

        // --- Value inspection ---
        Expression::HasOneValue { column } => {
            let col_str = format_expr(column, table, Precedence::Lowest);
            format!("HASONEVALUE({col_str})")
        }
        Expression::SelectedValue { column, alternate } => {
            let col_str = format_expr(column, table, Precedence::Lowest);
            if let Some(alt) = alternate {
                let alt_str = format_expr(alt, table, Precedence::Lowest);
                format!("SELECTEDVALUE({col_str}, {alt_str})")
            } else {
                format!("SELECTEDVALUE({col_str})")
            }
        }
        Expression::FirstValue { column, order_by } => {
            let col_str = format_expr(column, table, Precedence::Lowest);
            let order_str = format_expr(order_by, table, Precedence::Lowest);
            format!("FIRST({col_str}, ORDER BY {order_str})")
        }

        // --- Two-stage aggregation ---
        Expression::Query {
            aggregates,
            group_by,
        } => {
            let agg_parts: Vec<String> = aggregates
                .iter()
                .map(|(agg_expr, alias)| {
                    let e = format_expr(agg_expr, table, Precedence::Lowest);
                    format!("{e} AS {alias}")
                })
                .collect();
            let gb_parts: Vec<String> = group_by
                .iter()
                .map(|(tbl, col)| format!("{tbl}[{col}]"))
                .collect();
            format!("QUERY({} BY {})", agg_parts.join(", "), gb_parts.join(", "))
        }
        // --- Date/time functions ---
        Expression::DateTimeFunc { function, args } => {
            let parts: Vec<String> = args
                .iter()
                .map(|a| format_expr(a, table, Precedence::Lowest))
                .collect();
            format!(
                "{}({})",
                format_datetime_function(function),
                parts.join(", ")
            )
        }

        // --- Error handling ---
        Expression::IfError {
            expr: inner,
            alternate,
        } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            let alt_str = format_expr(alternate, table, Precedence::Lowest);
            format!("IFERROR({inner_str}, {alt_str})")
        }

        // --- Scope check ---
        Expression::IsInScope { table: tbl, column } => {
            format!("ISINSCOPE({tbl}[{column}])")
        }

        // --- ClearExcept ---
        Expression::ClearExcept {
            expr: inner,
            table: tbl,
            except_columns,
        } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            let cols = except_columns.join(", ");
            format!("CLEAREXCEPT({inner_str}, {tbl}, {cols})")
        }

        // --- Iterate ---
        Expression::Iterate {
            table: tbl,
            expression,
        } => {
            let expr_str = format_expr(expression, table, Precedence::Lowest);
            format!("ITERATE({tbl}, {expr_str})")
        }

        // --- Percentile ---
        Expression::Percentile {
            operand,
            percentile,
        } => {
            let op_str = format_expr(operand, table, Precedence::Lowest);
            let k_str = format_expr(percentile, table, Precedence::Lowest);
            format!("PERCENTILE({op_str}, {k_str})")
        }

        // --- Greatest / Least ---
        Expression::Greatest(args) => {
            let parts: Vec<String> = args
                .iter()
                .map(|a| format_expr(a, table, Precedence::Lowest))
                .collect();
            format!("GREATEST({})", parts.join(", "))
        }
        Expression::Least(args) => {
            let parts: Vec<String> = args
                .iter()
                .map(|a| format_expr(a, table, Precedence::Lowest))
                .collect();
            format!("LEAST({})", parts.join(", "))
        }

        // --- NullIf ---
        Expression::NullIf { expr: inner, value } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            let val_str = format_expr(value, table, Precedence::Lowest);
            format!("NULLIF({inner_str}, {val_str})")
        }

        // --- CountIf ---
        Expression::CountIf { condition } => {
            let cond_str = format_expr(condition, table, Precedence::Lowest);
            format!("COUNTIF({cond_str})")
        }

        // --- ListAgg ---
        Expression::ListAgg { column, delimiter } => {
            let col_str = format_expr(column, table, Precedence::Lowest);
            let delim_str = format_expr(delimiter, table, Precedence::Lowest);
            format!("LISTAGG({col_str}, {delim_str})")
        }

        // --- MaxBy / MinBy ---
        Expression::MaxBy { value, sort_by } => {
            let val_str = format_expr(value, table, Precedence::Lowest);
            let sort_str = format_expr(sort_by, table, Precedence::Lowest);
            format!("MAXBY({val_str}, {sort_str})")
        }
        Expression::MinBy { value, sort_by } => {
            let val_str = format_expr(value, table, Precedence::Lowest);
            let sort_str = format_expr(sort_by, table, Precedence::Lowest);
            format!("MINBY({val_str}, {sort_str})")
        }

        // --- Rank window functions ---
        // Canonical shape `{FN}(ORDERBY(...) [, PARTITIONBY(...)])` so that
        // parse(format(x)) == x ({function} Displays as RANK/ROW_NUMBER/DENSE_RANK).
        Expression::RankWindow {
            function,
            order_by,
            partition_by,
        } => {
            let mut parts = vec![format!("ORDERBY({})", format_column_pairs(order_by))];
            if !partition_by.is_empty() {
                parts.push(format!("PARTITIONBY({})", format_column_pairs(partition_by)));
            }
            format!("{function}({})", parts.join(", "))
        }

        Expression::MeasureRef(name) => {
            format!("[{name}]")
        }

        // --- Time intelligence ---
        Expression::ToDate {
            expr: inner,
            granularity,
        } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            let func = match granularity {
                DateGranularity::Year => "YTD",
                DateGranularity::Quarter => "QTD",
                DateGranularity::Month => "MTD",
            };
            format!("{func}({inner_str})")
        }
        Expression::PeriodShift {
            expr: inner,
            offset,
            granularity,
        } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            if *offset == -1 && matches!(granularity, DateGranularity::Year) {
                format!("PRIORYEAR({inner_str})")
            } else {
                let unit = match granularity {
                    DateGranularity::Year => "YEAR",
                    DateGranularity::Quarter => "QUARTER",
                    DateGranularity::Month => "MONTH",
                };
                format!("PRIORPERIOD({inner_str}, {offset}, \"{unit}\")")
            }
        }
        Expression::DatesInPeriod {
            expr: inner,
            intervals,
            granularity,
        } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            let unit = match granularity {
                DateGranularity::Year => "YEAR",
                DateGranularity::Quarter => "QUARTER",
                DateGranularity::Month => "MONTH",
            };
            format!("DATESINPERIOD({inner_str}, {intervals}, \"{unit}\")")
        }

        // --- Host/script UDF call ---
        Expression::Call { name, args } => {
            let parts: Vec<String> = args
                .iter()
                .map(|a| format_expr(a, table, Precedence::Lowest))
                .collect();
            format!("{name}({})", parts.join(", "))
        }

        // --- Calculation-group placeholder ---
        Expression::SelectedMeasure => "SELECTEDMEASURE()".to_string(),

        // --- Semi-additive balances (period-boundary, format version 9) ---
        Expression::SemiAdditiveBalance {
            expr: inner,
            opening,
        } => {
            let inner_str = format_expr(inner, table, Precedence::Lowest);
            let func = if *opening {
                "OPENINGBALANCE"
            } else {
                "CLOSINGBALANCE"
            };
            format!("{func}({inner_str})")
        }

        // --- Transient date literal ---
        // Produced only during query-time scalar substitution (e.g. a
        // context-driven calculated column's as-of date); never present in an
        // authored/persisted expression. The arm exists for exhaustiveness.
        Expression::LiteralDate(days) => format!("{days}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_sum() {
        let expr = agg(AggregateOp::Sum, col("Amount"));
        assert_eq!(expression_to_formula(&expr, "Sales"), "SUM(Sales[Amount])");
    }

    #[test]
    fn test_binary_op() {
        let expr = col("Price").multiply(col("Quantity"));
        assert_eq!(
            expression_to_formula(&expr, "OrderItems"),
            "OrderItems[Price] * OrderItems[Quantity]"
        );
    }

    #[test]
    fn test_complex_formula() {
        let expr = Expression::BinaryOp {
            left: Box::new(agg(AggregateOp::Sum, col("Amount"))),
            op: ArithmeticOp::Divide,
            right: Box::new(agg(AggregateOp::Count, col("Id"))),
        };
        assert_eq!(
            expression_to_formula(&expr, "Sales"),
            "SUM(Sales[Amount]) / COUNT(Sales[Id])"
        );
    }

    #[test]
    fn test_precedence_parens() {
        let expr = Expression::BinaryOp {
            left: Box::new(Expression::BinaryOp {
                left: Box::new(col("A")),
                op: ArithmeticOp::Add,
                right: Box::new(col("B")),
            }),
            op: ArithmeticOp::Multiply,
            right: Box::new(col("C")),
        };
        assert_eq!(expression_to_formula(&expr, "T"), "(T[A] + T[B]) * T[C]");
    }

    #[test]
    fn test_reset() {
        let expr = agg(AggregateOp::Sum, reset(col("Amount")));
        assert_eq!(
            expression_to_formula(&expr, "Sales"),
            "SUM(RESET(Sales[Amount]))"
        );
    }

    #[test]
    fn test_qualified_col() {
        let expr = qualified_col("premium", "category");
        assert_eq!(expression_to_formula(&expr, "Products"), "premium[category]");
    }

    #[test]
    fn test_countrows() {
        let expr = count_rows();
        assert_eq!(expression_to_formula(&expr, "Sales"), "COUNTROWS()");
    }

    #[test]
    fn test_if_formula() {
        let expr = Expression::If {
            condition: Box::new(Expression::Comparison {
                left: Box::new(agg(AggregateOp::Sum, col("Amount"))),
                op: ComparisonOp::GreaterThan,
                right: Box::new(lit_int(0)),
            }),
            then_expr: Box::new(agg(AggregateOp::Sum, col("Amount"))),
            else_expr: Box::new(lit_int(0)),
        };
        assert_eq!(
            expression_to_formula(&expr, "Sales"),
            "IF(SUM(Sales[Amount]) > 0, SUM(Sales[Amount]), 0)"
        );
    }

    #[test]
    fn test_divide_formula() {
        let expr = Expression::SafeDivide {
            numerator: Box::new(agg(AggregateOp::Sum, col("Amount"))),
            denominator: Box::new(agg(AggregateOp::Count, col("Id"))),
            alternate: None,
        };
        assert_eq!(
            expression_to_formula(&expr, "Sales"),
            "DIVIDE(SUM(Sales[Amount]), COUNT(Sales[Id]))"
        );
    }

    #[test]
    fn test_coalesce_formula() {
        let expr = Expression::Coalesce(vec![agg(AggregateOp::Sum, col("Amount")), lit_int(0)]);
        assert_eq!(
            expression_to_formula(&expr, "Sales"),
            "COALESCE(SUM(Sales[Amount]), 0)"
        );
    }

    #[test]
    fn test_round_formula() {
        let expr = scalar_fn(
            ScalarFunction::Round,
            vec![agg(AggregateOp::Sum, col("Amount")), lit_int(2)],
        );
        assert_eq!(
            expression_to_formula(&expr, "Sales"),
            "ROUND(SUM(Sales[Amount]), 2)"
        );
    }

    #[test]
    fn test_var_return_formula() {
        let expr = block(
            vec![
                ("x".to_string(), agg(AggregateOp::Sum, col("Amount"))),
                ("y".to_string(), agg(AggregateOp::Count, col("Id"))),
            ],
            Expression::SafeDivide {
                numerator: Box::new(Expression::ColumnRef("x".to_string())),
                denominator: Box::new(Expression::ColumnRef("y".to_string())),
                alternate: None,
            },
        );
        // Block is formatted as VAR/RETURN instead of { }.
        let formula = expression_to_formula(&expr, "Sales");
        assert!(formula.starts_with("VAR x ="));
        assert!(formula.contains("RETURN"));
    }

    #[test]
    fn test_string_literal() {
        let expr = Expression::LiteralString("hello".to_string());
        assert_eq!(expression_to_formula(&expr, "T"), "\"hello\"");
    }

    #[test]
    fn test_blank() {
        assert_eq!(expression_to_formula(&Expression::Blank, "T"), "BLANK()");
    }

    #[test]
    fn test_measure_ref_formats_without_error() {
        // The SQL renderers reject an unexpanded MeasureRef; the formula
        // formatter must render it as [Name].
        let expr = Expression::MeasureRef("Total Sales".to_string())
            .subtract(Expression::MeasureRef("Cost".to_string()));
        assert_eq!(expression_to_formula(&expr, "Sales"), "[Total Sales] - [Cost]");
    }

    #[test]
    fn test_measure_to_formula_uses_inferred_table() {
        let measure = Measure::new(
            "Revenue",
            agg(AggregateOp::Sum, qualified_col("Sales", "amount")),
        );
        assert_eq!(measure_to_formula(&measure), "SUM(Sales[amount])");
    }

    #[test]
    fn round_trip_through_parser() {
        // Parse-independent construction, then a full parse(format(x)) cycle:
        // the formatted text must parse back to an expression that formats
        // to the same text (fixed-point round trip).
        let expr = agg(AggregateOp::Sum, qualified_col("Sales", "amount"))
            .divide(agg(AggregateOp::Count, qualified_col("Sales", "id")));
        let text = expression_to_formula(&expr, "Sales");
        assert_eq!(text, "SUM(Sales[amount]) / COUNT(Sales[id])");
        let reparsed = crate::compute::parser::parse_measure(&text).unwrap();
        assert_eq!(expression_to_formula(&reparsed, "Sales"), text);
    }
}
