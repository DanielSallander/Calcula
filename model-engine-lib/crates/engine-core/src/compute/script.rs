//! Sandboxed Rhai script functions embedded in model files (scripting phase 2).
//!
//! Phase 1 ([`udf`](crate::compute::udf)) let *host applications* register
//! native Rust [`ScalarUDF`]s. Phase 2 lets *model authors* embed small
//! script functions directly in the model JSON. Each [`ScriptFunction`] is
//! compiled into the same [`ScalarUDF`] shape and registered through the same
//! [`UdfRegistry`](crate::compute::udf::UdfRegistry), so everything built in
//! phase 1 (call parsing, pushdown-forcing, query-cache identity) carries
//! over unchanged.
//!
//! # Trust boundary
//!
//! Script bodies travel inside shared model files, which is a stated trust
//! boundary: a model you open may have been authored by someone else. The
//! defenses are:
//!
//! - **Deny-by-default sandbox.** Scripts run on a [`rhai::Engine`]
//!   ([`build_sandboxed_engine`]) configured with hard resource limits, with
//!   no custom functions registered, and with the standard library's
//!   trust-boundary-breaching capabilities removed: `import`/module
//!   resolution (crate-wide via the `no_module` feature — otherwise Rhai's
//!   default `FileModuleResolver` would read/execute `.rhai` files from
//!   disk), `eval`, `sleep` (a non-interruptible native thread block), and
//!   `print`/`debug` (stdout side channel). What remains is pure
//!   arithmetic / string / math computation with no filesystem, network,
//!   clock, random, or process access.
//! - **Host-owned limits.** [`ScriptSandboxConfig`] (operation budget,
//!   call-level depth, expression depth, string/array size caps) is **host
//!   policy**, held on the engine like
//!   [`SourceQueryPolicy`](../../../bi_engine/struct.Engine.html). It is
//!   *never* part of [`ScriptFunction`]: a malicious model can never raise
//!   its own budget.
//! - **Inert loading.** Deserializing a model never compiles or runs a
//!   script (a body of `loop {}` loads instantly). Compilation happens only
//!   on an explicit host action (`Engine::new` / `set_model`); execution
//!   only during a query that references the function.
//!
//! # Determinism
//!
//! No clock and no random function are exposed — deliberately. The
//! query-result cache assumes called functions are pure (same inputs →
//! same outputs); a `now()` or `rand()` would silently serve stale cached
//! results. Rhai's `time_basic` package (which registers `timestamp()` /
//! `elapsed()`) is part of its `StandardPackage`, so the engine-core
//! dependency enables Rhai's **`no_time`** feature to remove it crate-wide —
//! a hard guarantee that no clock is reachable from a script. Random access
//! is not in Rhai's core at all (it lives in the separate `rhai-rand` crate,
//! which we do not depend on). Determinism here is thus structural, not a
//! runtime check.
//!
//! # NULL semantics (v1)
//!
//! If **any** argument is NULL at a given row, the result for that row is
//! NULL and the script body is **not** run. This matches the NULL-propagating
//! behavior of the engine's built-in scalar functions and keeps script
//! authors from having to handle the null case in every body.
//!
//! # Performance
//!
//! Each row runs the interpreter once (build a fresh [`rhai::Scope`], push
//! the row's argument values, evaluate the compiled AST). This is inherently
//! slower than a vectorized native UDF — the documented cost of phase 2. The
//! interpreter is **not** vectorized; for heavy per-row logic prefer a
//! **calculated column** (materialized once at refresh) over a script measure
//! that re-runs on every query.
//!
//! The operation budget ([`ScriptSandboxConfig::max_operations`]) is **per
//! row**: a single row's evaluation cannot exceed it, but a script measure
//! over `N` rows costs up to `N * max_operations` in aggregate. DataFusion
//! invokes the UDF one record batch at a time, and the engine's query
//! cancellation is observed at batch boundaries, so the longest
//! uninterruptible run is bounded by one batch's worth of rows — not the whole
//! table. Hosts that allow large per-row budgets should size them with the
//! batch row-count in mind.

use std::sync::Arc;

use arrow::array::{
    Array, ArrayRef, BooleanArray, BooleanBuilder, Float64Array, Float64Builder, Int64Array,
    Int64Builder, StringArray, StringBuilder,
};
use arrow::datatypes::DataType as ArrowDataType;
use datafusion::error::DataFusionError;
use rhai::{Dynamic, Engine as RhaiEngine, Scope, AST};
use serde::{Deserialize, Serialize};

use crate::compute::expression::is_valid_call_name;
use crate::compute::udf::{create_udf, ColumnarValue, ScalarUDF, Volatility};
use crate::error::{EngineError, EngineResult};

/// The scalar type of a script parameter or return value.
///
/// Each maps to one Arrow type (the UDF's declared input/output type) and to
/// one Rhai value type the body sees / must produce.
///
/// | `ScriptType` | Arrow type | Rhai type |
/// |--------------|-----------|-----------|
/// | [`Int`](ScriptType::Int)       | `Int64`   | `INT` (`i64`) |
/// | [`Float`](ScriptType::Float)   | `Float64` | `FLOAT` (`f64`) |
/// | [`Bool`](ScriptType::Bool)     | `Boolean` | `bool` |
/// | [`String`](ScriptType::String) | `Utf8`    | `String` |
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScriptType {
    /// 64-bit signed integer (Arrow `Int64`, Rhai `INT`).
    Int,
    /// 64-bit float (Arrow `Float64`, Rhai `FLOAT`).
    Float,
    /// Boolean (Arrow `Boolean`, Rhai `bool`).
    Bool,
    /// UTF-8 string (Arrow `Utf8`, Rhai `String`).
    String,
}

impl ScriptType {
    /// Returns the Arrow data type this script type maps to.
    pub fn to_arrow_type(self) -> ArrowDataType {
        match self {
            ScriptType::Int => ArrowDataType::Int64,
            ScriptType::Float => ArrowDataType::Float64,
            ScriptType::Bool => ArrowDataType::Boolean,
            ScriptType::String => ArrowDataType::Utf8,
        }
    }
}

