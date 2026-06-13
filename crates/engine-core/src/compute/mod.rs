//! Aggregation, measure computation, expression evaluation, and relationship traversal.

pub mod aggregate;
pub mod context;
pub mod evaluate;
pub mod expression;
pub mod join;
pub mod measure;
pub mod measure_engine;
pub mod parser;
pub mod plan;
pub mod script;
pub mod sql_util;
pub mod time_intelligence;
pub mod udf;

pub use aggregate::{
    average_column, compute_aggregate, compute_aggregates, count_column, distinct_count_column,
    sum_column, AggregateOp, AggregateResult,
};
pub use context::{
    format_filter_value, ContextResolver, EvaluationContext, FilterSource, ResolvedFilter,
    ResolvedInFilter,
};
pub use evaluate::{
    evaluate_expression, evaluate_expression_with_udfs, materialize_calculated_columns,
    materialize_calculated_columns_with_udfs,
};
pub use expression::{
    infer_fact_table, ArithmeticOp, BoundaryType, ComparisonOp, DateGranularity, DateTimeFunction,
    Expression, FilterPredicate, InPredicate, RelationshipPath, ScalarFunction, TextFunction,
    WindowFrame,
};
pub use join::{
    aggregate_over_relationship, determine_join_strategy, join_tables, JoinStrategy, JoinType,
};
pub use measure::{
    average_measure, count_measure, distinct_count_measure, expression_measure, sum_measure,
    Measure, MeasureGroup,
};
pub use measure_engine::MeasureEngine;
pub use plan::{ExecutionPlan, PlanDuration, PlanNode, PlanOperation, PlanProperty, PlanValue};
pub use script::{
    build_sandboxed_engine, compile_script_function, script_error_from_datafusion, ScriptFunction,
    ScriptFunctionBuilder, ScriptParam, ScriptSandboxConfig, ScriptType,
};
pub use sql_util::{quote_ident_bracket, quote_ident_double, sql_quote_literal};
pub use time_intelligence::lower_time_intelligence;
pub use udf::{session_context_with_udfs, UdfRegistry};
