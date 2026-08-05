//! FILENAME: core/script-engine/src/ops/sheets.rs
//! PURPOSE: Sheet-related operations for the script engine.
//! CONTEXT: Registers getActiveSheet, getSheetNames, setActiveSheet, and
//! getSheetCount methods on the Calcula global object.

use rquickjs::{Ctx, Function, Object, Value};
use std::cell::RefCell;
use std::rc::Rc;

use crate::ops::resolve_sheet_key;
use crate::types::{DeferredAction, ScriptContext};

/// Register sheet operations on the Calcula object.
pub fn register_sheet_ops<'js>(
    ctx: &rquickjs::Ctx<'js>,
    calcula: &Object<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
) -> Result<(), String> {
    // getActiveSheet() -> { index, name }
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> String {
            let ctx = sc.borrow();
            let index = ctx.active_sheet;
            let name = ctx
                .sheet_names
                .get(index)
                .cloned()
                .unwrap_or_else(|| format!("Sheet{}", index + 1));
            serde_json::json!({
                "index": index,
                "name": name
            })
            .to_string()
        })
        .map_err(|e| format!("Failed to create getActiveSheet: {}", e))?;
        calcula
            .set("getActiveSheet", func)
            .map_err(|e| format!("Failed to set getActiveSheet: {}", e))?;
    }

    // getSheetNames() -> string[]
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> String {
            let ctx = sc.borrow();
            serde_json::to_string(&ctx.sheet_names).unwrap_or_else(|_| "[]".to_string())
        })
        .map_err(|e| format!("Failed to create getSheetNames: {}", e))?;
        calcula
            .set("getSheetNames", func)
            .map_err(|e| format!("Failed to set getSheetNames: {}", e))?;
    }

    // setActiveSheet(indexOrName)
    //
    // Accepts a 0-based index OR a sheet name (exact match first, then a
    // unique case-insensitive match) and THROWS on a miss, listing the
    // workbook's sheet names — it used to silently no-op, so a typo'd name
    // left every following write landing on the WRONG sheet.
    //
    // Retargets the script's own reads/writes AND queues the activation so the
    // host follows. Mutating `active_sheet` alone left the UI on the old sheet:
    // the context is discarded after the run, so "switch the active sheet" was
    // only ever true inside the script.
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, key: Value<'js>| -> rquickjs::Result<()> {
                let index = resolve_sheet_key(&ctx, &sc.borrow(), &key)?;
                let mut ctx_ref = sc.borrow_mut();
                ctx_ref.active_sheet = index;
                ctx_ref
                    .deferred_actions
                    .borrow_mut()
                    .push(DeferredAction::ActivateSheet { sheet_index: index });
                Ok(())
            },
        )
        .map_err(|e| format!("Failed to create setActiveSheet: {}", e))?;
        calcula
            .set("setActiveSheet", func)
            .map_err(|e| format!("Failed to set setActiveSheet: {}", e))?;
    }

    // getSheetCount() -> number
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> i32 {
            let ctx = sc.borrow();
            ctx.grids.len() as i32
        })
        .map_err(|e| format!("Failed to create getSheetCount: {}", e))?;
        calcula
            .set("getSheetCount", func)
            .map_err(|e| format!("Failed to set getSheetCount: {}", e))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::types::{DeferredAction, ScriptResult};
    use crate::ScriptEngine;
    use engine::grid::Grid;
    use engine::style::StyleRegistry;

    fn run(src: &str, active: usize) -> (ScriptResult, Vec<Grid>) {
        ScriptEngine::run(
            src,
            "test.js",
            vec![Grid::new(), Grid::new(), Grid::new()],
            StyleRegistry::new(),
            vec![
                "Sheet1".to_string(),
                "Budget".to_string(),
                "Data Two".to_string(),
            ],
            active,
        )
    }

    fn activations(result: &ScriptResult) -> Vec<usize> {
        match result {
            ScriptResult::Success { deferred_actions, .. } => deferred_actions
                .iter()
                .filter_map(|a| match a {
                    DeferredAction::ActivateSheet { sheet_index } => Some(*sheet_index),
                    _ => None,
                })
                .collect(),
            ScriptResult::Error { message, .. } => panic!("script error: {message}"),
        }
    }

    #[test]
    fn set_active_sheet_by_exact_name() {
        let (result, _) = run(r#"Calcula.setActiveSheet("Budget");"#, 0);
        assert_eq!(activations(&result), vec![1]);
    }

    #[test]
    fn set_active_sheet_by_unique_case_insensitive_name() {
        let (result, _) = run(r#"Calcula.setActiveSheet("data two");"#, 0);
        assert_eq!(activations(&result), vec![2]);
    }

    #[test]
    fn set_active_sheet_by_index_still_works() {
        let (result, _) = run("Calcula.setActiveSheet(2);", 0);
        assert_eq!(activations(&result), vec![2]);
    }

    #[test]
    fn set_active_sheet_retargets_following_writes() {
        let (result, grids) = run(
            r#"Calcula.setActiveSheet("Budget"); Calcula.setCellValue(0, 0, "moved");"#,
            0,
        );
        assert_eq!(activations(&result), vec![1]);
        assert!(grids[0].get_cell(0, 0).is_none());
        assert!(grids[1].get_cell(0, 0).is_some());
    }

    #[test]
    fn set_active_sheet_unknown_name_throws_listing_sheets() {
        let (result, _) = run(r#"Calcula.setActiveSheet("Bugdet");"#, 0);
        match result {
            ScriptResult::Error { message, .. } => {
                assert!(message.contains("No sheet named \"Bugdet\""), "{message}");
                assert!(message.contains("\"Sheet1\""), "{message}");
                assert!(message.contains("\"Budget\""), "{message}");
                assert!(message.contains("\"Data Two\""), "{message}");
            }
            ScriptResult::Success { .. } => panic!("expected the script to throw"),
        }
    }

    #[test]
    fn set_active_sheet_out_of_range_index_throws() {
        let (result, _) = run("Calcula.setActiveSheet(7);", 0);
        match result {
            ScriptResult::Error { message, .. } => {
                assert!(message.contains("out of range"), "{message}");
            }
            ScriptResult::Success { .. } => panic!("expected the script to throw"),
        }
    }
}