/// A single declared parameter of a [`ScriptFunction`].
///
/// The `name` is bound as a variable of the script body's scope, so it must
/// be a valid Rhai identifier (`[A-Za-z_][A-Za-z0-9_]*`). The `ty` fixes both
/// the UDF's declared Arrow input type for that argument and the Rhai value
/// type pushed into the scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScriptParam {
    name: String,
    ty: ScriptType,
}

impl ScriptParam {
    /// Create a parameter with the given name and type.
    pub fn new(name: impl Into<String>, ty: ScriptType) -> Self {
        Self {
            name: name.into(),
            ty,
        }
    }

    /// The parameter's name (the variable the body sees).
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The parameter's scalar type.
    pub fn ty(&self) -> ScriptType {
        self.ty
    }

    /// Validate the parameter name as a Rhai identifier.
    fn validate_name(&self) -> EngineResult<()> {
        if is_valid_rhai_identifier(&self.name) {
            Ok(())
        } else {
            Err(EngineError::InvalidIdentifier {
                name: self.name.clone(),
                reason: "script parameter name must match [A-Za-z_][A-Za-z0-9_]*".to_string(),
            })
        }
    }
}

/// A model-authored script function compiled to a sandboxed scalar UDF.
///
/// Travels inside the model JSON (it is `Serialize`/`Deserialize`). Build one
/// with [`ScriptFunction::builder`]:
///
/// ```
/// use engine_core::compute::script::{ScriptFunction, ScriptParam, ScriptType};
///
/// let markup = ScriptFunction::builder("markup")
///     .param("cost", ScriptType::Float)
///     .param("rate", ScriptType::Float)
///     .returns(ScriptType::Float)
///     .body("cost * rate")
///     .build();
///
/// assert_eq!(markup.name(), "markup");
/// assert_eq!(markup.params().len(), 2);
/// assert_eq!(markup.return_type(), ScriptType::Float);
/// ```
///
/// The `name` follows the same rule as [`Expression::Call`] names
/// (`[A-Za-z_][A-Za-z0-9_]{0,63}`): it is rendered unquoted into SQL when the
/// compiled UDF is called.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScriptFunction {
    name: String,
    params: Vec<ScriptParam>,
    return_type: ScriptType,
    body: String,
}

impl ScriptFunction {
    /// Start building a script function with the given name.
    pub fn builder(name: impl Into<String>) -> ScriptFunctionBuilder {
        ScriptFunctionBuilder {
            name: name.into(),
            params: Vec::new(),
            return_type: ScriptType::Float,
            body: String::new(),
        }
    }

    /// The function name (the identifier measures call).
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The declared parameters, in call order.
    pub fn params(&self) -> &[ScriptParam] {
        &self.params
    }

    /// The declared return type.
    pub fn return_type(&self) -> ScriptType {
        self.return_type
    }

    /// The Rhai source body (an expression or statement block).
    pub fn body(&self) -> &str {
        &self.body
    }

    /// Validate the function's name, parameter names, and parameter
    /// uniqueness — **without** compiling or running the body.
    ///
    /// - The function name must match the call-identifier rule (it is
    ///   rendered unquoted into SQL).
    /// - Every parameter name must be a valid Rhai identifier and unique.
    ///
    /// Returns [`EngineError::InvalidIdentifier`] on a bad name and
    /// [`EngineError::ScriptError`] on a duplicate parameter.
    pub fn validate_signature(&self) -> EngineResult<()> {
        if !is_valid_call_name(&self.name) {
            return Err(EngineError::InvalidIdentifier {
                name: self.name.clone(),
                reason: "script function name must match [A-Za-z_][A-Za-z0-9_]* \
                         (max 64 chars); it is rendered unquoted into SQL"
                    .to_string(),
            });
        }
        // Reject an oversized body before it is ever tokenized into an AST
        // (parse-time memory guard).
        if self.body.len() > MAX_SCRIPT_BODY_BYTES {
            return Err(EngineError::ScriptError {
                function: self.name.clone(),
                position: None,
                message: format!(
                    "script body is {} bytes; the maximum is {MAX_SCRIPT_BODY_BYTES}",
                    self.body.len()
                ),
            });
        }
        // A script UDF is evaluated once per row and must produce one value
        // per input row; with no parameters there is no per-row input to
        // size the output, so reject it (a constant belongs in the
        // expression, not a UDF).
        if self.params.is_empty() {
            return Err(EngineError::ScriptError {
                function: self.name.clone(),
                position: None,
                message: "a script function must declare at least one parameter".to_string(),
            });
        }
        let mut seen = std::collections::HashSet::new();
        for param in &self.params {
            param.validate_name()?;
            if !seen.insert(param.name()) {
                return Err(EngineError::ScriptError {
                    function: self.name.clone(),
                    position: None,
                    message: format!("duplicate parameter name '{}'", param.name()),
                });
            }
        }
        Ok(())
    }

    /// Stable identity hash over the function's *behavior-affecting* content:
    /// body plus the ordered parameter types and return type.
    ///
    /// Used as the UDF `version` when the function is compiled into the
    /// effective registry, so that editing a script body (or changing a
    /// parameter / return type) changes the registry's
    /// [`identity_hash`](crate::compute::udf::UdfRegistry::identity_hash) and
    /// therefore every query-cache key — stale cached results are never
    /// served for an edited script. The name is excluded (it is the registry
    /// key, not behavior); two functions differing only in name produce the
    /// same hash, which is correct.
    pub fn identity_version(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.body.hash(&mut hasher);
        self.params.len().hash(&mut hasher);
        for param in &self.params {
            // Discriminant of the type enum (cheap stable encoding).
            (param.ty() as u8).hash(&mut hasher);
        }
        (self.return_type as u8).hash(&mut hasher);
        hasher.finish()
    }
}

/// Builder for [`ScriptFunction`].
pub struct ScriptFunctionBuilder {
    name: String,
    params: Vec<ScriptParam>,
    return_type: ScriptType,
    body: String,
}

impl ScriptFunctionBuilder {
    /// Append a parameter of the given name and type.
    pub fn param(mut self, name: impl Into<String>, ty: ScriptType) -> Self {
        self.params.push(ScriptParam::new(name, ty));
        self
    }

    /// Set the return type (default [`ScriptType::Float`]).
    pub fn returns(mut self, ty: ScriptType) -> Self {
        self.return_type = ty;
        self
    }

