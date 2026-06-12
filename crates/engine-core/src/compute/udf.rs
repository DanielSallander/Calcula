//! Host-registered scalar UDFs (user-defined functions).
//!
//! Phase 1 of the scripting roadmap: host applications register native Rust
//! scalar functions (DataFusion [`ScalarUDF`]s) with the engine, and measure
//! or calculated-column expressions call them by name via
//! [`Expression::Call`](crate::compute::expression::Expression::Call).
//! Phase 2 (sandboxed scripts) will compile scripts down to the same
//! [`ScalarUDF`] shape and register them through the same [`UdfRegistry`],
//! so all plumbing built here carries over unchanged.
//!
//! UDFs execute **locally only**: expressions containing calls are never
//! pushed down to data sources (the pushdown planner forces local
//! aggregation), and the source-SQL renderer fails closed if a call ever
//! reaches it.
//!
//! # Name rules
//!
//! DataFusion stores registered functions under their exact name but
//! normalizes *unquoted* SQL function identifiers to lowercase before
//! lookup (`SELECT MY_FUNC(x)` looks up `"my_func"`). To make resolution
//! deterministic, [`UdfRegistry::register`] requires names to match
//! `^[a-z_][a-z0-9_]{0,63}$` (lowercase). Expressions may spell the call in
//! any case — [`UdfRegistry::get`] matches case-insensitively and the SQL
//! renderer emits the name lowercased.

use std::hash::{Hash, Hasher};

use datafusion::prelude::SessionContext;

use crate::compute::expression::is_valid_call_name;
use crate::error::{EngineError, EngineResult};

// Re-exported so host applications can build UDFs without depending on
// datafusion directly (the engine facade re-exports these in turn).
pub use datafusion::logical_expr::{create_udf, ColumnarValue, ScalarUDF, Volatility};

/// Registry of host-provided scalar UDFs.
///
/// The engine facade owns the canonical registry; the measure engine and the
/// query pipeline receive it (shared via `Arc`) and register every UDF into
/// each DataFusion `SessionContext` that evaluates expression SQL.
///
/// # Versioning
///
/// Each UDF carries a host-supplied `version`. The function body is opaque
/// Rust code, so the engine cannot hash it — the version is the host's
/// declaration of "this function's behavior changed", and it feeds
/// [`UdfRegistry::identity_hash`], which the engine mixes into query-result
/// cache keys. Without it, re-registering a UDF with different behavior
/// would keep serving stale cached results.
#[derive(Debug, Clone, Default)]
pub struct UdfRegistry {
    /// Registered UDFs with their host-supplied versions. Names are unique
    /// and lowercase (enforced by [`UdfRegistry::register`]).
    udfs: Vec<(ScalarUDF, u64)>,
}

