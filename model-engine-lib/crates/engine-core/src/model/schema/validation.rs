//! Identifier validation and the model-level lookup-resolution placeholder.

use crate::compute::expression::Expression;
use crate::error::{EngineError, EngineResult};

/// Characters rejected in model identifiers.
///
/// These can break out of quoted SQL identifiers (`"`, `[`, `]`, `'`, `;`)
/// or escape file/path contexts (`\`, `/`). Names with inner spaces, single
/// dots, unicode letters, or parentheses remain legal — BI models
/// legitimately use names like "Sales Amount".
const FORBIDDEN_IDENTIFIER_CHARS: [char; 7] = ['"', '[', ']', '\'', ';', '\\', '/'];

/// Validate a model identifier (table, column, calculated-column, or
/// measure name) before it can reach SQL generation or file naming.
///
/// Rejects names that are empty/whitespace-only, have leading or trailing
/// whitespace, contain control characters, contain any of
/// [`FORBIDDEN_IDENTIFIER_CHARS`], or contain the path-traversal sequence
/// `..`.
///
/// Also used by `Expression::validate()` for table references embedded in
/// expression trees, which are rendered as raw (unquoted) SQL qualifiers.
pub(crate) fn validate_identifier(name: &str, kind: &str) -> EngineResult<()> {
    let invalid = |reason: String| EngineError::InvalidIdentifier {
        name: name.to_string(),
        reason,
    };
    if name.trim().is_empty() {
        return Err(invalid(format!(
            "{kind} name must not be empty or whitespace-only"
        )));
    }
    if name != name.trim() {
        return Err(invalid(format!(
            "{kind} name must not have leading or trailing whitespace"
        )));
    }
    if name.contains("..") {
        return Err(invalid(format!(
            "{kind} name must not contain the sequence '..'"
        )));
    }
    for c in name.chars() {
        if c < '\u{20}' || c == '\u{7f}' {
            return Err(invalid(format!(
                "{kind} name must not contain control characters"
            )));
        }
        if FORBIDDEN_IDENTIFIER_CHARS.contains(&c) {
            return Err(invalid(format!("{kind} name must not contain '{c}'")));
        }
    }
    Ok(())
}

/// Maximum length in characters of short presentation-metadata strings
/// (`display_name` on tables and columns, `format_string` on measures).
pub(crate) const MAX_METADATA_NAME_CHARS: usize = 256;

/// Maximum length in characters of `description` presentation metadata.
pub(crate) const MAX_METADATA_DESCRIPTION_CHARS: usize = 1024;

/// Validate one presentation-metadata string field.
///
/// Presentation metadata (display names, descriptions, format strings) is
/// host-interpreted: the engine never parses its content, so validation is
/// deliberately minimal — a length cap so corrupt or hostile model files
/// cannot smuggle unbounded payloads through metadata, plus (for display
/// names) a non-empty requirement, since an empty-but-present display name
/// would render model objects as blank entries in host field lists.
pub(crate) fn validate_metadata_text(
    entity: &str,
    field: &str,
    value: &str,
    max_chars: usize,
    reject_empty: bool,
) -> EngineResult<()> {
    let invalid = |reason: String| EngineError::InvalidMetadata {
        entity: entity.to_string(),
        field: field.to_string(),
        reason,
    };
    if reject_empty && value.trim().is_empty() {
        return Err(invalid(
            "must not be empty or whitespace-only when present".to_string(),
        ));
    }
    let chars = value.chars().count();
    if chars > max_chars {
        return Err(invalid(format!(
            "must be at most {max_chars} characters (got {chars})"
        )));
    }
    Ok(())
}

