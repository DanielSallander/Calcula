//! FILENAME: core/script-engine/src/lib.rs
//! PURPOSE: Public API for the Calcula script engine.
//! CONTEXT: Provides `ScriptEngine::run()` as the single entry point for
//! executing scripts in an embedded QuickJS runtime.
//! The engine operates on a ScriptContext (cloned from AppState) and returns
//! a ScriptResult with the outcome and any modified grid data.

pub mod ops;
pub mod runtime;
pub mod types;

use std::cell::RefCell;
use std::time::Instant;

use engine::grid::Grid;
use engine::style::StyleRegistry;

/// The main script engine. Stateless - each execution creates a fresh QuickJS runtime.
pub struct ScriptEngine;

impl ScriptEngine {
    /// Execute a JavaScript source string against spreadsheet data.
    ///
    /// # Arguments
    /// * `source` - The script source code (JavaScript)
    /// * `filename` - Display name for error messages
    /// * `grids` - Cloned grid data (one per sheet)
    /// * `style_registry` - Cloned style registry
    /// * `sheet_names` - Sheet names
    /// * `active_sheet` - Active sheet index
    ///
    /// # Returns
    /// A tuple of (ScriptResult, modified_grids) where modified_grids contains
    /// the grids after script execution (with any changes the script made).
    pub fn run(
        source: &str,
        filename: &str,
        grids: Vec<Grid>,
        style_registry: StyleRegistry,
        sheet_names: Vec<String>,
        active_sheet: usize,
    ) -> (ScriptResult, Vec<Grid>) {
        let start = Instant::now();

        let context = types::ScriptContext {
            grids,
            style_registry,
            sheet_names,
            active_sheet,
            console_output: RefCell::new(Vec::new()),
            cells_modified: RefCell::new(0),
        };

        match runtime::execute_script(source, filename, context) {
            Ok(ctx) => {
                let duration_ms = start.elapsed().as_millis() as u64;
                let output = ctx.console_output.borrow().clone();
                let cells_modified = *ctx.cells_modified.borrow();
                let grids = ctx.grids;
                let result = types::ScriptResult::Success {
                    output,
                    cells_modified,
                    duration_ms,
                };
                (result, grids)
            }
            Err(msg) => {
                let result = types::ScriptResult::Error {
                    message: msg,
                    output: Vec::new(),
                };
                (result, Vec::new())
            }
        }
    }
}

// Re-export key types for consumers
pub use types::{ScriptContext, ScriptMeta, ScriptResult};