impl UdfRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a UDF with a host-supplied version, replacing any UDF
    /// already registered under the same name.
    ///
    /// The UDF's name must match `^[a-z_][a-z0-9_]{0,63}$` (lowercase):
    /// DataFusion normalizes unquoted SQL function identifiers to lowercase
    /// before lookup, so a mixed-case registration would never resolve from
    /// the SQL the engine generates.
    ///
    /// Bump `version` whenever the function's behavior changes — it is the
    /// cache-identity for the (opaque) function body (see
    /// [`UdfRegistry::identity_hash`]).
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::InvalidIdentifier`] when the name violates the
    /// rule above.
    pub fn register(&mut self, udf: ScalarUDF, version: u64) -> EngineResult<()> {
        let name = udf.name();
        if !is_valid_call_name(name) || name != name.to_lowercase() {
            return Err(EngineError::InvalidIdentifier {
                name: name.to_string(),
                reason: "UDF name must match [a-z_][a-z0-9_]* (max 64 chars, lowercase); \
                         DataFusion resolves unquoted SQL function names in lowercase"
                    .to_string(),
            });
        }
        if let Some(existing) = self.udfs.iter_mut().find(|(u, _)| u.name() == name) {
            *existing = (udf, version);
        } else {
            self.udfs.push((udf, version));
        }
        Ok(())
    }

    /// Look up a UDF by name, case-insensitively (consistent with how
    /// DataFusion resolves unquoted function identifiers).
    pub fn get(&self, name: &str) -> Option<&ScalarUDF> {
        let lowered = name.to_lowercase();
        self.udfs
            .iter()
            .find(|(u, _)| u.name() == lowered)
            .map(|(u, _)| u)
    }

    /// Names of all registered UDFs, sorted.
    pub fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .udfs
            .iter()
            .map(|(u, _)| u.name().to_string())
            .collect();
        names.sort_unstable();
        names
    }

    /// Returns `true` when no UDFs are registered.
    pub fn is_empty(&self) -> bool {
        self.udfs.is_empty()
    }

    /// Stable hash over the sorted `(name, version)` pairs of all registered
    /// UDFs.
    ///
    /// Mixed into query-result cache keys so that registering, replacing, or
    /// version-bumping a UDF invalidates cached results that may have been
    /// computed with different function behavior. The hash covers only names
    /// and host-supplied versions — function bodies are opaque, which is
    /// exactly why [`UdfRegistry::register`] takes a version.
    ///
    /// Stable for a given registry state within one process; not meant to be
    /// persisted across runs.
    pub fn identity_hash(&self) -> u64 {
        let mut pairs: Vec<(&str, u64)> = self
            .udfs
            .iter()
            .map(|(u, version)| (u.name(), *version))
            .collect();
        pairs.sort_unstable();
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        pairs.len().hash(&mut hasher);
        for (name, version) in pairs {
            name.hash(&mut hasher);
            version.hash(&mut hasher);
        }
        hasher.finish()
    }
}

/// Create a DataFusion `SessionContext` with every UDF in `registry`
/// registered.
///
/// All expression-evaluating SQL in the engine (measure engine, calculated
/// column materialization, the local-aggregation pipeline) creates its
/// session contexts through this function so that
/// [`Expression::Call`](crate::compute::expression::Expression::Call) nodes
/// resolve uniformly everywhere.
pub fn session_context_with_udfs(registry: &UdfRegistry) -> SessionContext {
    let ctx = SessionContext::new();
    for (udf, _) in &registry.udfs {
        ctx.register_udf(udf.clone());
    }
    ctx
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use arrow::array::Float64Array;
    use arrow::datatypes::DataType as ArrowDataType;

    use super::*;

    /// `double(x) = x * 2` over Float64.
    pub(crate) fn double_udf() -> ScalarUDF {
        create_udf(
            "double",
            vec![ArrowDataType::Float64],
            ArrowDataType::Float64,
            Volatility::Immutable,
            Arc::new(|args: &[ColumnarValue]| {
                let arrays = ColumnarValue::values_to_arrays(args)?;
                let input = arrays[0]
                    .as_any()
                    .downcast_ref::<Float64Array>()
                    .ok_or_else(|| {
                        datafusion::error::DataFusionError::Internal(
                            "double: expected Float64 input".to_string(),
                        )
                    })?;
                let out: Float64Array = input.iter().map(|v| v.map(|x| x * 2.0)).collect();
                Ok(ColumnarValue::Array(Arc::new(out)))
            }),
        )
    }

    #[test]
    fn register_and_get_case_insensitive() {
        let mut registry = UdfRegistry::new();
        registry.register(double_udf(), 1).unwrap();

        assert!(registry.get("double").is_some());
        assert!(registry.get("DOUBLE").is_some());
        assert!(registry.get("Double").is_some());
        assert!(registry.get("triple").is_none());
        assert!(!registry.is_empty());
        assert_eq!(registry.names(), vec!["double".to_string()]);
    }

    #[test]
    fn register_replaces_same_name() {
        let mut registry = UdfRegistry::new();
        registry.register(double_udf(), 1).unwrap();
        registry.register(double_udf(), 2).unwrap();
        assert_eq!(registry.names().len(), 1);
    }

    #[test]
    fn register_rejects_uppercase_name() {
        let mut registry = UdfRegistry::new();
        let udf = create_udf(
            "MyFunc",
            vec![ArrowDataType::Float64],
            ArrowDataType::Float64,
            Volatility::Immutable,
            Arc::new(|_| {
                Ok(ColumnarValue::Array(Arc::new(Float64Array::from(
                    Vec::<f64>::new(),
                ))))
            }),
        );
        let err = registry.register(udf, 1).unwrap_err();
        assert!(matches!(err, EngineError::InvalidIdentifier { .. }));
        assert!(err.to_string().contains("lowercase"), "got: {err}");
    }

    #[test]
    fn register_rejects_hostile_name() {
        let mut registry = UdfRegistry::new();
        let udf = create_udf(
            "f(); drop table x; --",
            vec![],
            ArrowDataType::Float64,
            Volatility::Immutable,
            Arc::new(|_| {
                Ok(ColumnarValue::Array(Arc::new(Float64Array::from(
                    Vec::<f64>::new(),
                ))))
            }),
        );
        assert!(registry.register(udf, 1).is_err());
    }

    #[test]
    fn identity_hash_changes_with_version_and_registration() {
        let empty = UdfRegistry::new();

        let mut v1 = UdfRegistry::new();
        v1.register(double_udf(), 1).unwrap();

        let mut v2 = UdfRegistry::new();
        v2.register(double_udf(), 2).unwrap();

        assert_ne!(empty.identity_hash(), v1.identity_hash());
        assert_ne!(v1.identity_hash(), v2.identity_hash());

        // Same registrations → same hash.
        let mut v1_again = UdfRegistry::new();
        v1_again.register(double_udf(), 1).unwrap();
        assert_eq!(v1.identity_hash(), v1_again.identity_hash());
    }

    #[tokio::test]
    async fn session_context_resolves_registered_udf_in_sql() {
        use arrow::record_batch::RecordBatch;

        let mut registry = UdfRegistry::new();
        registry.register(double_udf(), 1).unwrap();

        let ctx = session_context_with_udfs(&registry);
        let schema = Arc::new(arrow::datatypes::Schema::new(vec![
            arrow::datatypes::Field::new("amount", ArrowDataType::Float64, true),
        ]));
        let batch = RecordBatch::try_new(
            schema,
            vec![Arc::new(Float64Array::from(vec![1.5, 2.5, 3.0]))],
        )
        .unwrap();
        ctx.register_batch("t", batch).unwrap();

        let df = ctx
            .sql("SELECT SUM(double(\"amount\")) AS total FROM t")
            .await
            .unwrap();
        let batches = df.collect().await.unwrap();
        let total = batches[0]
            .column(0)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap()
            .value(0);
        assert!((total - 14.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn empty_registry_session_context_has_no_udf() {
        let registry = UdfRegistry::new();
        let ctx = session_context_with_udfs(&registry);
        // Without registration the function does not resolve.
        assert!(ctx.sql("SELECT double(1.0)").await.is_err());
    }
}
