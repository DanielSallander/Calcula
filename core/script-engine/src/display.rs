//! FILENAME: core/script-engine/src/display.rs
//! PURPOSE: The `display` global — rich structured output from scripts.
//! CONTEXT: display.table(...) pushes a Table output item onto the shared
//! ScriptContext output stream. Registered on notebook AND one-off runtimes;
//! string-only surfaces (run_script, MCP) flatten Table items via
//! ScriptOutputItem::to_text(). Lives outside ops/ because the native sink is
//! an internal name, not part of the Calcula.* op surface.

use rquickjs::{Function, Object};
use std::cell::RefCell;
use std::rc::Rc;

use crate::types::{ScriptContext, ScriptOutputItem};

/// Max rows carried by a single Table output item (live response).
pub const MAX_TABLE_ROWS_PER_ITEM: usize = 200;
/// Max Table items a single cell/script run may emit (guards display.table in a loop).
pub const MAX_TABLE_ITEMS_PER_CELL: usize = 100;

/// JS glue: normalizes the accepted display.table(...) shapes into
/// `{columns, rows}` and hands the JSON to the native sink. Runs once at
/// runtime init; all user code sees only the `display` global.
const DISPLAY_GLUE_JS: &str = r#"
globalThis.display = {
  table: function (a, b) {
    let columns = [];
    let rows = [];
    if (Array.isArray(a) && Array.isArray(b)) {
      columns = a.map(String);
      rows = b;
    } else if (Array.isArray(a)) {
      if (a.length > 0 && Array.isArray(a[0])) {
        rows = a;
      } else if (a.length > 0 && typeof a[0] === "object" && a[0] !== null) {
        columns = Object.keys(a[0]);
        rows = a.map(function (o) { return columns.map(function (k) { return o[k]; }); });
      } else {
        rows = a.map(function (v) { return [v]; });
      }
    } else if (a && typeof a === "object" && Array.isArray(a.columns) && Array.isArray(a.rows)) {
      columns = a.columns.map(String);
      rows = a.rows;
    } else {
      throw new Error(
        "display.table expects an array of objects, an array of arrays, (columns, rows), or a {columns, rows} object"
      );
    }
    __calcula_display_table(JSON.stringify({ columns: columns, rows: rows }));
  },
};
"#;

/// Register the hidden native sink + the `display` JS glue object.
pub fn register_display<'js>(
    ctx: &rquickjs::Ctx<'js>,
    _globals: &Object<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
) -> Result<(), String> {
    let sink = {
        let sc = shared_ctx.clone();
        Function::new(ctx.clone(), move |json: String| {
            push_table_from_json(&sc, &json);
        })
        .map_err(|e| format!("Failed to create display sink: {}", e))?
    };
    ctx.globals()
        .set("__calcula_display_table", sink)
        .map_err(|e| format!("Failed to set display sink: {}", e))?;

    ctx.eval::<(), _>(DISPLAY_GLUE_JS)
        .map_err(|e| format!("Failed to install display glue: {}", e))?;
    Ok(())
}

/// Parse the normalized `{columns, rows}` JSON and push a Table item,
/// enforcing the per-run table cap with a single marker line.
fn push_table_from_json(sc: &Rc<RefCell<ScriptContext>>, json: &str) {
    let parsed: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return,
    };
    let item = match table_item_from_json(&parsed) {
        Some(i) => i,
        None => return,
    };
    let ctx = sc.borrow();
    let mut out = ctx.console_output.borrow_mut();
    let table_count = out
        .iter()
        .filter(|i| matches!(i, ScriptOutputItem::Table { .. }))
        .count();
    if table_count >= MAX_TABLE_ITEMS_PER_CELL {
        let marker = format!(
            "... table output limit reached ({} tables per run)",
            MAX_TABLE_ITEMS_PER_CELL
        );
        let already = out
            .last()
            .map_or(false, |i| matches!(i, ScriptOutputItem::Text { text } if *text == marker));
        if !already {
            out.push(ScriptOutputItem::text(marker));
        }
        return;
    }
    out.push(item);
}

