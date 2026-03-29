//! FILENAME: core/engine/src/evaluator.rs
//! PURPOSE: Evaluates AST expressions to compute cell values.
//! CONTEXT: After a formula is parsed into an AST, this module traverses
//! the tree and computes the final result. It handles cell lookups,
//! arithmetic operations, comparisons, string concatenation, and
//! built-in spreadsheet functions (SUM, AVERAGE, IF, etc.).
//!
//! SUPPORTED FEATURES:
//! - Literal evaluation: Numbers, Strings, Booleans
//! - Cell reference lookup from Grid (including cross-sheet references)
//! - Range expansion for aggregate functions
//! - Column references (A:A, A:B) - expands to all cells in columns
//! - Row references (1:1, 1:5) - expands to all cells in rows
//! - Binary operations: +, -, *, /, ^, &, =, <>, <, >, <=, >=
//! - Unary operations: - (negation)
//! - Functions: SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF, AND, OR, NOT,
//!              ABS, ROUND, FLOOR, CEILING, SQRT, POWER, MOD, LEN, UPPER,
//!              LOWER, TRIM, CONCATENATE, LEFT, RIGHT, MID
//!

use crate::cell::{CellError, CellValue, DictKey};
use crate::coord::col_to_index;
use crate::date_serial;
use crate::dependency_extractor::{BinaryOperator, BuiltinFunction, Expression, UnaryOperator, Value};
use crate::grid::Grid;
use crate::style::StyleRegistry;

use std::cell::RefCell;
use std::collections::HashMap;

/// Comparison operator for criteria matching in SUMIF/COUNTIF etc.
#[derive(Debug, Clone)]
enum CriteriaOp {
    Greater,
    GreaterEqual,
    Less,
    LessEqual,
    NotEqual,
}

/// Parsed criteria for conditional aggregate functions.
#[derive(Debug, Clone)]
enum CriteriaMatch {
    ExactNumber(f64),
    ExactBool(bool),
    ExactText(String),
    TextNotEqual(String),
    Compare(CriteriaOp, f64),
    Wildcard(String),
}

/// The result of evaluating an expression.
/// This maps directly to CellValue but is separate to allow for
/// intermediate computation states.
#[derive(Debug, Clone, PartialEq)]
pub enum EvalResult {
    Number(f64),
    Text(String),
    Boolean(bool),
    Error(CellError),
    /// A list of values, used internally for range expansion.
    /// Functions like SUM receive this when given a range argument.
    /// Arrays are transient — they spill onto the grid.
    Array(Vec<EvalResult>),
    /// A contained list of values (does NOT spill). Created by COLLECT().
    List(Vec<EvalResult>),
    /// A contained key-value collection (does NOT spill). Created by DICT().
    Dict(Vec<(DictKey, EvalResult)>),
    /// A lambda (callable) created by LAMBDA(). Contains parameter names and body expression.
    /// Does not spill. Invoked by MAP, REDUCE, SCAN, MAKEARRAY, BYROW, BYCOL.
    Lambda {
        params: Vec<String>,
        body: Box<Expression>,
    },
}

impl EvalResult {
    /// Converts the evaluation result to a CellValue for storage.
    pub fn to_cell_value(&self) -> CellValue {
        match self {
            EvalResult::Number(n) => CellValue::Number(*n),
            EvalResult::Text(s) => CellValue::Text(s.clone()),
            EvalResult::Boolean(b) => CellValue::Boolean(*b),
            EvalResult::Error(e) => CellValue::Error(e.clone()),
            EvalResult::Array(arr) => {
                // Arrays collapse to the first value when stored in a cell
                if let Some(first) = arr.first() {
                    first.to_cell_value()
                } else {
                    CellValue::Empty
                }
            }
            EvalResult::List(items) => {
                CellValue::List(Box::new(items.iter().map(|i| i.to_cell_value()).collect()))
            }
            EvalResult::Dict(entries) => {
                CellValue::Dict(Box::new(
                    entries.iter().map(|(k, v)| (k.clone(), v.to_cell_value())).collect()
                ))
            }
            EvalResult::Lambda { .. } => {
                // Lambdas stored in cells display as a text indicator
                CellValue::Text("#LAMBDA".to_string())
            }
        }
    }

    /// Attempts to coerce the result to a number.
    /// Returns None if coercion is not possible.
    pub fn as_number(&self) -> Option<f64> {
        match self {
            EvalResult::Number(n) => Some(*n),
            EvalResult::Boolean(b) => Some(if *b { 1.0 } else { 0.0 }),
            EvalResult::Text(s) => s.trim().parse::<f64>().ok(),
            // List/Dict are not coercible to number (Python convention)
            _ => None,
        }
    }

    /// Attempts to coerce the result to a boolean.
    pub fn as_boolean(&self) -> Option<bool> {
        match self {
            EvalResult::Boolean(b) => Some(*b),
            EvalResult::Number(n) => Some(*n != 0.0),
            EvalResult::Text(s) => {
                let upper = s.to_uppercase();
                if upper == "TRUE" {
                    Some(true)
                } else if upper == "FALSE" {
                    Some(false)
                } else {
                    None
                }
            }
            // List/Dict are not coercible to boolean (Python convention)
            _ => None,
        }
    }

    /// Converts the result to a string representation.
    pub fn as_text(&self) -> String {
        match self {
            EvalResult::Number(n) => {
                // Format without unnecessary decimal places
                if n.fract() == 0.0 && n.abs() < 1e15 {
                    format!("{}", *n as i64)
                } else {
                    format!("{}", n)
                }
            }
            EvalResult::Text(s) => s.clone(),
            EvalResult::Boolean(b) => {
                if *b {
                    "TRUE".to_string()
                } else {
                    "FALSE".to_string()
                }
            }
            EvalResult::Error(e) => format!("{:?}", e),
            EvalResult::Array(arr) => {
                if let Some(first) = arr.first() {
                    first.as_text()
                } else {
                    String::new()
                }
            }
            EvalResult::List(items) => format!("[List({})]", items.len()),
            EvalResult::Dict(entries) => format!("[Dict({})]", entries.len()),
            EvalResult::Lambda { .. } => "#LAMBDA".to_string(),
        }
    }

    /// Returns true if this result is an error.
    pub fn is_error(&self) -> bool {
        matches!(self, EvalResult::Error(_))
    }

    /// Returns (rows, cols) dimensions if this is an array result suitable for spilling.
    /// Non-array values return (1, 1).
    /// A flat Array returns (n, 1). A nested Array of Arrays returns (outer_len, inner_len).
    pub fn spill_dimensions(&self) -> (usize, usize) {
        match self {
            EvalResult::Array(arr) if !arr.is_empty() => {
                // Check if first element is also an Array (2D)
                if let EvalResult::Array(inner) = &arr[0] {
                    (arr.len(), inner.len())
                } else {
                    // 1D array: n rows, 1 column
                    (arr.len(), 1)
                }
            }
            // List and Dict are contained — they do NOT spill
            _ => (1, 1),
        }
    }

    /// Extract a 2D grid of CellValues for spilling.
    /// Returns Vec of (row_offset, col_offset, CellValue).
    pub fn to_spill_values(&self) -> Vec<(u32, u32, CellValue)> {
        match self {
            EvalResult::Array(arr) if !arr.is_empty() => {
                let mut result = Vec::new();
                for (r, item) in arr.iter().enumerate() {
                    match item {
                        EvalResult::Array(inner) => {
                            // 2D: each item is a row
                            for (c, val) in inner.iter().enumerate() {
                                result.push((r as u32, c as u32, val.to_cell_value()));
                            }
                        }
                        _ => {
                            // 1D: single column
                            result.push((r as u32, 0, item.to_cell_value()));
                        }
                    }
                }
                result
            }
            _ => {
                vec![(0, 0, self.to_cell_value())]
            }
        }
    }

    /// Flattens an array result into individual values.
    /// Non-array values return a single-element vector.
    pub fn flatten(&self) -> Vec<EvalResult> {
        match self {
            EvalResult::Array(arr) => {
                let mut result = Vec::new();
                for item in arr {
                    result.extend(item.flatten());
                }
                result
            }
            // List and Dict are opaque to flatten — they are treated as single values
            other => vec![other.clone()],
        }
    }
}

/// Context for multi-sheet evaluation.
/// Maps sheet names to their corresponding grids.
pub struct MultiSheetContext<'a> {
    /// All grids indexed by sheet name (case-insensitive lookup)
    pub grids: HashMap<String, &'a Grid>,
    /// The current/default sheet name (for references without sheet prefix)
    pub current_sheet: String,
    /// Ordered list of sheet names matching the workbook's tab order.
    /// Required for 3D references to determine which sheets fall between bookends.
    pub sheet_order: Vec<String>,
}

impl<'a> MultiSheetContext<'a> {
    /// Creates a new multi-sheet context.
    pub fn new(current_sheet: String) -> Self {
        MultiSheetContext {
            grids: HashMap::new(),
            current_sheet,
            sheet_order: Vec::new(),
        }
    }

    /// Adds a grid to the context.
    pub fn add_grid(&mut self, name: String, grid: &'a Grid) {
        // Store with uppercase key for case-insensitive lookup
        self.grids.insert(name.to_uppercase(), grid);
    }

    /// Gets a grid by name (case-insensitive).
    pub fn get_grid(&self, name: &str) -> Option<&&'a Grid> {
        self.grids.get(&name.to_uppercase())
    }

    /// Gets the current/default grid.
    pub fn get_current_grid(&self) -> Option<&&'a Grid> {
        self.grids.get(&self.current_sheet.to_uppercase())
    }

    /// Gets all sheet names between start and end (inclusive) based on tab order.
    /// Returns an empty Vec if either sheet is not found in the order.
    pub fn get_sheets_in_range(&self, start: &str, end: &str) -> Vec<String> {
        let start_upper = start.to_uppercase();
        let end_upper = end.to_uppercase();

        let start_idx = self.sheet_order.iter()
            .position(|s| s.to_uppercase() == start_upper);
        let end_idx = self.sheet_order.iter()
            .position(|s| s.to_uppercase() == end_upper);

        match (start_idx, end_idx) {
            (Some(si), Some(ei)) => {
                let min = si.min(ei);
                let max = si.max(ei);
                self.sheet_order[min..=max].to_vec()
            }
            _ => Vec::new(),
        }
    }
}

/// A UI side-effect produced during formula evaluation.
/// Optional evaluation context providing the current cell's position
/// and external state needed by GET/UI functions.
#[derive(Debug, Clone, Default)]
pub struct EvalContext {
    /// The 0-indexed row of the cell currently being evaluated.
    pub current_row: Option<u32>,
    /// The 0-indexed column of the cell currently being evaluated.
    pub current_col: Option<u32>,
    /// Row heights: row_index (0-indexed) -> height in pixels (for GET.ROW.HEIGHT).
    pub row_heights: Option<HashMap<u32, f64>>,
    /// Column widths: col_index (0-indexed) -> width in pixels (for GET.COLUMN.WIDTH).
    pub column_widths: Option<HashMap<u32, f64>>,
}

/// The formula evaluator.
/// Holds a reference to the grid for cell lookups.
pub struct Evaluator<'a> {
    grid: &'a Grid,
    /// Optional multi-sheet context for cross-sheet references
    multi_sheet: Option<MultiSheetContext<'a>>,
    /// Evaluation context: current cell position + external state for GET/UI functions.
    context: EvalContext,
    /// Optional style registry reference for GET.CELL.FILLCOLOR.
    styles: Option<&'a StyleRegistry>,
    /// Optional file reader for FILEREAD/FILELINES/FILEEXISTS functions.
    /// The closure takes a file path and returns the file content if it exists.
    file_reader: Option<&'a dyn Fn(&str) -> Option<String>>,
    /// Scope for LAMBDA/LET name bindings. Names are stored uppercased.
    /// Uses RefCell for interior mutability so evaluate() can stay &self.
    scope: RefCell<HashMap<String, EvalResult>>,
}

impl<'a> Evaluator<'a> {
    /// Creates a new Evaluator with a reference to the grid.
    /// For single-sheet evaluation (backward compatible).
    pub fn new(grid: &'a Grid) -> Self {
        Evaluator {
            grid,
            multi_sheet: None,
            context: EvalContext::default(),
            styles: None,
            file_reader: None,
            scope: RefCell::new(HashMap::new()),
        }
    }

    /// Creates a new Evaluator with multi-sheet support.
    pub fn with_multi_sheet(grid: &'a Grid, context: MultiSheetContext<'a>) -> Self {
        Evaluator {
            grid,
            multi_sheet: Some(context),
            context: EvalContext::default(),
            styles: None,
            file_reader: None,
            scope: RefCell::new(HashMap::new()),
        }
    }

    /// Creates a new Evaluator with multi-sheet support and evaluation context.
    pub fn with_context(grid: &'a Grid, multi_sheet: MultiSheetContext<'a>, eval_ctx: EvalContext) -> Self {
        Evaluator {
            grid,
            multi_sheet: Some(multi_sheet),
            context: eval_ctx,
            styles: None,
            file_reader: None,
            scope: RefCell::new(HashMap::new()),
        }
    }

    /// Sets the style registry reference for GET.CELL.FILLCOLOR.
    pub fn set_styles(&mut self, style_registry: &'a StyleRegistry) {
        self.styles = Some(style_registry);
    }

    /// Sets the file reader closure for FILEREAD/FILELINES/FILEEXISTS functions.
    pub fn set_file_reader(&mut self, reader: &'a dyn Fn(&str) -> Option<String>) {
        self.file_reader = Some(reader);
    }