    /// Set the Rhai source body.
    pub fn body(mut self, body: impl Into<String>) -> Self {
        self.body = body.into();
        self
    }

    /// Finish building.
    pub fn build(self) -> ScriptFunction {
        ScriptFunction {
            name: self.name,
            params: self.params,
            return_type: self.return_type,
            body: self.body,
        }
    }
}

/// Host policy: hard resource limits for the script sandbox.
///
/// These are **not** model content. Like
/// [`SourceQueryPolicy`](../../../bi_engine/struct.Engine.html) they live on
/// the host/engine so a malicious model can never relax its own limits.
/// [`Default`] is deliberately conservative.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScriptSandboxConfig {
    /// Maximum number of operations a single script evaluation may execute
    /// before the sandbox aborts it (guards against infinite loops). Default
    /// `1_000_000`.
    pub max_operations: u64,
    /// Maximum function-call nesting depth (guards against deep / infinite
    /// recursion). Default `32`.
    pub max_call_levels: usize,
    /// Maximum expression nesting depth accepted at compile time (guards
    /// against pathologically nested source). Default `64`.
    pub max_expr_depth: usize,
    /// Maximum size (in bytes/chars) of any string the script builds (guards
    /// against memory-blowup via string growth). Default `64 * 1024`.
    pub max_string_size: usize,
    /// Maximum length of any array the script builds. Default `8192`.
    pub max_array_size: usize,
    /// Maximum number of entries in any object map the script builds (guards
    /// against memory-blowup via map growth). Default `8192`.
    pub max_map_size: usize,
}

impl Default for ScriptSandboxConfig {
    fn default() -> Self {
        Self {
            max_operations: 1_000_000,
            max_call_levels: 32,
            max_expr_depth: 64,
            max_string_size: 64 * 1024,
            max_array_size: 8192,
            max_map_size: 8192,
        }
    }
}

/// Maximum accepted byte length of a script body, enforced at validation /
/// compile time so a pathologically large source string is rejected up front
/// rather than tokenized into an AST (parse-time memory guard).
pub const MAX_SCRIPT_BODY_BYTES: usize = 256 * 1024;

/// Build a sandboxed [`rhai::Engine`] from a [`ScriptSandboxConfig`].
///
/// The returned engine:
///
/// - Enforces every limit in `cfg` (`set_max_operations`,
///   `set_max_call_levels`, `set_max_expr_depths`, `set_max_string_size`,
///   `set_max_array_size`).
/// - Registers **no** custom functions and disables the dangerous parts of
///   Rhai's standard library that would otherwise breach the trust boundary:
///   - `import` / module resolution is removed crate-wide via Rhai's
///     **`no_module`** feature (enabled on the engine-core dependency), so a
///     body cannot reach the default `FileModuleResolver` to read or execute
///     `.rhai` files from disk. `import` is not even a valid token.
///   - `eval` is disabled (`disable_symbol("eval")`) so a body cannot smuggle
///     in dynamically built code that bypasses compile-time checks.
///   - `sleep` is disabled (`disable_symbol("sleep")`): it is a native call
///     into `std::thread::sleep` that the operation budget cannot interrupt,
///     so it would otherwise be an availability DoS that blocks the worker
///     thread for an attacker-chosen duration.
///   - `print` / `debug` are routed to no-op sinks (`on_print` / `on_debug`)
///     so a body cannot write attacker-controlled text to the host's stdout.
/// - The clock (`timestamp()` / `elapsed()`) is removed crate-wide via Rhai's
///   **`no_time`** feature; random is not in Rhai's core. So scripts are
///   deterministic (see the module docs). With those removed and the above
///   disabled, Rhai's remaining standard library is pure arithmetic / string /
///   math computation with no filesystem, network, clock, random, or process
///   access.
pub fn build_sandboxed_engine(cfg: &ScriptSandboxConfig) -> RhaiEngine {
    let mut engine = RhaiEngine::new();
    engine.set_max_operations(cfg.max_operations);
    engine.set_max_call_levels(cfg.max_call_levels);
    // Second argument is the per-function-body expression-depth limit; use
    // the same cap for both (we don't expose a separate knob).
    engine.set_max_expr_depths(cfg.max_expr_depth, cfg.max_expr_depth);
    engine.set_max_string_size(cfg.max_string_size);
    engine.set_max_array_size(cfg.max_array_size);
    engine.set_max_map_size(cfg.max_map_size);
    // `eval` is a keyword: disabling the symbol makes a body using it fail to
    // compile. `import` is already removed crate-wide by the `no_module`
    // Cargo feature (so it is not even a valid token); disabling the symbol is
    // belt-and-suspenders should the feature ever be dropped.
    engine.disable_symbol("eval");
    engine.disable_symbol("import");
    // `sleep` is a registered std-library function (a native `std::thread::sleep`
    // the operation budget cannot interrupt — an availability DoS that blocks
    // the worker thread). `disable_symbol` only affects keywords/operators, not
    // function identifiers, so instead override both registered signatures with
    // erroring stubs (user functions shadow package functions); a body calling
    // sleep fails at call time instead of blocking.
    engine.register_fn(
        "sleep",
        |_: rhai::INT| -> Result<(), Box<rhai::EvalAltResult>> {
            Err("`sleep` is not available in the script sandbox".into())
        },
    );
    engine.register_fn(
        "sleep",
        |_: rhai::FLOAT| -> Result<(), Box<rhai::EvalAltResult>> {
            Err("`sleep` is not available in the script sandbox".into())
        },
    );
    // Swallow print/debug so a body cannot write to the host process stdout
    // (log-injection / untracked side channel).
    engine.on_print(|_| {});
    engine.on_debug(|_, _, _| {});
    engine
}

