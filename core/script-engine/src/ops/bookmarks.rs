//! FILENAME: core/script-engine/src/ops/bookmarks.rs
//! PURPOSE: Bookmark operations for the script engine.
//! CONTEXT: Registers Calcula.bookmarks.* methods that allow scripts to
//! list, create, and manage both cell bookmarks and view bookmarks.
//! Mutations are queued and applied on the frontend after execution.

use rquickjs::{Ctx, Function, Object, Value};
use std::cell::RefCell;
use std::rc::Rc;

use crate::ops::resolve_opt_sheet_key;
use crate::types::{BookmarkMutation, ScriptContext};

/// Register bookmark operations on a `Calcula.bookmarks` sub-object.
pub fn register_bookmark_ops<'js>(
    ctx: &rquickjs::Ctx<'js>,
    calcula: &Object<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
) -> Result<(), String> {
    let bookmarks = Object::new(ctx.clone())
        .map_err(|e| format!("Failed to create bookmarks object: {}", e))?;

    // listCellBookmarks() -> JSON string
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> String {
            let ctx = sc.borrow();
            ctx.cell_bookmarks_json.clone()
        })
        .map_err(|e| format!("Failed to create listCellBookmarks: {}", e))?;
        bookmarks
            .set("listCellBookmarks", func)
            .map_err(|e| format!("Failed to set listCellBookmarks: {}", e))?;
    }

    // addCellBookmark(row, col, sheet?, label?, color?) -> void
    // `sheet` is a 0-based index or a sheet name; a miss THROWS (ops/mod.rs).
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>,
                  row: u32,
                  col: u32,
                  sheet: rquickjs::function::Opt<Value<'js>>,
                  label: rquickjs::function::Opt<String>,
                  color: rquickjs::function::Opt<String>|
                  -> rquickjs::Result<()> {
                let ctx_ref = sc.borrow();
                let si = resolve_opt_sheet_key(&ctx, &ctx_ref, sheet.0.as_ref())?;
                ctx_ref.bookmark_mutations.borrow_mut().push(BookmarkMutation::AddCellBookmark {
                    row,
                    col,
                    sheet_index: si,
                    label: label.0,
                    color: color.0,
                });
                Ok(())
            },
        )
        .map_err(|e| format!("Failed to create addCellBookmark: {}", e))?;
        bookmarks
            .set("addCellBookmark", func)
            .map_err(|e| format!("Failed to set addCellBookmark: {}", e))?;
    }

    // removeCellBookmark(row, col, sheet?) -> void
    // `sheet` is a 0-based index or a sheet name; a miss THROWS (ops/mod.rs).
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>,
                  row: u32,
                  col: u32,
                  sheet: rquickjs::function::Opt<Value<'js>>|
                  -> rquickjs::Result<()> {
                let ctx_ref = sc.borrow();
                let si = resolve_opt_sheet_key(&ctx, &ctx_ref, sheet.0.as_ref())?;
                ctx_ref.bookmark_mutations.borrow_mut().push(BookmarkMutation::RemoveCellBookmark {
                    row,
                    col,
                    sheet_index: si,
                });
                Ok(())
            },
        )
        .map_err(|e| format!("Failed to create removeCellBookmark: {}", e))?;
        bookmarks
            .set("removeCellBookmark", func)
            .map_err(|e| format!("Failed to set removeCellBookmark: {}", e))?;
    }

    // listViewBookmarks() -> JSON string
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> String {
            let ctx = sc.borrow();
            ctx.view_bookmarks_json.clone()
        })
        .map_err(|e| format!("Failed to create listViewBookmarks: {}", e))?;
        bookmarks
            .set("listViewBookmarks", func)
            .map_err(|e| format!("Failed to set listViewBookmarks: {}", e))?;
    }

    // createViewBookmark(label, color?, dimensionsJson?) -> void
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |label: String,
                  color: rquickjs::function::Opt<String>,
                  dimensions_json: rquickjs::function::Opt<String>| {
                let ctx = sc.borrow();
                ctx.bookmark_mutations
                    .borrow_mut()
                    .push(BookmarkMutation::CreateViewBookmark {
                        label,
                        color: color.0,
                        dimensions_json: dimensions_json.0,
                    });
            },
        )
        .map_err(|e| format!("Failed to create createViewBookmark: {}", e))?;
        bookmarks
            .set("createViewBookmark", func)
            .map_err(|e| format!("Failed to set createViewBookmark: {}", e))?;
    }

    // deleteViewBookmark(id) -> void
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |id: String| {
            let ctx = sc.borrow();
            ctx.bookmark_mutations
                .borrow_mut()
                .push(BookmarkMutation::DeleteViewBookmark { id });
        })
        .map_err(|e| format!("Failed to create deleteViewBookmark: {}", e))?;
        bookmarks
            .set("deleteViewBookmark", func)
            .map_err(|e| format!("Failed to set deleteViewBookmark: {}", e))?;
    }

    // activateViewBookmark(id) -> void
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |id: String| {
            let ctx = sc.borrow();
            ctx.bookmark_mutations
                .borrow_mut()
                .push(BookmarkMutation::ActivateViewBookmark { id });
        })
        .map_err(|e| format!("Failed to create activateViewBookmark: {}", e))?;
        bookmarks
            .set("activateViewBookmark", func)
            .map_err(|e| format!("Failed to set activateViewBookmark: {}", e))?;
    }

    calcula
        .set("bookmarks", bookmarks)
        .map_err(|e| format!("Failed to set bookmarks namespace: {}", e))?;

    Ok(())
}
