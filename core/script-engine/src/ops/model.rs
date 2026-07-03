//! FILENAME: core/script-engine/src/ops/model.rs
//! PURPOSE: The read-only `model` global — script access to BI data models.
//! CONTEXT: Bridges JS calls to the host-injected ModelDataProvider
//! (model_provider.rs). Native sinks are hidden `__calcula_model_*` functions;
//! the user-facing `model.*` namespace is installed by a JS glue snippet that
//! also decorates query results with `.objects()` / `.toGrid()`. On surfaces
//! without a provider (one-off run_script, MCP) every call throws a clear
//! "not available on this surface" error. Capability consent + audit happen
//! HOST-SIDE in the provider (keyed by ScriptContext.surface_id); a consent
//! miss surfaces as a JS error carrying the BI_CONSENT_REQUIRED sentinel that
//! the notebook frontend turns into a grant prompt + retry.

use rquickjs::{Ctx, Function, Object};
use std::cell::RefCell;
use std::rc::Rc;

use crate::model_provider::{ModelProviderError, ModelProviderErrorKind, ModelQuerySpec, ModelTable};
use crate::types::ScriptContext;

/// JS glue: the user-facing `model` namespace over the native sinks, plus the
/// result decorator. Kept as plain functions (no classes) so results stay
/// JSON-friendly and auto-render as tables when they are a cell's last value.
const MODEL_GLUE_JS: &str = r#"
globalThis.model = (function () {
  function wrap(r) {
    Object.defineProperty(r, "objects", {
      value: function () {
        var cols = r.columns;
        return r.rows.map(function (row) {
          var o = {};
          cols.forEach(function (c, i) { o[c] = row[i]; });
          return o;
        });
      },
      enumerable: false,
    });
    Object.defineProperty(r, "toGrid", {
      value: function (startRow, startCol, opts) {
        opts = opts || {};
        var headers = opts.headers !== false;
        var rr = startRow;
        var writeCell = function (row, col, v) {
          if (opts.sheet === undefined || opts.sheet === null) {
            Calcula.setCellValue(row, col, v);
          } else {
            Calcula.setCellValue(row, col, v, opts.sheet);
          }
        };
        if (headers && r.columns.length > 0) {
          for (var c = 0; c < r.columns.length; c++) {
            writeCell(rr, startCol + c, String(r.columns[c]));
          }
          rr++;
        }
        for (var i = 0; i < r.rows.length; i++) {
          var row = r.rows[i];
          for (var j = 0; j < row.length; j++) {
            var v = row[j];
            writeCell(rr, startCol + j, v === null || v === undefined ? "" : String(v));
          }
          rr++;
        }
        return {
          rows: rr - startRow,
          cols: r.columns.length || (r.rows[0] ? r.rows[0].length : 0),
        };
      },
      enumerable: false,
    });
    return r;
  }
  return {
    connections: function () {
      return JSON.parse(__calcula_model_connections());
    },
    info: function (conn) {
      return JSON.parse(__calcula_model_info(String(conn)));
    },
    query: function (conn, spec) {
      return wrap(JSON.parse(__calcula_model_query(String(conn), JSON.stringify(spec || {}))));
    },
    sql: function (conn, sql) {
      return wrap(JSON.parse(__calcula_model_sql(String(conn), String(sql))));
    },
    value: function (conn) {
      var members = Array.prototype.slice.call(arguments, 1).map(String);
      var s = __calcula_model_value(String(conn), JSON.stringify(members));
      return s === "" ? null : Number(s);
    },
    members: function (conn, level) {
      return JSON.parse(__calcula_model_members(String(conn), String(level)));
    },
    kpi: function (conn, name, property) {
      var p = property === undefined || property === null ? 1 : Number(property);
      var s = __calcula_model_kpi(String(conn), String(name), p);
      return s === "" ? null : Number(s);
    },
  };
})();
"#;