/// Compile a [`ScriptFunction`] into a sandboxed [`ScalarUDF`].
///
/// The body is parsed **once** into a Rhai [`AST`]; a compile error becomes
/// [`EngineError::ScriptError`] carrying the function name and a best-effort
/// byte position. The resulting UDF declares its input types from the
/// parameter list and its output type from the return type, with
/// [`Volatility::Immutable`] (scripts are pure — see the module docs on
/// determinism).
///
/// The per-row invoke closure (called by DataFusion at query time) holds the
/// configured engine and compiled AST behind `Arc` (both `Send + Sync` under
/// Rhai's `sync` feature). For each row it:
///
/// 1. Returns NULL immediately if any argument is NULL at that row
///    (NULL-propagation; the body is not run).
/// 2. Builds a fresh [`Scope`], pushes each argument's scalar value under its
///    parameter name.
/// 3. Evaluates the AST; a runtime failure (operation budget, recursion
///    depth, string/array size, type error, or a non-convertible result)
///    becomes a [`DataFusionError`] whose message names the script — which
///    [`crate::compute::script::script_error_from_datafusion`] maps back to
///    [`EngineError::ScriptError`] where it crosses the engine boundary.
/// 4. Converts the [`Dynamic`] result into the declared return type and
///    appends it to the output builder.
pub fn compile_script_function(
    f: &ScriptFunction,
    cfg: &ScriptSandboxConfig,
) -> EngineResult<ScalarUDF> {
    // Validate the signature first (cheap; no compilation).
    f.validate_signature()?;

    let engine = build_sandboxed_engine(cfg);
    let ast = engine
        .compile(&f.body)
        .map_err(|e| EngineError::ScriptError {
            function: f.name.clone(),
            position: rhai_position_to_byte_offset(&f.body, e.1),
            message: e.0.to_string(),
        })?;

    let params = f.params.clone();
    let return_type = f.return_type;
    let input_types: Vec<ArrowDataType> = params.iter().map(|p| p.ty().to_arrow_type()).collect();

    // Name owned by the closure (used in runtime error messages); the
    // `create_udf` name argument is a separate borrow.
    let closure_name = f.name.clone();

    // Shared, immutable across all invocations and threads.
    let engine = Arc::new(engine);
    let ast = Arc::new(ast);

    let udf = create_udf(
        &f.name,
        input_types,
        return_type.to_arrow_type(),
        Volatility::Immutable,
        Arc::new(move |args: &[ColumnarValue]| {
            let arrays = ColumnarValue::values_to_arrays(args)?;
            evaluate_script_udf(&closure_name, &params, return_type, &engine, &ast, &arrays)
        }),
    );
    Ok(udf)
}

/// The marker prefix every script runtime error carries inside its
/// [`DataFusionError`] message, so the engine boundary can recognize a script
/// failure and recover the function name. See
/// [`script_error_from_datafusion`].
const SCRIPT_ERROR_MARKER: &str = "calcula-script-error";

/// Run the compiled script over every row, producing one output array.
fn evaluate_script_udf(
    function_name: &str,
    params: &[ScriptParam],
    return_type: ScriptType,
    engine: &RhaiEngine,
    ast: &AST,
    arrays: &[ArrayRef],
) -> Result<ColumnarValue, DataFusionError> {
    let num_rows = arrays.first().map(|a| a.len()).unwrap_or(0);

    // One output builder per declared return type.
    let mut out = OutputBuilder::new(return_type, num_rows);

    for row in 0..num_rows {
        // NULL propagation: any null argument → null result, body not run.
        if arrays.iter().any(|a| a.is_null(row)) {
            out.append_null();
            continue;
        }

        let mut scope = Scope::new();
        for (param, array) in params.iter().zip(arrays.iter()) {
            push_scalar(&mut scope, param, array.as_ref(), row)
                .map_err(|message| script_runtime_error(function_name, &message))?;
        }

        let result: Dynamic = engine
            .eval_ast_with_scope::<Dynamic>(&mut scope, ast)
            .map_err(|e| script_runtime_error(function_name, &e.to_string()))?;

        out.append_dynamic(function_name, result)
            .map_err(|message| script_runtime_error(function_name, &message))?;
    }

    Ok(ColumnarValue::Array(out.finish()))
}

/// Push one argument scalar (already known non-null) into the script scope
/// under its parameter name, coercing to the parameter's Rhai type.
fn push_scalar(
    scope: &mut Scope,
    param: &ScriptParam,
    array: &dyn Array,
    row: usize,
) -> Result<(), String> {
    match param.ty() {
        ScriptType::Int => {
            let arr = array
                .as_any()
                .downcast_ref::<Int64Array>()
                .ok_or_else(|| type_error(param, "Int64"))?;
            scope.push(param.name().to_string(), arr.value(row));
        }
        ScriptType::Float => {
            let arr = array
                .as_any()
                .downcast_ref::<Float64Array>()
                .ok_or_else(|| type_error(param, "Float64"))?;
            scope.push(param.name().to_string(), arr.value(row));
        }
        ScriptType::Bool => {
            let arr = array
                .as_any()
                .downcast_ref::<BooleanArray>()
                .ok_or_else(|| type_error(param, "Boolean"))?;
            scope.push(param.name().to_string(), arr.value(row));
        }
        ScriptType::String => {
            let arr = array
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| type_error(param, "Utf8"))?;
            scope.push(param.name().to_string(), arr.value(row).to_string());
        }
    }
    Ok(())
}

fn type_error(param: &ScriptParam, expected: &str) -> String {
    format!(
        "argument for parameter '{}' is not the expected Arrow type {expected}",
        param.name()
    )
}

/// Accumulates per-row script results into the right Arrow builder.
enum OutputBuilder {
    Int(Int64Builder),
    Float(Float64Builder),
    Bool(BooleanBuilder),
    String(StringBuilder),
}

impl OutputBuilder {
    fn new(return_type: ScriptType, capacity: usize) -> Self {
        match return_type {
            ScriptType::Int => OutputBuilder::Int(Int64Builder::with_capacity(capacity)),
            ScriptType::Float => OutputBuilder::Float(Float64Builder::with_capacity(capacity)),
            ScriptType::Bool => OutputBuilder::Bool(BooleanBuilder::with_capacity(capacity)),
            ScriptType::String => {
                OutputBuilder::String(StringBuilder::with_capacity(capacity, capacity * 8))
            }
        }
    }

    fn append_null(&mut self) {
        match self {
            OutputBuilder::Int(b) => b.append_null(),
            OutputBuilder::Float(b) => b.append_null(),
            OutputBuilder::Bool(b) => b.append_null(),
            OutputBuilder::String(b) => b.append_null(),
        }
    }