    /// Gets the grid for a given sheet name, or the current grid if None.
    fn get_grid_for_sheet(&self, sheet: &Option<String>) -> &'a Grid {
        match (sheet, &self.multi_sheet) {
            (Some(sheet_name), Some(ctx)) => {
                ctx.get_grid(sheet_name).copied().unwrap_or(self.grid)
            }
            _ => self.grid,
        }
    }

    /// Evaluates an AST expression and returns the result.
    pub fn evaluate(&self, expr: &Expression) -> EvalResult {
        match expr {
            Expression::Literal(value) => self.eval_literal(value),
            Expression::CellRef { sheet, col, row } => self.eval_cell_ref(sheet, col, *row),
            Expression::Range { sheet, start, end } => self.eval_range(sheet, start, end),
            Expression::ColumnRef { sheet, start_col, end_col } => {
                self.eval_column_ref(sheet, start_col, end_col)
            }
            Expression::RowRef { sheet, start_row, end_row } => {
                self.eval_row_ref(sheet, *start_row, *end_row)
            }
            Expression::BinaryOp { left, op, right } => self.eval_binary_op(left, op, right),
            Expression::UnaryOp { op, operand } => self.eval_unary_op(op, operand),
            Expression::FunctionCall { func, args } => self.eval_function(func, args),
            Expression::Sheet3DRef { start_sheet, end_sheet, reference } => {
                self.eval_3d_ref(start_sheet, end_sheet, reference)
            }
            Expression::TableRef { .. } => {
                // TableRef should be resolved before evaluation reaches the engine.
                // If it arrives here unresolved, return #NAME? error.
                EvalResult::Error(CellError::Name)
            }
            Expression::IndexAccess { target, index } => {
                self.eval_index_access(target, index)
            }
            Expression::ListLiteral { elements } => {
                self.eval_list_literal(elements)
            }
            Expression::DictLiteral { entries } => {
                self.eval_dict_literal(entries)
            }
            Expression::NamedRef { name } => {
                // Check scope first (LAMBDA/LET bindings)
                let key = name.to_uppercase();
                let scope = self.scope.borrow();
                if let Some(val) = scope.get(&key) {
                    val.clone()
                } else {
                    // Unresolved name → #NAME? error
                    EvalResult::Error(CellError::Name)
                }
            }
            Expression::SpillRef { .. } => {
                // SpillRef should be resolved in the Tauri layer before evaluation.
                // If it reaches here, it means the spill range lookup failed.
                EvalResult::Error(CellError::Name)
            }
            Expression::ImplicitIntersection { operand } => {
                self.eval_implicit_intersection(operand)
            }
        }
    }

    /// Evaluates the @ implicit intersection operator.
    /// Extracts the single value from a range at the formula's row or column.
    fn eval_implicit_intersection(&self, operand: &Expression) -> EvalResult {
        // Get the formula's position
        let current_row = self.context.current_row.unwrap_or(0);
        let current_col = self.context.current_col.unwrap_or(0);

        // Try to determine the range start position from the operand
        match operand {
            Expression::Range { start, end, sheet } => {
                let grid = self.get_grid_for_sheet(sheet);
                let (start_col_s, start_row) = if let Expression::CellRef { col, row, .. } = start.as_ref() {
                    (col.clone(), *row)
                } else {
                    return self.evaluate(operand);
                };
                let (end_col_s, end_row) = if let Expression::CellRef { col, row, .. } = end.as_ref() {
                    (col.clone(), *row)
                } else {
                    return self.evaluate(operand);
                };

                let start_col_idx = col_to_index(&start_col_s);
                let end_col_idx = col_to_index(&end_col_s);
                let start_row_idx = start_row - 1;
                let end_row_idx = end_row - 1;

                let min_row = start_row_idx.min(end_row_idx);
                let max_row = start_row_idx.max(end_row_idx);
                let min_col = start_col_idx.min(end_col_idx);
                let max_col = start_col_idx.max(end_col_idx);

                let is_single_col = min_col == max_col;
                let is_single_row = min_row == max_row;

                if is_single_col && current_row >= min_row && current_row <= max_row {
                    // Vertical range: return cell at formula's row
                    match grid.get_cell(current_row, min_col) {
                        Some(cell) => self.cell_value_to_result(&cell.value),
                        None => EvalResult::Number(0.0),
                    }
                } else if is_single_row && current_col >= min_col && current_col <= max_col {
                    // Horizontal range: return cell at formula's column
                    match grid.get_cell(min_row, current_col) {
                        Some(cell) => self.cell_value_to_result(&cell.value),
                        None => EvalResult::Number(0.0),
                    }
                } else if current_row >= min_row && current_row <= max_row
                       && current_col >= min_col && current_col <= max_col {
                    // 2D range but formula is inside it: return the intersecting cell
                    match grid.get_cell(current_row, current_col) {
                        Some(cell) => self.cell_value_to_result(&cell.value),
                        None => EvalResult::Number(0.0),
                    }
                } else {
                    // Formula is outside the range - no intersection
                    EvalResult::Error(CellError::Value)
                }
            }
            _ => {
                // For non-range operands, evaluate normally
                let result = self.evaluate(operand);
                // If result is an array, try to pick the element at the formula's row
                match &result {
                    EvalResult::Array(arr) if !arr.is_empty() => {
                        let idx = current_row as usize;
                        if idx < arr.len() {
                            arr[idx].clone()
                        } else {
                            EvalResult::Error(CellError::Value)
                        }
                    }
                    _ => result,
                }
            }
        }
    }

    /// Evaluates a literal value.
    fn eval_literal(&self, value: &Value) -> EvalResult {
        match value {
            Value::Number(n) => EvalResult::Number(*n),
            Value::String(s) => EvalResult::Text(s.clone()),
            Value::Boolean(b) => EvalResult::Boolean(*b),
        }
    }

    /// Evaluates a cell reference by looking up its value in the grid.
    fn eval_cell_ref(&self, sheet: &Option<String>, col: &str, row: u32) -> EvalResult {
        let grid = self.get_grid_for_sheet(sheet);
        let col_idx = col_to_index(col);
        let row_idx = row - 1; // Convert 1-based to 0-based

        match grid.get_cell(row_idx, col_idx) {
            Some(cell) => self.cell_value_to_result(&cell.value),
            None => EvalResult::Number(0.0), // Empty cells are treated as 0
        }
    }

    /// Converts a CellValue to an EvalResult.
    fn cell_value_to_result(&self, value: &CellValue) -> EvalResult {
        match value {
            CellValue::Empty => EvalResult::Number(0.0),
            CellValue::Number(n) => EvalResult::Number(*n),
            CellValue::Text(s) => EvalResult::Text(s.clone()),
            CellValue::Boolean(b) => EvalResult::Boolean(*b),
            CellValue::Error(e) => EvalResult::Error(e.clone()),
            CellValue::List(items) => {
                EvalResult::List(items.iter().map(|i| self.cell_value_to_result(i)).collect())
            }
            CellValue::Dict(entries) => {
                EvalResult::Dict(entries.iter().map(|(k, v)| (k.clone(), self.cell_value_to_result(v))).collect())
            }
        }
    }

    /// Evaluates a range and returns an array of values.
    fn eval_range(
        &self,
        sheet: &Option<String>,
        start: &Expression,
        end: &Expression,
    ) -> EvalResult {
        let grid = self.get_grid_for_sheet(sheet);

        // Extract start and end coordinates
        let (start_col, start_row) = if let Expression::CellRef { col, row, .. } = start {
            (col.clone(), *row)
        } else {
            return EvalResult::Error(CellError::Ref);
        };

        let (end_col, end_row) = if let Expression::CellRef { col, row, .. } = end {
            (col.clone(), *row)
        } else {
            return EvalResult::Error(CellError::Ref);
        };

        let start_col_idx = col_to_index(&start_col);
        let end_col_idx = col_to_index(&end_col);
        let start_row_idx = start_row - 1;
        let end_row_idx = end_row - 1;

        // Normalize range bounds
        let min_row = start_row_idx.min(end_row_idx);
        let max_row = start_row_idx.max(end_row_idx);
        let min_col = start_col_idx.min(end_col_idx);
        let max_col = start_col_idx.max(end_col_idx);

        // Collect all values in the range
        let mut values = Vec::new();
        for r in min_row..=max_row {
            for c in min_col..=max_col {
                let result = match grid.get_cell(r, c) {
                    Some(cell) => self.cell_value_to_result(&cell.value),
                    None => EvalResult::Number(0.0),
                };
                values.push(result);
            }
        }

        EvalResult::Array(values)
    }

    /// Evaluates a column reference and returns an array of values.
    /// Only includes cells that have data (iterates over actual cells, not all rows).
    /// OPTIMIZED: Instead of iterating 0..max_row (potentially thousands of iterations),
    /// we iterate directly over the grid's HashMap and filter by column range.
    /// This is O(n) where n = number of cells, not O(max_row * columns).
    fn eval_column_ref(
        &self,
        sheet: &Option<String>,
        start_col: &str,
        end_col: &str,
    ) -> EvalResult {
        let grid = self.get_grid_for_sheet(sheet);
        let start_col_idx = col_to_index(start_col);
        let end_col_idx = col_to_index(end_col);

        let min_col = start_col_idx.min(end_col_idx);
        let max_col = start_col_idx.max(end_col_idx);

        // OPTIMIZED: Collect cells from the HashMap that fall within the column range
        // This avoids iterating over potentially thousands of empty rows
        let mut cell_list: Vec<(u32, u32, &crate::cell::Cell)> = grid
            .cells
            .iter()
            .filter_map(|((row, col), cell)| {
                if *col >= min_col && *col <= max_col {
                    Some((*row, *col, cell))
                } else {
                    None
                }
            })
            .collect();

        // Sort by column first, then row to match Excel's order
        cell_list.sort_by(|a, b| {
            match a.1.cmp(&b.1) {
                std::cmp::Ordering::Equal => a.0.cmp(&b.0),
                other => other,
            }
        });

        let mut values = Vec::new();
        for (_row, _col, cell) in cell_list {
            let result = self.cell_value_to_result(&cell.value);
            values.push(result);
        }

        EvalResult::Array(values)
    }

    /// Evaluates a row reference and returns an array of values.
    /// Only includes cells that have data (iterates over actual cells, not all cols).
    /// OPTIMIZED: Instead of iterating 0..max_col, we iterate directly over the
    /// grid's HashMap and filter by row range. This is O(n) where n = number of cells.
    fn eval_row_ref(&self, sheet: &Option<String>, start_row: u32, end_row: u32) -> EvalResult {
        let grid = self.get_grid_for_sheet(sheet);
        let start_row_idx = start_row - 1; // Convert to 0-based
        let end_row_idx = end_row - 1;

        let min_row = start_row_idx.min(end_row_idx);
        let max_row = start_row_idx.max(end_row_idx);

        // OPTIMIZED: Collect cells from the HashMap that fall within the row range
        let mut cell_list: Vec<(u32, u32, &crate::cell::Cell)> = grid
            .cells
            .iter()
            .filter_map(|((row, col), cell)| {
                if *row >= min_row && *row <= max_row {
                    Some((*row, *col, cell))
                } else {
                    None
                }
            })
            .collect();

        // Sort by row first, then column to match Excel's order
        cell_list.sort_by(|a, b| {
            match a.0.cmp(&b.0) {
                std::cmp::Ordering::Equal => a.1.cmp(&b.1),
                other => other,
            }
        });

        let mut values = Vec::new();
        for (_row, _col, cell) in cell_list {
            let result = self.cell_value_to_result(&cell.value);
            values.push(result);
        }

        EvalResult::Array(values)
    }

    /// Evaluates a 3D (cross-sheet) reference.
    /// Collects values from the same spatial coordinates across all sheets
    /// between start_sheet and end_sheet (inclusive, based on tab order).
    /// Evaluates subscript access: target[index]
    /// - List: 0-based integer index, out of bounds → #REF!
    /// - Dict: key lookup (string/number/boolean), not found → #N/A
    /// - Array: 0-based integer index into flat array
    /// - Other: #VALUE!
    /// Evaluates a list literal: {1, 2, 3} → EvalResult::List
    fn eval_list_literal(&self, elements: &[Expression]) -> EvalResult {
        let mut items = Vec::with_capacity(elements.len());
        for elem in elements {
            let val = self.evaluate(elem);
            if let EvalResult::Error(_) = &val {
                return val;
            }
            items.push(val);
        }
        EvalResult::List(items)
    }

    /// Evaluates a dict literal: {"a": 1, "b": 2} → EvalResult::Dict
    fn eval_dict_literal(&self, entries: &[(Expression, Expression)]) -> EvalResult {
        let mut result: Vec<(DictKey, EvalResult)> = Vec::with_capacity(entries.len());
        for (key_expr, val_expr) in entries {
            let key_val = self.evaluate(key_expr);
            let value = self.evaluate(val_expr);

            let key = match key_val {
                EvalResult::Text(s) => DictKey::Text(s),
                EvalResult::Number(n) => DictKey::Number(n),
                EvalResult::Boolean(b) => DictKey::Boolean(b),
                EvalResult::Error(e) => return EvalResult::Error(e),
                _ => return EvalResult::Error(CellError::Value),
            };

            if let EvalResult::Error(_) = &value {
                return value;
            }

            // Duplicate keys: last value wins
            if let Some(pos) = result.iter().position(|(k, _)| *k == key) {
                result[pos] = (key, value);
            } else {
                result.push((key, value));
            }
        }
        EvalResult::Dict(result)
    }

    fn eval_index_access(&self, target: &Expression, index: &Expression) -> EvalResult {
        let target_val = self.evaluate(target);
        let index_val = self.evaluate(index);

        // Propagate errors
        if let EvalResult::Error(_) = &target_val {
            return target_val;
        }
        if let EvalResult::Error(_) = &index_val {
            return index_val;
        }

        match target_val {
            EvalResult::List(items) => {
                // Index must coerce to integer
                let idx = match &index_val {
                    EvalResult::Number(n) => *n,
                    EvalResult::Boolean(b) => if *b { 1.0 } else { 0.0 },
                    EvalResult::Text(s) => match s.parse::<f64>() {
                        Ok(n) => n,
                        Err(_) => return EvalResult::Error(CellError::Value),
                    },
                    _ => return EvalResult::Error(CellError::Value),
                };
                let idx = idx as i64;
                // Support negative indexing (Python convention): -1 = last element
                let resolved = if idx < 0 {
                    items.len() as i64 + idx
                } else {
                    idx
                };
                if resolved < 0 || resolved as usize >= items.len() {
                    EvalResult::Error(CellError::Ref)
                } else {
                    items.into_iter().nth(resolved as usize).unwrap()
                }
            }
            EvalResult::Dict(entries) => {
                // Coerce index to DictKey
                let key = match &index_val {
                    EvalResult::Text(s) => DictKey::Text(s.clone()),
                    EvalResult::Number(n) => DictKey::Number(*n),
                    EvalResult::Boolean(b) => DictKey::Boolean(*b),
                    _ => return EvalResult::Error(CellError::Value),
                };
                // Look up key
                for (k, v) in entries {
                    if k == key {
                        return v;
                    }
                }
                EvalResult::Error(CellError::NA)
            }
            EvalResult::Array(arr) => {
                // Flat index into array (treating as 1D list of values)
                let idx = match &index_val {
                    EvalResult::Number(n) => *n,
                    EvalResult::Boolean(b) => if *b { 1.0 } else { 0.0 },
                    EvalResult::Text(s) => match s.parse::<f64>() {
                        Ok(n) => n,
                        Err(_) => return EvalResult::Error(CellError::Value),
                    },
                    _ => return EvalResult::Error(CellError::Value),
                };
                let idx = idx as i64;
                let resolved = if idx < 0 {
                    arr.len() as i64 + idx
                } else {
                    idx
                };
                if resolved < 0 || resolved as usize >= arr.len() {
                    EvalResult::Error(CellError::Ref)
                } else {
                    arr.into_iter().nth(resolved as usize).unwrap()
                }
            }
            _ => EvalResult::Error(CellError::Value),
        }
    }

    fn eval_3d_ref(
        &self,
        start_sheet: &str,
        end_sheet: &str,
        reference: &Expression,
    ) -> EvalResult {
        let ctx = match &self.multi_sheet {
            Some(ctx) => ctx,
            None => return EvalResult::Error(CellError::Ref),
        };

        // Wildcard: "*" means all sheets in the workbook
        let sheets = if start_sheet == "*" && end_sheet == "*" {
            ctx.sheet_order.clone()
        } else {
            ctx.get_sheets_in_range(start_sheet, end_sheet)
        };
        if sheets.is_empty() {
            return EvalResult::Error(CellError::Ref);
        }

        // Collect values from each sheet by evaluating the inner reference
        // against that sheet's grid using a temporary single-sheet evaluator.
        let mut all_values = Vec::new();
        for sheet_name in &sheets {
            if let Some(grid) = ctx.get_grid(sheet_name) {
                let sheet_eval = Evaluator::new(grid);
                let result = sheet_eval.evaluate(reference);
                match result {
                    EvalResult::Array(vals) => all_values.extend(vals),
                    other => all_values.push(other),
                }
            }
        }

        EvalResult::Array(all_values)
    }

    /// Evaluates a binary operation.
    fn eval_binary_op(
        &self,
        left: &Expression,
        op: &BinaryOperator,
        right: &Expression,
    ) -> EvalResult {
        let left_val = self.evaluate(left);
        let right_val = self.evaluate(right);

        // Propagate errors
        if let EvalResult::Error(e) = &left_val {
            return EvalResult::Error(e.clone());
        }
        if let EvalResult::Error(e) = &right_val {
            return EvalResult::Error(e.clone());
        }

        match op {
            // Arithmetic operations
            BinaryOperator::Add => self.eval_add(&left_val, &right_val),
            BinaryOperator::Subtract => self.eval_subtract(&left_val, &right_val),
            BinaryOperator::Multiply => self.eval_multiply(&left_val, &right_val),
            BinaryOperator::Divide => self.eval_divide(&left_val, &right_val),
            BinaryOperator::Power => self.eval_power(&left_val, &right_val),

            // String concatenation
            BinaryOperator::Concat => self.eval_concat(&left_val, &right_val),

            // Comparison operations
            BinaryOperator::Equal => self.eval_equal(&left_val, &right_val),
            BinaryOperator::NotEqual => self.eval_not_equal(&left_val, &right_val),
            BinaryOperator::LessThan => self.eval_less_than(&left_val, &right_val),
            BinaryOperator::GreaterThan => self.eval_greater_than(&left_val, &right_val),
            BinaryOperator::LessEqual => self.eval_less_equal(&left_val, &right_val),
            BinaryOperator::GreaterEqual => self.eval_greater_equal(&left_val, &right_val),
        }
    }

    fn eval_add(&self, left: &EvalResult, right: &EvalResult) -> EvalResult {
        match (left.as_number(), right.as_number()) {
            (Some(l), Some(r)) => EvalResult::Number(l + r),
            _ => EvalResult::Error(CellError::Value),
        }
    }

    fn eval_subtract(&self, left: &EvalResult, right: &EvalResult) -> EvalResult {
        match (left.as_number(), right.as_number()) {
            (Some(l), Some(r)) => EvalResult::Number(l - r),
            _ => EvalResult::Error(CellError::Value),
        }
    }

    fn eval_multiply(&self, left: &EvalResult, right: &EvalResult) -> EvalResult {
        match (left.as_number(), right.as_number()) {
            (Some(l), Some(r)) => EvalResult::Number(l * r),
            _ => EvalResult::Error(CellError::Value),
        }
    }

    fn eval_divide(&self, left: &EvalResult, right: &EvalResult) -> EvalResult {
        match (left.as_number(), right.as_number()) {
            (Some(_), Some(r)) if r == 0.0 => EvalResult::Error(CellError::Div0),
            (Some(l), Some(r)) => EvalResult::Number(l / r),
            _ => EvalResult::Error(CellError::Value),
        }
    }

    fn eval_power(&self, left: &EvalResult, right: &EvalResult) -> EvalResult {
        match (left.as_number(), right.as_number()) {
            (Some(l), Some(r)) => {
                let result = l.powf(r);
                if result.is_nan() || result.is_infinite() {
                    EvalResult::Error(CellError::Value)
                } else {
                    EvalResult::Number(result)
                }
            }
            _ => EvalResult::Error(CellError::Value),
        }
    }

    fn eval_concat(&self, left: &EvalResult, right: &EvalResult) -> EvalResult {
        let left_str = left.as_text();
        let right_str = right.as_text();
        EvalResult::Text(format!("{}{}", left_str, right_str))
    }

    fn eval_equal(&self, left: &EvalResult, right: &EvalResult) -> EvalResult {
        let result = match (left, right) {
            (EvalResult::Number(l), EvalResult::Number(r)) => (l - r).abs() < f64::EPSILON,
            (EvalResult::Text(l), EvalResult::Text(r)) => l.to_uppercase() == r.to_uppercase(),
            (EvalResult::Boolean(l), EvalResult::Boolean(r)) => l == r,
            // Cross-type comparisons
            (EvalResult::Number(n), EvalResult::Text(s))
            | (EvalResult::Text(s), EvalResult::Number(n)) => {
                if let Ok(parsed) = s.parse::<f64>() {
                    (parsed - n).abs() < f64::EPSILON
                } else {
                    false
                }
            }
            _ => false,
        };
        EvalResult::Boolean(result)
    }

    fn eval_not_equal(&self, left: &EvalResult, right: &EvalResult) -> EvalResult {
        match self.eval_equal(left, right) {
            EvalResult::Boolean(b) => EvalResult::Boolean(!b),
            other => other,
        }
    }

    fn eval_less_than(&self, left: &EvalResult, right: &EvalResult) -> EvalResult {
        match (left.as_number(), right.as_number()) {
            (Some(l), Some(r)) => EvalResult::Boolean(l < r),
            _ => {
                // String comparison
                match (left, right) {
                    (EvalResult::Text(l), EvalResult::Text(r)) => {
                        EvalResult::Boolean(l.to_uppercase() < r.to_uppercase())
                    }
                    _ => EvalResult::Error(CellError::Value),
                }
            }
        }
    }

    fn eval_greater_than(&self, left: &EvalResult, right: &EvalResult) -> EvalResult {
        match (left.as_number(), right.as_number()) {
            (Some(l), Some(r)) => EvalResult::Boolean(l > r),
            _ => match (left, right) {
                (EvalResult::Text(l), EvalResult::Text(r)) => {
                    EvalResult::Boolean(l.to_uppercase() > r.to_uppercase())
                }
                _ => EvalResult::Error(CellError::Value),
            },
        }
    }

    fn eval_less_equal(&self, left: &EvalResult, right: &EvalResult) -> EvalResult {
        match (left.as_number(), right.as_number()) {
            (Some(l), Some(r)) => EvalResult::Boolean(l <= r),
            _ => match (left, right) {
                (EvalResult::Text(l), EvalResult::Text(r)) => {
                    EvalResult::Boolean(l.to_uppercase() <= r.to_uppercase())
                }
                _ => EvalResult::Error(CellError::Value),
            },
        }
    }

    fn eval_greater_equal(&self, left: &EvalResult, right: &EvalResult) -> EvalResult {
        match (left.as_number(), right.as_number()) {
            (Some(l), Some(r)) => EvalResult::Boolean(l >= r),
            _ => match (left, right) {
                (EvalResult::Text(l), EvalResult::Text(r)) => {
                    EvalResult::Boolean(l.to_uppercase() >= r.to_uppercase())
                }
                _ => EvalResult::Error(CellError::Value),
            },
        }
    }

    /// Evaluates a unary operation.
    fn eval_unary_op(&self, op: &UnaryOperator, operand: &Expression) -> EvalResult {
        let val = self.evaluate(operand);

        if let EvalResult::Error(e) = &val {
            return EvalResult::Error(e.clone());
        }

        match op {
            UnaryOperator::Negate => match val.as_number() {
                Some(n) => EvalResult::Number(-n),
                None => EvalResult::Error(CellError::Value),
            },
        }
    }

    /// Evaluates a function call via fast enum dispatch.
    /// No heap allocations or string comparisons - just integer matching.
    fn eval_function(&self, func: &BuiltinFunction, args: &[Expression]) -> EvalResult {
        match func {
            // Aggregate functions
            BuiltinFunction::Sum => self.fn_sum(args),
            BuiltinFunction::Average => self.fn_average(args),
            BuiltinFunction::Min => self.fn_min(args),
            BuiltinFunction::Max => self.fn_max(args),
            BuiltinFunction::Count => self.fn_count(args),
            BuiltinFunction::CountA => self.fn_counta(args),

            // Conditional aggregate functions
            BuiltinFunction::SumIf => self.fn_sumif(args),
            BuiltinFunction::SumIfs => self.fn_sumifs(args),
            BuiltinFunction::CountIf => self.fn_countif(args),
            BuiltinFunction::CountIfs => self.fn_countifs(args),
            BuiltinFunction::AverageIf => self.fn_averageif(args),
            BuiltinFunction::AverageIfs => self.fn_averageifs(args),
            BuiltinFunction::CountBlank => self.fn_countblank(args),
            BuiltinFunction::MinIfs => self.fn_minifs(args),
            BuiltinFunction::MaxIfs => self.fn_maxifs(args),

            // Logical functions
            BuiltinFunction::If => self.fn_if(args),
            BuiltinFunction::And => self.fn_and(args),
            BuiltinFunction::Or => self.fn_or(args),
            BuiltinFunction::Not => self.fn_not(args),
            BuiltinFunction::True => EvalResult::Boolean(true),
            BuiltinFunction::False => EvalResult::Boolean(false),
            BuiltinFunction::IfError => self.fn_iferror(args),
            BuiltinFunction::IfNa => self.fn_ifna(args),
            BuiltinFunction::Ifs => self.fn_ifs(args),
            BuiltinFunction::Switch => self.fn_switch(args),
            BuiltinFunction::Xor => self.fn_xor(args),

            // Math functions
            BuiltinFunction::Abs => self.fn_abs(args),
            BuiltinFunction::Round => self.fn_round(args),
            BuiltinFunction::Floor => self.fn_floor(args),
            BuiltinFunction::Ceiling => self.fn_ceiling(args),
            BuiltinFunction::Sqrt => self.fn_sqrt(args),
            BuiltinFunction::Power => self.fn_power(args),
            BuiltinFunction::Mod => self.fn_mod(args),
            BuiltinFunction::Int => self.fn_int(args),
            BuiltinFunction::Sign => self.fn_sign(args),
            BuiltinFunction::SumProduct => self.fn_sumproduct(args),
            BuiltinFunction::Rand => self.fn_rand(args),
            BuiltinFunction::RandBetween => self.fn_randbetween(args),
            BuiltinFunction::Pi => EvalResult::Number(std::f64::consts::PI),
            BuiltinFunction::Log => self.fn_log(args),
            BuiltinFunction::Log10 => self.fn_log10(args),
            BuiltinFunction::Ln => self.fn_ln(args),
            BuiltinFunction::Exp => self.fn_exp(args),
            BuiltinFunction::Sin => self.fn_sin(args),
            BuiltinFunction::Cos => self.fn_cos(args),
            BuiltinFunction::Tan => self.fn_tan(args),
            BuiltinFunction::Asin => self.fn_asin(args),
            BuiltinFunction::Acos => self.fn_acos(args),
            BuiltinFunction::Atan => self.fn_atan(args),
            BuiltinFunction::Atan2 => self.fn_atan2(args),
            BuiltinFunction::RoundUp => self.fn_roundup(args),
            BuiltinFunction::RoundDown => self.fn_rounddown(args),
            BuiltinFunction::Trunc => self.fn_trunc(args),
            BuiltinFunction::Even => self.fn_even(args),
            BuiltinFunction::Odd => self.fn_odd(args),
            BuiltinFunction::Gcd => self.fn_gcd(args),
            BuiltinFunction::Lcm => self.fn_lcm(args),
            BuiltinFunction::Combin => self.fn_combin(args),
            BuiltinFunction::Fact => self.fn_fact(args),
            BuiltinFunction::Degrees => self.fn_degrees(args),
            BuiltinFunction::Radians => self.fn_radians(args),

            // Text functions
            BuiltinFunction::Len => self.fn_len(args),
            BuiltinFunction::Upper => self.fn_upper(args),
            BuiltinFunction::Lower => self.fn_lower(args),
            BuiltinFunction::Trim => self.fn_trim(args),
            BuiltinFunction::Concatenate => self.fn_concatenate(args),
            BuiltinFunction::Left => self.fn_left(args),
            BuiltinFunction::Right => self.fn_right(args),
            BuiltinFunction::Mid => self.fn_mid(args),
            BuiltinFunction::Rept => self.fn_rept(args),
            BuiltinFunction::Text => self.fn_text(args),
            BuiltinFunction::Find => self.fn_find(args),
            BuiltinFunction::Search => self.fn_search(args),
            BuiltinFunction::Substitute => self.fn_substitute(args),
            BuiltinFunction::Replace => self.fn_replace(args),
            BuiltinFunction::ValueFn => self.fn_value(args),
            BuiltinFunction::Exact => self.fn_exact(args),
            BuiltinFunction::Proper => self.fn_proper(args),
            BuiltinFunction::Char => self.fn_char(args),
            BuiltinFunction::Code => self.fn_code(args),
            BuiltinFunction::Clean => self.fn_clean(args),
            BuiltinFunction::NumberValue => self.fn_numbervalue(args),
            BuiltinFunction::TFn => self.fn_t(args),

            // Date & Time functions
            BuiltinFunction::Today => self.fn_today(args),
            BuiltinFunction::Now => self.fn_now(args),
            BuiltinFunction::Date => self.fn_date(args),
            BuiltinFunction::Year => self.fn_year(args),
            BuiltinFunction::Month => self.fn_month(args),
            BuiltinFunction::Day => self.fn_day(args),
            BuiltinFunction::Hour => self.fn_hour(args),
            BuiltinFunction::Minute => self.fn_minute(args),
            BuiltinFunction::Second => self.fn_second(args),
            BuiltinFunction::DateValue => self.fn_datevalue(args),
            BuiltinFunction::TimeValue => self.fn_timevalue(args),
            BuiltinFunction::EDate => self.fn_edate(args),
            BuiltinFunction::EOMonth => self.fn_eomonth(args),
            BuiltinFunction::NetworkDays => self.fn_networkdays(args),
            BuiltinFunction::WorkDay => self.fn_workday(args),
            BuiltinFunction::DateDif => self.fn_datedif(args),
            BuiltinFunction::Weekday => self.fn_weekday(args),
            BuiltinFunction::WeekNum => self.fn_weeknum(args),

            // Information functions
            BuiltinFunction::IsNumber => self.fn_isnumber(args),
            BuiltinFunction::IsText => self.fn_istext(args),
            BuiltinFunction::IsBlank => self.fn_isblank(args),
            BuiltinFunction::IsError => self.fn_iserror(args),
            BuiltinFunction::IsNa => self.fn_isna(args),
            BuiltinFunction::IsErr => self.fn_iserr(args),
            BuiltinFunction::IsLogical => self.fn_islogical(args),
            BuiltinFunction::IsOdd => self.fn_isodd(args),
            BuiltinFunction::IsEven => self.fn_iseven(args),
            BuiltinFunction::TypeFn => self.fn_type(args),
            BuiltinFunction::NFn => self.fn_n(args),
            BuiltinFunction::Na => EvalResult::Error(CellError::NA),
            BuiltinFunction::IsFormula => self.fn_isformula(args),

            // Lookup & Reference functions
            BuiltinFunction::XLookup => self.fn_xlookup(args),
            BuiltinFunction::XLookups => self.fn_xlookups(args),
            BuiltinFunction::Index => self.fn_index(args),
            BuiltinFunction::Match => self.fn_match(args),
            BuiltinFunction::Choose => self.fn_choose(args),
            BuiltinFunction::Indirect => self.fn_indirect(args),
            BuiltinFunction::Offset => self.fn_offset(args),
            BuiltinFunction::Address => self.fn_address(args),
            BuiltinFunction::Rows => self.fn_rows(args),
            BuiltinFunction::Columns => self.fn_columns(args),
            BuiltinFunction::Transpose => self.fn_transpose(args),

            // Statistical functions
            BuiltinFunction::Median => self.fn_median(args),
            BuiltinFunction::Stdev => self.fn_stdev(args),
            BuiltinFunction::StdevP => self.fn_stdevp(args),
            BuiltinFunction::Var => self.fn_var(args),
            BuiltinFunction::VarP => self.fn_varp(args),
            BuiltinFunction::Large => self.fn_large(args),
            BuiltinFunction::Small => self.fn_small(args),
            BuiltinFunction::Rank => self.fn_rank(args),
            BuiltinFunction::Percentile => self.fn_percentile(args),
            BuiltinFunction::Quartile => self.fn_quartile(args),
            BuiltinFunction::Mode => self.fn_mode(args),
            BuiltinFunction::Frequency => self.fn_frequency(args),

            // Financial functions
            BuiltinFunction::Pmt => self.fn_pmt(args),
            BuiltinFunction::Pv => self.fn_pv(args),
            BuiltinFunction::Fv => self.fn_fv(args),
            BuiltinFunction::Npv => self.fn_npv(args),
            BuiltinFunction::Irr => self.fn_irr(args),
            BuiltinFunction::Rate => self.fn_rate(args),
            BuiltinFunction::Nper => self.fn_nper(args),
            BuiltinFunction::Sln => self.fn_sln(args),
            BuiltinFunction::Db => self.fn_db(args),
            BuiltinFunction::Ddb => self.fn_ddb(args),

            // UI GET functions
            BuiltinFunction::GetRowHeight => self.fn_get_row_height(args),
            BuiltinFunction::GetColumnWidth => self.fn_get_column_width(args),
            BuiltinFunction::GetCellFillColor => self.fn_get_cell_fillcolor(args),

            // Reference functions
            BuiltinFunction::Row => self.fn_row(args),
            BuiltinFunction::Column => self.fn_column(args),

            // Advanced / Lambda
            BuiltinFunction::Let => self.fn_let(args),
            BuiltinFunction::TextJoin => self.fn_textjoin(args),
            BuiltinFunction::Lambda => self.fn_lambda(args),
            BuiltinFunction::Map => self.fn_map(args),
            BuiltinFunction::Reduce => self.fn_reduce(args),
            BuiltinFunction::Scan => self.fn_scan(args),
            BuiltinFunction::MakeArray => self.fn_makearray(args),
            BuiltinFunction::ByRow => self.fn_byrow(args),
            BuiltinFunction::ByCol => self.fn_bycol(args),

            // Dynamic array functions
            BuiltinFunction::Filter => self.fn_filter(args),
            BuiltinFunction::Sort => self.fn_sort(args),
            BuiltinFunction::SortBy => self.fn_sortby(args),
            BuiltinFunction::Unique => self.fn_unique(args),
            BuiltinFunction::Sequence => self.fn_sequence(args),
            BuiltinFunction::RandArray => self.fn_randarray(args),
            BuiltinFunction::GroupBy => self.fn_groupby(args),
            BuiltinFunction::PivotBy => self.fn_pivotby(args),

            // Collection functions (3D cells)
            BuiltinFunction::Collect => self.fn_collect(args),
            BuiltinFunction::DictFn => self.fn_dict(args),
            BuiltinFunction::Keys => self.fn_keys(args),
            BuiltinFunction::Values => self.fn_values(args),
            BuiltinFunction::Contains => self.fn_contains(args),
            BuiltinFunction::IsList => self.fn_islist(args),
            BuiltinFunction::IsDict => self.fn_isdict(args),
            BuiltinFunction::Flatten => self.fn_flatten(args),
            BuiltinFunction::Take => self.fn_take(args),
            BuiltinFunction::Drop => self.fn_drop(args),
            BuiltinFunction::Append => self.fn_append(args),
            BuiltinFunction::Merge => self.fn_merge(args),
            BuiltinFunction::HStack => self.fn_hstack(args),

            // File functions
            BuiltinFunction::FileRead => self.fn_file_read(args),
            BuiltinFunction::FileLines => self.fn_file_lines(args),
            BuiltinFunction::FileExists => self.fn_file_exists(args),

            // Unknown/custom functions — check scope for LAMBDA bindings
            BuiltinFunction::Custom(name) => {
                // __INVOKE__: call-on-expression (e.g., LAMBDA(x, x+1)(10))
                // args[0] is the callee expression, args[1..] are the invocation arguments
                if name == "__INVOKE__" {
                    if args.is_empty() {
                        return EvalResult::Error(CellError::Value);
                    }
                    let callee = self.evaluate(&args[0]);
                    match callee {
                        EvalResult::Lambda { params, body } => {
                            let eval_args: Vec<EvalResult> = args[1..].iter().map(|a| self.evaluate(a)).collect();
                            if eval_args.len() != params.len() {
                                return EvalResult::Error(CellError::Value);
                            }
                            return self.invoke_lambda(&params, &body, &eval_args);
                        }
                        _ => return EvalResult::Error(CellError::Value),
                    }
                }

                // Check scope for a LAMBDA bound by LET
                let key = name.to_uppercase();
                let maybe_lambda = {
                    let scope = self.scope.borrow();
                    scope.get(&key).cloned()
                };
                match maybe_lambda {
                    Some(EvalResult::Lambda { params, body }) => {
                        let eval_args: Vec<EvalResult> = args.iter().map(|a| self.evaluate(a)).collect();
                        if eval_args.len() != params.len() {
                            return EvalResult::Error(CellError::Value);
                        }
                        self.invoke_lambda(&params, &body, &eval_args)
                    }
                    _ => EvalResult::Error(CellError::Name),
                }
            },
        }
    }

    /// Collects numeric values from evaluated arguments, flattening arrays and unpacking List/Dict.
    fn collect_numbers(&self, args: &[Expression]) -> Result<Vec<f64>, CellError> {
        let mut numbers = Vec::new();

        for arg in args {
            let result = self.evaluate(arg);
            Self::collect_numbers_recursive(result, &mut numbers)?;
        }

        Ok(numbers)
    }

    /// Recursively collects numbers from an EvalResult, unpacking Arrays, Lists, and Dict values.
    fn collect_numbers_recursive(result: EvalResult, numbers: &mut Vec<f64>) -> Result<(), CellError> {
        match result {
            EvalResult::Error(e) => return Err(e),
            EvalResult::Array(arr) => {
                for item in arr {
                    Self::collect_numbers_recursive(item, numbers)?;
                }
            }
            EvalResult::List(items) => {
                for item in items {
                    Self::collect_numbers_recursive(item, numbers)?;
                }
            }
            EvalResult::Dict(entries) => {
                for (_, value) in entries {
                    Self::collect_numbers_recursive(value, numbers)?;
                }
            }
            other => {
                if let Some(n) = other.as_number() {
                    numbers.push(n);
                }
            }
        }
        Ok(())
    }

    /// Collects all values from arguments, flattening arrays and unpacking List/Dict.
    fn collect_values(&self, args: &[Expression]) -> Result<Vec<EvalResult>, CellError> {
        let mut values = Vec::new();

        for arg in args {
            let result = self.evaluate(arg);
            Self::collect_values_recursive(result, &mut values)?;
        }

        Ok(values)
    }

    /// Recursively collects values from an EvalResult, unpacking Arrays, Lists, and Dict values.
    fn collect_values_recursive(result: EvalResult, values: &mut Vec<EvalResult>) -> Result<(), CellError> {
        match result {
            EvalResult::Error(e) => return Err(e),
            EvalResult::Array(arr) => {
                for item in arr {
                    Self::collect_values_recursive(item, values)?;
                }
            }
            EvalResult::List(items) => {
                for item in items {
                    Self::collect_values_recursive(item, values)?;
                }
            }
            EvalResult::Dict(entries) => {
                for (_, value) in entries {
                    Self::collect_values_recursive(value, values)?;
                }
            }
            other => {
                values.push(other);
            }
        }
        Ok(())
    }

    // ==================== Aggregate Functions ====================

    fn fn_sum(&self, args: &[Expression]) -> EvalResult {
        match self.collect_numbers(args) {
            Ok(numbers) => {
                let sum: f64 = numbers.iter().sum();
                EvalResult::Number(sum)
            }
            Err(e) => EvalResult::Error(e),
        }
    }

    fn fn_average(&self, args: &[Expression]) -> EvalResult {
        match self.collect_numbers(args) {
            Ok(numbers) if numbers.is_empty() => EvalResult::Error(CellError::Div0),
            Ok(numbers) => {
                let sum: f64 = numbers.iter().sum();
                let count = numbers.len() as f64;
                EvalResult::Number(sum / count)
            }
            Err(e) => EvalResult::Error(e),
        }
    }

    fn fn_min(&self, args: &[Expression]) -> EvalResult {
        match self.collect_numbers(args) {
            Ok(numbers) if numbers.is_empty() => EvalResult::Number(0.0),
            Ok(numbers) => {
                let min = numbers.iter().cloned().fold(f64::INFINITY, f64::min);
                EvalResult::Number(min)
            }
            Err(e) => EvalResult::Error(e),
        }
    }

    fn fn_max(&self, args: &[Expression]) -> EvalResult {
        match self.collect_numbers(args) {
            Ok(numbers) if numbers.is_empty() => EvalResult::Number(0.0),
            Ok(numbers) => {
                let max = numbers.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                EvalResult::Number(max)
            }
            Err(e) => EvalResult::Error(e),
        }
    }

    fn fn_count(&self, args: &[Expression]) -> EvalResult {
        // COUNT counts only numeric values
        match self.collect_numbers(args) {
            Ok(numbers) => EvalResult::Number(numbers.len() as f64),
            Err(e) => EvalResult::Error(e),
        }
    }

    fn fn_counta(&self, args: &[Expression]) -> EvalResult {
        // COUNTA counts all non-empty values
        match self.collect_values(args) {
            Ok(values) => {
                let count = values
                    .iter()
                    .filter(|v| !matches!(v, EvalResult::Text(s) if s.is_empty()))
                    .count();
                EvalResult::Number(count as f64)
            }
            Err(e) => EvalResult::Error(e),
        }
    }

    // ==================== Logical Functions ====================

    fn fn_if(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 2 || args.len() > 3 {
            return EvalResult::Error(CellError::Value);
        }

        let condition = self.evaluate(&args[0]);
        if let EvalResult::Error(e) = condition {
            return EvalResult::Error(e);
        }

        let is_true = condition.as_boolean().unwrap_or(false);

        if is_true {
            self.evaluate(&args[1])
        } else if args.len() == 3 {
            self.evaluate(&args[2])
        } else {
            EvalResult::Boolean(false)
        }
    }

    fn fn_and(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() {
            return EvalResult::Error(CellError::Value);
        }

        for arg in args {
            let result = self.evaluate(arg);
            if let EvalResult::Error(e) = result {
                return EvalResult::Error(e);
            }

            match result.as_boolean() {
                Some(false) => return EvalResult::Boolean(false),
                None => return EvalResult::Error(CellError::Value),
                _ => {}
            }
        }

        EvalResult::Boolean(true)
    }

    fn fn_or(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() {
            return EvalResult::Error(CellError::Value);
        }

        for arg in args {
            let result = self.evaluate(arg);
            if let EvalResult::Error(e) = result {
                return EvalResult::Error(e);
            }

            match result.as_boolean() {
                Some(true) => return EvalResult::Boolean(true),
                None => return EvalResult::Error(CellError::Value),
                _ => {}
            }
        }

        EvalResult::Boolean(false)
    }

    fn fn_not(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }

        let result = self.evaluate(&args[0]);
        if let EvalResult::Error(e) = result {
            return EvalResult::Error(e);
        }

        match result.as_boolean() {
            Some(b) => EvalResult::Boolean(!b),
            None => EvalResult::Error(CellError::Value),
        }
    }

    // ==================== Math Functions ====================

    fn fn_abs(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }

        let result = self.evaluate(&args[0]);
        match result.as_number() {
            Some(n) => EvalResult::Number(n.abs()),
            None => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_round(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() || args.len() > 2 {
            return EvalResult::Error(CellError::Value);
        }

        let num = match self.evaluate(&args[0]).as_number() {
            Some(n) => n,
            None => return EvalResult::Error(CellError::Value),
        };

        let digits = if args.len() == 2 {
            match self.evaluate(&args[1]).as_number() {
                Some(d) => d as i32,
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            0
        };

        let multiplier = 10_f64.powi(digits);
        let rounded = (num * multiplier).round() / multiplier;
        EvalResult::Number(rounded)
    }

    fn fn_floor(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() || args.len() > 2 {
            return EvalResult::Error(CellError::Value);
        }

        let num = match self.evaluate(&args[0]).as_number() {
            Some(n) => n,
            None => return EvalResult::Error(CellError::Value),
        };

        let significance = if args.len() == 2 {
            match self.evaluate(&args[1]).as_number() {
                Some(s) if s == 0.0 => return EvalResult::Error(CellError::Div0),
                Some(s) => s,
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            1.0
        };

        let result = (num / significance).floor() * significance;
        EvalResult::Number(result)
    }

    fn fn_ceiling(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() || args.len() > 2 {
            return EvalResult::Error(CellError::Value);
        }

        let num = match self.evaluate(&args[0]).as_number() {
            Some(n) => n,
            None => return EvalResult::Error(CellError::Value),
        };

        let significance = if args.len() == 2 {
            match self.evaluate(&args[1]).as_number() {
                Some(s) if s == 0.0 => return EvalResult::Error(CellError::Div0),
                Some(s) => s,
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            1.0
        };

        let result = (num / significance).ceil() * significance;
        EvalResult::Number(result)
    }

    fn fn_sqrt(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }

        let num = match self.evaluate(&args[0]).as_number() {
            Some(n) if n < 0.0 => return EvalResult::Error(CellError::Value),
            Some(n) => n,
            None => return EvalResult::Error(CellError::Value),
        };

        EvalResult::Number(num.sqrt())
    }

    fn fn_power(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 {
            return EvalResult::Error(CellError::Value);
        }

        let base = match self.evaluate(&args[0]).as_number() {
            Some(n) => n,
            None => return EvalResult::Error(CellError::Value),
        };

        let exponent = match self.evaluate(&args[1]).as_number() {
            Some(n) => n,
            None => return EvalResult::Error(CellError::Value),
        };

        let result = base.powf(exponent);
        if result.is_nan() || result.is_infinite() {
            EvalResult::Error(CellError::Value)
        } else {
            EvalResult::Number(result)
        }
    }

    fn fn_mod(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 {
            return EvalResult::Error(CellError::Value);
        }

        let num = match self.evaluate(&args[0]).as_number() {
            Some(n) => n,
            None => return EvalResult::Error(CellError::Value),
        };

        let divisor = match self.evaluate(&args[1]).as_number() {
            Some(d) if d == 0.0 => return EvalResult::Error(CellError::Div0),
            Some(d) => d,
            None => return EvalResult::Error(CellError::Value),
        };

        // Excel's MOD: result has same sign as divisor
        let result = num - divisor * (num / divisor).floor();
        EvalResult::Number(result)
    }

    fn fn_int(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }

        let num = match self.evaluate(&args[0]).as_number() {
            Some(n) => n,
            None => return EvalResult::Error(CellError::Value),
        };

        EvalResult::Number(num.floor())
    }

    fn fn_sign(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }

        let num = match self.evaluate(&args[0]).as_number() {
            Some(n) => n,
            None => return EvalResult::Error(CellError::Value),
        };

        let sign = if num > 0.0 {
            1.0
        } else if num < 0.0 {
            -1.0
        } else {
            0.0
        };

        EvalResult::Number(sign)
    }

    // ==================== Text Functions ====================

    fn fn_len(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }

        let val = self.evaluate(&args[0]);
        match &val {
            EvalResult::List(items) => EvalResult::Number(items.len() as f64),
            EvalResult::Dict(entries) => EvalResult::Number(entries.len() as f64),
            _ => {
                let text = val.as_text();
                EvalResult::Number(text.len() as f64)
            }
        }
    }

    fn fn_upper(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }

        let text = self.evaluate(&args[0]).as_text();
        EvalResult::Text(text.to_uppercase())
    }

    fn fn_lower(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }

        let text = self.evaluate(&args[0]).as_text();
        EvalResult::Text(text.to_lowercase())
    }

    fn fn_trim(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }

        let text = self.evaluate(&args[0]).as_text();
        // Trim leading/trailing whitespace and collapse internal whitespace
        let trimmed: String = text.split_whitespace().collect::<Vec<&str>>().join(" ");
        EvalResult::Text(trimmed)
    }

    fn fn_concatenate(&self, args: &[Expression]) -> EvalResult {
        let mut result = String::new();

        for arg in args {
            let val = self.evaluate(arg);
            if let EvalResult::Error(e) = val {
                return EvalResult::Error(e);
            }
            result.push_str(&val.as_text());
        }

        EvalResult::Text(result)
    }

    fn fn_left(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() || args.len() > 2 {
            return EvalResult::Error(CellError::Value);
        }

        let text = self.evaluate(&args[0]).as_text();

        let num_chars = if args.len() == 2 {
            match self.evaluate(&args[1]).as_number() {
                Some(n) if n < 0.0 => return EvalResult::Error(CellError::Value),
                Some(n) => n as usize,
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            1
        };

        let result: String = text.chars().take(num_chars).collect();
        EvalResult::Text(result)
    }

    fn fn_right(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() || args.len() > 2 {
            return EvalResult::Error(CellError::Value);
        }

        let text = self.evaluate(&args[0]).as_text();

        let num_chars = if args.len() == 2 {
            match self.evaluate(&args[1]).as_number() {
                Some(n) if n < 0.0 => return EvalResult::Error(CellError::Value),
                Some(n) => n as usize,
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            1
        };

        let char_count = text.chars().count();
        let skip = char_count.saturating_sub(num_chars);
        let result: String = text.chars().skip(skip).collect();
        EvalResult::Text(result)
    }

    fn fn_mid(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 3 {
            return EvalResult::Error(CellError::Value);
        }

        let text = self.evaluate(&args[0]).as_text();

        let start = match self.evaluate(&args[1]).as_number() {
            Some(n) if n < 1.0 => return EvalResult::Error(CellError::Value),
            Some(n) => (n as usize) - 1, // Convert to 0-based index
            None => return EvalResult::Error(CellError::Value),
        };

        let num_chars = match self.evaluate(&args[2]).as_number() {
            Some(n) if n < 0.0 => return EvalResult::Error(CellError::Value),
            Some(n) => n as usize,
            None => return EvalResult::Error(CellError::Value),
        };

        let result: String = text.chars().skip(start).take(num_chars).collect();
        EvalResult::Text(result)
    }

    fn fn_rept(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 {
            return EvalResult::Error(CellError::Value);
        }

        let text = self.evaluate(&args[0]).as_text();

        let times = match self.evaluate(&args[1]).as_number() {
            Some(n) if n < 0.0 => return EvalResult::Error(CellError::Value),
            Some(n) => n as usize,
            None => return EvalResult::Error(CellError::Value),
        };

        EvalResult::Text(text.repeat(times))
    }

    fn fn_text(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 {
            return EvalResult::Error(CellError::Value);
        }

        let value = self.evaluate(&args[0]);
        let _format = self.evaluate(&args[1]).as_text();

        // Simplified TEXT function - just converts to string
        // Full implementation would parse format codes
        EvalResult::Text(value.as_text())
    }

    // ==================== Information Functions ====================

    fn fn_isnumber(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }

        let result = self.evaluate(&args[0]);
        EvalResult::Boolean(matches!(result, EvalResult::Number(_)))
    }

    fn fn_istext(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }

        let result = self.evaluate(&args[0]);
        EvalResult::Boolean(matches!(result, EvalResult::Text(_)))
    }

    fn fn_isblank(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }

        // Check if the cell reference points to an empty cell
        match &args[0] {
            Expression::CellRef { sheet, col, row } => {
                let grid = self.get_grid_for_sheet(sheet);
                let col_idx = col_to_index(col);
                let row_idx = row - 1;
                let is_blank = grid.get_cell(row_idx, col_idx).is_none();
                EvalResult::Boolean(is_blank)
            }
            _ => {
                let result = self.evaluate(&args[0]);
                let is_blank = matches!(result, EvalResult::Text(ref s) if s.is_empty());
                EvalResult::Boolean(is_blank)
            }
        }
    }

    fn fn_iserror(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }

        let result = self.evaluate(&args[0]);
        EvalResult::Boolean(result.is_error())
    }

    // ==================== Lookup & Reference Functions ====================

    /// XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode])
    ///
    /// Searches lookup_array for lookup_value and returns the corresponding item
    /// from return_array.
    ///
    /// match_mode:  0 = exact (default), -1 = exact or next smaller, 1 = exact or next larger, 2 = wildcard
    /// search_mode: 1 = first-to-last (default), -1 = last-to-first, 2 = binary asc, -2 = binary desc
    fn fn_xlookup(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 3 || args.len() > 6 {
            return EvalResult::Error(CellError::Value);
        }

        // Evaluate lookup_value
        let lookup_val = self.evaluate(&args[0]);
        if let EvalResult::Error(e) = &lookup_val {
            return EvalResult::Error(e.clone());
        }

        // Evaluate lookup_array and return_array (flatten ranges into flat lists)
        let lookup_array = self.evaluate(&args[1]).flatten();
        let return_array = self.evaluate(&args[2]).flatten();

        // match_mode (default 0 = exact match)
        let match_mode: i32 = if args.len() > 4 {
            match self.evaluate(&args[4]).as_number() {
                Some(n) => n as i32,
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            0
        };

        // search_mode (default 1 = first to last)
        let search_mode: i32 = if args.len() > 5 {
            match self.evaluate(&args[5]).as_number() {
                Some(n) => n as i32,
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            1
        };

        // Validate match_mode and search_mode
        if !matches!(match_mode, 0 | -1 | 1 | 2) {
            return EvalResult::Error(CellError::Value);
        }
        if !matches!(search_mode, 1 | -1 | 2 | -2) {
            return EvalResult::Error(CellError::Value);
        }

        // Find the matching index
        let found_index = match match_mode {
            0 => self.xlookup_exact(&lookup_val, &lookup_array, search_mode),
            -1 => self.xlookup_approx_smaller(&lookup_val, &lookup_array, search_mode),
            1 => self.xlookup_approx_larger(&lookup_val, &lookup_array, search_mode),
            2 => self.xlookup_wildcard(&lookup_val, &lookup_array, search_mode),
            _ => None,
        };

        // Return the corresponding value from return_array, or if_not_found, or #N/A
        match found_index {
            Some(idx) => {
                if idx < return_array.len() {
                    return_array[idx].clone()
                } else {
                    EvalResult::Error(CellError::NA)
                }
            }
            None => {
                // If [if_not_found] argument is provided, evaluate and return it
                if args.len() > 3 {
                    self.evaluate(&args[3])
                } else {
                    EvalResult::Error(CellError::NA)
                }
            }
        }
    }

    /// Checks whether an Expression is a range-like expression (produces an array).
    /// Used by XLOOKUPS to detect criteria pairs vs return_array.
    fn is_range_expression(expr: &Expression) -> bool {
        matches!(
            expr,
            Expression::Range { .. } | Expression::ColumnRef { .. } | Expression::RowRef { .. }
        )
    }

    /// XLOOKUPS: Multi-criteria XLOOKUP.
    /// Syntax: XLOOKUPS(value1, array1, [value2, array2, ...], return_array, [match_mode], [search_mode])
    ///
    /// Criteria are specified as (lookup_value, lookup_array) pairs. The end of
    /// criteria is detected when two consecutive range arguments appear — the
    /// second one is the return_array.
    fn fn_xlookups(&self, args: &[Expression]) -> EvalResult {
        // Minimum 3 args: value1, array1, return_array
        if args.len() < 3 {
            return EvalResult::Error(CellError::Value);
        }

        // ----------------------------------------------------------------
        // Phase 1: Parse criteria pairs and detect return_array
        // ----------------------------------------------------------------
        let mut criteria_exprs: Vec<(usize, usize)> = Vec::new(); // (value_idx, array_idx) pairs
        let mut return_array_idx: Option<usize> = None;
        let mut i = 0;

        while i < args.len() {
            // Expect a scalar (lookup_value)
            if Self::is_range_expression(&args[i]) {
                // Two consecutive ranges: previous array was the last lookup_array,
                // this one is the return_array.
                return_array_idx = Some(i);
                break;
            }

            // Need at least one more arg for the lookup_array
            if i + 1 >= args.len() {
                return EvalResult::Error(CellError::Value);
            }

            // The next arg should be a range (lookup_array)
            if !Self::is_range_expression(&args[i + 1]) {
                return EvalResult::Error(CellError::Value);
            }

            criteria_exprs.push((i, i + 1));
            i += 2;

            // Check if next arg is another range (= return_array)
            if i < args.len() && Self::is_range_expression(&args[i]) {
                return_array_idx = Some(i);
                break;
            }
        }

        // Must have at least one criteria pair and a return_array
        if criteria_exprs.is_empty() || return_array_idx.is_none() {
            return EvalResult::Error(CellError::Value);
        }
        let ret_idx = return_array_idx.unwrap();

        // ----------------------------------------------------------------
        // Phase 2: Evaluate all criteria and the return array
        // ----------------------------------------------------------------
        let mut criteria: Vec<(EvalResult, Vec<EvalResult>)> = Vec::new();
        for &(val_idx, arr_idx) in &criteria_exprs {
            let lookup_val = self.evaluate(&args[val_idx]);
            if let EvalResult::Error(e) = &lookup_val {
                return EvalResult::Error(e.clone());
            }
            let lookup_arr = self.evaluate(&args[arr_idx]).flatten();
            criteria.push((lookup_val, lookup_arr));
        }

        let return_array = self.evaluate(&args[ret_idx]).flatten();

        // Validate all lookup arrays have the same length
        let expected_len = criteria[0].1.len();
        for (_, arr) in &criteria {
            if arr.len() != expected_len {
                return EvalResult::Error(CellError::Value);
            }
        }
        if return_array.len() != expected_len {
            return EvalResult::Error(CellError::Value);
        }

        // ----------------------------------------------------------------
        // Phase 3: Parse optional match_mode and search_mode
        // ----------------------------------------------------------------
        let remaining_start = ret_idx + 1;

        let match_mode: i32 = if remaining_start < args.len() {
            match self.evaluate(&args[remaining_start]).as_number() {
                Some(n) => n as i32,
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            0
        };

        let search_mode: i32 = if remaining_start + 1 < args.len() {
            match self.evaluate(&args[remaining_start + 1]).as_number() {
                Some(n) => n as i32,
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            1
        };

        // Validate match_mode
        if !matches!(match_mode, 0 | -1 | 1 | 2) {
            return EvalResult::Error(CellError::Value);
        }
        // Approximate match modes don't apply to multi-criteria
        if criteria.len() > 1 && matches!(match_mode, -1 | 1) {
            return EvalResult::Error(CellError::Value);
        }
        // Validate search_mode
        if !matches!(search_mode, 1 | -1 | 2 | -2) {
            return EvalResult::Error(CellError::Value);
        }

        // ----------------------------------------------------------------
        // Phase 4: Search for a matching row
        // ----------------------------------------------------------------

        // For single-criterion with approximate match, delegate to XLOOKUP helpers
        if criteria.len() == 1 {
            let (ref val, ref arr) = criteria[0];
            let found_index = match match_mode {
                0 => self.xlookup_exact(val, arr, search_mode),
                -1 => self.xlookup_approx_smaller(val, arr, search_mode),
                1 => self.xlookup_approx_larger(val, arr, search_mode),
                2 => self.xlookup_wildcard(val, arr, search_mode),
                _ => None,
            };
            return match found_index {
                Some(idx) if idx < return_array.len() => return_array[idx].clone(),
                _ => EvalResult::Error(CellError::NA),
            };
        }

        // Multi-criteria: linear scan with direction from search_mode
        // (binary search modes 2/-2 fall back to linear for multi-criteria)
        let len = expected_len;
        let indices: Box<dyn Iterator<Item = usize>> = if search_mode == -1 {
            Box::new((0..len).rev())
        } else {
            Box::new(0..len)
        };

        for idx in indices {
            let all_match = criteria.iter().all(|(val, arr)| {
                match match_mode {
                    0 => self.xlookup_values_equal(val, &arr[idx]),
                    2 => {
                        // Wildcard: if lookup_val is text, use wildcard matching
                        if let EvalResult::Text(pattern) = val {
                            if let EvalResult::Text(s) = &arr[idx] {
                                self.xlookup_wildcard_match(
                                    &pattern.to_uppercase(),
                                    &s.to_uppercase(),
                                )
                            } else {
                                false
                            }
                        } else {
                            // Non-text values: fall back to exact match
                            self.xlookup_values_equal(val, &arr[idx])
                        }
                    }
                    _ => false, // -1, 1 already rejected above for multi-criteria
                }
            });

            if all_match {
                return return_array[idx].clone();
            }
        }

        EvalResult::Error(CellError::NA)
    }

    /// Exact match search for XLOOKUP (match_mode = 0).
    /// Supports search_mode: 1 (first-to-last), -1 (last-to-first),
    /// 2 (binary search ascending), -2 (binary search descending).
    fn xlookup_exact(
        &self,
        lookup_val: &EvalResult,
        lookup_array: &[EvalResult],
        search_mode: i32,
    ) -> Option<usize> {
        match search_mode {
            1 => {
                // Linear search first-to-last
                for (i, item) in lookup_array.iter().enumerate() {
                    if self.xlookup_values_equal(lookup_val, item) {
                        return Some(i);
                    }
                }
                None
            }
            -1 => {
                // Linear search last-to-first
                for (i, item) in lookup_array.iter().enumerate().rev() {
                    if self.xlookup_values_equal(lookup_val, item) {
                        return Some(i);
                    }
                }
                None
            }
            2 | -2 => {
                // Binary search (ascending or descending)
                let ascending = search_mode == 2;
                self.xlookup_binary_exact(lookup_val, lookup_array, ascending)
            }
            _ => None,
        }
    }

    /// Binary search for exact match.
    fn xlookup_binary_exact(
        &self,
        lookup_val: &EvalResult,
        lookup_array: &[EvalResult],
        ascending: bool,
    ) -> Option<usize> {
        if lookup_array.is_empty() {
            return None;
        }

        let mut lo: usize = 0;
        let mut hi: usize = lookup_array.len();

        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let cmp = self.xlookup_compare(lookup_val, &lookup_array[mid]);
            match cmp {
                std::cmp::Ordering::Equal => return Some(mid),
                std::cmp::Ordering::Less => {
                    if ascending { hi = mid; } else { lo = mid + 1; }
                }
                std::cmp::Ordering::Greater => {
                    if ascending { lo = mid + 1; } else { hi = mid; }
                }
            }
        }
        None
    }

    /// Approximate match: exact or next smaller item (match_mode = -1).
    fn xlookup_approx_smaller(
        &self,
        lookup_val: &EvalResult,
        lookup_array: &[EvalResult],
        search_mode: i32,
    ) -> Option<usize> {
        // First try exact match
        if let Some(idx) = self.xlookup_exact(lookup_val, lookup_array, search_mode) {
            return Some(idx);
        }

        // Find the largest value that is less than lookup_val
        let mut best_index: Option<usize> = None;
        let mut best_val: Option<f64> = None;
        let target = lookup_val.as_number()?;

        for (i, item) in lookup_array.iter().enumerate() {
            if let Some(n) = item.as_number() {
                if n < target {
                    match best_val {
                        Some(bv) if n > bv => {
                            best_val = Some(n);
                            best_index = Some(i);
                        }
                        None => {
                            best_val = Some(n);
                            best_index = Some(i);
                        }
                        _ => {}
                    }
                }
            }
        }
        best_index
    }

    /// Approximate match: exact or next larger item (match_mode = 1).
    fn xlookup_approx_larger(
        &self,
        lookup_val: &EvalResult,
        lookup_array: &[EvalResult],
        search_mode: i32,
    ) -> Option<usize> {
        // First try exact match
        if let Some(idx) = self.xlookup_exact(lookup_val, lookup_array, search_mode) {
            return Some(idx);
        }

        // Find the smallest value that is greater than lookup_val
        let mut best_index: Option<usize> = None;
        let mut best_val: Option<f64> = None;
        let target = lookup_val.as_number()?;

        for (i, item) in lookup_array.iter().enumerate() {
            if let Some(n) = item.as_number() {
                if n > target {
                    match best_val {
                        Some(bv) if n < bv => {
                            best_val = Some(n);
                            best_index = Some(i);
                        }
                        None => {
                            best_val = Some(n);
                            best_index = Some(i);
                        }
                        _ => {}
                    }
                }
            }
        }
        best_index
    }

    /// Wildcard match (match_mode = 2).
    /// Supports * (any characters), ? (single character), ~ (escape).
    fn xlookup_wildcard(
        &self,
        lookup_val: &EvalResult,
        lookup_array: &[EvalResult],
        search_mode: i32,
    ) -> Option<usize> {
        let pattern = match lookup_val {
            EvalResult::Text(s) => s.to_uppercase(),
            _ => return self.xlookup_exact(lookup_val, lookup_array, search_mode),
        };

        let iter: Box<dyn Iterator<Item = (usize, &EvalResult)>> = if search_mode == -1 {
            Box::new(lookup_array.iter().enumerate().rev())
        } else {
            Box::new(lookup_array.iter().enumerate())
        };

        for (i, item) in iter {
            if let EvalResult::Text(s) = item {
                if self.xlookup_wildcard_match(&pattern, &s.to_uppercase()) {
                    return Some(i);
                }
            }
        }
        None
    }

    /// Matches a wildcard pattern against a string.
    /// * matches any sequence of characters, ? matches exactly one character,
    /// ~* and ~? match literal * and ?.
    fn xlookup_wildcard_match(&self, pattern: &str, text: &str) -> bool {
        let pat_chars: Vec<char> = pattern.chars().collect();
        let text_chars: Vec<char> = text.chars().collect();
        self.xlookup_wildcard_match_recursive(&pat_chars, 0, &text_chars, 0)
    }

    fn xlookup_wildcard_match_recursive(
        &self,
        pattern: &[char],
        pi: usize,
        text: &[char],
        ti: usize,
    ) -> bool {
        if pi == pattern.len() {
            return ti == text.len();
        }

        let ch = pattern[pi];

        if ch == '~' && pi + 1 < pattern.len() {
            // Escape: ~* matches literal *, ~? matches literal ?
            let escaped = pattern[pi + 1];
            if ti < text.len() && text[ti] == escaped {
                return self.xlookup_wildcard_match_recursive(pattern, pi + 2, text, ti + 1);
            }
            return false;
        }

        if ch == '*' {
            // * matches zero or more characters
            // Try matching zero characters, then one, then two, etc.
            for k in ti..=text.len() {
                if self.xlookup_wildcard_match_recursive(pattern, pi + 1, text, k) {
                    return true;
                }
            }
            return false;
        }

        if ch == '?' {
            // ? matches exactly one character
            if ti < text.len() {
                return self.xlookup_wildcard_match_recursive(pattern, pi + 1, text, ti + 1);
            }
            return false;
        }

        // Literal character match
        if ti < text.len() && text[ti] == ch {
            return self.xlookup_wildcard_match_recursive(pattern, pi + 1, text, ti + 1);
        }

        false
    }

    /// Compares two EvalResult values for ordering.
    /// Numbers are compared numerically, strings case-insensitively.
    fn xlookup_compare(&self, a: &EvalResult, b: &EvalResult) -> std::cmp::Ordering {
        match (a.as_number(), b.as_number()) {
            (Some(na), Some(nb)) => na.partial_cmp(&nb).unwrap_or(std::cmp::Ordering::Equal),
            _ => {
                let sa = a.as_text().to_uppercase();
                let sb = b.as_text().to_uppercase();
                sa.cmp(&sb)
            }
        }
    }

    /// Checks if two EvalResult values are equal for XLOOKUP matching.
    /// Numbers compared with epsilon tolerance, strings case-insensitively.
    fn xlookup_values_equal(&self, a: &EvalResult, b: &EvalResult) -> bool {
        match (a, b) {
            (EvalResult::Number(n1), EvalResult::Number(n2)) => (n1 - n2).abs() < f64::EPSILON,
            (EvalResult::Text(s1), EvalResult::Text(s2)) => {
                s1.to_uppercase() == s2.to_uppercase()
            }
            (EvalResult::Boolean(b1), EvalResult::Boolean(b2)) => b1 == b2,
            // Cross-type: number vs text that parses to number
            (EvalResult::Number(n), EvalResult::Text(s))
            | (EvalResult::Text(s), EvalResult::Number(n)) => {
                if let Ok(parsed) = s.parse::<f64>() {
                    (parsed - n).abs() < f64::EPSILON
                } else {
                    false
                }
            }
            _ => false,
        }
    }

    // =========================================================================
    // UI Functions
    // =========================================================================

    /// ROW([cell_ref])
    /// With no arguments, returns the 1-indexed row of the current cell.
    /// With a cell_ref argument, returns the 1-indexed row of that reference.
    fn fn_row(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() {
            match self.context.current_row {
                Some(r) => EvalResult::Number((r + 1) as f64),
                None => EvalResult::Error(CellError::Value),
            }
        } else if args.len() == 1 {
            match &args[0] {
                Expression::CellRef { row, .. } => EvalResult::Number(*row as f64),
                _ => EvalResult::Error(CellError::Value),
            }
        } else {
            EvalResult::Error(CellError::Value)
        }
    }

    /// COLUMN([cell_ref])
    /// With no arguments, returns the 1-indexed column of the current cell.
    /// With a cell_ref argument, returns the 1-indexed column of that reference.
    fn fn_column(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() {
            match self.context.current_col {
                Some(c) => EvalResult::Number((c + 1) as f64),
                None => EvalResult::Error(CellError::Value),
            }
        } else if args.len() == 1 {
            match &args[0] {
                Expression::CellRef { col, .. } => {
                    let col_idx = col_to_index(col);
                    EvalResult::Number((col_idx + 1) as f64)
                }
                _ => EvalResult::Error(CellError::Value),
            }
        } else {
            EvalResult::Error(CellError::Value)
        }
    }

    /// GET.ROW.HEIGHT(row_number)
    /// Returns the current height of the specified row (1-indexed) in pixels.
    /// Falls back to default height (24.0) if no custom height is set.
    fn fn_get_row_height(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }
        let row_result = self.evaluate(&args[0]);
        match row_result.as_number() {
            Some(n) if n >= 1.0 && n == n.floor() => {
                let row_idx = (n as u32) - 1;
                let height = self.context.row_heights
                    .as_ref()
                    .and_then(|m| m.get(&row_idx).copied())
                    .unwrap_or(24.0);
                EvalResult::Number(height)
            }
            Some(_) => EvalResult::Error(CellError::Value),
            None => {
                if let EvalResult::Error(e) = row_result {
                    return EvalResult::Error(e);
                }
                EvalResult::Error(CellError::Value)
            }
        }
    }

    /// GET.COLUMN.WIDTH(col_number)
    /// Returns the current width of the specified column (1-indexed) in pixels.
    /// Falls back to default width (100.0) if no custom width is set.
    fn fn_get_column_width(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }
        let col_result = self.evaluate(&args[0]);
        match col_result.as_number() {
            Some(n) if n >= 1.0 && n == n.floor() => {
                let col_idx = (n as u32) - 1;
                let width = self.context.column_widths
                    .as_ref()
                    .and_then(|m| m.get(&col_idx).copied())
                    .unwrap_or(100.0);
                EvalResult::Number(width)
            }
            Some(_) => EvalResult::Error(CellError::Value),
            None => {
                if let EvalResult::Error(e) = col_result {
                    return EvalResult::Error(e);
                }
                EvalResult::Error(CellError::Value)
            }
        }
    }

    /// GET.CELL.FILLCOLOR(cell_ref)
    /// Returns the hex color string of the cell's background fill color.
    fn fn_get_cell_fillcolor(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }

        let (row_idx, col_idx) = match &args[0] {
            Expression::CellRef { col, row, .. } => {
                (row - 1, col_to_index(col) as u32)
            }
            _ => return EvalResult::Error(CellError::Value),
        };

        let style_registry = match &self.styles {
            Some(sr) => sr,
            None => return EvalResult::Text(String::new()),
        };

        let style_index = self.grid
            .get_cell(row_idx, col_idx)
            .map(|c| c.style_index)
            .unwrap_or(0);

        let style = style_registry.get(style_index);
        EvalResult::Text(style.background.to_css())
    }

    // ==================== Criteria Matching Infrastructure ====================

    /// Parses a criteria value into a typed matcher.
    /// Handles: ">5", "<=10", "<>apple", "A*", "?x?", exact match.
    fn parse_criteria(&self, criteria: &EvalResult) -> CriteriaMatch {
        match criteria {
            EvalResult::Number(n) => CriteriaMatch::ExactNumber(*n),
            EvalResult::Boolean(b) => CriteriaMatch::ExactBool(*b),
            EvalResult::Text(s) => {
                let trimmed = s.trim();
                // Check for comparison operators
                if let Some(rest) = trimmed.strip_prefix("<>") {
                    if let Ok(n) = rest.trim().parse::<f64>() {
                        return CriteriaMatch::Compare(CriteriaOp::NotEqual, n);
                    }
                    return CriteriaMatch::TextNotEqual(rest.trim().to_uppercase());
                }
                if let Some(rest) = trimmed.strip_prefix("<=") {
                    if let Ok(n) = rest.trim().parse::<f64>() {
                        return CriteriaMatch::Compare(CriteriaOp::LessEqual, n);
                    }
                }
                if let Some(rest) = trimmed.strip_prefix(">=") {
                    if let Ok(n) = rest.trim().parse::<f64>() {
                        return CriteriaMatch::Compare(CriteriaOp::GreaterEqual, n);
                    }
                }
                if let Some(rest) = trimmed.strip_prefix('<') {
                    if let Ok(n) = rest.trim().parse::<f64>() {
                        return CriteriaMatch::Compare(CriteriaOp::Less, n);
                    }
                }
                if let Some(rest) = trimmed.strip_prefix('>') {
                    if let Ok(n) = rest.trim().parse::<f64>() {
                        return CriteriaMatch::Compare(CriteriaOp::Greater, n);
                    }
                }
                if let Some(rest) = trimmed.strip_prefix('=') {
                    if let Ok(n) = rest.trim().parse::<f64>() {
                        return CriteriaMatch::ExactNumber(n);
                    }
                    return CriteriaMatch::ExactText(rest.trim().to_uppercase());
                }
                // Check for wildcards
                if trimmed.contains('*') || trimmed.contains('?') {
                    return CriteriaMatch::Wildcard(trimmed.to_uppercase());
                }
                // Try as number
                if let Ok(n) = trimmed.parse::<f64>() {
                    return CriteriaMatch::ExactNumber(n);
                }
                CriteriaMatch::ExactText(trimmed.to_uppercase())
            }
            _ => CriteriaMatch::ExactText(String::new()),
        }
    }

    /// Tests whether a value matches a criteria.
    fn matches_criteria(&self, value: &EvalResult, criteria: &CriteriaMatch) -> bool {
        match criteria {
            CriteriaMatch::ExactNumber(n) => value.as_number().map_or(false, |v| (v - n).abs() < 1e-10),
            CriteriaMatch::ExactBool(b) => {
                matches!(value, EvalResult::Boolean(v) if v == b)
            }
            CriteriaMatch::ExactText(s) => value.as_text().to_uppercase() == *s,
            CriteriaMatch::TextNotEqual(s) => value.as_text().to_uppercase() != *s,
            CriteriaMatch::Compare(op, n) => {
                if let Some(v) = value.as_number() {
                    match op {
                        CriteriaOp::Greater => v > *n,
                        CriteriaOp::GreaterEqual => v >= *n,
                        CriteriaOp::Less => v < *n,
                        CriteriaOp::LessEqual => v <= *n,
                        CriteriaOp::NotEqual => (v - n).abs() >= 1e-10,
                    }
                } else {
                    false
                }
            }
            CriteriaMatch::Wildcard(pattern) => {
                let text = value.as_text().to_uppercase();
                self.xlookup_wildcard_match(pattern, &text)
            }
        }
    }

    /// Evaluates an argument and flattens it into a Vec of individual values.
    fn eval_flat(&self, arg: &Expression) -> Vec<EvalResult> {
        self.evaluate(arg).flatten()
    }

    // ==================== Conditional Aggregate Functions ====================

    fn fn_sumif(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 2 || args.len() > 3 {
            return EvalResult::Error(CellError::Value);
        }
        let range_vals = self.eval_flat(&args[0]);
        let criteria = self.parse_criteria(&self.evaluate(&args[1]));
        let sum_vals = if args.len() == 3 { self.eval_flat(&args[2]) } else { range_vals.clone() };
        let mut total = 0.0;
        for (i, val) in range_vals.iter().enumerate() {
            if self.matches_criteria(val, &criteria) {
                if let Some(n) = sum_vals.get(i).and_then(|v| v.as_number()) {
                    total += n;
                }
            }
        }
        EvalResult::Number(total)
    }

    fn fn_sumifs(&self, args: &[Expression]) -> EvalResult {
        // SUMIFS(sum_range, criteria_range1, criteria1, [criteria_range2, criteria2], ...)
        if args.len() < 3 || (args.len() - 1) % 2 != 0 {
            return EvalResult::Error(CellError::Value);
        }
        let sum_vals = self.eval_flat(&args[0]);
        let num_criteria = (args.len() - 1) / 2;
        let mut criteria_data: Vec<(Vec<EvalResult>, CriteriaMatch)> = Vec::new();
        for i in 0..num_criteria {
            let range_vals = self.eval_flat(&args[1 + i * 2]);
            let criteria = self.parse_criteria(&self.evaluate(&args[2 + i * 2]));
            criteria_data.push((range_vals, criteria));
        }
        let mut total = 0.0;
        for i in 0..sum_vals.len() {
            let all_match = criteria_data.iter().all(|(range_vals, criteria)| {
                range_vals.get(i).map_or(false, |v| self.matches_criteria(v, criteria))
            });
            if all_match {
                if let Some(n) = sum_vals[i].as_number() {
                    total += n;
                }
            }
        }
        EvalResult::Number(total)
    }

    fn fn_countif(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 {
            return EvalResult::Error(CellError::Value);
        }
        let range_vals = self.eval_flat(&args[0]);
        let criteria = self.parse_criteria(&self.evaluate(&args[1]));
        let count = range_vals.iter().filter(|v| self.matches_criteria(v, &criteria)).count();
        EvalResult::Number(count as f64)
    }

    fn fn_countifs(&self, args: &[Expression]) -> EvalResult {
        // COUNTIFS(criteria_range1, criteria1, [criteria_range2, criteria2], ...)
        if args.is_empty() || args.len() % 2 != 0 {
            return EvalResult::Error(CellError::Value);
        }
        let num_criteria = args.len() / 2;
        let mut criteria_data: Vec<(Vec<EvalResult>, CriteriaMatch)> = Vec::new();
        for i in 0..num_criteria {
            let range_vals = self.eval_flat(&args[i * 2]);
            let criteria = self.parse_criteria(&self.evaluate(&args[i * 2 + 1]));
            criteria_data.push((range_vals, criteria));
        }
        let len = criteria_data.first().map_or(0, |(r, _)| r.len());
        let mut count = 0usize;
        for i in 0..len {
            let all_match = criteria_data.iter().all(|(range_vals, criteria)| {
                range_vals.get(i).map_or(false, |v| self.matches_criteria(v, criteria))
            });
            if all_match {
                count += 1;
            }
        }
        EvalResult::Number(count as f64)
    }

    fn fn_averageif(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 2 || args.len() > 3 {
            return EvalResult::Error(CellError::Value);
        }
        let range_vals = self.eval_flat(&args[0]);
        let criteria = self.parse_criteria(&self.evaluate(&args[1]));
        let avg_vals = if args.len() == 3 { self.eval_flat(&args[2]) } else { range_vals.clone() };
        let mut total = 0.0;
        let mut count = 0usize;
        for (i, val) in range_vals.iter().enumerate() {
            if self.matches_criteria(val, &criteria) {
                if let Some(n) = avg_vals.get(i).and_then(|v| v.as_number()) {
                    total += n;
                    count += 1;
                }
            }
        }
        if count == 0 { EvalResult::Error(CellError::Div0) } else { EvalResult::Number(total / count as f64) }
    }

    fn fn_averageifs(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 3 || (args.len() - 1) % 2 != 0 {
            return EvalResult::Error(CellError::Value);
        }
        let avg_vals = self.eval_flat(&args[0]);
        let num_criteria = (args.len() - 1) / 2;
        let mut criteria_data: Vec<(Vec<EvalResult>, CriteriaMatch)> = Vec::new();
        for i in 0..num_criteria {
            let range_vals = self.eval_flat(&args[1 + i * 2]);
            let criteria = self.parse_criteria(&self.evaluate(&args[2 + i * 2]));
            criteria_data.push((range_vals, criteria));
        }
        let mut total = 0.0;
        let mut count = 0usize;
        for i in 0..avg_vals.len() {
            let all_match = criteria_data.iter().all(|(range_vals, criteria)| {
                range_vals.get(i).map_or(false, |v| self.matches_criteria(v, criteria))
            });
            if all_match {
                if let Some(n) = avg_vals[i].as_number() {
                    total += n;
                    count += 1;
                }
            }
        }
        if count == 0 { EvalResult::Error(CellError::Div0) } else { EvalResult::Number(total / count as f64) }
    }

    fn fn_countblank(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }
        let vals = self.eval_flat(&args[0]);
        let count = vals.iter().filter(|v| {
            matches!(v, EvalResult::Text(s) if s.is_empty()) || matches!(v, EvalResult::Array(a) if a.is_empty())
        }).count();
        // Also count truly empty cells: eval_flat doesn't produce them, but cells not in grid
        // return empty text. The above check handles it.
        EvalResult::Number(count as f64)
    }

    fn fn_minifs(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 3 || (args.len() - 1) % 2 != 0 {
            return EvalResult::Error(CellError::Value);
        }
        let min_vals = self.eval_flat(&args[0]);
        let num_criteria = (args.len() - 1) / 2;
        let mut criteria_data: Vec<(Vec<EvalResult>, CriteriaMatch)> = Vec::new();
        for i in 0..num_criteria {
            let range_vals = self.eval_flat(&args[1 + i * 2]);
            let criteria = self.parse_criteria(&self.evaluate(&args[2 + i * 2]));
            criteria_data.push((range_vals, criteria));
        }
        let mut result = f64::INFINITY;
        let mut found = false;
        for i in 0..min_vals.len() {
            let all_match = criteria_data.iter().all(|(range_vals, criteria)| {
                range_vals.get(i).map_or(false, |v| self.matches_criteria(v, criteria))
            });
            if all_match {
                if let Some(n) = min_vals[i].as_number() {
                    result = result.min(n);
                    found = true;
                }
            }
        }
        if found { EvalResult::Number(result) } else { EvalResult::Number(0.0) }
    }

    fn fn_maxifs(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 3 || (args.len() - 1) % 2 != 0 {
            return EvalResult::Error(CellError::Value);
        }
        let max_vals = self.eval_flat(&args[0]);
        let num_criteria = (args.len() - 1) / 2;
        let mut criteria_data: Vec<(Vec<EvalResult>, CriteriaMatch)> = Vec::new();
        for i in 0..num_criteria {
            let range_vals = self.eval_flat(&args[1 + i * 2]);
            let criteria = self.parse_criteria(&self.evaluate(&args[2 + i * 2]));
            criteria_data.push((range_vals, criteria));
        }
        let mut result = f64::NEG_INFINITY;
        let mut found = false;
        for i in 0..max_vals.len() {
            let all_match = criteria_data.iter().all(|(range_vals, criteria)| {
                range_vals.get(i).map_or(false, |v| self.matches_criteria(v, criteria))
            });
            if all_match {
                if let Some(n) = max_vals[i].as_number() {
                    result = result.max(n);
                    found = true;
                }
            }
        }
        if found { EvalResult::Number(result) } else { EvalResult::Number(0.0) }
    }

    // ==================== Error Handling & Logic Functions (Batch 4) ====================

    fn fn_iferror(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 { return EvalResult::Error(CellError::Value); }
        let val = self.evaluate(&args[0]);
        if matches!(val, EvalResult::Error(_)) { self.evaluate(&args[1]) } else { val }
    }

    fn fn_ifna(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 { return EvalResult::Error(CellError::Value); }
        let val = self.evaluate(&args[0]);
        if matches!(val, EvalResult::Error(CellError::NA)) { self.evaluate(&args[1]) } else { val }
    }

    fn fn_ifs(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() || args.len() % 2 != 0 {
            return EvalResult::Error(CellError::Value);
        }
        for i in (0..args.len()).step_by(2) {
            let cond = self.evaluate(&args[i]);
            if let EvalResult::Error(e) = cond { return EvalResult::Error(e); }
            if cond.as_boolean().unwrap_or(false) {
                return self.evaluate(&args[i + 1]);
            }
        }
        EvalResult::Error(CellError::NA)
    }

    fn fn_switch(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 3 { return EvalResult::Error(CellError::Value); }
        let expr_val = self.evaluate(&args[0]);
        if let EvalResult::Error(e) = &expr_val { return EvalResult::Error(e.clone()); }
        let pairs = &args[1..];
        let has_default = pairs.len() % 2 != 0;
        let pair_count = pairs.len() / 2;
        for i in 0..pair_count {
            let case_val = self.evaluate(&pairs[i * 2]);
            if self.eval_values_equal(&expr_val, &case_val) {
                return self.evaluate(&pairs[i * 2 + 1]);
            }
        }
        if has_default {
            self.evaluate(pairs.last().unwrap())
        } else {
            EvalResult::Error(CellError::NA)
        }
    }

    fn eval_values_equal(&self, a: &EvalResult, b: &EvalResult) -> bool {
        match (a, b) {
            (EvalResult::Number(x), EvalResult::Number(y)) => (x - y).abs() < 1e-10,
            (EvalResult::Text(x), EvalResult::Text(y)) => x.to_uppercase() == y.to_uppercase(),
            (EvalResult::Boolean(x), EvalResult::Boolean(y)) => x == y,
            _ => false,
        }
    }

    fn fn_xor(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() { return EvalResult::Error(CellError::Value); }
        let mut true_count = 0usize;
        for arg in args {
            let val = self.evaluate(arg);
            for item in val.flatten() {
                if let EvalResult::Error(e) = item { return EvalResult::Error(e); }
                if item.as_boolean().unwrap_or(false) { true_count += 1; }
            }
        }
        EvalResult::Boolean(true_count % 2 != 0)
    }

    // ==================== Math Functions (Batch 5) ====================

    fn fn_sumproduct(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() { return EvalResult::Error(CellError::Value); }
        let arrays: Vec<Vec<EvalResult>> = args.iter().map(|a| self.eval_flat(a)).collect();
        let len = arrays[0].len();
        if arrays.iter().any(|a| a.len() != len) {
            return EvalResult::Error(CellError::Value);
        }
        let mut total = 0.0;
        for i in 0..len {
            let mut product = 1.0;
            for arr in &arrays {
                product *= arr[i].as_number().unwrap_or(0.0);
            }
            total += product;
        }
        EvalResult::Number(total)
    }

    fn fn_rand(&self, _args: &[Expression]) -> EvalResult {
        use std::collections::hash_map::RandomState;
        use std::hash::{BuildHasher, Hasher};
        let s = RandomState::new();
        let mut hasher = s.build_hasher();
        hasher.write_u64(0);
        let bits = hasher.finish();
        EvalResult::Number((bits as f64) / (u64::MAX as f64))
    }

    fn fn_randbetween(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 { return EvalResult::Error(CellError::Value); }
        let bottom = match self.evaluate(&args[0]).as_number() {
            Some(n) => n.ceil() as i64,
            None => return EvalResult::Error(CellError::Value),
        };
        let top = match self.evaluate(&args[1]).as_number() {
            Some(n) => n.floor() as i64,
            None => return EvalResult::Error(CellError::Value),
        };
        if bottom > top { return EvalResult::Error(CellError::Value); }
        // Generate random using hashing
        use std::collections::hash_map::RandomState;
        use std::hash::{BuildHasher, Hasher};
        let s = RandomState::new();
        let mut hasher = s.build_hasher();
        hasher.write_u64(0);
        let bits = hasher.finish();
        let range = (top - bottom + 1) as u64;
        let result = bottom + (bits % range) as i64;
        EvalResult::Number(result as f64)
    }

    fn fn_log(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() || args.len() > 2 { return EvalResult::Error(CellError::Value); }
        let n = match self.evaluate(&args[0]).as_number() {
            Some(n) if n > 0.0 => n,
            _ => return EvalResult::Error(CellError::Value),
        };
        let base = if args.len() == 2 {
            match self.evaluate(&args[1]).as_number() {
                Some(b) if b > 0.0 && (b - 1.0).abs() > 1e-10 => b,
                _ => return EvalResult::Error(CellError::Value),
            }
        } else {
            10.0
        };
        EvalResult::Number(n.ln() / base.ln())
    }

    fn fn_log10(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() {
            Some(n) if n > 0.0 => EvalResult::Number(n.log10()),
            _ => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_ln(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() {
            Some(n) if n > 0.0 => EvalResult::Number(n.ln()),
            _ => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_exp(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() {
            Some(n) => EvalResult::Number(n.exp()),
            None => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_sin(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() { Some(n) => EvalResult::Number(n.sin()), None => EvalResult::Error(CellError::Value) }
    }
    fn fn_cos(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() { Some(n) => EvalResult::Number(n.cos()), None => EvalResult::Error(CellError::Value) }
    }
    fn fn_tan(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() { Some(n) => EvalResult::Number(n.tan()), None => EvalResult::Error(CellError::Value) }
    }
    fn fn_asin(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() {
            Some(n) if (-1.0..=1.0).contains(&n) => EvalResult::Number(n.asin()),
            Some(_) => EvalResult::Error(CellError::Value),
            None => EvalResult::Error(CellError::Value),
        }
    }
    fn fn_acos(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() {
            Some(n) if (-1.0..=1.0).contains(&n) => EvalResult::Number(n.acos()),
            Some(_) => EvalResult::Error(CellError::Value),
            None => EvalResult::Error(CellError::Value),
        }
    }
    fn fn_atan(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() { Some(n) => EvalResult::Number(n.atan()), None => EvalResult::Error(CellError::Value) }
    }
    fn fn_atan2(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 { return EvalResult::Error(CellError::Value); }
        let x = match self.evaluate(&args[0]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let y = match self.evaluate(&args[1]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        if x == 0.0 && y == 0.0 { return EvalResult::Error(CellError::Div0); }
        EvalResult::Number(y.atan2(x))
    }

    fn fn_roundup(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 { return EvalResult::Error(CellError::Value); }
        let n = match self.evaluate(&args[0]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let digits = match self.evaluate(&args[1]).as_number() { Some(n) => n as i32, None => return EvalResult::Error(CellError::Value) };
        let factor = 10f64.powi(digits);
        EvalResult::Number(if n >= 0.0 { (n * factor).ceil() / factor } else { (n * factor).floor() / factor })
    }

    fn fn_rounddown(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 { return EvalResult::Error(CellError::Value); }
        let n = match self.evaluate(&args[0]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let digits = match self.evaluate(&args[1]).as_number() { Some(n) => n as i32, None => return EvalResult::Error(CellError::Value) };
        let factor = 10f64.powi(digits);
        EvalResult::Number(if n >= 0.0 { (n * factor).floor() / factor } else { (n * factor).ceil() / factor })
    }

    fn fn_trunc(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() || args.len() > 2 { return EvalResult::Error(CellError::Value); }
        let n = match self.evaluate(&args[0]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let digits = if args.len() == 2 {
            match self.evaluate(&args[1]).as_number() { Some(d) => d as i32, None => return EvalResult::Error(CellError::Value) }
        } else { 0 };
        let factor = 10f64.powi(digits);
        EvalResult::Number((n * factor).trunc() / factor)
    }

    fn fn_even(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() {
            Some(n) => {
                let ceil = if n >= 0.0 { n.ceil() } else { n.floor() };
                let result = if ceil as i64 % 2 == 0 { ceil } else if n >= 0.0 { ceil + 1.0 } else { ceil - 1.0 };
                EvalResult::Number(result)
            }
            None => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_odd(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() {
            Some(n) => {
                if n == 0.0 { return EvalResult::Number(1.0); }
                let ceil = if n >= 0.0 { n.ceil() } else { n.floor() };
                let result = if ceil as i64 % 2 != 0 { ceil } else if n >= 0.0 { ceil + 1.0 } else { ceil - 1.0 };
                EvalResult::Number(result)
            }
            None => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_gcd(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() { return EvalResult::Error(CellError::Value); }
        fn gcd(a: u64, b: u64) -> u64 { if b == 0 { a } else { gcd(b, a % b) } }
        let mut result = 0u64;
        for arg in args {
            match self.evaluate(arg).as_number() {
                Some(n) if n >= 0.0 => result = gcd(result, n as u64),
                _ => return EvalResult::Error(CellError::Value),
            }
        }
        EvalResult::Number(result as f64)
    }

    fn fn_lcm(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() { return EvalResult::Error(CellError::Value); }
        fn gcd(a: u64, b: u64) -> u64 { if b == 0 { a } else { gcd(b, a % b) } }
        fn lcm(a: u64, b: u64) -> u64 { if a == 0 || b == 0 { 0 } else { a / gcd(a, b) * b } }
        let mut result = 1u64;
        for arg in args {
            match self.evaluate(arg).as_number() {
                Some(n) if n >= 0.0 => result = lcm(result, n as u64),
                _ => return EvalResult::Error(CellError::Value),
            }
        }
        EvalResult::Number(result as f64)
    }

    fn fn_combin(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 { return EvalResult::Error(CellError::Value); }
        let n = match self.evaluate(&args[0]).as_number() { Some(v) => v as u64, None => return EvalResult::Error(CellError::Value) };
        let k = match self.evaluate(&args[1]).as_number() { Some(v) => v as u64, None => return EvalResult::Error(CellError::Value) };
        if k > n { return EvalResult::Error(CellError::Value); }
        let k = k.min(n - k);
        let mut result = 1u64;
        for i in 0..k { result = result * (n - i) / (i + 1); }
        EvalResult::Number(result as f64)
    }

    fn fn_fact(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() {
            Some(n) if n >= 0.0 => {
                let n = n as u64;
                let mut result = 1u64;
                for i in 2..=n { result = result.saturating_mul(i); }
                EvalResult::Number(result as f64)
            }
            _ => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_degrees(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() {
            Some(n) => EvalResult::Number(n.to_degrees()),
            None => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_radians(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() {
            Some(n) => EvalResult::Number(n.to_radians()),
            None => EvalResult::Error(CellError::Value),
        }
    }

    // ==================== Text Functions (Batch 6) ====================

    fn fn_find(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 2 || args.len() > 3 { return EvalResult::Error(CellError::Value); }
        let find_text = self.evaluate(&args[0]).as_text();
        let within_text = self.evaluate(&args[1]).as_text();
        let start = if args.len() == 3 {
            match self.evaluate(&args[2]).as_number() { Some(n) if n >= 1.0 => (n as usize) - 1, _ => return EvalResult::Error(CellError::Value) }
        } else { 0 };
        if start > within_text.len() { return EvalResult::Error(CellError::Value); }
        match within_text[start..].find(&find_text) {
            Some(pos) => EvalResult::Number((start + pos + 1) as f64),
            None => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_search(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 2 || args.len() > 3 { return EvalResult::Error(CellError::Value); }
        let find_text = self.evaluate(&args[0]).as_text().to_uppercase();
        let within_text = self.evaluate(&args[1]).as_text().to_uppercase();
        let start = if args.len() == 3 {
            match self.evaluate(&args[2]).as_number() { Some(n) if n >= 1.0 => (n as usize) - 1, _ => return EvalResult::Error(CellError::Value) }
        } else { 0 };
        if start > within_text.len() { return EvalResult::Error(CellError::Value); }
        // SEARCH supports wildcards
        if find_text.contains('*') || find_text.contains('?') {
            // Try matching at each position
            for pos in start..within_text.len() {
                if self.xlookup_wildcard_match(&find_text, &within_text[pos..]) {
                    return EvalResult::Number((pos + 1) as f64);
                }
            }
            EvalResult::Error(CellError::Value)
        } else {
            match within_text[start..].find(&find_text) {
                Some(pos) => EvalResult::Number((start + pos + 1) as f64),
                None => EvalResult::Error(CellError::Value),
            }
        }
    }

    fn fn_substitute(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 3 || args.len() > 4 { return EvalResult::Error(CellError::Value); }
        let text = self.evaluate(&args[0]).as_text();
        let old_text = self.evaluate(&args[1]).as_text();
        let new_text = self.evaluate(&args[2]).as_text();
        if old_text.is_empty() { return EvalResult::Text(text); }
        if args.len() == 4 {
            let instance = match self.evaluate(&args[3]).as_number() { Some(n) if n >= 1.0 => n as usize, _ => return EvalResult::Error(CellError::Value) };
            let mut count = 0usize;
            let mut result = String::new();
            let mut remaining = text.as_str();
            while let Some(pos) = remaining.find(&old_text) {
                count += 1;
                if count == instance {
                    result.push_str(&remaining[..pos]);
                    result.push_str(&new_text);
                    result.push_str(&remaining[pos + old_text.len()..]);
                    return EvalResult::Text(result);
                }
                result.push_str(&remaining[..pos + old_text.len()]);
                remaining = &remaining[pos + old_text.len()..];
            }
            result.push_str(remaining);
            EvalResult::Text(result)
        } else {
            EvalResult::Text(text.replace(&old_text, &new_text))
        }
    }

    fn fn_replace(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 4 { return EvalResult::Error(CellError::Value); }
        let text = self.evaluate(&args[0]).as_text();
        let start = match self.evaluate(&args[1]).as_number() { Some(n) if n >= 1.0 => (n as usize) - 1, _ => return EvalResult::Error(CellError::Value) };
        let num_chars = match self.evaluate(&args[2]).as_number() { Some(n) if n >= 0.0 => n as usize, _ => return EvalResult::Error(CellError::Value) };
        let new_text = self.evaluate(&args[3]).as_text();
        let chars: Vec<char> = text.chars().collect();
        let mut result = String::new();
        for (i, c) in chars.iter().enumerate() {
            if i == start { result.push_str(&new_text); }
            if i < start || i >= start + num_chars { result.push(*c); }
        }
        if start >= chars.len() { result.push_str(&new_text); }
        EvalResult::Text(result)
    }

    fn fn_value(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        let text = self.evaluate(&args[0]).as_text();
        match text.trim().parse::<f64>() {
            Ok(n) => EvalResult::Number(n),
            Err(_) => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_exact(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 { return EvalResult::Error(CellError::Value); }
        let a = self.evaluate(&args[0]).as_text();
        let b = self.evaluate(&args[1]).as_text();
        EvalResult::Boolean(a == b) // case-sensitive
    }

    fn fn_proper(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        let text = self.evaluate(&args[0]).as_text();
        let mut result = String::new();
        let mut capitalize_next = true;
        for c in text.chars() {
            if c.is_alphanumeric() {
                if capitalize_next { result.extend(c.to_uppercase()); capitalize_next = false; }
                else { result.extend(c.to_lowercase()); }
            } else {
                result.push(c);
                capitalize_next = true;
            }
        }
        EvalResult::Text(result)
    }

    fn fn_char(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() {
            Some(n) if n >= 1.0 && n <= 255.0 => EvalResult::Text(String::from(n as u8 as char)),
            _ => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_code(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        let text = self.evaluate(&args[0]).as_text();
        match text.chars().next() {
            Some(c) => EvalResult::Number(c as u32 as f64),
            None => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_clean(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        let text = self.evaluate(&args[0]).as_text();
        EvalResult::Text(text.chars().filter(|c| *c as u32 >= 32).collect())
    }

    fn fn_numbervalue(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() || args.len() > 3 { return EvalResult::Error(CellError::Value); }
        let text = self.evaluate(&args[0]).as_text();
        let decimal_sep = if args.len() >= 2 { self.evaluate(&args[1]).as_text() } else { ".".to_string() };
        let group_sep = if args.len() == 3 { self.evaluate(&args[2]).as_text() } else { ",".to_string() };
        let cleaned = text.replace(&group_sep, "").replace(&decimal_sep, ".");
        match cleaned.trim().parse::<f64>() {
            Ok(n) => EvalResult::Number(n),
            Err(_) => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_t(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        let val = self.evaluate(&args[0]);
        match val {
            EvalResult::Text(_) => val,
            EvalResult::Error(e) => EvalResult::Error(e),
            _ => EvalResult::Text(String::new()),
        }
    }

    // ==================== Date & Time Functions (Batch 2) ====================

    fn fn_today(&self, _args: &[Expression]) -> EvalResult {
        EvalResult::Number(date_serial::today_serial())
    }

    fn fn_now(&self, _args: &[Expression]) -> EvalResult {
        EvalResult::Number(date_serial::now_serial())
    }

    fn fn_date(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 3 { return EvalResult::Error(CellError::Value); }
        let year = match self.evaluate(&args[0]).as_number() { Some(n) => n as i32, None => return EvalResult::Error(CellError::Value) };
        let month = match self.evaluate(&args[1]).as_number() { Some(n) => n as i32, None => return EvalResult::Error(CellError::Value) };
        let day = match self.evaluate(&args[2]).as_number() { Some(n) => n as i32, None => return EvalResult::Error(CellError::Value) };
        EvalResult::Number(date_serial::date_to_serial(year, month, day))
    }

    fn fn_year(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() {
            Some(serial) => { let (y, _, _) = date_serial::serial_to_date(serial as i64); EvalResult::Number(y as f64) }
            None => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_month(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() {
            Some(serial) => { let (_, m, _) = date_serial::serial_to_date(serial as i64); EvalResult::Number(m as f64) }
            None => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_day(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() {
            Some(serial) => { let (_, _, d) = date_serial::serial_to_date(serial as i64); EvalResult::Number(d as f64) }
            None => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_hour(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() {
            Some(serial) => { let (h, _, _) = date_serial::serial_to_time(serial); EvalResult::Number(h as f64) }
            None => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_minute(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() {
            Some(serial) => { let (_, m, _) = date_serial::serial_to_time(serial); EvalResult::Number(m as f64) }
            None => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_second(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() {
            Some(serial) => { let (_, _, s) = date_serial::serial_to_time(serial); EvalResult::Number(s as f64) }
            None => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_datevalue(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        let text = self.evaluate(&args[0]).as_text();
        match date_serial::parse_date_string(&text) {
            Some(serial) => EvalResult::Number(serial),
            None => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_timevalue(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        let text = self.evaluate(&args[0]).as_text();
        match date_serial::parse_time_string(&text) {
            Some(fraction) => EvalResult::Number(fraction),
            None => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_edate(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 { return EvalResult::Error(CellError::Value); }
        let serial = match self.evaluate(&args[0]).as_number() { Some(n) => n as i64, None => return EvalResult::Error(CellError::Value) };
        let months = match self.evaluate(&args[1]).as_number() { Some(n) => n as i32, None => return EvalResult::Error(CellError::Value) };
        let (y, m, d) = date_serial::serial_to_date(serial);
        let (ny, nm, nd) = date_serial::add_months(y, m as i32, d, months);
        EvalResult::Number(date_serial::date_to_serial(ny, nm, nd as i32))
    }

    fn fn_eomonth(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 { return EvalResult::Error(CellError::Value); }
        let serial = match self.evaluate(&args[0]).as_number() { Some(n) => n as i64, None => return EvalResult::Error(CellError::Value) };
        let months = match self.evaluate(&args[1]).as_number() { Some(n) => n as i32, None => return EvalResult::Error(CellError::Value) };
        let (y, m, _) = date_serial::serial_to_date(serial);
        let (ny, nm, _) = date_serial::add_months(y, m as i32, 1, months);
        let last_day = date_serial::days_in_month(ny, nm as u32);
        EvalResult::Number(date_serial::date_to_serial(ny, nm, last_day as i32))
    }

    fn fn_networkdays(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 2 || args.len() > 3 { return EvalResult::Error(CellError::Value); }
        let start = match self.evaluate(&args[0]).as_number() { Some(n) => n as i64, None => return EvalResult::Error(CellError::Value) };
        let end = match self.evaluate(&args[1]).as_number() { Some(n) => n as i64, None => return EvalResult::Error(CellError::Value) };
        let holidays: Vec<i64> = if args.len() == 3 {
            self.eval_flat(&args[2]).iter().filter_map(|v| v.as_number().map(|n| n as i64)).collect()
        } else { vec![] };
        EvalResult::Number(date_serial::networkdays(start, end, &holidays) as f64)
    }

    fn fn_workday(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 2 || args.len() > 3 { return EvalResult::Error(CellError::Value); }
        let start = match self.evaluate(&args[0]).as_number() { Some(n) => n as i64, None => return EvalResult::Error(CellError::Value) };
        let days = match self.evaluate(&args[1]).as_number() { Some(n) => n as i64, None => return EvalResult::Error(CellError::Value) };
        let holidays: Vec<i64> = if args.len() == 3 {
            self.eval_flat(&args[2]).iter().filter_map(|v| v.as_number().map(|n| n as i64)).collect()
        } else { vec![] };
        EvalResult::Number(date_serial::workday(start, days, &holidays) as f64)
    }

    fn fn_datedif(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 3 { return EvalResult::Error(CellError::Value); }
        let start = match self.evaluate(&args[0]).as_number() { Some(n) => n as i64, None => return EvalResult::Error(CellError::Value) };
        let end = match self.evaluate(&args[1]).as_number() { Some(n) => n as i64, None => return EvalResult::Error(CellError::Value) };
        let unit = self.evaluate(&args[2]).as_text().to_uppercase();
        if start > end { return EvalResult::Error(CellError::Value); }
        let (sy, sm, sd) = date_serial::serial_to_date(start);
        let (ey, em, ed) = date_serial::serial_to_date(end);
        match unit.as_str() {
            "Y" => EvalResult::Number(date_serial::datedif_years(sy, sm, sd, ey, em, ed) as f64),
            "M" => EvalResult::Number(date_serial::datedif_months(sy, sm, sd, ey, em, ed) as f64),
            "D" => EvalResult::Number((end - start) as f64),
            "YM" => {
                let total_months = date_serial::datedif_months(sy, sm, sd, ey, em, ed);
                EvalResult::Number((total_months % 12) as f64)
            }
            "YD" => {
                let start_this_year = date_serial::date_to_serial(ey, sm as i32, sd as i32) as i64;
                let diff = if start_this_year <= end { end - start_this_year } else {
                    let start_prev = date_serial::date_to_serial(ey - 1, sm as i32, sd as i32) as i64;
                    end - start_prev
                };
                EvalResult::Number(diff as f64)
            }
            "MD" => {
                let diff = ed as i32 - sd as i32;
                EvalResult::Number(if diff >= 0 { diff as f64 } else {
                    let prev_month_days = date_serial::days_in_month(if em > 1 { ey } else { ey - 1 }, if em > 1 { em - 1 } else { 12 });
                    (prev_month_days as i32 + diff) as f64
                })
            }
            _ => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_weekday(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() || args.len() > 2 { return EvalResult::Error(CellError::Value); }
        let serial = match self.evaluate(&args[0]).as_number() { Some(n) => n as i64, None => return EvalResult::Error(CellError::Value) };
        let return_type = if args.len() == 2 {
            match self.evaluate(&args[1]).as_number() { Some(n) => n as i32, None => return EvalResult::Error(CellError::Value) }
        } else { 1 };
        let dow = date_serial::weekday(serial); // 0=Sunday .. 6=Saturday
        let result = match return_type {
            1 => dow + 1,       // 1=Sunday .. 7=Saturday
            2 => if dow == 0 { 7 } else { dow }, // 1=Monday .. 7=Sunday
            3 => if dow == 0 { 6 } else { dow - 1 }, // 0=Monday .. 6=Sunday
            _ => return EvalResult::Error(CellError::Value),
        };
        EvalResult::Number(result as f64)
    }

    fn fn_weeknum(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() || args.len() > 2 { return EvalResult::Error(CellError::Value); }
        let serial = match self.evaluate(&args[0]).as_number() { Some(n) => n as i64, None => return EvalResult::Error(CellError::Value) };
        let (y, _, _) = date_serial::serial_to_date(serial);
        let jan1 = date_serial::date_to_serial(y, 1, 1) as i64;
        let jan1_dow = date_serial::weekday(jan1);
        let days_since = serial - jan1;
        let week = (days_since + jan1_dow as i64) / 7 + 1;
        EvalResult::Number(week as f64)
    }

    // ==================== Information Functions (Batch 9) ====================

    fn fn_isna(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        EvalResult::Boolean(matches!(self.evaluate(&args[0]), EvalResult::Error(CellError::NA)))
    }

    fn fn_iserr(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        let val = self.evaluate(&args[0]);
        EvalResult::Boolean(matches!(val, EvalResult::Error(e) if e != CellError::NA))
    }

    fn fn_islogical(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        EvalResult::Boolean(matches!(self.evaluate(&args[0]), EvalResult::Boolean(_)))
    }

    fn fn_isodd(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() {
            Some(n) => EvalResult::Boolean(n as i64 % 2 != 0),
            None => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_iseven(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        match self.evaluate(&args[0]).as_number() {
            Some(n) => EvalResult::Boolean(n as i64 % 2 == 0),
            None => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_type(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        let val = self.evaluate(&args[0]);
        EvalResult::Number(match val {
            EvalResult::Number(_) => 1.0,
            EvalResult::Text(_) => 2.0,
            EvalResult::Boolean(_) => 4.0,
            EvalResult::Error(_) => 16.0,
            EvalResult::Array(_) => 64.0,
            EvalResult::List(_) => 128.0,
            EvalResult::Dict(_) => 256.0,
            EvalResult::Lambda { .. } => 512.0,
        })
    }

    fn fn_n(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        let val = self.evaluate(&args[0]);
        match val {
            EvalResult::Number(n) => EvalResult::Number(n),
            EvalResult::Boolean(b) => EvalResult::Number(if b { 1.0 } else { 0.0 }),
            EvalResult::Error(e) => EvalResult::Error(e),
            _ => EvalResult::Number(0.0),
        }
    }

    fn fn_isformula(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        // Check if the referenced cell contains a formula
        if let Expression::CellRef { col, row, .. } = &args[0] {
            let col_idx = col_to_index(col);
            let row_idx = row - 1;
            let has_formula = self.grid.get_cell(row_idx, col_idx).map_or(false, |c| c.formula.is_some());
            EvalResult::Boolean(has_formula)
        } else {
            EvalResult::Boolean(false)
        }
    }

    // ==================== Lookup & Reference Functions (Batch 3) ====================

    fn fn_index(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 2 || args.len() > 3 { return EvalResult::Error(CellError::Value); }
        let array = self.eval_flat(&args[0]);
        let row_num = match self.evaluate(&args[1]).as_number() {
            Some(n) if n >= 1.0 => (n as usize) - 1,
            Some(n) if n == 0.0 => 0, // Return entire column/row - simplified to first
            _ => return EvalResult::Error(CellError::Value),
        };
        // Determine array dimensions from the range expression
        let (_rows, cols) = self.get_range_dimensions(&args[0]);
        let col_num = if args.len() == 3 {
            match self.evaluate(&args[2]).as_number() {
                Some(n) if n >= 1.0 => (n as usize) - 1,
                Some(n) if n == 0.0 => 0,
                _ => return EvalResult::Error(CellError::Value),
            }
        } else { 0 };
        if cols <= 1 {
            // 1D array (single column or row)
            array.get(row_num).cloned().unwrap_or(EvalResult::Error(CellError::Ref))
        } else {
            // 2D array
            let idx = row_num * cols + col_num;
            array.get(idx).cloned().unwrap_or(EvalResult::Error(CellError::Ref))
        }
    }

    /// Helper to determine rows/cols dimensions of a range expression.
    fn get_range_dimensions(&self, expr: &Expression) -> (usize, usize) {
        match expr {
            Expression::Range { start, end, .. } => {
                if let (
                    Expression::CellRef { col: sc, row: sr, .. },
                    Expression::CellRef { col: ec, row: er, .. },
                ) = (start.as_ref(), end.as_ref()) {
                    let sc_idx = col_to_index(sc);
                    let ec_idx = col_to_index(ec);
                    let rows = ((*er as i64 - *sr as i64).unsigned_abs() + 1) as usize;
                    let cols = ((ec_idx as i64 - sc_idx as i64).unsigned_abs() + 1) as usize;
                    (rows, cols)
                } else { (1, 1) }
            }
            _ => (1, 1),
        }
    }

    fn fn_match(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 2 || args.len() > 3 { return EvalResult::Error(CellError::Value); }
        let lookup_val = self.evaluate(&args[0]);
        let lookup_array = self.eval_flat(&args[1]);
        let match_type = if args.len() == 3 {
            match self.evaluate(&args[2]).as_number() { Some(n) => n as i32, None => return EvalResult::Error(CellError::Value) }
        } else { 1 };

        match match_type {
            0 => {
                // Exact match (supports wildcards)
                let is_wildcard = matches!(&lookup_val, EvalResult::Text(s) if s.contains('*') || s.contains('?'));
                for (i, val) in lookup_array.iter().enumerate() {
                    if is_wildcard {
                        let pattern = lookup_val.as_text().to_uppercase();
                        let text = val.as_text().to_uppercase();
                        if self.xlookup_wildcard_match(&pattern, &text) {
                            return EvalResult::Number((i + 1) as f64);
                        }
                    } else if self.eval_values_equal(&lookup_val, val) {
                        return EvalResult::Number((i + 1) as f64);
                    }
                }
                EvalResult::Error(CellError::NA)
            }
            1 => {
                // Sorted ascending, find largest <= lookup_val
                let mut last_match = None;
                for (i, val) in lookup_array.iter().enumerate() {
                    if self.xlookup_compare(val, &lookup_val) != std::cmp::Ordering::Greater {
                        last_match = Some(i);
                    }
                }
                match last_match {
                    Some(i) => EvalResult::Number((i + 1) as f64),
                    None => EvalResult::Error(CellError::NA),
                }
            }
            -1 => {
                // Sorted descending, find smallest >= lookup_val
                let mut last_match = None;
                for (i, val) in lookup_array.iter().enumerate() {
                    if self.xlookup_compare(val, &lookup_val) != std::cmp::Ordering::Less {
                        last_match = Some(i);
                    }
                }
                match last_match {
                    Some(i) => EvalResult::Number((i + 1) as f64),
                    None => EvalResult::Error(CellError::NA),
                }
            }
            _ => EvalResult::Error(CellError::Value),
        }
    }

    fn fn_choose(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 2 { return EvalResult::Error(CellError::Value); }
        let idx = match self.evaluate(&args[0]).as_number() {
            Some(n) if n >= 1.0 && (n as usize) < args.len() => n as usize,
            _ => return EvalResult::Error(CellError::Value),
        };
        self.evaluate(&args[idx])
    }

    fn fn_indirect(&self, args: &[Expression]) -> EvalResult {
        // INDIRECT("A1") - parse string as cell reference and evaluate
        if args.len() < 1 || args.len() > 2 { return EvalResult::Error(CellError::Value); }
        let ref_text = self.evaluate(&args[0]).as_text();
        // Simple A1-style reference parsing
        let ref_text = ref_text.trim().to_uppercase();
        // Try to parse as cell reference: e.g., "A1", "AB123"
        let mut col_str = String::new();
        let mut row_str = String::new();
        for c in ref_text.chars() {
            if c.is_ascii_alphabetic() && row_str.is_empty() {
                col_str.push(c);
            } else if c.is_ascii_digit() {
                row_str.push(c);
            } else {
                return EvalResult::Error(CellError::Ref);
            }
        }
        if col_str.is_empty() || row_str.is_empty() {
            return EvalResult::Error(CellError::Ref);
        }
        let col_idx = col_to_index(&col_str);
        let row_idx = match row_str.parse::<u32>() {
            Ok(r) if r >= 1 => r - 1,
            _ => return EvalResult::Error(CellError::Ref),
        };
        match self.grid.get_cell(row_idx, col_idx) {
            Some(cell) => self.cell_value_to_result(&cell.value),
            None => EvalResult::Number(0.0),
        }
    }

    fn fn_offset(&self, args: &[Expression]) -> EvalResult {
        // OFFSET(reference, rows, cols, [height], [width])
        if args.len() < 3 || args.len() > 5 { return EvalResult::Error(CellError::Value); }
        // Get the base cell reference
        let (base_row, base_col) = match &args[0] {
            Expression::CellRef { col, row, .. } => ((*row as i64) - 1, col_to_index(col) as i64),
            _ => return EvalResult::Error(CellError::Value),
        };
        let row_offset = match self.evaluate(&args[1]).as_number() { Some(n) => n as i64, None => return EvalResult::Error(CellError::Value) };
        let col_offset = match self.evaluate(&args[2]).as_number() { Some(n) => n as i64, None => return EvalResult::Error(CellError::Value) };
        let new_row = base_row + row_offset;
        let new_col = base_col + col_offset;
        if new_row < 0 || new_col < 0 { return EvalResult::Error(CellError::Ref); }
        // For single cell (no height/width), return the cell value
        let height = if args.len() >= 4 { match self.evaluate(&args[3]).as_number() { Some(n) => n as usize, None => return EvalResult::Error(CellError::Value) } } else { 1 };
        let width = if args.len() == 5 { match self.evaluate(&args[4]).as_number() { Some(n) => n as usize, None => return EvalResult::Error(CellError::Value) } } else { 1 };
        if height == 1 && width == 1 {
            match self.grid.get_cell(new_row as u32, new_col as u32) {
                Some(cell) => self.cell_value_to_result(&cell.value),
                None => EvalResult::Number(0.0),
            }
        } else {
            // Return array of values
            let mut values = Vec::new();
            for r in 0..height {
                for c in 0..width {
                    let cell_row = (new_row + r as i64) as u32;
                    let cell_col = (new_col + c as i64) as u32;
                    match self.grid.get_cell(cell_row, cell_col) {
                        Some(cell) => values.push(self.cell_value_to_result(&cell.value)),
                        None => values.push(EvalResult::Number(0.0)),
                    }
                }
            }
            EvalResult::Array(values)
        }
    }

    fn fn_address(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 2 || args.len() > 5 { return EvalResult::Error(CellError::Value); }
        let row = match self.evaluate(&args[0]).as_number() { Some(n) if n >= 1.0 => n as u32, _ => return EvalResult::Error(CellError::Value) };
        let col = match self.evaluate(&args[1]).as_number() { Some(n) if n >= 1.0 => n as u32, _ => return EvalResult::Error(CellError::Value) };
        let abs_type = if args.len() >= 3 { match self.evaluate(&args[2]).as_number() { Some(n) => n as i32, None => return EvalResult::Error(CellError::Value) } } else { 1 };
        // Convert col number to letter(s)
        let col_str = crate::coord::index_to_col(col - 1);
        let result = match abs_type {
            1 => format!("${}${}", col_str, row),
            2 => format!("{}${}", col_str, row),
            3 => format!("${}{}", col_str, row),
            4 => format!("{}{}", col_str, row),
            _ => return EvalResult::Error(CellError::Value),
        };
        EvalResult::Text(result)
    }

    fn fn_rows(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        let (rows, _) = self.get_range_dimensions(&args[0]);
        EvalResult::Number(rows as f64)
    }

    fn fn_columns(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        let (_, cols) = self.get_range_dimensions(&args[0]);
        EvalResult::Number(cols as f64)
    }

    fn fn_transpose(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 { return EvalResult::Error(CellError::Value); }
        let array = self.eval_flat(&args[0]);
        let (rows, cols) = self.get_range_dimensions(&args[0]);
        if rows <= 1 && cols <= 1 {
            return array.into_iter().next().unwrap_or(EvalResult::Number(0.0));
        }
        let mut transposed = Vec::with_capacity(array.len());
        for c in 0..cols {
            for r in 0..rows {
                let idx = r * cols + c;
                transposed.push(array.get(idx).cloned().unwrap_or(EvalResult::Number(0.0)));
            }
        }
        EvalResult::Array(transposed)
    }

    // ==================== Statistical Functions (Batch 7) ====================

    fn fn_median(&self, args: &[Expression]) -> EvalResult {
        match self.collect_numbers(args) {
            Ok(mut numbers) if !numbers.is_empty() => {
                numbers.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                let len = numbers.len();
                let median = if len % 2 == 0 { (numbers[len / 2 - 1] + numbers[len / 2]) / 2.0 } else { numbers[len / 2] };
                EvalResult::Number(median)
            }
            Ok(_) => EvalResult::Error(CellError::Value),
            Err(e) => EvalResult::Error(e),
        }
    }

    fn fn_stdev(&self, args: &[Expression]) -> EvalResult {
        match self.collect_numbers(args) {
            Ok(numbers) if numbers.len() >= 2 => {
                let mean = numbers.iter().sum::<f64>() / numbers.len() as f64;
                let variance = numbers.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (numbers.len() - 1) as f64;
                EvalResult::Number(variance.sqrt())
            }
            Ok(_) => EvalResult::Error(CellError::Div0),
            Err(e) => EvalResult::Error(e),
        }
    }

    fn fn_stdevp(&self, args: &[Expression]) -> EvalResult {
        match self.collect_numbers(args) {
            Ok(numbers) if !numbers.is_empty() => {
                let mean = numbers.iter().sum::<f64>() / numbers.len() as f64;
                let variance = numbers.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / numbers.len() as f64;
                EvalResult::Number(variance.sqrt())
            }
            Ok(_) => EvalResult::Error(CellError::Div0),
            Err(e) => EvalResult::Error(e),
        }
    }

    fn fn_var(&self, args: &[Expression]) -> EvalResult {
        match self.collect_numbers(args) {
            Ok(numbers) if numbers.len() >= 2 => {
                let mean = numbers.iter().sum::<f64>() / numbers.len() as f64;
                let variance = numbers.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (numbers.len() - 1) as f64;
                EvalResult::Number(variance)
            }
            Ok(_) => EvalResult::Error(CellError::Div0),
            Err(e) => EvalResult::Error(e),
        }
    }

    fn fn_varp(&self, args: &[Expression]) -> EvalResult {
        match self.collect_numbers(args) {
            Ok(numbers) if !numbers.is_empty() => {
                let mean = numbers.iter().sum::<f64>() / numbers.len() as f64;
                let variance = numbers.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / numbers.len() as f64;
                EvalResult::Number(variance)
            }
            Ok(_) => EvalResult::Error(CellError::Div0),
            Err(e) => EvalResult::Error(e),
        }
    }

    fn fn_large(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 { return EvalResult::Error(CellError::Value); }
        let mut numbers = match self.collect_numbers(&args[0..1]) { Ok(n) => n, Err(e) => return EvalResult::Error(e) };
        let k = match self.evaluate(&args[1]).as_number() { Some(n) if n >= 1.0 => n as usize, _ => return EvalResult::Error(CellError::Value) };
        if k > numbers.len() { return EvalResult::Error(CellError::Value); }
        numbers.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
        EvalResult::Number(numbers[k - 1])
    }

    fn fn_small(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 { return EvalResult::Error(CellError::Value); }
        let mut numbers = match self.collect_numbers(&args[0..1]) { Ok(n) => n, Err(e) => return EvalResult::Error(e) };
        let k = match self.evaluate(&args[1]).as_number() { Some(n) if n >= 1.0 => n as usize, _ => return EvalResult::Error(CellError::Value) };
        if k > numbers.len() { return EvalResult::Error(CellError::Value); }
        numbers.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        EvalResult::Number(numbers[k - 1])
    }

    fn fn_rank(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 2 || args.len() > 3 { return EvalResult::Error(CellError::Value); }
        let number = match self.evaluate(&args[0]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let numbers = match self.collect_numbers(&args[1..2]) { Ok(n) => n, Err(e) => return EvalResult::Error(e) };
        let order = if args.len() == 3 { match self.evaluate(&args[2]).as_number() { Some(n) => n as i32, None => 0 } } else { 0 };
        let rank = if order == 0 {
            // Descending rank
            numbers.iter().filter(|&&n| n > number).count() + 1
        } else {
            // Ascending rank
            numbers.iter().filter(|&&n| n < number).count() + 1
        };
        if !numbers.iter().any(|&n| (n - number).abs() < 1e-10) {
            return EvalResult::Error(CellError::NA);
        }
        EvalResult::Number(rank as f64)
    }

    fn fn_percentile(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 { return EvalResult::Error(CellError::Value); }
        let mut numbers = match self.collect_numbers(&args[0..1]) { Ok(n) => n, Err(e) => return EvalResult::Error(e) };
        let k = match self.evaluate(&args[1]).as_number() { Some(n) if (0.0..=1.0).contains(&n) => n, _ => return EvalResult::Error(CellError::Value) };
        if numbers.is_empty() { return EvalResult::Error(CellError::Value); }
        numbers.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let n = numbers.len() as f64;
        let rank = k * (n - 1.0);
        let lower = rank.floor() as usize;
        let upper = rank.ceil() as usize;
        let frac = rank - lower as f64;
        let result = numbers[lower] + frac * (numbers[upper.min(numbers.len() - 1)] - numbers[lower]);
        EvalResult::Number(result)
    }

    fn fn_quartile(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 { return EvalResult::Error(CellError::Value); }
        let quart = match self.evaluate(&args[1]).as_number() {
            Some(n) if (0.0..=4.0).contains(&n) => n,
            _ => return EvalResult::Error(CellError::Value),
        };
        // Reuse PERCENTILE with k = quart/4
        let k_val = Expression::Literal(Value::Number(quart / 4.0));
        self.fn_percentile(&[args[0].clone(), k_val])
    }

    fn fn_mode(&self, args: &[Expression]) -> EvalResult {
        match self.collect_numbers(args) {
            Ok(numbers) if !numbers.is_empty() => {
                let mut counts: HashMap<i64, usize> = HashMap::new();
                for &n in &numbers {
                    // Use fixed-point for bucketing (multiply by 1e10 to handle floats)
                    let key = (n * 1e10).round() as i64;
                    *counts.entry(key).or_insert(0) += 1;
                }
                let max_count = counts.values().max().copied().unwrap_or(0);
                if max_count <= 1 { return EvalResult::Error(CellError::NA); }
                // Return the first value with max count
                for &n in &numbers {
                    let key = (n * 1e10).round() as i64;
                    if counts.get(&key) == Some(&max_count) {
                        return EvalResult::Number(n);
                    }
                }
                EvalResult::Error(CellError::NA)
            }
            Ok(_) => EvalResult::Error(CellError::Value),
            Err(e) => EvalResult::Error(e),
        }
    }

    fn fn_frequency(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 { return EvalResult::Error(CellError::Value); }
        let data = match self.collect_numbers(&args[0..1]) { Ok(n) => n, Err(e) => return EvalResult::Error(e) };
        let mut bins = match self.collect_numbers(&args[1..2]) { Ok(n) => n, Err(e) => return EvalResult::Error(e) };
        bins.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mut counts = vec![0.0; bins.len() + 1];
        for &val in &data {
            let mut placed = false;
            for (i, &bin) in bins.iter().enumerate() {
                if val <= bin { counts[i] += 1.0; placed = true; break; }
            }
            if !placed { *counts.last_mut().unwrap() += 1.0; }
        }
        EvalResult::Array(counts.into_iter().map(EvalResult::Number).collect())
    }

    // ==================== Financial Functions (Batch 8) ====================

    fn fn_pmt(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 3 || args.len() > 5 { return EvalResult::Error(CellError::Value); }
        let rate = match self.evaluate(&args[0]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let nper = match self.evaluate(&args[1]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let pv = match self.evaluate(&args[2]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let fv = if args.len() >= 4 { self.evaluate(&args[3]).as_number().unwrap_or(0.0) } else { 0.0 };
        let pmt_type = if args.len() == 5 { self.evaluate(&args[4]).as_number().unwrap_or(0.0) as i32 } else { 0 };
        if nper == 0.0 { return EvalResult::Error(CellError::Value); }
        let pmt = if rate.abs() < 1e-10 {
            -(pv + fv) / nper
        } else {
            let pvif = (1.0 + rate).powf(nper);
            let pmt = rate * (pv * pvif + fv) / (pvif - 1.0);
            if pmt_type == 1 { -pmt / (1.0 + rate) } else { -pmt }
        };
        EvalResult::Number(pmt)
    }

    fn fn_pv(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 3 || args.len() > 5 { return EvalResult::Error(CellError::Value); }
        let rate = match self.evaluate(&args[0]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let nper = match self.evaluate(&args[1]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let pmt = match self.evaluate(&args[2]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let fv = if args.len() >= 4 { self.evaluate(&args[3]).as_number().unwrap_or(0.0) } else { 0.0 };
        let pmt_type = if args.len() == 5 { self.evaluate(&args[4]).as_number().unwrap_or(0.0) as i32 } else { 0 };
        if rate.abs() < 1e-10 {
            EvalResult::Number(-pmt * nper - fv)
        } else {
            let pvif = (1.0 + rate).powf(nper);
            let pv_factor = if pmt_type == 1 { 1.0 + rate } else { 1.0 };
            EvalResult::Number((-pmt * pv_factor * (pvif - 1.0) / rate - fv) / pvif)
        }
    }

    fn fn_fv(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 3 || args.len() > 5 { return EvalResult::Error(CellError::Value); }
        let rate = match self.evaluate(&args[0]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let nper = match self.evaluate(&args[1]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let pmt = match self.evaluate(&args[2]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let pv = if args.len() >= 4 { self.evaluate(&args[3]).as_number().unwrap_or(0.0) } else { 0.0 };
        let pmt_type = if args.len() == 5 { self.evaluate(&args[4]).as_number().unwrap_or(0.0) as i32 } else { 0 };
        if rate.abs() < 1e-10 {
            EvalResult::Number(-pv - pmt * nper)
        } else {
            let pvif = (1.0 + rate).powf(nper);
            let pmt_factor = if pmt_type == 1 { 1.0 + rate } else { 1.0 };
            EvalResult::Number(-pv * pvif - pmt * pmt_factor * (pvif - 1.0) / rate)
        }
    }

    fn fn_npv(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 2 { return EvalResult::Error(CellError::Value); }
        let rate = match self.evaluate(&args[0]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let mut total = 0.0;
        let mut period = 1;
        for arg in &args[1..] {
            for val in self.eval_flat(arg) {
                if let Some(cf) = val.as_number() {
                    total += cf / (1.0 + rate).powi(period);
                    period += 1;
                }
            }
        }
        EvalResult::Number(total)
    }

    fn fn_irr(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() || args.len() > 2 { return EvalResult::Error(CellError::Value); }
        let cashflows: Vec<f64> = self.eval_flat(&args[0]).iter().filter_map(|v| v.as_number()).collect();
        if cashflows.len() < 2 { return EvalResult::Error(CellError::Value); }
        let mut guess = if args.len() == 2 { self.evaluate(&args[1]).as_number().unwrap_or(0.1) } else { 0.1 };
        // Newton's method
        for _ in 0..100 {
            let mut npv = 0.0;
            let mut dnpv = 0.0;
            for (i, &cf) in cashflows.iter().enumerate() {
                let pv_factor = (1.0 + guess).powi(i as i32);
                npv += cf / pv_factor;
                if i > 0 { dnpv -= (i as f64) * cf / (1.0 + guess).powi(i as i32 + 1); }
            }
            if dnpv.abs() < 1e-15 { return EvalResult::Error(CellError::Value); }
            let new_guess = guess - npv / dnpv;
            if (new_guess - guess).abs() < 1e-10 { return EvalResult::Number(new_guess); }
            guess = new_guess;
        }
        EvalResult::Error(CellError::Value) // Did not converge
    }

    fn fn_rate(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 3 || args.len() > 6 { return EvalResult::Error(CellError::Value); }
        let nper = match self.evaluate(&args[0]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let pmt = match self.evaluate(&args[1]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let pv = match self.evaluate(&args[2]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let fv = if args.len() >= 4 { self.evaluate(&args[3]).as_number().unwrap_or(0.0) } else { 0.0 };
        let pmt_type = if args.len() >= 5 { self.evaluate(&args[4]).as_number().unwrap_or(0.0) as i32 } else { 0 };
        let mut guess = if args.len() == 6 { self.evaluate(&args[5]).as_number().unwrap_or(0.1) } else { 0.1 };
        // Newton's method
        for _ in 0..100 {
            let pvif = (1.0 + guess).powf(nper);
            let pmt_factor = if pmt_type == 1 { 1.0 + guess } else { 1.0 };
            let f = pv * pvif + pmt * pmt_factor * (pvif - 1.0) / guess + fv;
            let df = nper * pv * (1.0 + guess).powf(nper - 1.0) + pmt * pmt_factor * (nper * guess * (1.0 + guess).powf(nper - 1.0) - (pvif - 1.0)) / (guess * guess);
            if df.abs() < 1e-15 { return EvalResult::Error(CellError::Value); }
            let new_guess = guess - f / df;
            if (new_guess - guess).abs() < 1e-10 { return EvalResult::Number(new_guess); }
            guess = new_guess;
        }
        EvalResult::Error(CellError::Value)
    }

    fn fn_nper(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 3 || args.len() > 5 { return EvalResult::Error(CellError::Value); }
        let rate = match self.evaluate(&args[0]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let pmt = match self.evaluate(&args[1]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let pv = match self.evaluate(&args[2]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let fv = if args.len() >= 4 { self.evaluate(&args[3]).as_number().unwrap_or(0.0) } else { 0.0 };
        let pmt_type = if args.len() == 5 { self.evaluate(&args[4]).as_number().unwrap_or(0.0) as i32 } else { 0 };
        if rate.abs() < 1e-10 {
            if pmt.abs() < 1e-10 { return EvalResult::Error(CellError::Value); }
            return EvalResult::Number(-(pv + fv) / pmt);
        }
        let pmt_factor = if pmt_type == 1 { 1.0 + rate } else { 1.0 };
        let num = -fv + pmt * pmt_factor / rate;
        let den = pv + pmt * pmt_factor / rate;
        if num / den <= 0.0 { return EvalResult::Error(CellError::Value); }
        EvalResult::Number((num / den).ln() / (1.0 + rate).ln())
    }

    fn fn_sln(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 3 { return EvalResult::Error(CellError::Value); }
        let cost = match self.evaluate(&args[0]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let salvage = match self.evaluate(&args[1]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let life = match self.evaluate(&args[2]).as_number() { Some(n) if n > 0.0 => n, _ => return EvalResult::Error(CellError::Value) };
        EvalResult::Number((cost - salvage) / life)
    }

    fn fn_db(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 4 || args.len() > 5 { return EvalResult::Error(CellError::Value); }
        let cost = match self.evaluate(&args[0]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let salvage = match self.evaluate(&args[1]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let life = match self.evaluate(&args[2]).as_number() { Some(n) if n > 0.0 => n as i32, _ => return EvalResult::Error(CellError::Value) };
        let period = match self.evaluate(&args[3]).as_number() { Some(n) if n >= 1.0 => n as i32, _ => return EvalResult::Error(CellError::Value) };
        let month = if args.len() == 5 { match self.evaluate(&args[4]).as_number() { Some(n) => n as i32, None => 12 } } else { 12 };
        if cost <= 0.0 || life == 0 { return EvalResult::Error(CellError::Value); }
        let rate = (1.0 - (salvage / cost).powf(1.0 / life as f64) * 1000.0).round() / 1000.0;
        let mut total_dep = 0.0;
        let mut current_value = cost;
        for p in 1..=period {
            let dep = if p == 1 {
                cost * rate * month as f64 / 12.0
            } else if p == life + 1 {
                current_value * rate * (12 - month) as f64 / 12.0
            } else {
                current_value * rate
            };
            if p == period { return EvalResult::Number(dep); }
            total_dep += dep;
            current_value = cost - total_dep;
        }
        EvalResult::Number(0.0)
    }

    fn fn_ddb(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 4 || args.len() > 5 { return EvalResult::Error(CellError::Value); }
        let cost = match self.evaluate(&args[0]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let salvage = match self.evaluate(&args[1]).as_number() { Some(n) => n, None => return EvalResult::Error(CellError::Value) };
        let life = match self.evaluate(&args[2]).as_number() { Some(n) if n > 0.0 => n, _ => return EvalResult::Error(CellError::Value) };
        let period = match self.evaluate(&args[3]).as_number() { Some(n) if n >= 1.0 => n, _ => return EvalResult::Error(CellError::Value) };
        let factor = if args.len() == 5 { self.evaluate(&args[4]).as_number().unwrap_or(2.0) } else { 2.0 };
        let mut current_value = cost;
        for p in 1..=(period as i32) {
            let dep = (current_value * factor / life).min(current_value - salvage).max(0.0);
            if p == period as i32 { return EvalResult::Number(dep); }
            current_value -= dep;
        }
        EvalResult::Number(0.0)
    }

    // ==================== Advanced Functions ====================

    /// LET(name1, value1, [name2, value2, ...], calculation)
    /// Assigns names to intermediate results for use in a final calculation.
    /// Since our AST doesn't have a "name binding" node, LET works by evaluating
    /// value expressions and substituting them into the calculation expression.
    /// In practice, the parser passes all arguments as positional expressions.
    /// We evaluate pairs of (name_expr, value_expr) and the final calculation.
    ///
    /// Implementation note: LET requires at least 3 arguments (name, value, calculation),
    /// the total argument count must be odd, and there can be at most 126 name/value pairs.
    /// Since our Expression AST doesn't support name binding, we use a workaround:
    /// LET(name1, value1, [name2, value2, ...], calculation)
    /// Binds names to values in a local scope, then evaluates the calculation.
    fn fn_let(&self, args: &[Expression]) -> EvalResult {
        // LET needs at least 3 args: name1, value1, calculation
        // Total must be odd (pairs of name/value + final calculation)
        if args.len() < 3 || args.len() % 2 == 0 {
            return EvalResult::Error(CellError::Value);
        }
        // Max 126 name/value pairs (252 args + 1 calculation = 253)
        if args.len() > 253 {
            return EvalResult::Error(CellError::Value);
        }

        // Save previous scope values that might be shadowed
        let pair_count = (args.len() - 1) / 2;
        let mut saved: Vec<(String, Option<EvalResult>)> = Vec::new();

        for i in 0..pair_count {
            let name = self.extract_param_name(&args[i * 2]);
            if name.is_empty() {
                return EvalResult::Error(CellError::Value);
            }
            let value = self.evaluate(&args[i * 2 + 1]);
            if let EvalResult::Error(e) = &value {
                // Restore saved scope entries before returning error
                let mut scope = self.scope.borrow_mut();
                for (k, old) in saved.into_iter().rev() {
                    match old {
                        Some(v) => { scope.insert(k, v); }
                        None => { scope.remove(&k); }
                    }
                }
                return EvalResult::Error(e.clone());
            }
            let key = name.to_uppercase();
            {
                let mut scope = self.scope.borrow_mut();
                saved.push((key.clone(), scope.get(&key).cloned()));
                scope.insert(key, value);
            }
        }

        // Evaluate the calculation expression with bindings in scope
        let result = self.evaluate(args.last().unwrap());

        // Restore previous scope
        {
            let mut scope = self.scope.borrow_mut();
            for (k, old) in saved.into_iter().rev() {
                match old {
                    Some(v) => { scope.insert(k, v); }
                    None => { scope.remove(&k); }
                }
            }
        }

        result
    }

    // ==================== Lambda Helper ====================

    /// Extract a parameter name from a NamedRef expression.
    /// Returns the uppercased name, or empty string if not a NamedRef.
    fn extract_param_name(&self, expr: &Expression) -> String {
        if let Expression::NamedRef { name } = expr {
            name.to_uppercase()
        } else {
            String::new()
        }
    }

    /// Invoke a lambda with the given argument values bound to its parameters.
    /// Temporarily binds params in scope, evaluates body, then restores scope.
    fn invoke_lambda(&self, params: &[String], body: &Expression, args: &[EvalResult]) -> EvalResult {
        // Save previous scope values and set new bindings
        let mut saved: Vec<(String, Option<EvalResult>)> = Vec::with_capacity(params.len());
        {
            let mut scope = self.scope.borrow_mut();
            for (i, name) in params.iter().enumerate() {
                let key = name.to_uppercase();
                saved.push((key.clone(), scope.get(&key).cloned()));
                if let Some(val) = args.get(i) {
                    scope.insert(key, val.clone());
                }
            }
        }

        let result = self.evaluate(body);

        // Restore scope
        {
            let mut scope = self.scope.borrow_mut();
            for (k, old) in saved.into_iter().rev() {
                match old {
                    Some(v) => { scope.insert(k, v); }
                    None => { scope.remove(&k); }
                }
            }
        }

        result
    }

    // ==================== LAMBDA Functions ====================

    /// LAMBDA([param1], [param2], ..., calculation)
    /// Creates a callable function. The last argument is the body; all others are parameter names.
    /// With 1 arg: no-param lambda (thunk) — LAMBDA(body)
    /// With 2+ args: parameterized lambda — LAMBDA(param1, ..., body)
    fn fn_lambda(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() {
            return EvalResult::Error(CellError::Value);
        }

        // Extract parameter names from first N-1 args
        let mut params = Vec::with_capacity(args.len() - 1);
        for arg in &args[..args.len() - 1] {
            let name = self.extract_param_name(arg);
            if name.is_empty() {
                return EvalResult::Error(CellError::Value);
            }
            params.push(name);
        }

        // The last argument is the body (unevaluated)
        let body = args.last().unwrap().clone();

        EvalResult::Lambda {
            params,
            body: Box::new(body),
        }
    }

    /// MAP(array, lambda)
    /// Applies lambda to each element of the array. Returns an array of results.
    /// Works with COLLECT: if the lambda returns a List/Dict, each output cell is 3D.
    fn fn_map(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 {
            return EvalResult::Error(CellError::Value);
        }

        let (rows, cols, data) = self.eval_range_2d(&args[0]);
        let lambda = self.evaluate(&args[1]);

        let (params, body) = match &lambda {
            EvalResult::Lambda { params, body } => (params.clone(), body.as_ref().clone()),
            _ => return EvalResult::Error(CellError::Value),
        };

        if params.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }

        // Apply lambda to each element
        let mut results: Vec<EvalResult> = Vec::with_capacity(rows * cols);
        for item in &data {
            let result = self.invoke_lambda(&params, &body, &[item.clone()]);
            results.push(result);
        }

        // Reshape to match input dimensions
        if cols == 1 {
            EvalResult::Array(results)
        } else {
            let mut row_arrays = Vec::with_capacity(rows);
            for r in 0..rows {
                let start = r * cols;
                let end = start + cols;
                row_arrays.push(EvalResult::Array(results[start..end].to_vec()));
            }
            EvalResult::Array(row_arrays)
        }
    }

    /// REDUCE(initial_value, array, lambda)
    /// Reduces an array to a single value by applying lambda(accumulator, element) iteratively.
    fn fn_reduce(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 3 {
            return EvalResult::Error(CellError::Value);
        }

        let initial = self.evaluate(&args[0]);
        if let EvalResult::Error(e) = &initial {
            return EvalResult::Error(e.clone());
        }

        let flat = self.eval_flat(&args[1]);
        let lambda = self.evaluate(&args[2]);

        let (params, body) = match &lambda {
            EvalResult::Lambda { params, body } => (params.clone(), body.as_ref().clone()),
            _ => return EvalResult::Error(CellError::Value),
        };

        if params.len() != 2 {
            return EvalResult::Error(CellError::Value);
        }

        let mut accumulator = initial;
        for item in &flat {
            accumulator = self.invoke_lambda(&params, &body, &[accumulator, item.clone()]);
            if let EvalResult::Error(_) = &accumulator {
                return accumulator;
            }
        }

        accumulator
    }

    /// SCAN(initial_value, array, lambda)
    /// Like REDUCE, but returns an array of all intermediate accumulator values.
    fn fn_scan(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 3 {
            return EvalResult::Error(CellError::Value);
        }

        let initial = self.evaluate(&args[0]);
        if let EvalResult::Error(e) = &initial {
            return EvalResult::Error(e.clone());
        }

        let flat = self.eval_flat(&args[1]);
        let lambda = self.evaluate(&args[2]);

        let (params, body) = match &lambda {
            EvalResult::Lambda { params, body } => (params.clone(), body.as_ref().clone()),
            _ => return EvalResult::Error(CellError::Value),
        };

        if params.len() != 2 {
            return EvalResult::Error(CellError::Value);
        }

        let mut accumulator = initial;
        let mut results: Vec<EvalResult> = Vec::with_capacity(flat.len());
        for item in &flat {
            accumulator = self.invoke_lambda(&params, &body, &[accumulator, item.clone()]);
            if let EvalResult::Error(_) = &accumulator {
                return accumulator;
            }
            results.push(accumulator.clone());
        }

        EvalResult::Array(results)
    }

    /// MAKEARRAY(rows, cols, lambda)
    /// Creates an array where each cell is computed by lambda(row_index, col_index).
    /// Indices are 1-based (Excel convention).
    fn fn_makearray(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 3 {
            return EvalResult::Error(CellError::Value);
        }

        let rows = match self.evaluate(&args[0]).as_number() {
            Some(n) if n >= 1.0 && n <= 1048576.0 => n as usize,
            _ => return EvalResult::Error(CellError::Value),
        };
        let cols = match self.evaluate(&args[1]).as_number() {
            Some(n) if n >= 1.0 && n <= 16384.0 => n as usize,
            _ => return EvalResult::Error(CellError::Value),
        };

        let lambda = self.evaluate(&args[2]);
        let (params, body) = match &lambda {
            EvalResult::Lambda { params, body } => (params.clone(), body.as_ref().clone()),
            _ => return EvalResult::Error(CellError::Value),
        };

        if params.len() != 2 {
            return EvalResult::Error(CellError::Value);
        }

        if cols == 1 {
            // Single column → flat array
            let mut results = Vec::with_capacity(rows);
            for r in 0..rows {
                let result = self.invoke_lambda(&params, &body, &[
                    EvalResult::Number((r + 1) as f64),
                    EvalResult::Number(1.0),
                ]);
                results.push(result);
            }
            EvalResult::Array(results)
        } else {
            // Multi-column → 2D array
            let mut row_arrays = Vec::with_capacity(rows);
            for r in 0..rows {
                let mut row = Vec::with_capacity(cols);
                for c in 0..cols {
                    let result = self.invoke_lambda(&params, &body, &[
                        EvalResult::Number((r + 1) as f64),
                        EvalResult::Number((c + 1) as f64),
                    ]);
                    row.push(result);
                }
                row_arrays.push(EvalResult::Array(row));
            }
            EvalResult::Array(row_arrays)
        }
    }

    /// BYROW(array, lambda)
    /// Applies lambda to each row of the array. Lambda receives a 1D array (the row).
    /// Returns a single-column array of results.
    fn fn_byrow(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 {
            return EvalResult::Error(CellError::Value);
        }

        let (rows, cols, data) = self.eval_range_2d(&args[0]);
        let lambda = self.evaluate(&args[1]);

        let (params, body) = match &lambda {
            EvalResult::Lambda { params, body } => (params.clone(), body.as_ref().clone()),
            _ => return EvalResult::Error(CellError::Value),
        };

        if params.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }

        let mut results = Vec::with_capacity(rows);
        for r in 0..rows {
            // Build the row as a List (so the lambda can use aggregate functions on it)
            let start = r * cols;
            let row_data: Vec<EvalResult> = (0..cols)
                .map(|c| data.get(start + c).cloned().unwrap_or(EvalResult::Number(0.0)))
                .collect();
            let row_arg = EvalResult::Array(row_data);
            let result = self.invoke_lambda(&params, &body, &[row_arg]);
            results.push(result);
        }

        EvalResult::Array(results)
    }

    /// BYCOL(array, lambda)
    /// Applies lambda to each column of the array. Lambda receives a 1D array (the column).
    /// Returns a single-row array of results.
    fn fn_bycol(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 {
            return EvalResult::Error(CellError::Value);
        }

        let (rows, cols, data) = self.eval_range_2d(&args[0]);
        let lambda = self.evaluate(&args[1]);

        let (params, body) = match &lambda {
            EvalResult::Lambda { params, body } => (params.clone(), body.as_ref().clone()),
            _ => return EvalResult::Error(CellError::Value),
        };

        if params.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }

        let mut results = Vec::with_capacity(cols);
        for c in 0..cols {
            // Build the column as a 1D array
            let col_data: Vec<EvalResult> = (0..rows)
                .map(|r| data.get(r * cols + c).cloned().unwrap_or(EvalResult::Number(0.0)))
                .collect();
            let col_arg = EvalResult::Array(col_data);
            let result = self.invoke_lambda(&params, &body, &[col_arg]);
            results.push(result);
        }

        EvalResult::Array(results)
    }

    /// TEXTJOIN(delimiter, ignore_empty, text1, [text2], ...)
    /// Joins text from multiple ranges/values with a specified delimiter.
    fn fn_textjoin(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 3 {
            return EvalResult::Error(CellError::Value);
        }
        // Evaluate delimiter
        let delimiter = match self.evaluate(&args[0]) {
            EvalResult::Text(s) => s,
            EvalResult::Number(n) => format!("{}", n),
            EvalResult::Boolean(b) => if b { "TRUE".to_string() } else { "FALSE".to_string() },
            EvalResult::Error(e) => return EvalResult::Error(e),
            _ => String::new(),
        };

        // Evaluate ignore_empty flag
        let ignore_empty = match self.evaluate(&args[1]) {
            EvalResult::Boolean(b) => b,
            EvalResult::Number(n) => n != 0.0,
            EvalResult::Text(s) => s.eq_ignore_ascii_case("TRUE"),
            _ => true, // default to TRUE
        };

        // Collect text values from remaining arguments, iterating over range cells
        // directly so we can detect truly empty cells (which eval_flat maps to 0.0).
        let mut parts: Vec<String> = Vec::new();
        for arg in &args[2..] {
            self.textjoin_collect(arg, ignore_empty, &mut parts);
        }

        let result = parts.join(&delimiter);
        // Excel returns #VALUE! if result exceeds 32767 characters
        if result.len() > 32767 {
            return EvalResult::Error(CellError::Value);
        }
        EvalResult::Text(result)
    }

    /// Helper for TEXTJOIN: collects string parts from an expression,
    /// detecting truly empty cells when iterating over ranges.
    // ==================== Dynamic Array Functions ====================

    /// Helper: extract a 2D grid of values from a range expression.
    /// Returns (rows, cols, data) where data[row_idx * cols + col_idx] = value.
    fn eval_range_2d(&self, expr: &Expression) -> (usize, usize, Vec<EvalResult>) {
        let (rows, cols) = self.get_range_dimensions(expr);
        let flat = self.eval_flat(expr);
        (rows, cols, flat)
    }

    /// FILTER(array, include, [if_empty])
    /// Returns only the rows (or values) where include is TRUE.
    fn fn_filter(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() || args.len() > 3 {
            return EvalResult::Error(CellError::Value);
        }

        let (rows, cols, data) = self.eval_range_2d(&args[0]);
        let include = self.eval_flat(&args[1]);
        let (inc_rows, inc_cols) = self.get_range_dimensions(&args[1]);

        // include must be a single column or single row matching the array dimension
        let filter_by_row = inc_cols == 1 && inc_rows == rows;
        let filter_by_col = inc_rows == 1 && inc_cols == cols;

        if !filter_by_row && !filter_by_col {
            return EvalResult::Error(CellError::Value);
        }

        if filter_by_row {
            // Filter rows: keep rows where include[i] is truthy
            let mut result_rows: Vec<Vec<EvalResult>> = Vec::new();
            for r in 0..rows {
                let inc_val = include.get(r).cloned().unwrap_or(EvalResult::Boolean(false));
                let truthy = match &inc_val {
                    EvalResult::Boolean(b) => *b,
                    EvalResult::Number(n) => *n != 0.0,
                    _ => false,
                };
                if truthy {
                    let row_start = r * cols;
                    let row_data: Vec<EvalResult> = (0..cols)
                        .map(|c| data.get(row_start + c).cloned().unwrap_or(EvalResult::Number(0.0)))
                        .collect();
                    result_rows.push(row_data);
                }
            }

            if result_rows.is_empty() {
                // Return if_empty or #CALC! error
                if args.len() >= 3 {
                    return self.evaluate(&args[2]);
                }
                return EvalResult::Error(CellError::Value);
            }

            // Build 2D array: Array of row-Arrays
            if cols == 1 {
                // Single column: return flat array
                EvalResult::Array(result_rows.into_iter().map(|r| r.into_iter().next().unwrap()).collect())
            } else {
                EvalResult::Array(result_rows.into_iter().map(|r| EvalResult::Array(r)).collect())
            }
        } else {
            // Filter columns: keep columns where include[j] is truthy
            let mut kept_cols: Vec<usize> = Vec::new();
            for c in 0..cols {
                let inc_val = include.get(c).cloned().unwrap_or(EvalResult::Boolean(false));
                let truthy = match &inc_val {
                    EvalResult::Boolean(b) => *b,
                    EvalResult::Number(n) => *n != 0.0,
                    _ => false,
                };
                if truthy {
                    kept_cols.push(c);
                }
            }

            if kept_cols.is_empty() {
                if args.len() >= 3 {
                    return self.evaluate(&args[2]);
                }
                return EvalResult::Error(CellError::Value);
            }

            let mut result_rows: Vec<Vec<EvalResult>> = Vec::new();
            for r in 0..rows {
                let row_start = r * cols;
                let row_data: Vec<EvalResult> = kept_cols
                    .iter()
                    .map(|&c| data.get(row_start + c).cloned().unwrap_or(EvalResult::Number(0.0)))
                    .collect();
                result_rows.push(row_data);
            }

            if kept_cols.len() == 1 {
                EvalResult::Array(result_rows.into_iter().map(|r| r.into_iter().next().unwrap()).collect())
            } else {
                EvalResult::Array(result_rows.into_iter().map(|r| EvalResult::Array(r)).collect())
            }
        }
    }

    /// SORT(array, [sort_index], [sort_order], [by_col])
    /// Returns the array sorted by a given row or column.
    fn fn_sort(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() || args.len() > 4 {
            return EvalResult::Error(CellError::Value);
        }

        let (rows, cols, data) = self.eval_range_2d(&args[0]);
        let sort_index = if args.len() >= 2 {
            match self.evaluate(&args[1]).as_number() {
                Some(n) => n as usize,
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            1
        };
        let sort_order = if args.len() >= 3 {
            match self.evaluate(&args[2]).as_number() {
                Some(n) => n as i32,
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            1 // ascending
        };
        let by_col = if args.len() >= 4 {
            match self.evaluate(&args[3]).as_boolean() {
                Some(b) => b,
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            false // sort by row (default)
        };

        if !by_col {
            // Sort rows by column sort_index
            if sort_index < 1 || sort_index > cols {
                return EvalResult::Error(CellError::Value);
            }
            let col_idx = sort_index - 1;

            // Build row vectors
            let mut row_vecs: Vec<Vec<EvalResult>> = (0..rows)
                .map(|r| {
                    let start = r * cols;
                    (0..cols).map(|c| data.get(start + c).cloned().unwrap_or(EvalResult::Number(0.0))).collect()
                })
                .collect();

            // Sort by the key column
            row_vecs.sort_by(|a, b| {
                let va = &a[col_idx];
                let vb = &b[col_idx];
                let cmp = Self::compare_eval_results(va, vb);
                if sort_order == -1 { cmp.reverse() } else { cmp }
            });

            if cols == 1 {
                EvalResult::Array(row_vecs.into_iter().map(|r| r.into_iter().next().unwrap()).collect())
            } else {
                EvalResult::Array(row_vecs.into_iter().map(|r| EvalResult::Array(r)).collect())
            }
        } else {
            // Sort columns by row sort_index
            if sort_index < 1 || sort_index > rows {
                return EvalResult::Error(CellError::Value);
            }
            let row_idx = sort_index - 1;

            // Build column vectors
            let mut col_vecs: Vec<(usize, Vec<EvalResult>)> = (0..cols)
                .map(|c| {
                    let col_data: Vec<EvalResult> = (0..rows)
                        .map(|r| data.get(r * cols + c).cloned().unwrap_or(EvalResult::Number(0.0)))
                        .collect();
                    (c, col_data)
                })
                .collect();

            col_vecs.sort_by(|a, b| {
                let va = &a.1[row_idx];
                let vb = &b.1[row_idx];
                let cmp = Self::compare_eval_results(va, vb);
                if sort_order == -1 { cmp.reverse() } else { cmp }
            });

            // Rebuild as rows
            let mut result_rows: Vec<Vec<EvalResult>> = Vec::new();
            for r in 0..rows {
                let row_data: Vec<EvalResult> = col_vecs
                    .iter()
                    .map(|(_, col_data)| col_data[r].clone())
                    .collect();
                result_rows.push(row_data);
            }

            if rows == 1 {
                EvalResult::Array(result_rows.into_iter().next().unwrap())
            } else {
                EvalResult::Array(result_rows.into_iter().map(|r| EvalResult::Array(r)).collect())
            }
        }
    }

    /// Compare two EvalResults for sorting (numbers < text < booleans < errors).
    fn compare_eval_results(a: &EvalResult, b: &EvalResult) -> std::cmp::Ordering {
        fn sort_key(v: &EvalResult) -> (u8, f64, String) {
            match v {
                EvalResult::Number(n) => (0, *n, String::new()),
                EvalResult::Text(s) => (1, 0.0, s.to_uppercase()),
                EvalResult::Boolean(b) => (2, if *b { 1.0 } else { 0.0 }, String::new()),
                EvalResult::Error(_) => (3, 0.0, String::new()),
                EvalResult::Array(_) => (4, 0.0, String::new()),
                EvalResult::List(_) | EvalResult::Dict(_) | EvalResult::Lambda { .. } => (5, 0.0, String::new()),
            }
        }
        let (ta, na, sa) = sort_key(a);
        let (tb, nb, sb) = sort_key(b);
        ta.cmp(&tb)
            .then(na.partial_cmp(&nb).unwrap_or(std::cmp::Ordering::Equal))
            .then(sa.cmp(&sb))
    }

    /// SORTBY(array, by_array1, [sort_order1], [by_array2], [sort_order2], ...)
    /// Sorts the rows of array based on one or more by_arrays.
    fn fn_sortby(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 2 {
            return EvalResult::Error(CellError::Value);
        }

        let (rows, cols, data) = self.eval_range_2d(&args[0]);
        if rows == 0 {
            return EvalResult::Error(CellError::Value);
        }

        // Parse by_array/sort_order pairs
        let mut sort_keys: Vec<(Vec<EvalResult>, i32)> = Vec::new();
        let mut i = 1;
        while i < args.len() {
            let by_vals = self.eval_flat(&args[i]);
            if by_vals.len() != rows {
                return EvalResult::Error(CellError::Value);
            }
            let order = if i + 1 < args.len() {
                match self.evaluate(&args[i + 1]).as_number() {
                    Some(n) => {
                        i += 2;
                        n as i32
                    }
                    None => {
                        // Next arg is not a number, treat as next by_array (order defaults to 1)
                        i += 1;
                        1
                    }
                }
            } else {
                i += 1;
                1 // ascending
            };
            sort_keys.push((by_vals, order));
        }

        // Build row vectors
        let mut row_vecs: Vec<(usize, Vec<EvalResult>)> = (0..rows)
            .map(|r| {
                let start = r * cols;
                let row_data: Vec<EvalResult> = (0..cols)
                    .map(|c| data.get(start + c).cloned().unwrap_or(EvalResult::Number(0.0)))
                    .collect();
                (r, row_data)
            })
            .collect();

        // Stable sort by all keys (primary first, then secondary, etc.)
        row_vecs.sort_by(|a, b| {
            for (by_vals, order) in &sort_keys {
                let va = &by_vals[a.0];
                let vb = &by_vals[b.0];
                let cmp = Self::compare_eval_results(va, vb);
                let cmp = if *order == -1 { cmp.reverse() } else { cmp };
                if cmp != std::cmp::Ordering::Equal {
                    return cmp;
                }
            }
            std::cmp::Ordering::Equal
        });

        if cols == 1 {
            EvalResult::Array(row_vecs.into_iter().map(|(_, r)| r.into_iter().next().unwrap()).collect())
        } else {
            EvalResult::Array(row_vecs.into_iter().map(|(_, r)| EvalResult::Array(r)).collect())
        }
    }

    /// UNIQUE(array, [by_col], [exactly_once])
    /// Returns unique rows (or columns) from the array.
    fn fn_unique(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() || args.len() > 3 {
            return EvalResult::Error(CellError::Value);
        }

        let (rows, cols, data) = self.eval_range_2d(&args[0]);
        let by_col = if args.len() >= 2 {
            match self.evaluate(&args[1]).as_boolean() {
                Some(b) => b,
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            false
        };
        let exactly_once = if args.len() >= 3 {
            match self.evaluate(&args[2]).as_boolean() {
                Some(b) => b,
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            false
        };

        if !by_col {
            // Unique rows
            let row_vecs: Vec<Vec<EvalResult>> = (0..rows)
                .map(|r| {
                    let start = r * cols;
                    (0..cols).map(|c| data.get(start + c).cloned().unwrap_or(EvalResult::Number(0.0))).collect()
                })
                .collect();

            let unique_rows = Self::unique_vectors(&row_vecs, exactly_once);

            if unique_rows.is_empty() {
                return EvalResult::Error(CellError::Value);
            }

            if cols == 1 {
                EvalResult::Array(unique_rows.into_iter().map(|r| r.into_iter().next().unwrap()).collect())
            } else {
                EvalResult::Array(unique_rows.into_iter().map(|r| EvalResult::Array(r)).collect())
            }
        } else {
            // Unique columns
            let col_vecs: Vec<Vec<EvalResult>> = (0..cols)
                .map(|c| {
                    (0..rows)
                        .map(|r| data.get(r * cols + c).cloned().unwrap_or(EvalResult::Number(0.0)))
                        .collect()
                })
                .collect();

            let unique_cols = Self::unique_vectors(&col_vecs, exactly_once);

            if unique_cols.is_empty() {
                return EvalResult::Error(CellError::Value);
            }

            // Rebuild as rows
            let new_cols = unique_cols.len();
            let mut result_rows: Vec<Vec<EvalResult>> = Vec::new();
            for r in 0..rows {
                let row_data: Vec<EvalResult> = unique_cols.iter().map(|col| col[r].clone()).collect();
                result_rows.push(row_data);
            }

            if rows == 1 {
                EvalResult::Array(result_rows.into_iter().next().unwrap())
            } else if new_cols == 1 {
                EvalResult::Array(result_rows.into_iter().map(|r| r.into_iter().next().unwrap()).collect())
            } else {
                EvalResult::Array(result_rows.into_iter().map(|r| EvalResult::Array(r)).collect())
            }
        }
    }

    /// Helper for UNIQUE: returns unique (or exactly-once) vectors.
    fn unique_vectors(vecs: &[Vec<EvalResult>], exactly_once: bool) -> Vec<Vec<EvalResult>> {
        // Build a string key for comparison
        fn vec_key(v: &[EvalResult]) -> String {
            v.iter().map(|e| format!("{:?}", e)).collect::<Vec<_>>().join("|")
        }

        if exactly_once {
            // Only keep rows that appear exactly once
            let mut counts: HashMap<String, usize> = HashMap::new();
            for v in vecs {
                *counts.entry(vec_key(v)).or_insert(0) += 1;
            }
            let mut seen = std::collections::HashSet::new();
            let mut result = Vec::new();
            for v in vecs {
                let key = vec_key(v);
                if counts.get(&key) == Some(&1) && seen.insert(key) {
                    result.push(v.clone());
                }
            }
            result
        } else {
            // Keep first occurrence of each unique row
            let mut seen = std::collections::HashSet::new();
            let mut result = Vec::new();
            for v in vecs {
                let key = vec_key(v);
                if seen.insert(key) {
                    result.push(v.clone());
                }
            }
            result
        }
    }

    /// SEQUENCE(rows, [columns], [start], [step])
    /// Returns a sequence of numbers arranged in rows and columns.
    fn fn_sequence(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() || args.len() > 4 {
            return EvalResult::Error(CellError::Value);
        }

        let seq_rows = match self.evaluate(&args[0]).as_number() {
            Some(n) if n >= 1.0 => n as usize,
            _ => return EvalResult::Error(CellError::Value),
        };
        let seq_cols = if args.len() >= 2 {
            match self.evaluate(&args[1]).as_number() {
                Some(n) if n >= 1.0 => n as usize,
                _ => return EvalResult::Error(CellError::Value),
            }
        } else {
            1
        };
        let start = if args.len() >= 3 {
            match self.evaluate(&args[2]).as_number() {
                Some(n) => n,
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            1.0
        };
        let step = if args.len() >= 4 {
            match self.evaluate(&args[3]).as_number() {
                Some(n) => n,
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            1.0
        };

        // Single cell result
        if seq_rows == 1 && seq_cols == 1 {
            return EvalResult::Number(start);
        }

        let mut current = start;
        if seq_cols == 1 {
            // Single column: flat array
            let mut vals = Vec::with_capacity(seq_rows);
            for _ in 0..seq_rows {
                vals.push(EvalResult::Number(current));
                current += step;
            }
            EvalResult::Array(vals)
        } else {
            // Multi-column: 2D array (Array of row-Arrays)
            let mut rows_out = Vec::with_capacity(seq_rows);
            for _ in 0..seq_rows {
                let mut row = Vec::with_capacity(seq_cols);
                for _ in 0..seq_cols {
                    row.push(EvalResult::Number(current));
                    current += step;
                }
                rows_out.push(EvalResult::Array(row));
            }
            EvalResult::Array(rows_out)
        }
    }

    /// RANDARRAY([rows], [columns], [min], [max], [whole_number])
    /// Returns an array of random numbers.
    fn fn_randarray(&self, args: &[Expression]) -> EvalResult {
        if args.len() > 5 {
            return EvalResult::Error(CellError::Value);
        }

        let ra_rows = if !args.is_empty() {
            match self.evaluate(&args[0]).as_number() {
                Some(n) if n >= 1.0 => n as usize,
                Some(_) => return EvalResult::Error(CellError::Value),
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            1
        };
        let ra_cols = if args.len() >= 2 {
            match self.evaluate(&args[1]).as_number() {
                Some(n) if n >= 1.0 => n as usize,
                Some(_) => return EvalResult::Error(CellError::Value),
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            1
        };
        let min_val = if args.len() >= 3 {
            match self.evaluate(&args[2]).as_number() {
                Some(n) => n,
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            0.0
        };
        let max_val = if args.len() >= 4 {
            match self.evaluate(&args[3]).as_number() {
                Some(n) => n,
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            1.0
        };
        let whole_number = if args.len() >= 5 {
            match self.evaluate(&args[4]).as_boolean() {
                Some(b) => b,
                None => return EvalResult::Error(CellError::Value),
            }
        } else {
            false
        };

        if min_val > max_val {
            return EvalResult::Error(CellError::Value);
        }

        // Use RandomState for random generation (same approach as RAND)
        use std::collections::hash_map::RandomState;
        use std::hash::{BuildHasher, Hasher};

        let gen_random = || -> f64 {
            let s = RandomState::new();
            let mut hasher = s.build_hasher();
            hasher.write_u64(0);
            let bits = hasher.finish();
            let unit = (bits as f64) / (u64::MAX as f64); // 0.0 to ~1.0
            if whole_number {
                let min_i = min_val.ceil() as i64;
                let max_i = max_val.floor() as i64;
                if min_i > max_i {
                    return min_val; // degenerate
                }
                let range = (max_i - min_i + 1) as f64;
                min_i as f64 + (unit * range).floor()
            } else {
                min_val + unit * (max_val - min_val)
            }
        };

        // Single cell result
        if ra_rows == 1 && ra_cols == 1 {
            return EvalResult::Number(gen_random());
        }

        if ra_cols == 1 {
            let vals: Vec<EvalResult> = (0..ra_rows).map(|_| EvalResult::Number(gen_random())).collect();
            EvalResult::Array(vals)
        } else {
            let mut rows_out = Vec::with_capacity(ra_rows);
            for _ in 0..ra_rows {
                let row: Vec<EvalResult> = (0..ra_cols).map(|_| EvalResult::Number(gen_random())).collect();
                rows_out.push(EvalResult::Array(row));
            }
            EvalResult::Array(rows_out)
        }
    }

    /// GROUPBY(row_fields, values, function, [field_headers], [total_depth], [sort_order], [filter_array])
    /// Groups rows by row_fields and aggregates values.
    fn fn_groupby(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 3 || args.len() > 7 {
            return EvalResult::Error(CellError::Value);
        }

        let (rf_rows, rf_cols, rf_data) = self.eval_range_2d(&args[0]);
        let (v_rows, v_cols, v_data) = self.eval_range_2d(&args[1]);

        // Determine aggregation function
        let agg_fn_code = self.evaluate(&args[2]);
        let has_lambda = matches!(&agg_fn_code, EvalResult::Lambda { .. });

        let field_headers = if args.len() >= 4 {
            match self.evaluate(&args[3]).as_number() {
                Some(n) => n as i32,
                None => 0,
            }
        } else {
            0 // no headers
        };
        let total_depth = if args.len() >= 5 {
            match self.evaluate(&args[4]).as_number() {
                Some(n) => n as i32,
                None => 0,
            }
        } else {
            0 // no totals
        };
        let sort_order = if args.len() >= 6 {
            match self.evaluate(&args[5]).as_number() {
                Some(n) => n as i32,
                None => 0,
            }
        } else {
            0 // preserve original order
        };

        // Optional filter array
        let filter_mask: Option<Vec<bool>> = if args.len() >= 7 {
            let filter_vals = self.eval_flat(&args[6]);
            Some(filter_vals.iter().map(|v| match v {
                EvalResult::Boolean(b) => *b,
                EvalResult::Number(n) => *n != 0.0,
                _ => true,
            }).collect())
        } else {
            None
        };

        // Determine data rows (skip header if field_headers > 0)
        let header_rows = if field_headers > 0 { 1 } else { 0 };
        if rf_rows <= header_rows || v_rows <= header_rows {
            return EvalResult::Error(CellError::Value);
        }
        if rf_rows != v_rows {
            return EvalResult::Error(CellError::Value);
        }

        let data_row_start = header_rows as usize;

        // Collect group keys and values
        let mut group_order: Vec<String> = Vec::new();
        let mut groups: HashMap<String, Vec<usize>> = HashMap::new();

        for r in data_row_start..rf_rows {
            // Apply filter
            if let Some(ref mask) = filter_mask {
                if r < mask.len() && !mask[r] {
                    continue;
                }
            }

            // Build group key from row_fields columns
            let key_parts: Vec<String> = (0..rf_cols)
                .map(|c| {
                    let val = &rf_data[r * rf_cols + c];
                    format!("{:?}", val)
                })
                .collect();
            let key = key_parts.join("|");

            if !groups.contains_key(&key) {
                group_order.push(key.clone());
            }
            groups.entry(key).or_default().push(r);
        }

        // Sort groups if requested
        if sort_order == 1 || sort_order == 2 {
            group_order.sort_by(|a, b| {
                let ra = groups[a][0];
                let rb = groups[b][0];
                let mut cmp = std::cmp::Ordering::Equal;
                for c in 0..rf_cols {
                    let va = &rf_data[ra * rf_cols + c];
                    let vb = &rf_data[rb * rf_cols + c];
                    cmp = Self::compare_eval_results(va, vb);
                    if cmp != std::cmp::Ordering::Equal {
                        break;
                    }
                }
                if sort_order == 2 { cmp.reverse() } else { cmp }
            });
        }

        // Build output
        let mut result_rows: Vec<Vec<EvalResult>> = Vec::new();

        // Header row if requested
        if field_headers > 0 {
            let mut header: Vec<EvalResult> = Vec::new();
            for c in 0..rf_cols {
                header.push(rf_data[c].clone());
            }
            for c in 0..v_cols {
                header.push(v_data[c].clone());
            }
            result_rows.push(header);
        }

        // Data rows (one per group)
        for key in &group_order {
            let row_indices = &groups[key];
            let first_row = row_indices[0];

            let mut row: Vec<EvalResult> = Vec::new();
            // Group label columns
            for c in 0..rf_cols {
                row.push(rf_data[first_row * rf_cols + c].clone());
            }
            // Aggregated value columns
            for c in 0..v_cols {
                let vals: Vec<EvalResult> = row_indices.iter()
                    .map(|&r| v_data[r * v_cols + c].clone())
                    .collect();

                let agg = if has_lambda {
                    self.apply_lambda(&agg_fn_code, &[EvalResult::Array(vals)])
                } else {
                    Self::aggregate_values(&vals, &agg_fn_code)
                };
                row.push(agg);
            }
            result_rows.push(row);
        }

        // Grand total row if total_depth >= 1
        if total_depth >= 1 && !group_order.is_empty() {
            let mut total_row: Vec<EvalResult> = Vec::new();
            for c in 0..rf_cols {
                if c == 0 {
                    total_row.push(EvalResult::Text("Grand Total".to_string()));
                } else {
                    total_row.push(EvalResult::Text(String::new()));
                }
            }
            for c in 0..v_cols {
                let all_vals: Vec<EvalResult> = (data_row_start..rf_rows)
                    .filter(|&r| {
                        if let Some(ref mask) = filter_mask {
                            r >= mask.len() || mask[r]
                        } else {
                            true
                        }
                    })
                    .map(|r| v_data[r * v_cols + c].clone())
                    .collect();
                let agg = if has_lambda {
                    self.apply_lambda(&agg_fn_code, &[EvalResult::Array(all_vals)])
                } else {
                    Self::aggregate_values(&all_vals, &agg_fn_code)
                };
                total_row.push(agg);
            }
            result_rows.push(total_row);
        }

        if result_rows.is_empty() {
            return EvalResult::Error(CellError::Value);
        }

        let out_cols = rf_cols + v_cols;
        if out_cols == 1 {
            EvalResult::Array(result_rows.into_iter().map(|r| r.into_iter().next().unwrap()).collect())
        } else {
            EvalResult::Array(result_rows.into_iter().map(|r| EvalResult::Array(r)).collect())
        }
    }

    /// Aggregate a list of EvalResults using a numeric function code.
    /// 0/101=SUM, 1/102=COUNT, 2/103=AVERAGE, 3/104=MAX, 4/105=MIN, 5/106=PRODUCT
    fn aggregate_values(vals: &[EvalResult], fn_code: &EvalResult) -> EvalResult {
        let code = match fn_code.as_number() {
            Some(n) => n as i32,
            None => return EvalResult::Error(CellError::Value),
        };

        let nums: Vec<f64> = vals.iter().filter_map(|v| v.as_number()).collect();

        match code {
            0 | 101 => {
                // SUM
                EvalResult::Number(nums.iter().sum())
            }
            1 | 102 => {
                // COUNT
                EvalResult::Number(nums.len() as f64)
            }
            2 | 103 => {
                // AVERAGE
                if nums.is_empty() {
                    EvalResult::Error(CellError::Div0)
                } else {
                    EvalResult::Number(nums.iter().sum::<f64>() / nums.len() as f64)
                }
            }
            3 | 104 => {
                // MAX
                nums.iter().cloned().reduce(f64::max)
                    .map(EvalResult::Number)
                    .unwrap_or(EvalResult::Error(CellError::Value))
            }
            4 | 105 => {
                // MIN
                nums.iter().cloned().reduce(f64::min)
                    .map(EvalResult::Number)
                    .unwrap_or(EvalResult::Error(CellError::Value))
            }
            5 | 106 => {
                // PRODUCT
                EvalResult::Number(nums.iter().product())
            }
            _ => EvalResult::Error(CellError::Value),
        }
    }

    /// Apply a lambda to arguments
    fn apply_lambda(&self, lambda: &EvalResult, apply_args: &[EvalResult]) -> EvalResult {
        if let EvalResult::Lambda { params, body } = lambda {
            self.invoke_lambda(params, body, apply_args)
        } else {
            EvalResult::Error(CellError::Value)
        }
    }

    /// PIVOTBY(row_fields, col_fields, values, function, [field_headers],
    ///         [row_total_depth], [row_sort_order], [col_total_depth], [col_sort_order], [filter_array])
    /// Creates a pivot table grouping by rows and columns.
    fn fn_pivotby(&self, args: &[Expression]) -> EvalResult {
        if args.len() < 4 || args.len() > 10 {
            return EvalResult::Error(CellError::Value);
        }

        let (rf_rows, rf_cols, rf_data) = self.eval_range_2d(&args[0]);
        let (cf_rows, cf_cols, cf_data) = self.eval_range_2d(&args[1]);
        let (v_rows, v_cols, v_data) = self.eval_range_2d(&args[2]);
        let agg_fn_code = self.evaluate(&args[3]);
        let has_lambda = matches!(&agg_fn_code, EvalResult::Lambda { .. });

        let field_headers = if args.len() >= 5 {
            self.evaluate(&args[4]).as_number().unwrap_or(0.0) as i32
        } else { 0 };
        let row_sort_order = if args.len() >= 7 {
            self.evaluate(&args[6]).as_number().unwrap_or(0.0) as i32
        } else { 0 };
        let col_sort_order = if args.len() >= 9 {
            self.evaluate(&args[8]).as_number().unwrap_or(0.0) as i32
        } else { 0 };

        let filter_mask: Option<Vec<bool>> = if args.len() >= 10 {
            let filter_vals = self.eval_flat(&args[9]);
            Some(filter_vals.iter().map(|v| match v {
                EvalResult::Boolean(b) => *b,
                EvalResult::Number(n) => *n != 0.0,
                _ => true,
            }).collect())
        } else {
            None
        };

        let header_rows = if field_headers > 0 { 1 } else { 0 };
        if rf_rows <= header_rows || cf_rows <= header_rows || v_rows <= header_rows {
            return EvalResult::Error(CellError::Value);
        }
        if rf_rows != cf_rows || rf_rows != v_rows {
            return EvalResult::Error(CellError::Value);
        }

        let data_row_start = header_rows as usize;

        // Collect unique row keys and column keys
        let mut row_key_order: Vec<String> = Vec::new();
        let mut row_keys_set: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut col_key_order: Vec<String> = Vec::new();
        let mut col_keys_set: std::collections::HashSet<String> = std::collections::HashSet::new();

        // Map (row_key, col_key) -> Vec<row_indices>
        let mut pivot_map: HashMap<(String, String), Vec<usize>> = HashMap::new();

        for r in data_row_start..rf_rows {
            if let Some(ref mask) = filter_mask {
                if r < mask.len() && !mask[r] {
                    continue;
                }
            }

            let rk: Vec<String> = (0..rf_cols).map(|c| format!("{:?}", rf_data[r * rf_cols + c])).collect();
            let row_key = rk.join("|");

            let ck: Vec<String> = (0..cf_cols).map(|c| format!("{:?}", cf_data[r * cf_cols + c])).collect();
            let col_key = ck.join("|");

            if row_keys_set.insert(row_key.clone()) {
                row_key_order.push(row_key.clone());
            }
            if col_keys_set.insert(col_key.clone()) {
                col_key_order.push(col_key.clone());
            }

            pivot_map.entry((row_key, col_key)).or_default().push(r);
        }

        // Sort row keys
        if row_sort_order == 1 || row_sort_order == 2 {
            row_key_order.sort_by(|a, b| {
                let cmp = a.cmp(b);
                if row_sort_order == 2 { cmp.reverse() } else { cmp }
            });
        }
        // Sort column keys
        if col_sort_order == 1 || col_sort_order == 2 {
            col_key_order.sort_by(|a, b| {
                let cmp = a.cmp(b);
                if col_sort_order == 2 { cmp.reverse() } else { cmp }
            });
        }

        // Helper: get the first row index for a key to extract display values
        let first_row_for_key = |key: &str, data: &[EvalResult], cols: usize| -> Vec<EvalResult> {
            // Find the first row that produced this key
            for r in data_row_start..rf_rows {
                let parts: Vec<String> = (0..cols).map(|c| format!("{:?}", data[r * cols + c])).collect();
                if parts.join("|") == key {
                    return (0..cols).map(|c| data[r * cols + c].clone()).collect();
                }
            }
            vec![EvalResult::Text(String::new()); cols]
        };

        let mut result_rows: Vec<Vec<EvalResult>> = Vec::new();

        // Header row(s): empty cells for row_fields, then col group labels
        if field_headers > 0 || true {
            // Always produce a header row for column labels
            let mut header: Vec<EvalResult> = Vec::new();
            // Empty cells for row field columns
            for _ in 0..rf_cols {
                header.push(EvalResult::Text(String::new()));
            }
            // Column group labels
            for ck in &col_key_order {
                let col_labels = first_row_for_key(ck, &cf_data, cf_cols);
                // Use first column of col_fields as label
                header.push(col_labels.into_iter().next().unwrap_or(EvalResult::Text(String::new())));
            }
            result_rows.push(header);
        }

        // Data rows: one per row group
        for rk in &row_key_order {
            let mut row: Vec<EvalResult> = Vec::new();
            // Row labels
            let row_labels = first_row_for_key(rk, &rf_data, rf_cols);
            row.extend(row_labels);

            // Values for each column group
            for ck in &col_key_order {
                let key = (rk.clone(), ck.clone());
                if let Some(indices) = pivot_map.get(&key) {
                    // Aggregate values (use first value column)
                    let vals: Vec<EvalResult> = indices.iter()
                        .map(|&r| v_data[r * v_cols].clone())
                        .collect();
                    let agg = if has_lambda {
                        self.apply_lambda(&agg_fn_code, &[EvalResult::Array(vals)])
                    } else {
                        Self::aggregate_values(&vals, &agg_fn_code)
                    };
                    row.push(agg);
                } else {
                    row.push(EvalResult::Number(0.0));
                }
            }
            result_rows.push(row);
        }

        if result_rows.is_empty() {
            return EvalResult::Error(CellError::Value);
        }

        EvalResult::Array(result_rows.into_iter().map(|r| EvalResult::Array(r)).collect())
    }

    // ========================================================================
    // Collection functions (3D cells)
    // ========================================================================

    /// COLLECT(value) — wraps an array result into a contained List cell.
    /// If the argument is already a List or Dict, returns as-is.
    /// If scalar, wraps in a single-element List.
    fn fn_collect(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }
        let val = self.evaluate(&args[0]);
        match val {
            EvalResult::Error(_) => val,
            EvalResult::Array(arr) => EvalResult::List(Self::array_to_list_items(arr, 0)),
            EvalResult::List(_) => val,
            EvalResult::Dict(_) => val,
            // Scalar → single-element list
            other => EvalResult::List(vec![other]),
        }
    }

    /// Recursively converts Array items to List items, enforcing max nesting depth.
    fn array_to_list_items(items: Vec<EvalResult>, depth: usize) -> Vec<EvalResult> {
        if depth >= 32 {
            return vec![EvalResult::Error(CellError::Value)];
        }
        items.into_iter().map(|item| {
            match item {
                EvalResult::Array(inner) => {
                    EvalResult::List(Self::array_to_list_items(inner, depth + 1))
                }
                other => other,
            }
        }).collect()
    }

    /// DICT("key1", value1, "key2", value2, ...) — creates a Dict cell from
    /// alternating key-value pairs. Keys must be scalar (text, number, boolean).
    /// Duplicate keys: last value wins (Python convention).
    fn fn_dict(&self, args: &[Expression]) -> EvalResult {
        if args.is_empty() || args.len() % 2 != 0 {
            return EvalResult::Error(CellError::Value);
        }

        let mut entries: Vec<(DictKey, EvalResult)> = Vec::with_capacity(args.len() / 2);
        let mut i = 0;
        while i < args.len() {
            let key_result = self.evaluate(&args[i]);
            let value_result = self.evaluate(&args[i + 1]);

            // Convert key to DictKey — must be scalar
            let key = match key_result {
                EvalResult::Text(s) => DictKey::Text(s),
                EvalResult::Number(n) => DictKey::Number(n),
                EvalResult::Boolean(b) => DictKey::Boolean(b),
                EvalResult::Error(e) => return EvalResult::Error(e),
                _ => return EvalResult::Error(CellError::Value),
            };

            if let EvalResult::Error(_) = &value_result {
                return value_result;
            }

            // Duplicate keys: replace existing (last value wins)
            if let Some(pos) = entries.iter().position(|(k, _)| *k == key) {
                entries[pos] = (key, value_result);
            } else {
                entries.push((key, value_result));
            }

            i += 2;
        }

        EvalResult::Dict(entries)
    }

    /// KEYS(collection) - returns array of keys
    /// For Dict: returns array of key strings
    /// For List: returns array of 0-based indices
    fn fn_keys(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }
        let val = self.evaluate(&args[0]);
        match val {
            EvalResult::Error(_) => val,
            EvalResult::Dict(entries) => {
                let keys: Vec<EvalResult> = entries
                    .into_iter()
                    .map(|(k, _)| match k {
                        DictKey::Text(s) => EvalResult::Text(s),
                        DictKey::Number(n) => EvalResult::Number(n),
                        DictKey::Boolean(b) => EvalResult::Boolean(b),
                    })
                    .collect();
                EvalResult::Array(keys)
            }
            EvalResult::List(items) => {
                let keys: Vec<EvalResult> = (0..items.len())
                    .map(|i| EvalResult::Number(i as f64))
                    .collect();
                EvalResult::Array(keys)
            }
            _ => EvalResult::Error(CellError::Value),
        }
    }

    /// VALUES(collection) - returns array of values
    /// For Dict: returns array of values
    /// For List: returns array of list elements
    fn fn_values(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }
        let val = self.evaluate(&args[0]);
        match val {
            EvalResult::Error(_) => val,
            EvalResult::Dict(entries) => {
                let values: Vec<EvalResult> = entries.into_iter().map(|(_, v)| v).collect();
                EvalResult::Array(values)
            }
            EvalResult::List(items) => {
                EvalResult::Array(items)
            }
            _ => EvalResult::Error(CellError::Value),
        }
    }

    /// CONTAINS(collection, value) - checks if value exists
    /// For List: checks if value is in the list
    /// For Dict: checks if key exists in the dict
    fn fn_contains(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 {
            return EvalResult::Error(CellError::Value);
        }
        let collection = self.evaluate(&args[0]);
        let search_val = self.evaluate(&args[1]);

        if let EvalResult::Error(_) = &collection {
            return collection;
        }
        if let EvalResult::Error(_) = &search_val {
            return search_val;
        }

        match collection {
            EvalResult::List(items) => {
                // Check if any element matches the search value
                for item in &items {
                    if Self::eval_results_equal(item, &search_val) {
                        return EvalResult::Boolean(true);
                    }
                }
                EvalResult::Boolean(false)
            }
            EvalResult::Dict(entries) => {
                // Check if key exists in dict
                let key = match &search_val {
                    EvalResult::Text(s) => DictKey::Text(s.clone()),
                    EvalResult::Number(n) => DictKey::Number(*n),
                    EvalResult::Boolean(b) => DictKey::Boolean(*b),
                    _ => return EvalResult::Error(CellError::Value),
                };
                EvalResult::Boolean(entries.iter().any(|(k, _)| *k == key))
            }
            _ => EvalResult::Error(CellError::Value),
        }
    }

    /// ISLIST(value) - returns TRUE if value is a list
    fn fn_islist(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }
        let val = self.evaluate(&args[0]);
        EvalResult::Boolean(matches!(val, EvalResult::List(_)))
    }

    /// ISDICT(value) - returns TRUE if value is a dict
    fn fn_isdict(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }
        let val = self.evaluate(&args[0]);
        EvalResult::Boolean(matches!(val, EvalResult::Dict(_)))
    }

    /// Helper: compare two EvalResults for equality (used by CONTAINS)
    fn eval_results_equal(a: &EvalResult, b: &EvalResult) -> bool {
        match (a, b) {
            (EvalResult::Number(x), EvalResult::Number(y)) => x == y,
            (EvalResult::Text(x), EvalResult::Text(y)) => x == y,
            (EvalResult::Boolean(x), EvalResult::Boolean(y)) => x == y,
            (EvalResult::Number(n), EvalResult::Boolean(b))
            | (EvalResult::Boolean(b), EvalResult::Number(n)) => {
                *n == if *b { 1.0 } else { 0.0 }
            }
            _ => false,
        }
    }

    /// FLATTEN(list) - recursively flatten nested lists into a single-level list
    fn fn_flatten(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }
        let val = self.evaluate(&args[0]);
        match val {
            EvalResult::Error(_) => val,
            EvalResult::List(items) => {
                let mut flat = Vec::new();
                Self::flatten_list_recursive(items, &mut flat, 0);
                EvalResult::List(flat)
            }
            EvalResult::Dict(_) => val, // Dict cannot be flattened
            other => EvalResult::List(vec![other]), // Scalar → single-element list
        }
    }

    fn flatten_list_recursive(items: Vec<EvalResult>, out: &mut Vec<EvalResult>, depth: usize) {
        if depth > 32 {
            return;
        }
        for item in items {
            match item {
                EvalResult::List(nested) => {
                    Self::flatten_list_recursive(nested, out, depth + 1);
                }
                other => out.push(other),
            }
        }
    }

    /// TAKE(list, n) - returns first n elements as a new list
    fn fn_take(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 {
            return EvalResult::Error(CellError::Value);
        }
        let collection = self.evaluate(&args[0]);
        let n_val = self.evaluate(&args[1]);

        if let EvalResult::Error(_) = &collection { return collection; }
        if let EvalResult::Error(_) = &n_val { return n_val; }

        let n = match n_val.as_number() {
            Some(n) => n as usize,
            None => return EvalResult::Error(CellError::Value),
        };

        match collection {
            EvalResult::List(items) => {
                let taken: Vec<EvalResult> = items.into_iter().take(n).collect();
                EvalResult::List(taken)
            }
            _ => EvalResult::Error(CellError::Value),
        }
    }

    /// DROP(list, n) - removes first n elements, returns rest as a new list
    fn fn_drop(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 {
            return EvalResult::Error(CellError::Value);
        }
        let collection = self.evaluate(&args[0]);
        let n_val = self.evaluate(&args[1]);

        if let EvalResult::Error(_) = &collection { return collection; }
        if let EvalResult::Error(_) = &n_val { return n_val; }

        let n = match n_val.as_number() {
            Some(n) => n as usize,
            None => return EvalResult::Error(CellError::Value),
        };

        match collection {
            EvalResult::List(items) => {
                let dropped: Vec<EvalResult> = items.into_iter().skip(n).collect();
                EvalResult::List(dropped)
            }
            _ => EvalResult::Error(CellError::Value),
        }
    }

    /// APPEND(list, value) - returns a new list with value appended
    fn fn_append(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 {
            return EvalResult::Error(CellError::Value);
        }
        let collection = self.evaluate(&args[0]);
        let value = self.evaluate(&args[1]);

        if let EvalResult::Error(_) = &collection { return collection; }
        if let EvalResult::Error(_) = &value { return value; }

        match collection {
            EvalResult::List(mut items) => {
                items.push(value);
                EvalResult::List(items)
            }
            _ => EvalResult::Error(CellError::Value),
        }
    }

    /// MERGE(dict1, dict2) - merges two dicts, second wins on key conflict
    fn fn_merge(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 {
            return EvalResult::Error(CellError::Value);
        }
        let dict1 = self.evaluate(&args[0]);
        let dict2 = self.evaluate(&args[1]);

        if let EvalResult::Error(_) = &dict1 { return dict1; }
        if let EvalResult::Error(_) = &dict2 { return dict2; }

        match (dict1, dict2) {
            (EvalResult::Dict(mut entries1), EvalResult::Dict(entries2)) => {
                for (key, value) in entries2 {
                    if let Some(pos) = entries1.iter().position(|(k, _)| *k == key) {
                        entries1[pos] = (key, value);
                    } else {
                        entries1.push((key, value));
                    }
                }
                EvalResult::Dict(entries1)
            }
            _ => EvalResult::Error(CellError::Value),
        }
    }

    /// HSTACK(list1, list2) - concatenate two lists
    fn fn_hstack(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 {
            return EvalResult::Error(CellError::Value);
        }
        let list1 = self.evaluate(&args[0]);
        let list2 = self.evaluate(&args[1]);

        if let EvalResult::Error(_) = &list1 { return list1; }
        if let EvalResult::Error(_) = &list2 { return list2; }

        match (list1, list2) {
            (EvalResult::List(mut items1), EvalResult::List(items2)) => {
                items1.extend(items2);
                EvalResult::List(items1)
            }
            _ => EvalResult::Error(CellError::Value),
        }
    }

    // ========================================================================
    // File functions (virtual file system)
    // ========================================================================

    /// FILEREAD(path) - returns the text content of a virtual file
    fn fn_file_read(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }
        let path = self.evaluate(&args[0]).as_text();
        match &self.file_reader {
            Some(reader) => match reader(&path) {
                Some(content) => EvalResult::Text(content),
                None => EvalResult::Error(CellError::NA),
            },
            None => EvalResult::Error(CellError::NA),
        }
    }

    /// FILELINES(path) - returns the number of lines in a virtual file
    fn fn_file_lines(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }
        let path = self.evaluate(&args[0]).as_text();
        match &self.file_reader {
            Some(reader) => match reader(&path) {
                Some(content) => EvalResult::Number(content.lines().count() as f64),
                None => EvalResult::Error(CellError::NA),
            },
            None => EvalResult::Error(CellError::NA),
        }
    }

    /// FILEEXISTS(path) - returns TRUE if a virtual file exists
    fn fn_file_exists(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 1 {
            return EvalResult::Error(CellError::Value);
        }
        let path = self.evaluate(&args[0]).as_text();
        match &self.file_reader {
            Some(reader) => EvalResult::Boolean(reader(&path).is_some()),
            None => EvalResult::Boolean(false),
        }
    }

    fn textjoin_collect(&self, expr: &Expression, ignore_empty: bool, parts: &mut Vec<String>) {
        match expr {
            Expression::Range { start, end, .. } => {
                // Iterate raw cells in the range to detect empties
                if let (
                    Expression::CellRef { col: sc, row: sr, .. },
                    Expression::CellRef { col: ec, row: er, .. },
                ) = (start.as_ref(), end.as_ref()) {
                    let sc_idx = col_to_index(sc);
                    let ec_idx = col_to_index(ec);
                    let sr_idx = sr - 1;
                    let er_idx = er - 1;
                    let r_start = sr_idx.min(er_idx);
                    let r_end = sr_idx.max(er_idx);
                    let c_start = sc_idx.min(ec_idx);
                    let c_end = sc_idx.max(ec_idx);
                    for r in r_start..=r_end {
                        for c in c_start..=c_end {
                            match self.grid.get_cell(r, c) {
                                Some(cell) => match &cell.value {
                                    CellValue::Empty => {
                                        if !ignore_empty { parts.push(String::new()); }
                                    }
                                    CellValue::Text(s) => {
                                        if !ignore_empty || !s.is_empty() {
                                            parts.push(s.clone());
                                        }
                                    }
                                    CellValue::Number(n) => parts.push(format!("{}", n)),
                                    CellValue::Boolean(b) => parts.push(if *b { "TRUE".to_string() } else { "FALSE".to_string() }),
                                    CellValue::Error(e) => parts.push(format!("{:?}", e)),
                                    CellValue::List(items) => parts.push(format!("[List({})]", items.len())),
                                    CellValue::Dict(entries) => parts.push(format!("[Dict({})]", entries.len())),
                                },
                                None => {
                                    if !ignore_empty { parts.push(String::new()); }
                                }
                            }
                        }
                    }
                }
            }
            _ => {
                // Non-range: evaluate normally
                match self.evaluate(expr) {
                    EvalResult::Text(s) => {
                        if !ignore_empty || !s.is_empty() {
                            parts.push(s);
                        }
                    }
                    EvalResult::Number(n) => parts.push(format!("{}", n)),
                    EvalResult::Boolean(b) => parts.push(if b { "TRUE".to_string() } else { "FALSE".to_string() }),
                    EvalResult::Error(_) => {} // skip errors in TEXTJOIN
                    EvalResult::List(items) => parts.push(format!("[List({})]", items.len())),
                    EvalResult::Dict(entries) => parts.push(format!("[Dict({})]", entries.len())),
                    EvalResult::Lambda { .. } => parts.push("#LAMBDA".to_string()),
                    EvalResult::Array(arr) => {
                        for val in arr {
                            match val {
                                EvalResult::Text(s) => {
                                    if !ignore_empty || !s.is_empty() {
                                        parts.push(s);
                                    }
                                }
                                EvalResult::Number(n) => parts.push(format!("{}", n)),
                                EvalResult::Boolean(b) => parts.push(if b { "TRUE".to_string() } else { "FALSE".to_string() }),
                                _ => {}
                            }
                        }
                    }
                }
            }
        }
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cell::Cell;

    fn make_grid() -> Grid {
        let mut grid = Grid::new();
        // Set up test data:
        // A1 = 10, A2 = 20, A3 = 30
        // B1 = 5, B2 = 15, B3 = "Hello"
        grid.set_cell(0, 0, Cell::new_number(10.0));
        grid.set_cell(1, 0, Cell::new_number(20.0));
        grid.set_cell(2, 0, Cell::new_number(30.0));
        grid.set_cell(0, 1, Cell::new_number(5.0));
        grid.set_cell(1, 1, Cell::new_number(15.0));
        grid.set_cell(2, 1, Cell::new_text("Hello".to_string()));
        grid
    }

    #[test]
    fn test_sum_column_ref() {
        let grid = make_grid();
        let eval = Evaluator::new(&grid);

        // =SUM(A:A) should sum A1+A2+A3 = 60
        let expr = Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![Expression::ColumnRef {
                sheet: None,
                start_col: "A".to_string(),
                end_col: "A".to_string(),
            }],
        };
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(60.0));
    }

    #[test]
    fn test_sum_row_ref() {
        let grid = make_grid();
        let eval = Evaluator::new(&grid);

        // =SUM(1:1) should sum A1+B1 = 15
        let expr = Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![Expression::RowRef {
                sheet: None,
                start_row: 1,
                end_row: 1,
            }],
        };
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(15.0));
    }

    #[test]
    fn test_literal_number() {
        let grid = Grid::new();
        let eval = Evaluator::new(&grid);

        let expr = Expression::Literal(Value::Number(42.0));
        let result = eval.evaluate(&expr);

        assert_eq!(result, EvalResult::Number(42.0));
    }

    #[test]
    fn test_literal_string() {
        let grid = Grid::new();
        let eval = Evaluator::new(&grid);

        let expr = Expression::Literal(Value::String("Hello".to_string()));
        let result = eval.evaluate(&expr);

        assert_eq!(result, EvalResult::Text("Hello".to_string()));
    }

    #[test]
    fn test_literal_boolean() {
        let grid = Grid::new();
        let eval = Evaluator::new(&grid);

        let expr = Expression::Literal(Value::Boolean(true));
        let result = eval.evaluate(&expr);

        assert_eq!(result, EvalResult::Boolean(true));
    }

    #[test]
    fn test_cell_ref() {
        let grid = make_grid();
        let eval = Evaluator::new(&grid);

        // =A1 (should be 10)
        let expr = Expression::CellRef {
            sheet: None,
            col: "A".to_string(),
            row: 1,
        };
        let result = eval.evaluate(&expr);

        assert_eq!(result, EvalResult::Number(10.0));
    }

    #[test]
    fn test_empty_cell_ref() {
        let grid = make_grid();
        let eval = Evaluator::new(&grid);

        // =Z99 (empty cell, should be 0)
        let expr = Expression::CellRef {
            sheet: None,
            col: "Z".to_string(),
            row: 99,
        };
        let result = eval.evaluate(&expr);

        assert_eq!(result, EvalResult::Number(0.0));
    }

    #[test]
    fn test_addition() {
        let grid = make_grid();
        let eval = Evaluator::new(&grid);

        // =A1 + A2 (10 + 20 = 30)
        let expr = Expression::BinaryOp {
            left: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
            }),
            op: BinaryOperator::Add,
            right: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 2,
            }),
        };
        let result = eval.evaluate(&expr);

        assert_eq!(result, EvalResult::Number(30.0));
    }

    #[test]
    fn test_division_by_zero() {
        let grid = Grid::new();
        let eval = Evaluator::new(&grid);

        // =10 / 0
        let expr = Expression::BinaryOp {
            left: Box::new(Expression::Literal(Value::Number(10.0))),
            op: BinaryOperator::Divide,
            right: Box::new(Expression::Literal(Value::Number(0.0))),
        };
        let result = eval.evaluate(&expr);

        assert_eq!(result, EvalResult::Error(CellError::Div0));
    }

    #[test]
    fn test_sum_function() {
        let grid = make_grid();
        let eval = Evaluator::new(&grid);

        // =SUM(A1:A3) (10 + 20 + 30 = 60)
        let expr = Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 1,
                }),
                end: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 3,
                }),
            }],
        };
        let result = eval.evaluate(&expr);

        assert_eq!(result, EvalResult::Number(60.0));
    }

    #[test]
    fn test_cross_sheet_cell_ref() {
        // Create two grids
        let mut grid1 = Grid::new();
        grid1.set_cell(0, 0, Cell::new_number(100.0)); // Sheet1!A1 = 100

        let mut grid2 = Grid::new();
        grid2.set_cell(0, 0, Cell::new_number(200.0)); // Sheet2!A1 = 200

        // Create multi-sheet context
        let mut context = MultiSheetContext::new("Sheet1".to_string());
        context.add_grid("Sheet1".to_string(), &grid1);
        context.add_grid("Sheet2".to_string(), &grid2);

        let eval = Evaluator::with_multi_sheet(&grid1, context);

        // =Sheet2!A1 (should be 200)
        let expr = Expression::CellRef {
            sheet: Some("Sheet2".to_string()),
            col: "A".to_string(),
            row: 1,
        };
        let result = eval.evaluate(&expr);

        assert_eq!(result, EvalResult::Number(200.0));
    }

    #[test]
    fn test_cross_sheet_sum() {
        // Create two grids
        let mut grid1 = Grid::new();
        grid1.set_cell(0, 0, Cell::new_number(10.0));
        grid1.set_cell(1, 0, Cell::new_number(20.0));

        let mut grid2 = Grid::new();
        grid2.set_cell(0, 0, Cell::new_number(100.0));
        grid2.set_cell(1, 0, Cell::new_number(200.0));

        let mut context = MultiSheetContext::new("Sheet1".to_string());
        context.add_grid("Sheet1".to_string(), &grid1);
        context.add_grid("Sheet2".to_string(), &grid2);

        let eval = Evaluator::with_multi_sheet(&grid1, context);

        // =SUM(Sheet2!A1:A2) (should be 300)
        let expr = Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![Expression::Range {
                sheet: Some("Sheet2".to_string()),
                start: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 1,
                }),
                end: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 2,
                }),
            }],
        };
        let result = eval.evaluate(&expr);

        assert_eq!(result, EvalResult::Number(300.0));
    }

    // ==================== XLOOKUP Tests ====================

    /// Helper: builds a grid for XLOOKUP tests.
    /// Layout:
    ///   A1 = "Apple",  B1 = 1.50
    ///   A2 = "Banana", B2 = 0.75
    ///   A3 = "Cherry", B3 = 3.00
    ///   A4 = "Date",   B4 = 5.00
    ///   A5 = "Elderberry", B5 = 8.00
    fn make_xlookup_grid() -> Grid {
        let mut grid = Grid::new();
        grid.set_cell(0, 0, Cell::new_text("Apple".to_string()));
        grid.set_cell(1, 0, Cell::new_text("Banana".to_string()));
        grid.set_cell(2, 0, Cell::new_text("Cherry".to_string()));
        grid.set_cell(3, 0, Cell::new_text("Date".to_string()));
        grid.set_cell(4, 0, Cell::new_text("Elderberry".to_string()));

        grid.set_cell(0, 1, Cell::new_number(1.50));
        grid.set_cell(1, 1, Cell::new_number(0.75));
        grid.set_cell(2, 1, Cell::new_number(3.00));
        grid.set_cell(3, 1, Cell::new_number(5.00));
        grid.set_cell(4, 1, Cell::new_number(8.00));
        grid
    }

    /// Helper to build an XLOOKUP expression from literal args.
    fn xlookup_expr(args: Vec<Expression>) -> Expression {
        Expression::FunctionCall {
            func: BuiltinFunction::XLookup,
            args,
        }
    }

    #[test]
    fn test_xlookup_exact_match_text() {
        let grid = make_xlookup_grid();
        let eval = Evaluator::new(&grid);

        // =XLOOKUP("Cherry", A1:A5, B1:B5) -> 3.0
        let expr = xlookup_expr(vec![
            Expression::Literal(Value::String("Cherry".to_string())),
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "A".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "A".to_string(), row: 5 }),
            },
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "B".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "B".to_string(), row: 5 }),
            },
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(3.0));
    }

    #[test]
    fn test_xlookup_exact_match_case_insensitive() {
        let grid = make_xlookup_grid();
        let eval = Evaluator::new(&grid);

        // =XLOOKUP("banana", A1:A5, B1:B5) -> 0.75 (case insensitive)
        let expr = xlookup_expr(vec![
            Expression::Literal(Value::String("banana".to_string())),
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "A".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "A".to_string(), row: 5 }),
            },
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "B".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "B".to_string(), row: 5 }),
            },
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(0.75));
    }

    #[test]
    fn test_xlookup_not_found_returns_na() {
        let grid = make_xlookup_grid();
        let eval = Evaluator::new(&grid);

        // =XLOOKUP("Fig", A1:A5, B1:B5) -> #N/A
        let expr = xlookup_expr(vec![
            Expression::Literal(Value::String("Fig".to_string())),
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "A".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "A".to_string(), row: 5 }),
            },
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "B".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "B".to_string(), row: 5 }),
            },
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Error(CellError::NA));
    }

    #[test]
    fn test_xlookup_if_not_found() {
        let grid = make_xlookup_grid();
        let eval = Evaluator::new(&grid);

        // =XLOOKUP("Fig", A1:A5, B1:B5, "Not found") -> "Not found"
        let expr = xlookup_expr(vec![
            Expression::Literal(Value::String("Fig".to_string())),
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "A".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "A".to_string(), row: 5 }),
            },
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "B".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "B".to_string(), row: 5 }),
            },
            Expression::Literal(Value::String("Not found".to_string())),
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Text("Not found".to_string()));
    }

    #[test]
    fn test_xlookup_numeric_exact_match() {
        // Grid with numeric lookup: C1=10,C2=20,C3=30 / D1="A",D2="B",D3="C"
        let mut grid = Grid::new();
        grid.set_cell(0, 2, Cell::new_number(10.0));
        grid.set_cell(1, 2, Cell::new_number(20.0));
        grid.set_cell(2, 2, Cell::new_number(30.0));
        grid.set_cell(0, 3, Cell::new_text("A".to_string()));
        grid.set_cell(1, 3, Cell::new_text("B".to_string()));
        grid.set_cell(2, 3, Cell::new_text("C".to_string()));

        let eval = Evaluator::new(&grid);

        // =XLOOKUP(20, C1:C3, D1:D3) -> "B"
        let expr = xlookup_expr(vec![
            Expression::Literal(Value::Number(20.0)),
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "C".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "C".to_string(), row: 3 }),
            },
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "D".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "D".to_string(), row: 3 }),
            },
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Text("B".to_string()));
    }

    #[test]
    fn test_xlookup_approx_smaller() {
        // Sorted ascending: C1=10, C2=20, C3=30 / D1="Low", D2="Mid", D3="High"
        let mut grid = Grid::new();
        grid.set_cell(0, 2, Cell::new_number(10.0));
        grid.set_cell(1, 2, Cell::new_number(20.0));
        grid.set_cell(2, 2, Cell::new_number(30.0));
        grid.set_cell(0, 3, Cell::new_text("Low".to_string()));
        grid.set_cell(1, 3, Cell::new_text("Mid".to_string()));
        grid.set_cell(2, 3, Cell::new_text("High".to_string()));

        let eval = Evaluator::new(&grid);

        // =XLOOKUP(25, C1:C3, D1:D3, , -1) -> "Mid" (25 not found, next smaller is 20)
        let expr = xlookup_expr(vec![
            Expression::Literal(Value::Number(25.0)),
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "C".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "C".to_string(), row: 3 }),
            },
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "D".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "D".to_string(), row: 3 }),
            },
            Expression::Literal(Value::String("N/A".to_string())),
            Expression::Literal(Value::Number(-1.0)),
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Text("Mid".to_string()));
    }

    #[test]
    fn test_xlookup_approx_larger() {
        // Sorted ascending: C1=10, C2=20, C3=30 / D1="Low", D2="Mid", D3="High"
        let mut grid = Grid::new();
        grid.set_cell(0, 2, Cell::new_number(10.0));
        grid.set_cell(1, 2, Cell::new_number(20.0));
        grid.set_cell(2, 2, Cell::new_number(30.0));
        grid.set_cell(0, 3, Cell::new_text("Low".to_string()));
        grid.set_cell(1, 3, Cell::new_text("Mid".to_string()));
        grid.set_cell(2, 3, Cell::new_text("High".to_string()));

        let eval = Evaluator::new(&grid);

        // =XLOOKUP(25, C1:C3, D1:D3, , 1) -> "High" (25 not found, next larger is 30)
        let expr = xlookup_expr(vec![
            Expression::Literal(Value::Number(25.0)),
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "C".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "C".to_string(), row: 3 }),
            },
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "D".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "D".to_string(), row: 3 }),
            },
            Expression::Literal(Value::String("N/A".to_string())),
            Expression::Literal(Value::Number(1.0)),
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Text("High".to_string()));
    }

    #[test]
    fn test_xlookup_wildcard() {
        let grid = make_xlookup_grid();
        let eval = Evaluator::new(&grid);

        // =XLOOKUP("Ch*", A1:A5, B1:B5, , 2) -> 3.0 (wildcard matches "Cherry")
        let expr = xlookup_expr(vec![
            Expression::Literal(Value::String("Ch*".to_string())),
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "A".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "A".to_string(), row: 5 }),
            },
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "B".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "B".to_string(), row: 5 }),
            },
            Expression::Literal(Value::String("N/A".to_string())),
            Expression::Literal(Value::Number(2.0)),
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(3.0));
    }

    #[test]
    fn test_xlookup_wildcard_question_mark() {
        let grid = make_xlookup_grid();
        let eval = Evaluator::new(&grid);

        // =XLOOKUP("Da?e", A1:A5, B1:B5, , 2) -> 5.0 (? matches single char, "Date")
        let expr = xlookup_expr(vec![
            Expression::Literal(Value::String("Da?e".to_string())),
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "A".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "A".to_string(), row: 5 }),
            },
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "B".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "B".to_string(), row: 5 }),
            },
            Expression::Literal(Value::String("N/A".to_string())),
            Expression::Literal(Value::Number(2.0)),
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(5.0));
    }

    #[test]
    fn test_xlookup_reverse_search() {
        // Grid with duplicate lookup values: A1="X",A2="Y",A3="X" / B1=1,B2=2,B3=3
        let mut grid = Grid::new();
        grid.set_cell(0, 0, Cell::new_text("X".to_string()));
        grid.set_cell(1, 0, Cell::new_text("Y".to_string()));
        grid.set_cell(2, 0, Cell::new_text("X".to_string()));
        grid.set_cell(0, 1, Cell::new_number(1.0));
        grid.set_cell(1, 1, Cell::new_number(2.0));
        grid.set_cell(2, 1, Cell::new_number(3.0));

        let eval = Evaluator::new(&grid);

        // =XLOOKUP("X", A1:A3, B1:B3, , 0, -1) -> 3.0 (reverse search finds last "X")
        let expr = xlookup_expr(vec![
            Expression::Literal(Value::String("X".to_string())),
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "A".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "A".to_string(), row: 3 }),
            },
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "B".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "B".to_string(), row: 3 }),
            },
            Expression::Literal(Value::String("N/A".to_string())),
            Expression::Literal(Value::Number(0.0)),
            Expression::Literal(Value::Number(-1.0)),
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(3.0));
    }

    #[test]
    fn test_xlookup_too_few_args() {
        let grid = Grid::new();
        let eval = Evaluator::new(&grid);

        // =XLOOKUP("X", A1:A3) -> #VALUE! (too few args)
        let expr = xlookup_expr(vec![
            Expression::Literal(Value::String("X".to_string())),
            Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef { sheet: None, col: "A".to_string(), row: 1 }),
                end: Box::new(Expression::CellRef { sheet: None, col: "A".to_string(), row: 3 }),
            },
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Error(CellError::Value));
    }

    // ==================== XLOOKUPS (Multi-Criteria) Tests ====================

    /// Helper: creates a grid for XLOOKUPS multi-criteria tests.
    /// Column A (names): Alice, Bob, Alice, Charlie, Bob
    /// Column B (depts): Sales, Engineering, Engineering, Sales, Sales
    /// Column C (scores): 85, 92, 78, 95, 88
    fn make_xlookups_grid() -> Grid {
        let mut grid = Grid::new();
        // Column A: names
        grid.set_cell(0, 0, Cell::new_text("Alice".to_string()));
        grid.set_cell(1, 0, Cell::new_text("Bob".to_string()));
        grid.set_cell(2, 0, Cell::new_text("Alice".to_string()));
        grid.set_cell(3, 0, Cell::new_text("Charlie".to_string()));
        grid.set_cell(4, 0, Cell::new_text("Bob".to_string()));
        // Column B: departments
        grid.set_cell(0, 1, Cell::new_text("Sales".to_string()));
        grid.set_cell(1, 1, Cell::new_text("Engineering".to_string()));
        grid.set_cell(2, 1, Cell::new_text("Engineering".to_string()));
        grid.set_cell(3, 1, Cell::new_text("Sales".to_string()));
        grid.set_cell(4, 1, Cell::new_text("Sales".to_string()));
        // Column C: scores
        grid.set_cell(0, 2, Cell::new_number(85.0));
        grid.set_cell(1, 2, Cell::new_number(92.0));
        grid.set_cell(2, 2, Cell::new_number(78.0));
        grid.set_cell(3, 2, Cell::new_number(95.0));
        grid.set_cell(4, 2, Cell::new_number(88.0));
        grid
    }

    /// Helper to build an XLOOKUPS expression.
    fn xlookups_expr(args: Vec<Expression>) -> Expression {
        Expression::FunctionCall {
            func: BuiltinFunction::XLookups,
            args,
        }
    }

    /// Helper to build a Range expression for a column range like A1:A5.
    fn col_range(col: &str, start_row: u32, end_row: u32) -> Expression {
        Expression::Range {
            sheet: None,
            start: Box::new(Expression::CellRef {
                sheet: None,
                col: col.to_string(),
                row: start_row,
            }),
            end: Box::new(Expression::CellRef {
                sheet: None,
                col: col.to_string(),
                row: end_row,
            }),
        }
    }

    #[test]
    fn test_xlookups_two_criteria_exact() {
        let grid = make_xlookups_grid();
        let eval = Evaluator::new(&grid);

        // =XLOOKUPS("Alice", A1:A5, "Engineering", B1:B5, C1:C5) -> 78.0
        let expr = xlookups_expr(vec![
            Expression::Literal(Value::String("Alice".to_string())),
            col_range("A", 1, 5),
            Expression::Literal(Value::String("Engineering".to_string())),
            col_range("B", 1, 5),
            col_range("C", 1, 5),
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(78.0));
    }

    #[test]
    fn test_xlookups_two_criteria_first_match() {
        let grid = make_xlookups_grid();
        let eval = Evaluator::new(&grid);

        // =XLOOKUPS("Bob", A1:A5, "Sales", B1:B5, C1:C5) -> 88.0
        // Bob+Sales is row 5 (index 4)
        let expr = xlookups_expr(vec![
            Expression::Literal(Value::String("Bob".to_string())),
            col_range("A", 1, 5),
            Expression::Literal(Value::String("Sales".to_string())),
            col_range("B", 1, 5),
            col_range("C", 1, 5),
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(88.0));
    }

    #[test]
    fn test_xlookups_single_criterion_fallback() {
        let grid = make_xlookups_grid();
        let eval = Evaluator::new(&grid);

        // =XLOOKUPS("Charlie", A1:A5, C1:C5) -> 95.0
        // Single criterion: behaves like XLOOKUP
        let expr = xlookups_expr(vec![
            Expression::Literal(Value::String("Charlie".to_string())),
            col_range("A", 1, 5),
            col_range("C", 1, 5),
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(95.0));
    }

    #[test]
    fn test_xlookups_no_match_returns_na() {
        let grid = make_xlookups_grid();
        let eval = Evaluator::new(&grid);

        // =XLOOKUPS("Charlie", A1:A5, "Engineering", B1:B5, C1:C5) -> #N/A
        // Charlie is only in Sales, not Engineering
        let expr = xlookups_expr(vec![
            Expression::Literal(Value::String("Charlie".to_string())),
            col_range("A", 1, 5),
            Expression::Literal(Value::String("Engineering".to_string())),
            col_range("B", 1, 5),
            col_range("C", 1, 5),
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Error(CellError::NA));
    }

    #[test]
    fn test_xlookups_reverse_search() {
        let grid = make_xlookups_grid();
        let eval = Evaluator::new(&grid);

        // =XLOOKUPS("Alice", A1:A5, C1:C5, , -1) -> search last-to-first
        // Alice appears at index 0 (85) and index 2 (78); reverse returns index 2 first
        let expr = xlookups_expr(vec![
            Expression::Literal(Value::String("Alice".to_string())),
            col_range("A", 1, 5),
            col_range("C", 1, 5),
            Expression::Literal(Value::Number(0.0)),  // match_mode = exact
            Expression::Literal(Value::Number(-1.0)), // search_mode = last-to-first
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(78.0));
    }

    #[test]
    fn test_xlookups_wildcard_multi_criteria() {
        let grid = make_xlookups_grid();
        let eval = Evaluator::new(&grid);

        // =XLOOKUPS("A*", A1:A5, "Eng*", B1:B5, C1:C5, 2) -> 78.0
        // Wildcard: "A*" matches Alice, "Eng*" matches Engineering -> row 3 (index 2)
        let expr = xlookups_expr(vec![
            Expression::Literal(Value::String("A*".to_string())),
            col_range("A", 1, 5),
            Expression::Literal(Value::String("Eng*".to_string())),
            col_range("B", 1, 5),
            col_range("C", 1, 5),
            Expression::Literal(Value::Number(2.0)), // match_mode = wildcard
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(78.0));
    }

    #[test]
    fn test_xlookups_too_few_args() {
        let grid = Grid::new();
        let eval = Evaluator::new(&grid);

        // =XLOOKUPS("X", A1:A5) -> #VALUE! (no return_array)
        let expr = xlookups_expr(vec![
            Expression::Literal(Value::String("X".to_string())),
            col_range("A", 1, 5),
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Error(CellError::Value));
    }

    #[test]
    fn test_xlookups_approx_rejected_for_multi_criteria() {
        let grid = make_xlookups_grid();
        let eval = Evaluator::new(&grid);

        // =XLOOKUPS("Alice", A1:A5, "Sales", B1:B5, C1:C5, -1) -> #VALUE!
        // Approximate match mode is not supported for multi-criteria
        let expr = xlookups_expr(vec![
            Expression::Literal(Value::String("Alice".to_string())),
            col_range("A", 1, 5),
            Expression::Literal(Value::String("Sales".to_string())),
            col_range("B", 1, 5),
            col_range("C", 1, 5),
            Expression::Literal(Value::Number(-1.0)), // match_mode = approx smaller
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Error(CellError::Value));
    }

    #[test]
    fn test_xlookups_case_insensitive() {
        let grid = make_xlookups_grid();
        let eval = Evaluator::new(&grid);

        // =XLOOKUPS("alice", A1:A5, "engineering", B1:B5, C1:C5) -> 78.0
        // Case insensitive matching
        let expr = xlookups_expr(vec![
            Expression::Literal(Value::String("alice".to_string())),
            col_range("A", 1, 5),
            Expression::Literal(Value::String("engineering".to_string())),
            col_range("B", 1, 5),
            col_range("C", 1, 5),
        ]);
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(78.0));
    }

    // ==================== 3D Reference Tests ====================

    /// Helper: creates three grids with data in A1 for 3D reference tests.
    /// Sheet1!A1 = 10, Sheet2!A1 = 20, Sheet3!A1 = 30
    fn make_3d_grids() -> (Grid, Grid, Grid) {
        let mut g1 = Grid::new();
        g1.set_cell(0, 0, Cell::new_number(10.0));

        let mut g2 = Grid::new();
        g2.set_cell(0, 0, Cell::new_number(20.0));

        let mut g3 = Grid::new();
        g3.set_cell(0, 0, Cell::new_number(30.0));

        (g1, g2, g3)
    }

    /// Helper: builds a MultiSheetContext with sheet_order for 3D tests.
    fn make_3d_context<'a>(
        g1: &'a Grid,
        g2: &'a Grid,
        g3: &'a Grid,
    ) -> MultiSheetContext<'a> {
        let mut ctx = MultiSheetContext::new("Sheet1".to_string());
        ctx.add_grid("Sheet1".to_string(), g1);
        ctx.add_grid("Sheet2".to_string(), g2);
        ctx.add_grid("Sheet3".to_string(), g3);
        ctx.sheet_order = vec![
            "Sheet1".to_string(),
            "Sheet2".to_string(),
            "Sheet3".to_string(),
        ];
        ctx
    }

    #[test]
    fn test_3d_ref_single_cell_sum() {
        // =SUM(Sheet1:Sheet3!A1) should sum 10 + 20 + 30 = 60
        let (g1, g2, g3) = make_3d_grids();
        let ctx = make_3d_context(&g1, &g2, &g3);
        let eval = Evaluator::with_multi_sheet(&g1, ctx);

        let expr = Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![Expression::Sheet3DRef {
                start_sheet: "Sheet1".to_string(),
                end_sheet: "Sheet3".to_string(),
                reference: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 1,
                }),
            }],
        };
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(60.0));
    }

    #[test]
    fn test_3d_ref_partial_range() {
        // =SUM(Sheet1:Sheet2!A1) should sum 10 + 20 = 30 (only first two sheets)
        let (g1, g2, g3) = make_3d_grids();
        let ctx = make_3d_context(&g1, &g2, &g3);
        let eval = Evaluator::with_multi_sheet(&g1, ctx);

        let expr = Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![Expression::Sheet3DRef {
                start_sheet: "Sheet1".to_string(),
                end_sheet: "Sheet2".to_string(),
                reference: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 1,
                }),
            }],
        };
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(30.0));
    }

    #[test]
    fn test_3d_ref_reversed_bookends() {
        // =SUM(Sheet3:Sheet1!A1) - reversed order should still include all 3 sheets
        let (g1, g2, g3) = make_3d_grids();
        let ctx = make_3d_context(&g1, &g2, &g3);
        let eval = Evaluator::with_multi_sheet(&g1, ctx);

        let expr = Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![Expression::Sheet3DRef {
                start_sheet: "Sheet3".to_string(),
                end_sheet: "Sheet1".to_string(),
                reference: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 1,
                }),
            }],
        };
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(60.0));
    }

    #[test]
    fn test_3d_ref_with_range() {
        // =SUM(Sheet1:Sheet3!A1:A2) with A1 and A2 on each sheet
        let mut g1 = Grid::new();
        g1.set_cell(0, 0, Cell::new_number(1.0));
        g1.set_cell(1, 0, Cell::new_number(2.0));

        let mut g2 = Grid::new();
        g2.set_cell(0, 0, Cell::new_number(10.0));
        g2.set_cell(1, 0, Cell::new_number(20.0));

        let mut g3 = Grid::new();
        g3.set_cell(0, 0, Cell::new_number(100.0));
        g3.set_cell(1, 0, Cell::new_number(200.0));

        let mut ctx = MultiSheetContext::new("Sheet1".to_string());
        ctx.add_grid("Sheet1".to_string(), &g1);
        ctx.add_grid("Sheet2".to_string(), &g2);
        ctx.add_grid("Sheet3".to_string(), &g3);
        ctx.sheet_order = vec![
            "Sheet1".to_string(),
            "Sheet2".to_string(),
            "Sheet3".to_string(),
        ];

        let eval = Evaluator::with_multi_sheet(&g1, ctx);

        // =SUM(Sheet1:Sheet3!A1:A2) = (1+2) + (10+20) + (100+200) = 333
        let expr = Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![Expression::Sheet3DRef {
                start_sheet: "Sheet1".to_string(),
                end_sheet: "Sheet3".to_string(),
                reference: Box::new(Expression::Range {
                    sheet: None,
                    start: Box::new(Expression::CellRef {
                        sheet: None,
                        col: "A".to_string(),
                        row: 1,
                    }),
                    end: Box::new(Expression::CellRef {
                        sheet: None,
                        col: "A".to_string(),
                        row: 2,
                    }),
                }),
            }],
        };
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(333.0));
    }

    #[test]
    fn test_3d_ref_average() {
        // =AVERAGE(Sheet1:Sheet3!A1) = (10+20+30)/3 = 20
        let (g1, g2, g3) = make_3d_grids();
        let ctx = make_3d_context(&g1, &g2, &g3);
        let eval = Evaluator::with_multi_sheet(&g1, ctx);

        let expr = Expression::FunctionCall {
            func: BuiltinFunction::Average,
            args: vec![Expression::Sheet3DRef {
                start_sheet: "Sheet1".to_string(),
                end_sheet: "Sheet3".to_string(),
                reference: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 1,
                }),
            }],
        };
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(20.0));
    }

    #[test]
    fn test_3d_ref_max_min() {
        // =MAX(Sheet1:Sheet3!A1) = 30, =MIN(Sheet1:Sheet3!A1) = 10
        let (g1, g2, g3) = make_3d_grids();

        // MAX
        let ctx = make_3d_context(&g1, &g2, &g3);
        let eval = Evaluator::with_multi_sheet(&g1, ctx);

        let expr_max = Expression::FunctionCall {
            func: BuiltinFunction::Max,
            args: vec![Expression::Sheet3DRef {
                start_sheet: "Sheet1".to_string(),
                end_sheet: "Sheet3".to_string(),
                reference: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 1,
                }),
            }],
        };
        assert_eq!(eval.evaluate(&expr_max), EvalResult::Number(30.0));

        // MIN (need new context since with_multi_sheet takes ownership)
        let ctx2 = make_3d_context(&g1, &g2, &g3);
        let eval2 = Evaluator::with_multi_sheet(&g1, ctx2);

        let expr_min = Expression::FunctionCall {
            func: BuiltinFunction::Min,
            args: vec![Expression::Sheet3DRef {
                start_sheet: "Sheet1".to_string(),
                end_sheet: "Sheet3".to_string(),
                reference: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 1,
                }),
            }],
        };
        assert_eq!(eval2.evaluate(&expr_min), EvalResult::Number(10.0));
    }

    #[test]
    fn test_3d_ref_count() {
        // =COUNT(Sheet1:Sheet3!A1) = 3
        let (g1, g2, g3) = make_3d_grids();
        let ctx = make_3d_context(&g1, &g2, &g3);
        let eval = Evaluator::with_multi_sheet(&g1, ctx);

        let expr = Expression::FunctionCall {
            func: BuiltinFunction::Count,
            args: vec![Expression::Sheet3DRef {
                start_sheet: "Sheet1".to_string(),
                end_sheet: "Sheet3".to_string(),
                reference: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 1,
                }),
            }],
        };
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(3.0));
    }

    #[test]
    fn test_3d_ref_invalid_sheet_returns_ref_error() {
        // =SUM(Sheet1:NonExistent!A1) -> #REF! (unknown bookend)
        let (g1, g2, g3) = make_3d_grids();
        let ctx = make_3d_context(&g1, &g2, &g3);
        let eval = Evaluator::with_multi_sheet(&g1, ctx);

        let expr = Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![Expression::Sheet3DRef {
                start_sheet: "Sheet1".to_string(),
                end_sheet: "NonExistent".to_string(),
                reference: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 1,
                }),
            }],
        };
        let result = eval.evaluate(&expr);
        // The 3D ref returns Array([]); SUM of empty = 0
        // But get_sheets_in_range returns empty vec, so eval_3d_ref returns #REF!
        assert_eq!(result, EvalResult::Error(CellError::Ref));
    }

    #[test]
    fn test_3d_ref_no_multi_sheet_context() {
        // 3D ref without multi-sheet context -> #REF!
        let grid = Grid::new();
        let eval = Evaluator::new(&grid);

        let expr = Expression::Sheet3DRef {
            start_sheet: "Sheet1".to_string(),
            end_sheet: "Sheet3".to_string(),
            reference: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
            }),
        };
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Error(CellError::Ref));
    }

    #[test]
    fn test_3d_ref_case_insensitive() {
        // Sheet names should be case-insensitive
        let (g1, g2, g3) = make_3d_grids();
        let ctx = make_3d_context(&g1, &g2, &g3);
        let eval = Evaluator::with_multi_sheet(&g1, ctx);

        let expr = Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![Expression::Sheet3DRef {
                start_sheet: "sheet1".to_string(),
                end_sheet: "SHEET3".to_string(),
                reference: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 1,
                }),
            }],
        };
        let result = eval.evaluate(&expr);
        assert_eq!(result, EvalResult::Number(60.0));
    }
}