/// Validate a table's transformation pipeline at model build time.
///
/// A pipeline travels inside a shared model file and is executed against a
/// live source on every refresh, so every property the refresh depends on is
/// established here, once, rather than discovered mid-fetch:
///
/// 1. **In-memory only.** A pipeline produces rows that exist nowhere but the
///    cache. A DirectQuery table has no cache and pushes filters and
///    aggregates to the source using the *declared* column names — which a
///    pipeline may have renamed, retyped, or invented outright. Allowing the
///    combination would generate source SQL for columns the source does not
///    have.
/// 2. **No incremental refresh.** Incremental refresh splices freshly fetched
///    **source-shaped** rows into a cache holding **transformed** rows. The
///    two shapes are not the same, so the splice would corrupt the cache.
/// 3. **A recorded source schema.** Without `source_columns` there is nothing
///    to derive from, and the pipeline could not be checked at all.
/// 4. **Declared columns match derived columns.** This is the invariant that
///    keeps the model honest: a table may not claim a shape its own pipeline
///    does not produce.
pub(crate) fn validate_table_transformations(table: &crate::model::Table) -> EngineResult<()> {
    let Some(binding) = table.source_binding() else {
        return Ok(());
    };
    if !binding.has_transformations() {
        return Ok(());
    }
    let name = table.name();
    let invalid = |reason: String| EngineError::InvalidTransform {
        table: name.to_string(),
        step_index: 0,
        reason,
    };

    if !table.is_in_memory() {
        return Err(invalid(
            "a table with transformation steps must use InMemory storage — \
             DirectQuery pushes queries to the source using this table's \
             declared column names, which its steps have already changed"
                .to_string(),
        ));
    }
    if table.incremental_refresh().is_some() {
        return Err(invalid(
            "a table cannot combine transformation steps with incremental \
             refresh: incremental refresh splices freshly fetched source rows \
             into a cache that holds transformed rows"
                .to_string(),
        ));
    }
    if binding.source_columns.is_empty() {
        return Err(invalid(
            "the table has transformation steps but no recorded source \
             columns — re-import the table or refresh its source schema"
                .to_string(),
        ));
    }

    let derived =
        crate::transform::validate_steps(name, &binding.source_columns, &binding.transformations)?;

    if !crate::transform::schemas_match(&derived, table.columns()) {
        return Err(EngineError::InvalidTransform {
            table: name.to_string(),
            step_index: binding.transformations.len().saturating_sub(1),
            reason: format!(
                "the table's declared columns do not match what its steps \
                 produce.\n  declared: {}\n  produced: {}",
                crate::transform::describe_schema(table.columns()),
                crate::transform::describe_schema(&derived)
            ),
        });
    }
    Ok(())
}

/// Validate every REST source's configuration, and the storage mode of the
/// tables bound to one, at model build time.
///
/// Two checks, for two different failure modes:
///
/// 1. **The configuration is well-formed.** A REST config travels inside a
///    shared model file (a trust boundary) and is turned into live HTTP
///    requests on every refresh, so its transport posture — https-or-loopback,
///    no credentials in the URL, no scheme smuggled into an endpoint path, a
///    bounded timeout / response size / page count — is established here rather
///    than discovered at fetch time. See
///    [`RestSourceConfig::validate`](crate::model::RestSourceConfig::validate).
/// 2. **A table bound to a REST source must be `InMemory`.** DirectQuery issues
///    one source query *per query*, and a REST endpoint answers with a full
///    (paginated) result set that the connector then restricts locally. Under
///    DirectQuery that means re-walking every page of a remote API for every
///    slicer click — pathological for the source and for the user — and the
///    connector advertises no pushdown, so nothing would be saved by it.
///    Refuse the combination rather than ship a model that is slow in a way its
///    author cannot see.
pub(crate) fn validate_rest_sources(
    sources: &[crate::model::PersistedSource],
    tables: &[crate::model::Table],
) -> EngineResult<()> {
    use crate::model::SourceKind;

    let mut rest_source_ids: Vec<&str> = Vec::new();
    for source in sources {
        match (source.kind, &source.rest) {
            (SourceKind::Rest, Some(config)) => {
                config.validate().map_err(|e| {
                    EngineError::InvalidData(format!("data source '{}': {e}", source.id))
                })?;
                rest_source_ids.push(source.id.as_str());
            }
            (SourceKind::Rest, None) => {
                return Err(EngineError::InvalidData(format!(
                    "data source '{}' is of kind 'rest' but carries no REST configuration",
                    source.id
                )));
            }
            (_, Some(_)) => {
                return Err(EngineError::InvalidData(format!(
                    "data source '{}' carries a REST configuration but is not of kind 'rest'",
                    source.id
                )));
            }
            (_, None) => {}
        }
    }
    if rest_source_ids.is_empty() {
        return Ok(());
    }

    for table in tables {
        let Some(binding) = table.source_binding() else {
            continue;
        };
        if !rest_source_ids.contains(&binding.source_id.as_str()) {
            continue;
        }
        if !table.is_in_memory() {
            return Err(EngineError::InvalidData(format!(
                "table '{}' is bound to REST source '{}' but is not InMemory; a REST \
                 endpoint is fetched and paginated in full, so DirectQuery would re-walk \
                 the whole API on every query",
                table.name(),
                binding.source_id
            )));
        }
    }
    Ok(())
}