    /// Convert the script's [`Dynamic`] result into the declared output type.
    ///
    /// A Rhai `()` (unit) result becomes NULL. An `INT` where `Float` is
    /// declared widens to `f64` (the common "I returned `2` not `2.0`" case).
    /// Any other mismatch is a runtime error naming the script.
    fn append_dynamic(&mut self, function_name: &str, value: Dynamic) -> Result<(), String> {
        if value.is_unit() {
            self.append_null();
            return Ok(());
        }
        match self {
            OutputBuilder::Int(b) => {
                let v = value
                    .as_int()
                    .map_err(|actual| convert_error(function_name, "Int", actual))?;
                b.append_value(v);
            }
            OutputBuilder::Float(b) => {
                // Widen an integer result to float; otherwise require float.
                let v = if value.is_int() {
                    value
                        .as_int()
                        .map(|i| i as f64)
                        .map_err(|actual| convert_error(function_name, "Float", actual))?
                } else {
                    value
                        .as_float()
                        .map_err(|actual| convert_error(function_name, "Float", actual))?
                };
                b.append_value(v);
            }
            OutputBuilder::Bool(b) => {
                let v = value
                    .as_bool()
                    .map_err(|actual| convert_error(function_name, "Bool", actual))?;
                b.append_value(v);
            }
            OutputBuilder::String(b) => {
                let type_name = value.type_name();
                let v = value
                    .into_string()
                    .map_err(|_| convert_error(function_name, "String", type_name))?;
                b.append_value(v);
            }
        }
        Ok(())
    }

    fn finish(mut self) -> ArrayRef {
        match &mut self {
            OutputBuilder::Int(b) => Arc::new(b.finish()) as ArrayRef,
            OutputBuilder::Float(b) => Arc::new(b.finish()) as ArrayRef,
            OutputBuilder::Bool(b) => Arc::new(b.finish()) as ArrayRef,
            OutputBuilder::String(b) => Arc::new(b.finish()) as ArrayRef,
        }
    }
}

fn convert_error(function_name: &str, declared: &str, actual: &str) -> String {
    format!(
        "script '{function_name}' returned a {actual} but its declared return type is {declared}"
    )
}

/// Build the [`DataFusionError`] for a script runtime failure, embedding the
/// marker and function name so the engine boundary can map it back to
/// [`EngineError::ScriptError`].
fn script_runtime_error(function_name: &str, message: &str) -> DataFusionError {
    DataFusionError::Execution(format!("{SCRIPT_ERROR_MARKER}|{function_name}|{message}"))
}

/// Recover an [`EngineError::ScriptError`] from a [`DataFusionError`] raised
/// by a compiled script UDF, or `None` if the error did not originate from a
/// script.
///
/// The engine boundary (pipeline / measure engine) calls this so a sandbox
/// abort (op-budget exceeded, recursion limit, type error) surfaces as a
/// clear, named [`EngineError::ScriptError`] rather than an opaque DataFusion
/// error.
pub fn script_error_from_datafusion(err: &DataFusionError) -> Option<EngineError> {
    let text = err.to_string();
    let idx = text.find(SCRIPT_ERROR_MARKER)?;
    let rest = &text[idx + SCRIPT_ERROR_MARKER.len()..];
    // Format: "|<function>|<message>" (possibly with a DataFusion prefix
    // before the marker and trailing context after — split on the first two
    // pipes only).
    let mut parts = rest.splitn(3, '|');
    let _empty = parts.next(); // leading "" before first '|'
    let function = parts.next()?.to_string();
    let message = parts.next().unwrap_or("").to_string();
    Some(EngineError::ScriptError {
        function,
        position: None,
        message,
    })
}

/// Best-effort conversion of a Rhai [`rhai::Position`] (1-based line/column)
/// into a byte offset into `body`, for inline error highlighting.
///
/// Returns `None` when Rhai reports no position. The column is treated as a
/// byte column (Rhai counts characters; for ASCII bodies — the common case —
/// this matches). Out-of-range positions clamp to the body length.
fn rhai_position_to_byte_offset(body: &str, position: rhai::Position) -> Option<usize> {
    if position.is_none() {
        return None;
    }
    let line = position.line()?; // 1-based
    let column = position.position().unwrap_or(1); // 1-based
                                                   // Sum byte lengths of all lines before `line`, then add the column.
    let mut offset = 0usize;
    for (i, line_text) in body.split_inclusive('\n').enumerate() {
        if i + 1 == line {
            // column is 1-based within this line.
            let col_bytes = line_text
                .char_indices()
                .nth(column.saturating_sub(1))
                .map(|(b, _)| b)
                .unwrap_or(line_text.len());
            return Some((offset + col_bytes).min(body.len()));
        }
        offset += line_text.len();
    }
    Some(body.len().min(offset))
}