/// Build a Table output item from a `{columns: [...], rows: [[...]]}` JSON
/// value (lenient: cells are stringified, non-array rows become single-cell
/// rows). Returns None when the value has no `columns`/`rows` arrays.
/// Result-shaped payloads may carry `totalRows`/`truncated` from an upstream
/// truncation (e.g. a model query row cap); those are honored so the rendered
/// footer reports the ORIGINAL result size.
pub fn table_item_from_json(v: &serde_json::Value) -> Option<ScriptOutputItem> {
    let obj = v.as_object()?;
    let columns_v = obj.get("columns")?.as_array()?;
    let rows_v = obj.get("rows")?.as_array()?;
    let columns: Vec<String> = columns_v.iter().map(json_scalar_to_string).collect();
    let upstream_total = obj
        .get("totalRows")
        .and_then(|t| t.as_u64())
        .map(|t| t as usize)
        .filter(|t| *t >= rows_v.len());
    let upstream_truncated = obj.get("truncated").and_then(|t| t.as_bool()).unwrap_or(false);
    let total_rows = upstream_total.unwrap_or(rows_v.len());
    let truncated = upstream_truncated || rows_v.len() > MAX_TABLE_ROWS_PER_ITEM;
    let rows: Vec<Vec<String>> = rows_v
        .iter()
        .take(MAX_TABLE_ROWS_PER_ITEM)
        .map(|row| match row {
            serde_json::Value::Array(cells) => cells.iter().map(json_scalar_to_string).collect(),
            other => vec![json_scalar_to_string(other)],
        })
        .collect();
    Some(ScriptOutputItem::Table {
        columns,
        rows,
        truncated,
        total_rows,
    })
}

/// Strict table-shape check for REPL auto-render of a last-expression value:
/// an object with `columns` (all strings) and `rows` (all arrays), not both
/// empty. display.table() is the lenient, explicit path; this heuristic must
/// not swallow arbitrary user objects.
pub fn detect_table_shape(v: &serde_json::Value) -> Option<ScriptOutputItem> {
    let obj = v.as_object()?;
    let columns = obj.get("columns")?.as_array()?;
    let rows = obj.get("rows")?.as_array()?;
    if !columns.iter().all(|c| c.is_string()) {
        return None;
    }
    if !rows.iter().all(|r| r.is_array()) {
        return None;
    }
    if columns.is_empty() && rows.is_empty() {
        return None;
    }
    table_item_from_json(v)
}

fn json_scalar_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => String::new(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                // Integer-valued floats print without a trailing ".0"
                if f.fract() == 0.0 && f.is_finite() && f.abs() < 9.007_199_254_740_992e15 {
                    return format!("{}", f as i64);
                }
            }
            n.to_string()
        }
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_item_truncates_and_flags() {
        let rows: Vec<serde_json::Value> = (0..250)
            .map(|i| serde_json::json!([i, format!("r{}", i)]))
            .collect();
        let v = serde_json::json!({ "columns": ["n", "label"], "rows": rows });
        let item = table_item_from_json(&v).expect("table shape");
        match item {
            ScriptOutputItem::Table {
                columns,
                rows,
                truncated,
                total_rows,
            } => {
                assert_eq!(columns, vec!["n", "label"]);
                assert_eq!(rows.len(), MAX_TABLE_ROWS_PER_ITEM);
                assert!(truncated);
                assert_eq!(total_rows, 250);
                assert_eq!(rows[0], vec!["0", "r0"]);
            }
            _ => panic!("expected table"),
        }
    }

    #[test]
    fn detect_table_shape_rejects_loose_objects() {
        // rows not all arrays -> not a table
        let v = serde_json::json!({ "columns": ["a"], "rows": [1, 2] });
        assert!(detect_table_shape(&v).is_none());
        // columns not all strings -> not a table
        let v = serde_json::json!({ "columns": [1], "rows": [[1]] });
        assert!(detect_table_shape(&v).is_none());
        // both empty -> not a table
        let v = serde_json::json!({ "columns": [], "rows": [] });
        assert!(detect_table_shape(&v).is_none());
        // headers-only empty result IS a table (empty query results render)
        let v = serde_json::json!({ "columns": ["a"], "rows": [] });
        assert!(detect_table_shape(&v).is_some());
    }

    #[test]
    fn scalar_formatting() {
        assert_eq!(json_scalar_to_string(&serde_json::json!(null)), "");
        assert_eq!(json_scalar_to_string(&serde_json::json!(true)), "true");
        assert_eq!(json_scalar_to_string(&serde_json::json!(42.0)), "42");
        assert_eq!(json_scalar_to_string(&serde_json::json!(1.5)), "1.5");
        assert_eq!(json_scalar_to_string(&serde_json::json!("x")), "x");
    }

    #[test]
    fn to_text_flattens_table() {
        let item = ScriptOutputItem::Table {
            columns: vec!["a".into(), "b".into()],
            rows: vec![vec!["1".into(), "2".into()]],
            truncated: false,
            total_rows: 1,
        };
        assert_eq!(item.to_text(), "a\tb\n1\t2");
    }
}