/// Reserved placeholder identifier for the model-level default lookup
/// resolution expression
/// ([`DataModelBuilder::default_lookup_resolution`]).
///
/// In the default expression, the bare identifier `__column`
/// (case-insensitive) stands for the lookup column the expression is being
/// applied to. It is rewritten to the actual column at query time via
/// [`apply_lookup_placeholder`].
pub const LOOKUP_COLUMN_PLACEHOLDER: &str = "__column";

/// Rewrite the [`LOOKUP_COLUMN_PLACEHOLDER`] in a parsed model-level default
/// lookup resolution expression to a reference to `column_name`.
///
/// The placeholder must appear as a bare identifier — a table-qualified
/// `dim[__column]` cannot be rewritten and is rejected. An expression that
/// does not reference the placeholder at all is also rejected: it would
/// silently resolve the same hard-coded column for every lookup it is
/// applied to.
pub fn apply_lookup_placeholder(
    expression: &Expression,
    column_name: &str,
) -> EngineResult<Expression> {
    // Collect the exact spellings used for the placeholder: the comparison
    // is case-insensitive, but substitution matches names exactly.
    let spellings: Vec<String> = expression
        .column_references()
        .iter()
        .filter(|r| r.eq_ignore_ascii_case(LOOKUP_COLUMN_PLACEHOLDER))
        .map(|r| (*r).to_string())
        .collect();
    if spellings.is_empty() {
        return Err(EngineError::InvalidLookup {
            table: "(model)".to_string(),
            column: "default_lookup_resolution".to_string(),
            reason: format!(
                "expression must reference the lookup column via the \
                 '{LOOKUP_COLUMN_PLACEHOLDER}' placeholder, \
                 e.g. \"MAX({LOOKUP_COLUMN_PLACEHOLDER})\""
            ),
        });
    }

    let env: std::collections::HashMap<String, Expression> = spellings
        .into_iter()
        .map(|s| (s, Expression::ColumnRef(column_name.to_string())))
        .collect();
    let rewritten = expression.substitute_vars(&env);

    // A table-qualified placeholder (`dim[__column]`) is not substituted by
    // `substitute_vars` — reject it instead of silently rendering a
    // reference to a non-existent "__column" column.
    if rewritten
        .column_references()
        .iter()
        .any(|r| r.eq_ignore_ascii_case(LOOKUP_COLUMN_PLACEHOLDER))
    {
        return Err(EngineError::InvalidLookup {
            table: "(model)".to_string(),
            column: "default_lookup_resolution".to_string(),
            reason: format!(
                "the '{LOOKUP_COLUMN_PLACEHOLDER}' placeholder must be a bare \
                 identifier (not table-qualified)"
            ),
        });
    }
    Ok(rewritten)
}

#[cfg(test)]
mod tests {
    use super::super::test_fixtures::sales_table;
    use super::*;
    use crate::model::calculated_column::CalculatedColumn;
    use crate::model::column::Column;
    use crate::model::schema::DataModel;
    use crate::model::table::Table;
    use crate::types::DataType;

    #[test]
    fn apply_lookup_placeholder_rewrites_case_insensitively() {
        let parsed = crate::compute::parser::parse_measure_expression("MAX(__COLUMN)").unwrap();
        let rewritten = apply_lookup_placeholder(&parsed, "category_name").unwrap();
        assert_eq!(rewritten.column_references(), vec!["category_name"]);
    }

    #[test]
    fn build_rejects_table_name_with_double_quote() {
        let table = Table::new("evil\"t", vec![Column::new("a", DataType::Int32)]).unwrap();
        let result = DataModel::builder().add_table(table).build();
        assert!(matches!(
            result,
            Err(EngineError::InvalidIdentifier { ref name, .. }) if name == "evil\"t"
        ));
    }