/// Returns `true` when `name` is a valid Rhai identifier
/// (`[A-Za-z_][A-Za-z0-9_]*`, non-empty). Used for parameter names.
fn is_valid_rhai_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn markup() -> ScriptFunction {
        ScriptFunction::builder("markup")
            .param("cost", ScriptType::Float)
            .param("rate", ScriptType::Float)
            .returns(ScriptType::Float)
            .body("cost * rate")
            .build()
    }

    // --- ScriptType <-> Arrow mapping ---

    #[test]
    fn script_type_maps_to_arrow() {
        assert_eq!(ScriptType::Int.to_arrow_type(), ArrowDataType::Int64);
        assert_eq!(ScriptType::Float.to_arrow_type(), ArrowDataType::Float64);
        assert_eq!(ScriptType::Bool.to_arrow_type(), ArrowDataType::Boolean);
        assert_eq!(ScriptType::String.to_arrow_type(), ArrowDataType::Utf8);
    }

    // --- Serde round-trip ---

    #[test]
    fn script_function_serde_round_trip() {
        let f = markup();
        let json = serde_json::to_string(&f).unwrap();
        let back: ScriptFunction = serde_json::from_str(&json).unwrap();
        assert_eq!(f, back);
        assert_eq!(back.name(), "markup");
        assert_eq!(back.params()[0].name(), "cost");
        assert_eq!(back.params()[1].ty(), ScriptType::Float);
        assert_eq!(back.return_type(), ScriptType::Float);
        assert_eq!(back.body(), "cost * rate");
    }

    // --- Signature validation ---

    #[test]
    fn validate_signature_accepts_good_function() {
        assert!(markup().validate_signature().is_ok());
    }

    #[test]
    fn validate_signature_rejects_bad_function_name() {
        let f = ScriptFunction::builder("bad name")
            .returns(ScriptType::Int)
            .body("1")
            .build();
        assert!(matches!(
            f.validate_signature(),
            Err(EngineError::InvalidIdentifier { .. })
        ));
    }

    #[test]
    fn validate_signature_rejects_bad_param_name() {
        let f = ScriptFunction::builder("f")
            .param("1bad", ScriptType::Int)
            .returns(ScriptType::Int)
            .body("1")
            .build();
        assert!(matches!(
            f.validate_signature(),
            Err(EngineError::InvalidIdentifier { .. })
        ));
    }

    #[test]
    fn validate_signature_rejects_duplicate_param() {
        let f = ScriptFunction::builder("f")
            .param("x", ScriptType::Int)
            .param("x", ScriptType::Float)
            .returns(ScriptType::Int)
            .body("x")
            .build();
        assert!(matches!(
            f.validate_signature(),
            Err(EngineError::ScriptError { .. })
        ));
    }

    // --- identity_version ---

    #[test]
    fn identity_version_changes_with_body_and_types() {
        let base = markup();
        let edited_body = ScriptFunction::builder("markup")
            .param("cost", ScriptType::Float)
            .param("rate", ScriptType::Float)
            .returns(ScriptType::Float)
            .body("cost * rate * 1.1")
            .build();
        let edited_ret = ScriptFunction::builder("markup")
            .param("cost", ScriptType::Float)
            .param("rate", ScriptType::Float)
            .returns(ScriptType::Int)
            .body("cost * rate")
            .build();
        assert_ne!(base.identity_version(), edited_body.identity_version());
        assert_ne!(base.identity_version(), edited_ret.identity_version());
        // Stable for the same definition.
        assert_eq!(base.identity_version(), markup().identity_version());
    }

    #[test]
    fn identity_version_ignores_name() {
        let a = ScriptFunction::builder("a")
            .param("x", ScriptType::Int)
            .returns(ScriptType::Int)
            .body("x + 1")
            .build();
        let b = ScriptFunction::builder("b")
            .param("x", ScriptType::Int)
            .returns(ScriptType::Int)
            .body("x + 1")
            .build();
        assert_eq!(a.identity_version(), b.identity_version());
    }

    // --- Compilation: success / error ---

    #[test]
    fn compile_simple_function_succeeds() {
        let udf = compile_script_function(&markup(), &ScriptSandboxConfig::default()).unwrap();
        assert_eq!(udf.name(), "markup");
    }

    #[test]
    fn compile_syntax_error_reports_script_error_with_position() {
        let f = ScriptFunction::builder("broken")
            .param("x", ScriptType::Int)
            .returns(ScriptType::Int)
            .body("x +") // dangling operator
            .build();
        let err = compile_script_function(&f, &ScriptSandboxConfig::default()).unwrap_err();
        match err {
            EngineError::ScriptError {
                function, position, ..
            } => {
                assert_eq!(function, "broken");
                assert!(
                    position.is_some(),
                    "expected a byte position for a syntax error"
                );
            }
            other => panic!("expected ScriptError, got {other:?}"),
        }
    }

    // --- Per-row evaluation helpers ---

    use arrow::array::{Float64Array, Int64Array};

    /// Invoke a compiled UDF over column arrays and return the result array.
    fn invoke(udf: &ScalarUDF, args: Vec<ArrayRef>) -> Result<ArrayRef, DataFusionError> {
        let cols: Vec<ColumnarValue> = args.into_iter().map(ColumnarValue::Array).collect();
        let result = udf.invoke_batch(&cols, cols_len(&cols))?;
        match result {
            ColumnarValue::Array(a) => Ok(a),
            ColumnarValue::Scalar(s) => Ok(s.to_array()?),
        }
    }

    fn cols_len(cols: &[ColumnarValue]) -> usize {
        cols.iter()
            .find_map(|c| match c {
                ColumnarValue::Array(a) => Some(a.len()),
                ColumnarValue::Scalar(_) => None,
            })
            .unwrap_or(1)
    }

    #[test]
    fn evaluates_multiply_per_row() {
        let udf = compile_script_function(&markup(), &ScriptSandboxConfig::default()).unwrap();
        let cost: ArrayRef = Arc::new(Float64Array::from(vec![10.0, 20.0, 5.0]));
        let rate: ArrayRef = Arc::new(Float64Array::from(vec![1.5, 2.0, 3.0]));
        let out = invoke(&udf, vec![cost, rate]).unwrap();
        let out = out.as_any().downcast_ref::<Float64Array>().unwrap();
        assert_eq!(out.value(0), 15.0);
        assert_eq!(out.value(1), 40.0);
        assert_eq!(out.value(2), 15.0);
    }

    #[test]
    fn int_result_widens_to_declared_float() {
        // Body returns an INT (`a + b`), declared return type is Float.
        let f = ScriptFunction::builder("addf")
            .param("a", ScriptType::Int)
            .param("b", ScriptType::Int)
            .returns(ScriptType::Float)
            .body("a + b")
            .build();
        let udf = compile_script_function(&f, &ScriptSandboxConfig::default()).unwrap();
        let a: ArrayRef = Arc::new(Int64Array::from(vec![1, 2]));
        let b: ArrayRef = Arc::new(Int64Array::from(vec![3, 4]));
        let out = invoke(&udf, vec![a, b]).unwrap();
        let out = out.as_any().downcast_ref::<Float64Array>().unwrap();
        assert_eq!(out.value(0), 4.0);
        assert_eq!(out.value(1), 6.0);
    }

    #[test]
    fn string_returning_script() {
        let f = ScriptFunction::builder("greet")
            .param("name", ScriptType::String)
            .returns(ScriptType::String)
            .body(r#""hi " + name"#)
            .build();
        let udf = compile_script_function(&f, &ScriptSandboxConfig::default()).unwrap();
        let names: ArrayRef = Arc::new(StringArray::from(vec!["ann", "bo"]));
        let out = invoke(&udf, vec![names]).unwrap();
        let out = out.as_any().downcast_ref::<StringArray>().unwrap();
        assert_eq!(out.value(0), "hi ann");
        assert_eq!(out.value(1), "hi bo");
    }

    #[test]
    fn null_argument_yields_null_result_without_running_body() {
        // If the body ran on a null row it would error (division by the
        // null-stand-in); NULL propagation must skip it entirely.
        let f = ScriptFunction::builder("inv")
            .param("x", ScriptType::Float)
            .returns(ScriptType::Float)
            .body("1.0 / x")
            .build();
        let udf = compile_script_function(&f, &ScriptSandboxConfig::default()).unwrap();
        let x: ArrayRef = Arc::new(Float64Array::from(vec![Some(2.0), None, Some(4.0)]));
        let out = invoke(&udf, vec![x]).unwrap();
        let out = out.as_any().downcast_ref::<Float64Array>().unwrap();
        assert_eq!(out.value(0), 0.5);
        assert!(out.is_null(1));
        assert_eq!(out.value(2), 0.25);
    }

    #[test]
    fn bool_returning_script() {
        let f = ScriptFunction::builder("ispos")
            .param("x", ScriptType::Int)
            .returns(ScriptType::Bool)
            .body("x > 0")
            .build();
        let udf = compile_script_function(&f, &ScriptSandboxConfig::default()).unwrap();
        let x: ArrayRef = Arc::new(Int64Array::from(vec![5, -3, 0]));
        let out = invoke(&udf, vec![x]).unwrap();
        let out = out.as_any().downcast_ref::<BooleanArray>().unwrap();
        assert!(out.value(0));
        assert!(!out.value(1));
        assert!(!out.value(2));
    }

    // --- Adversarial: sandbox limits ---

    #[test]
    fn infinite_loop_aborts_with_script_error_not_hang() {
        // Tiny op budget so the test is fast; an infinite loop must trip it.
        let cfg = ScriptSandboxConfig {
            max_operations: 10_000,
            ..ScriptSandboxConfig::default()
        };
        let f = ScriptFunction::builder("spin")
            .param("x", ScriptType::Int)
            .returns(ScriptType::Int)
            .body("loop {}")
            .build();
        let udf = compile_script_function(&f, &cfg).unwrap();
        let x: ArrayRef = Arc::new(Int64Array::from(vec![1]));
        let err = invoke(&udf, vec![x]).unwrap_err();
        let recovered = script_error_from_datafusion(&err).expect("script error expected");
        match recovered {
            EngineError::ScriptError { function, .. } => assert_eq!(function, "spin"),
            other => panic!("expected ScriptError, got {other:?}"),
        }
    }

    #[test]
    fn deep_recursion_aborts_with_script_error() {
        let cfg = ScriptSandboxConfig {
            max_call_levels: 8,
            max_operations: 1_000_000,
            ..ScriptSandboxConfig::default()
        };
        // A recursive Rhai function that never bottoms out.
        let f = ScriptFunction::builder("rec")
            .param("x", ScriptType::Int)
            .returns(ScriptType::Int)
            .body("fn walk(n) { walk(n + 1) } walk(x)")
            .build();
        let udf = compile_script_function(&f, &cfg).unwrap();
        let x: ArrayRef = Arc::new(Int64Array::from(vec![1]));
        let err = invoke(&udf, vec![x]).unwrap_err();
        assert!(script_error_from_datafusion(&err).is_some());
    }

    #[test]
    fn huge_string_growth_aborts_with_script_error() {
        let cfg = ScriptSandboxConfig {
            max_string_size: 64,
            max_operations: 1_000_000,
            ..ScriptSandboxConfig::default()
        };
        // Grow a string past the cap.
        let f = ScriptFunction::builder("grow")
            .param("x", ScriptType::Int)
            .returns(ScriptType::String)
            .body(r#"let s = "x"; let i = 0; while i < 1000 { s += "xxxxxxxxxx"; i += 1; } s"#)
            .build();
        let udf = compile_script_function(&f, &cfg).unwrap();
        let x: ArrayRef = Arc::new(Int64Array::from(vec![1]));
        let err = invoke(&udf, vec![x]).unwrap_err();
        assert!(script_error_from_datafusion(&err).is_some());
    }

    #[test]
    fn no_filesystem_access_body_fails_to_compile_or_run() {
        // `open_file` is not a registered function; the body must fail
        // (proving no I/O capability is reachable). It fails at runtime as
        // an unknown function call.
        let f = ScriptFunction::builder("io")
            .param("x", ScriptType::Int)
            .returns(ScriptType::Int)
            .body(r#"open_file("/etc/passwd"); x"#)
            .build();
        // Compilation may succeed (Rhai resolves calls at runtime) but
        // evaluation must fail because no such function exists.
        match compile_script_function(&f, &ScriptSandboxConfig::default()) {
            Ok(udf) => {
                let x: ArrayRef = Arc::new(Int64Array::from(vec![1]));
                let err = invoke(&udf, vec![x]).unwrap_err();
                assert!(
                    script_error_from_datafusion(&err).is_some(),
                    "I/O attempt must produce a script error, not succeed"
                );
            }
            Err(EngineError::ScriptError { .. }) => { /* also acceptable */ }
            Err(other) => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn eval_is_disabled() {
        // `eval` is disabled as a symbol — a body using it must not compile.
        let f = ScriptFunction::builder("ev")
            .param("x", ScriptType::Int)
            .returns(ScriptType::Int)
            .body(r#"eval("1 + 1")"#)
            .build();
        let result = compile_script_function(&f, &ScriptSandboxConfig::default());
        // Either it fails to compile, or (if compiled) fails to run because
        // eval is not available. Both prove eval is unreachable.
        match result {
            Err(EngineError::ScriptError { .. }) => {}
            Ok(udf) => {
                let x: ArrayRef = Arc::new(Int64Array::from(vec![1]));
                let err = invoke(&udf, vec![x]).unwrap_err();
                assert!(script_error_from_datafusion(&err).is_some());
            }
            Err(other) => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn import_is_unavailable_no_filesystem_escape() {
        // The `no_module` feature removes `import` entirely, so a body that
        // tries to reach the filesystem via module resolution must not
        // compile (cannot read or execute a .rhai file from disk).
        for body in [
            r#"import "payload" as m; x"#,
            r#"import "C:/Windows/System32/drivers/etc/hosts" as m; x"#,
        ] {
            let f = ScriptFunction::builder("imp")
                .param("x", ScriptType::Int)
                .returns(ScriptType::Int)
                .body(body)
                .build();
            let result = compile_script_function(&f, &ScriptSandboxConfig::default());
            assert!(
                matches!(result, Err(EngineError::ScriptError { .. })),
                "import must be rejected at compile, got {result:?}"
            );
        }
    }

    #[test]
    fn sleep_is_unavailable_no_thread_block_dos() {
        // `sleep` is overridden with an erroring stub: a body calling it (with
        // an INT or FLOAT argument) fails at call time rather than blocking the
        // worker thread. The body compiles but invocation must error — and must
        // NOT actually sleep (the test would otherwise hang).
        for body in ["sleep(86400); x", "sleep(3600.0); x"] {
            let f = ScriptFunction::builder("nap")
                .param("x", ScriptType::Int)
                .returns(ScriptType::Int)
                .body(body)
                .build();
            let udf = compile_script_function(&f, &ScriptSandboxConfig::default()).unwrap();
            let x: ArrayRef = Arc::new(Int64Array::from(vec![1]));
            let err = invoke(&udf, vec![x]).unwrap_err();
            assert!(
                script_error_from_datafusion(&err).is_some(),
                "calling sleep must error, got {err:?}"
            );
        }
    }

    #[test]
    fn print_is_swallowed_and_body_still_evaluates() {
        // `print`/`debug` are routed to no-op sinks; a body using print must
        // still run and return its value (proving no panic and no host stdout
        // write path). Output suppression itself can't be asserted from a unit
        // test, but the on_print no-op closure guarantees it.
        let f = ScriptFunction::builder("noisy")
            .param("x", ScriptType::Int)
            .returns(ScriptType::Int)
            .body(r#"print("hello " + x.to_string()); x + 1"#)
            .build();
        let udf = compile_script_function(&f, &ScriptSandboxConfig::default()).unwrap();
        let x: ArrayRef = Arc::new(Int64Array::from(vec![41]));
        let out = invoke(&udf, vec![x]).unwrap();
        let out = out.as_any().downcast_ref::<Int64Array>().unwrap();
        assert_eq!(out.value(0), 42);
    }

    #[test]
    fn unbounded_map_growth_aborts_with_script_error() {
        // Object maps are capped via set_max_map_size; a body growing a map
        // past the cap aborts instead of exhausting memory.
        let cfg = ScriptSandboxConfig {
            max_map_size: 16,
            ..ScriptSandboxConfig::default()
        };
        let f = ScriptFunction::builder("grow")
            .param("x", ScriptType::Int)
            .returns(ScriptType::Int)
            .body("let m = #{}; let i = 0; while i < 100000 { m[i.to_string()] = i; i += 1; } x")
            .build();
        let udf = compile_script_function(&f, &cfg).unwrap();
        let x: ArrayRef = Arc::new(Int64Array::from(vec![1]));
        let err = invoke(&udf, vec![x]).unwrap_err();
        assert!(
            script_error_from_datafusion(&err).is_some(),
            "map growth past cap must abort as a script error"
        );
    }

    #[test]
    fn oversized_body_is_rejected_at_validation() {
        let body = "0;".repeat(MAX_SCRIPT_BODY_BYTES); // ~512 KB > cap
        let f = ScriptFunction::builder("huge")
            .param("x", ScriptType::Int)
            .returns(ScriptType::Int)
            .body(body)
            .build();
        assert!(matches!(
            f.validate_signature(),
            Err(EngineError::ScriptError { .. })
        ));
    }

    #[test]
    fn zero_parameter_script_is_rejected() {
        let f = ScriptFunction::builder("konst")
            .returns(ScriptType::Int)
            .body("42")
            .build();
        assert!(matches!(
            f.validate_signature(),
            Err(EngineError::ScriptError { .. })
        ));
        // And it cannot be compiled either (validate runs first).
        assert!(compile_script_function(&f, &ScriptSandboxConfig::default()).is_err());
    }

    // --- Determinism ---

    #[test]
    fn same_inputs_produce_same_outputs_across_runs() {
        let udf = compile_script_function(&markup(), &ScriptSandboxConfig::default()).unwrap();
        let cost: ArrayRef = Arc::new(Float64Array::from(vec![10.0, 20.0]));
        let rate: ArrayRef = Arc::new(Float64Array::from(vec![1.5, 2.0]));
        let out1 = invoke(&udf, vec![cost.clone(), rate.clone()]).unwrap();
        let out2 = invoke(&udf, vec![cost, rate]).unwrap();
        let a = out1.as_any().downcast_ref::<Float64Array>().unwrap();
        let b = out2.as_any().downcast_ref::<Float64Array>().unwrap();
        assert_eq!(a.values(), b.values());
    }

    #[test]
    fn no_clock_or_random_function_is_callable() {
        for body in [r#"timestamp()"#, r#"rand()"#, r#"random()"#] {
            let f = ScriptFunction::builder("nd")
                .param("x", ScriptType::Int)
                .returns(ScriptType::Int)
                .body(format!("{body}; x"))
                .build();
            match compile_script_function(&f, &ScriptSandboxConfig::default()) {
                Ok(udf) => {
                    let x: ArrayRef = Arc::new(Int64Array::from(vec![1]));
                    let err = invoke(&udf, vec![x]).unwrap_err();
                    assert!(
                        script_error_from_datafusion(&err).is_some(),
                        "'{body}' must not be callable (no clock/random exposed)"
                    );
                }
                Err(EngineError::ScriptError { .. }) => { /* acceptable */ }
                Err(other) => panic!("unexpected error for '{body}': {other:?}"),
            }
        }
    }

    // --- position conversion ---

    #[test]
    fn position_conversion_handles_multiline() {
        // Line 2, column 1 → offset == length of line 1 (incl newline).
        let body = "let a = 1;\nbroken +";
        let f = ScriptFunction::builder("ml")
            .param("x", ScriptType::Int)
            .returns(ScriptType::Int)
            .body(body)
            .build();
        let err = compile_script_function(&f, &ScriptSandboxConfig::default()).unwrap_err();
        if let EngineError::ScriptError { position, .. } = err {
            let p = position.expect("position");
            assert!(
                p >= body.find('\n').unwrap(),
                "position should be on line 2"
            );
        } else {
            panic!("expected ScriptError");
        }
    }
}