/// Convert a provider error into a thrown JS exception. ConsentRequired gets
/// the machine-readable sentinel prefix the frontend consent flow parses.
fn provider_err<'js>(ctx: &Ctx<'js>, surface: &str, e: ModelProviderError) -> rquickjs::Error {
    let message = match e.kind {
        ModelProviderErrorKind::ConsentRequired => format!(
            "BI_CONSENT_REQUIRED capability={} surface={} — model access needs this capability; approve the prompt to grant it for this session",
            e.message, surface
        ),
        ModelProviderErrorKind::Timeout => format!("Model query timed out: {}", e.message),
        _ => e.message,
    };
    rquickjs::Exception::throw_message(ctx, &message)
}

/// The provider + surface for a call, or a clear surface error.
fn provider_of(
    sc: &Rc<RefCell<ScriptContext>>,
) -> Result<(Rc<dyn crate::model_provider::ModelDataProvider>, String), String> {
    let ctx = sc.borrow();
    match &ctx.model_provider {
        Some(p) => Ok((p.clone(), ctx.surface_id.clone())),
        None => Err("Model API is not available on this surface".to_string()),
    }
}

/// Register the hidden native sinks + the `model` JS glue namespace.
pub fn register_model_ops<'js>(
    ctx: &Ctx<'js>,
    _globals: &Object<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
) -> Result<(), String> {
    let globals = ctx.globals();

    // __calcula_model_connections() -> JSON array string
    {
        let sc = shared_ctx.clone();
        let f = Function::new(ctx.clone(), move |ctx: Ctx<'js>| -> rquickjs::Result<String> {
            let (p, surface) =
                provider_of(&sc).map_err(|m| rquickjs::Exception::throw_message(&ctx, &m))?;
            p.connections(&surface).map_err(|e| provider_err(&ctx, &surface, e))
        })
        .map_err(|e| format!("Failed to create model.connections: {}", e))?;
        globals
            .set("__calcula_model_connections", f)
            .map_err(|e| format!("Failed to set model sink: {}", e))?;
    }

    // __calcula_model_info(conn) -> JSON object string
    {
        let sc = shared_ctx.clone();
        let f = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, conn: String| -> rquickjs::Result<String> {
                let (p, surface) =
                    provider_of(&sc).map_err(|m| rquickjs::Exception::throw_message(&ctx, &m))?;
                p.model_info(&surface, &conn).map_err(|e| provider_err(&ctx, &surface, e))
            },
        )
        .map_err(|e| format!("Failed to create model.info: {}", e))?;
        globals
            .set("__calcula_model_info", f)
            .map_err(|e| format!("Failed to set model sink: {}", e))?;
    }

    // __calcula_model_query(conn, specJson) -> JSON result string
    {
        let sc = shared_ctx.clone();
        let f = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, conn: String, spec_json: String| -> rquickjs::Result<String> {
                let (p, surface) =
                    provider_of(&sc).map_err(|m| rquickjs::Exception::throw_message(&ctx, &m))?;
                let spec: ModelQuerySpec = serde_json::from_str(&spec_json).map_err(|e| {
                    rquickjs::Exception::throw_message(
                        &ctx,
                        &format!("Invalid query spec (expected {{measures, groupBy?, filters?}}): {}", e),
                    )
                })?;
                let table = p
                    .query(&surface, &conn, &spec)
                    .map_err(|e| provider_err(&ctx, &surface, e))?;
                table_to_json(&ctx, &table)
            },
        )
        .map_err(|e| format!("Failed to create model.query: {}", e))?;
        globals
            .set("__calcula_model_query", f)
            .map_err(|e| format!("Failed to set model sink: {}", e))?;
    }

    // __calcula_model_sql(conn, sql) -> JSON result string
    {
        let sc = shared_ctx.clone();
        let f = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, conn: String, sql: String| -> rquickjs::Result<String> {
                let (p, surface) =
                    provider_of(&sc).map_err(|m| rquickjs::Exception::throw_message(&ctx, &m))?;
                let table = p
                    .sql(&surface, &conn, &sql)
                    .map_err(|e| provider_err(&ctx, &surface, e))?;
                table_to_json(&ctx, &table)
            },
        )
        .map_err(|e| format!("Failed to create model.sql: {}", e))?;
        globals
            .set("__calcula_model_sql", f)
            .map_err(|e| format!("Failed to set model sink: {}", e))?;
    }

    // __calcula_model_value(conn, membersJson) -> "" | number-as-string
    {
        let sc = shared_ctx.clone();
        let f = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, conn: String, members_json: String| -> rquickjs::Result<String> {
                let (p, surface) =
                    provider_of(&sc).map_err(|m| rquickjs::Exception::throw_message(&ctx, &m))?;
                let members: Vec<String> = serde_json::from_str(&members_json)
                    .map_err(|e| rquickjs::Exception::throw_message(&ctx, &format!("Invalid members: {}", e)))?;
                let v = p
                    .cube_value(&surface, &conn, &members)
                    .map_err(|e| provider_err(&ctx, &surface, e))?;
                Ok(v.map(|n| n.to_string()).unwrap_or_default())
            },
        )
        .map_err(|e| format!("Failed to create model.value: {}", e))?;
        globals
            .set("__calcula_model_value", f)
            .map_err(|e| format!("Failed to set model sink: {}", e))?;
    }

    // __calcula_model_members(conn, level) -> JSON array string
    {
        let sc = shared_ctx.clone();
        let f = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, conn: String, level: String| -> rquickjs::Result<String> {
                let (p, surface) =
                    provider_of(&sc).map_err(|m| rquickjs::Exception::throw_message(&ctx, &m))?;
                let members = p
                    .cube_members(&surface, &conn, &level)
                    .map_err(|e| provider_err(&ctx, &surface, e))?;
                serde_json::to_string(&members)
                    .map_err(|e| rquickjs::Exception::throw_message(&ctx, &format!("Serialize failed: {}", e)))
            },
        )
        .map_err(|e| format!("Failed to create model.members: {}", e))?;
        globals
            .set("__calcula_model_members", f)
            .map_err(|e| format!("Failed to set model sink: {}", e))?;
    }

    // __calcula_model_kpi(conn, name, property) -> "" | number-as-string
    {
        let sc = shared_ctx.clone();
        let f = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, conn: String, kpi: String, property: i64| -> rquickjs::Result<String> {
                let (p, surface) =
                    provider_of(&sc).map_err(|m| rquickjs::Exception::throw_message(&ctx, &m))?;
                let v = p
                    .cube_kpi(&surface, &conn, &kpi, property)
                    .map_err(|e| provider_err(&ctx, &surface, e))?;
                Ok(v.map(|n| n.to_string()).unwrap_or_default())
            },
        )
        .map_err(|e| format!("Failed to create model.kpi: {}", e))?;
        globals
            .set("__calcula_model_kpi", f)
            .map_err(|e| format!("Failed to set model sink: {}", e))?;
    }

    ctx.eval::<(), _>(MODEL_GLUE_JS)
        .map_err(|e| format!("Failed to install model glue: {}", e))?;
    Ok(())
}

/// Serialize a ModelTable to the JS result shape: `{columns, rows, rowCount,
/// totalRows, truncated}` (rows keep JSON nulls so `.objects()` sees them).
/// This shape auto-renders as a Table output item when it is a notebook
/// cell's last expression (display::detect_table_shape).
fn table_to_json<'js>(ctx: &Ctx<'js>, table: &ModelTable) -> rquickjs::Result<String> {
    let payload = serde_json::json!({
        "columns": table.columns,
        "rows": table.rows,
        "rowCount": table.rows.len(),
        "totalRows": table.total_rows,
        "truncated": table.truncated,
    });
    serde_json::to_string(&payload)
        .map_err(|e| rquickjs::Exception::throw_message(ctx, &format!("Serialize failed: {}", e)))
}