    #[test]
    fn build_rejects_column_name_with_bracket() {
        let table = Table::new("t", vec![Column::new("c]x", DataType::Int32)]).unwrap();
        let result = DataModel::builder().add_table(table).build();
        assert!(matches!(
            result,
            Err(EngineError::InvalidIdentifier { ref name, .. }) if name == "c]x"
        ));
    }

    #[test]
    fn build_rejects_table_name_with_traversal_sequence() {
        let table = Table::new("..\\x", vec![Column::new("a", DataType::Int32)]).unwrap();
        let result = DataModel::builder().add_table(table).build();
        assert!(matches!(result, Err(EngineError::InvalidIdentifier { .. })));
    }

    #[test]
    fn build_rejects_empty_and_whitespace_table_names() {
        for bad in ["", "   ", " Sales", "Sales ", "\tSales"] {
            let table = Table::new(bad, vec![Column::new("a", DataType::Int32)]).unwrap();
            let result = DataModel::builder().add_table(table).build();
            assert!(
                matches!(result, Err(EngineError::InvalidIdentifier { .. })),
                "expected rejection of table name {bad:?}"
            );
        }
    }

    #[test]
    fn build_rejects_table_name_with_control_character() {
        let table = Table::new("Sa\x07les", vec![Column::new("a", DataType::Int32)]).unwrap();
        let result = DataModel::builder().add_table(table).build();
        assert!(matches!(result, Err(EngineError::InvalidIdentifier { .. })));
    }

    #[test]
    fn build_rejects_measure_name_with_quote() {
        // Measure names are interpolated into SQL as quoted aliases
        // (`... AS "name"`), so they must obey the same rules.
        let model = DataModel::builder()
            .add_table(sales_table())
            .add_measure(crate::compute::measure::sum_measure(
                "Rev\"enue",
                "Sales",
                "amount",
            ))
            .build();
        assert!(matches!(
            model,
            Err(EngineError::InvalidIdentifier { ref name, .. }) if name == "Rev\"enue"
        ));
    }

    #[test]
    fn build_rejects_calculated_column_name_with_semicolon() {
        let cc = CalculatedColumn::new(
            "margin;drop",
            "Sales",
            crate::compute::expression::Expression::ColumnRef("amount".to_string()),
            DataType::Float64,
        );
        let result = DataModel::builder()
            .add_table(sales_table())
            .add_calculated_column(cc)
            .build();
        assert!(matches!(
            result,
            Err(EngineError::InvalidIdentifier { ref name, .. }) if name == "margin;drop"
        ));
    }

    // --- Transformation pipelines ---

    mod transformations {
        use super::*;
        use crate::model::source::{
            PersistedAuthKind, PersistedConnection, PersistedSource, SourceKind, TableSourceBinding,
        };
        use crate::model::table::StorageMode;
        use crate::model::IncrementalRefresh;
        use crate::transform::TransformStep;

        /// A builder carrying the source catalog entry these tables bind to.
        ///
        /// The catalog check runs before transformation validation, so without
        /// this every case below would fail on a missing source instead of
        /// exercising the rule it is named for.
        fn builder_with_source() -> crate::model::DataModelBuilder {
            DataModel::builder().add_source(PersistedSource::new(
                "s",
                SourceKind::Postgres,
                PersistedConnection::default(),
                PersistedAuthKind::Integrated,
            ))
        }

        /// The source schema every case below derives from.
        fn source_columns() -> Vec<Column> {
            vec![
                Column::new("id", DataType::Int64),
                Column::new("status", DataType::String),
                Column::new("amount", DataType::Float64),
            ]
        }

        /// A table whose pipeline drops `status`, with declared columns that
        /// match — the valid baseline the other cases perturb.
        fn transformed_table() -> Table {
            Table::new(
                "Sales",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory)
            .with_source_binding(
                TableSourceBinding::new("s", "sales", "orders")
                    .with_source_columns(source_columns())
                    .with_transformations(vec![
                        TransformStep::FilterRows {
                            condition: "status <> \"cancelled\"".into(),
                        },
                        TransformStep::RemoveColumns {
                            columns: vec!["status".into()],
                        },
                    ]),
            )
        }

        #[test]
        fn a_consistent_pipeline_builds() {
            let result = builder_with_source().add_table(transformed_table()).build();
            assert!(result.is_ok(), "got {:?}", result.err());
        }

        #[test]
        fn declared_columns_must_match_what_the_steps_produce() {
            // The table still claims `status`, which its own pipeline removes.
            let table = Table::new("Sales", source_columns())
                .unwrap()
                .with_storage_mode(StorageMode::InMemory)
                .with_source_binding(
                    TableSourceBinding::new("s", "sales", "orders")
                        .with_source_columns(source_columns())
                        .with_transformations(vec![TransformStep::RemoveColumns {
                            columns: vec!["status".into()],
                        }]),
                );
            let err = builder_with_source().add_table(table).build().unwrap_err();
            let message = err.to_string();
            assert!(message.contains("do not match"), "got {message}");
            // The message must show BOTH shapes; that is what makes it fixable.
            assert!(message.contains("declared:"), "got {message}");
            assert!(message.contains("produced:"), "got {message}");
        }

        #[test]
        fn a_direct_query_table_may_not_carry_a_pipeline() {
            let mut table = transformed_table();
            table.set_storage_mode(StorageMode::DirectQuery);
            let err = builder_with_source().add_table(table).build().unwrap_err();
            assert!(err.to_string().contains("InMemory"), "got {err}");
        }

        #[test]
        fn a_pipeline_may_not_combine_with_incremental_refresh() {
            let mut table = transformed_table();
            table.set_incremental_refresh(Some(IncrementalRefresh::new("id > 0")));
            let err = builder_with_source().add_table(table).build().unwrap_err();
            assert!(err.to_string().contains("incremental"), "got {err}");
        }

        #[test]
        fn a_pipeline_without_recorded_source_columns_is_rejected() {
            let mut table = transformed_table();
            table.set_source_binding(Some(
                TableSourceBinding::new("s", "sales", "orders").with_transformations(vec![
                    TransformStep::RemoveColumns {
                        columns: vec!["status".into()],
                    },
                ]),
            ));
            let err = builder_with_source().add_table(table).build().unwrap_err();
            assert!(err.to_string().contains("source columns"), "got {err}");
        }

        #[test]
        fn an_invalid_step_is_reported_with_its_index() {
            let table = Table::new("Sales", vec![Column::new("id", DataType::Int64)])
                .unwrap()
                .with_storage_mode(StorageMode::InMemory)
                .with_source_binding(
                    TableSourceBinding::new("s", "sales", "orders")
                        .with_source_columns(source_columns())
                        .with_transformations(vec![
                            TransformStep::RemoveColumns {
                                columns: vec!["status".into()],
                            },
                            TransformStep::RemoveColumns {
                                columns: vec!["nope".into()],
                            },
                        ]),
                );
            let err = builder_with_source().add_table(table).build().unwrap_err();
            match err {
                EngineError::InvalidTransform { step_index, .. } => assert_eq!(step_index, 1),
                other => panic!("expected InvalidTransform, got {other:?}"),
            }
        }

        #[test]
        fn a_measure_over_a_column_the_pipeline_removed_is_caught() {
            // The pipeline drops `status`; a measure still counting it must
            // not survive the build.
            let model = DataModel::builder()
                .add_table(transformed_table())
                .add_measure(crate::compute::measure::sum_measure(
                    "Statuses", "Sales", "status",
                ))
                .build();
            assert!(
                model.is_err(),
                "a measure referencing a transformed-away column must be rejected"
            );
        }

        #[test]
        fn an_ordinary_bound_table_is_untouched_by_this_validation() {
            let table = Table::new("Sales", source_columns())
                .unwrap()
                .with_source_binding(TableSourceBinding::new("s", "sales", "orders"));
            assert!(builder_with_source().add_table(table).build().is_ok());
        }
    }

    // --- REST sources ---

    mod rest_sources {
        use super::*;
        use crate::model::rest::{RestEndpoint, RestSourceConfig};
        use crate::model::source::{
            PersistedAuthKind, PersistedConnection, PersistedSource, SourceKind, TableSourceBinding,
        };
        use crate::model::table::StorageMode;

        /// A valid REST configuration with one endpoint.
        fn rest_config() -> RestSourceConfig {
            RestSourceConfig::new("https://api.example.com/v1")
                .with_endpoint(RestEndpoint::new("orders", "orders"))
        }

        /// A model table bound to the REST source `web`, in-memory (the only
        /// storage mode a REST-bound table may use).
        fn rest_table() -> Table {
            Table::new("Orders", vec![Column::new("id", DataType::Int64)])
                .unwrap()
                .with_storage_mode(StorageMode::InMemory)
                .with_source_binding(TableSourceBinding::new("web", "rest", "orders"))
        }

        #[test]
        fn a_valid_rest_source_with_an_in_memory_table_builds() {
            let result = DataModel::builder()
                .add_source(PersistedSource::rest("web", rest_config()))
                .add_table(rest_table())
                .build();
            assert!(result.is_ok(), "got {:?}", result.err());
        }

        #[test]
        fn an_invalid_rest_configuration_is_rejected_at_build_naming_the_source() {
            // Plain http to a public host — refused by RestSourceConfig::validate.
            let config = RestSourceConfig::new("http://api.example.com")
                .with_endpoint(RestEndpoint::new("orders", "orders"));
            let err = DataModel::builder()
                .add_source(PersistedSource::rest("web", config))
                .build()
                .unwrap_err()
                .to_string();
            assert!(err.contains("'web'"), "got {err}");
            assert!(err.contains("plain http"), "got {err}");
        }

        #[test]
        fn a_direct_query_table_may_not_be_bound_to_a_rest_source() {
            let mut table = rest_table();
            table.set_storage_mode(StorageMode::DirectQuery);
            let err = DataModel::builder()
                .add_source(PersistedSource::rest("web", rest_config()))
                .add_table(table)
                .build()
                .unwrap_err()
                .to_string();
            assert!(err.contains("InMemory"), "got {err}");
            assert!(err.contains("re-walk"), "got {err}");
        }

        #[test]
        fn a_rest_source_without_a_configuration_is_a_corrupt_catalog_entry() {
            let source = PersistedSource::new(
                "web",
                SourceKind::Rest,
                PersistedConnection::default(),
                PersistedAuthKind::SecretMap,
            );
            let err = DataModel::builder()
                .add_source(source)
                .build()
                .unwrap_err()
                .to_string();
            assert!(err.contains("no REST configuration"), "got {err}");
        }

        #[test]
        fn a_non_rest_source_may_not_carry_a_rest_configuration() {
            let mut source = PersistedSource::new(
                "pg",
                SourceKind::Postgres,
                PersistedConnection::default(),
                PersistedAuthKind::Integrated,
            );
            source.rest = Some(rest_config());
            let err = DataModel::builder()
                .add_source(source)
                .build()
                .unwrap_err()
                .to_string();
            assert!(err.contains("not of kind 'rest'"), "got {err}");
        }

        #[test]
        fn a_model_with_no_rest_source_is_untouched_by_this_validation() {
            let table = Table::new("Sales", vec![Column::new("id", DataType::Int64)])
                .unwrap()
                .with_source_binding(TableSourceBinding::new("pg", "sales", "orders"));
            let result = DataModel::builder()
                .add_source(PersistedSource::new(
                    "pg",
                    SourceKind::Postgres,
                    PersistedConnection::default(),
                    PersistedAuthKind::Integrated,
                ))
                .add_table(table)
                .build();
            assert!(result.is_ok(), "got {:?}", result.err());
        }
    }

    #[test]
    fn build_accepts_legitimate_bi_names() {
        // Spaces, single dots, unicode letters, parentheses, and hyphens are
        // all legal in BI model names.
        let table = Table::new(
            "Sales Amount",
            vec![
                Column::new("Unit Price (USD)", DataType::Float64),
                Column::new("Försäljning", DataType::Float64),
                Column::new("v1.2 metric", DataType::Float64),
                Column::new("net-amount", DataType::Float64),
            ],
        )
        .unwrap();
        let result = DataModel::builder()
            .add_table(table)
            .add_table(Table::new("fact_sales", vec![Column::new("id", DataType::Int64)]).unwrap())
            .build();
        assert!(result.is_ok());
    }
}
