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

use crate::cell::{CellError, CellValue};
use crate::coord::col_to_index;
use crate::dependency_extractor::{BinaryOperator, BuiltinFunction, Expression, UnaryOperator, Value};
use crate::grid::Grid;
use std::cell::RefCell;
use std::collections::HashMap;

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
    Array(Vec<EvalResult>),
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
        }
    }

    /// Attempts to coerce the result to a number.
    /// Returns None if coercion is not possible.
    pub fn as_number(&self) -> Option<f64> {
        match self {
            EvalResult::Number(n) => Some(*n),
            EvalResult::Boolean(b) => Some(if *b { 1.0 } else { 0.0 }),
            EvalResult::Text(s) => s.trim().parse::<f64>().ok(),
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
        }
    }

    /// Returns true if this result is an error.
    pub fn is_error(&self) -> bool {
        matches!(self, EvalResult::Error(_))
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
/// These effects are collected by the evaluator and processed
/// by the caller (in app/src-tauri) after evaluation completes.
#[derive(Debug, Clone)]
pub enum UiEffect {
    /// Set the height of one or more rows.
    /// Rows are 0-indexed internally (converted from 1-indexed user input).
    SetRowHeight {
        rows: Vec<u32>,
        height: f64,
    },
}

/// The formula evaluator.
/// Holds a reference to the grid for cell lookups.
pub struct Evaluator<'a> {
    grid: &'a Grid,
    /// Optional multi-sheet context for cross-sheet references
    multi_sheet: Option<MultiSheetContext<'a>>,
    /// Side-effects collected during evaluation.
    /// Uses RefCell for interior mutability since evaluate() takes &self.
    ui_effects: RefCell<Vec<UiEffect>>,
}

impl<'a> Evaluator<'a> {
    /// Creates a new Evaluator with a reference to the grid.
    /// For single-sheet evaluation (backward compatible).
    pub fn new(grid: &'a Grid) -> Self {
        Evaluator {
            grid,
            multi_sheet: None,
            ui_effects: RefCell::new(Vec::new()),
        }
    }

    /// Creates a new Evaluator with multi-sheet support.
    pub fn with_multi_sheet(grid: &'a Grid, context: MultiSheetContext<'a>) -> Self {
        Evaluator {
            grid,
            multi_sheet: Some(context),
            ui_effects: RefCell::new(Vec::new()),
        }
    }

    /// Drain and return all collected UI effects.
    /// Called by the orchestrator after evaluation completes.
    pub fn take_ui_effects(&self) -> Vec<UiEffect> {
        self.ui_effects.borrow_mut().drain(..).collect()
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

            // Logical functions
            BuiltinFunction::If => self.fn_if(args),
            BuiltinFunction::And => self.fn_and(args),
            BuiltinFunction::Or => self.fn_or(args),
            BuiltinFunction::Not => self.fn_not(args),
            BuiltinFunction::True => EvalResult::Boolean(true),
            BuiltinFunction::False => EvalResult::Boolean(false),

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

            // Information functions
            BuiltinFunction::IsNumber => self.fn_isnumber(args),
            BuiltinFunction::IsText => self.fn_istext(args),
            BuiltinFunction::IsBlank => self.fn_isblank(args),
            BuiltinFunction::IsError => self.fn_iserror(args),

            // Lookup & Reference functions
            BuiltinFunction::XLookup => self.fn_xlookup(args),
            BuiltinFunction::XLookups => self.fn_xlookups(args),

            // UI functions
            BuiltinFunction::SetRowHeight => self.fn_set_row_height(args),

            // Unknown/custom functions
            BuiltinFunction::Custom(_) => EvalResult::Error(CellError::Name),
        }
    }

    /// Collects numeric values from evaluated arguments, flattening arrays.
    fn collect_numbers(&self, args: &[Expression]) -> Result<Vec<f64>, CellError> {
        let mut numbers = Vec::new();

        for arg in args {
            let result = self.evaluate(arg);
            for item in result.flatten() {
                if let EvalResult::Error(e) = item {
                    return Err(e);
                }
                // Skip non-numeric values in aggregates (like Excel)
                if let Some(n) = item.as_number() {
                    numbers.push(n);
                }
            }
        }

        Ok(numbers)
    }

    /// Collects all values from arguments, flattening arrays.
    fn collect_values(&self, args: &[Expression]) -> Result<Vec<EvalResult>, CellError> {
        let mut values = Vec::new();

        for arg in args {
            let result = self.evaluate(arg);
            for item in result.flatten() {
                if let EvalResult::Error(e) = item {
                    return Err(e);
                }
                values.push(item);
            }
        }

        Ok(values)
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

        let text = self.evaluate(&args[0]).as_text();
        EvalResult::Number(text.len() as f64)
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

    /// SET.ROW.HEIGHT(rows, height)
    /// rows: single row number or array of row numbers (1-indexed, user-facing)
    /// height: height in pixels (must be positive)
    /// Returns the height value. The actual row height change is a side-effect
    /// collected via the ui_effects channel and applied by the orchestrator.
    fn fn_set_row_height(&self, args: &[Expression]) -> EvalResult {
        if args.len() != 2 {
            return EvalResult::Error(CellError::Value);
        }

        // Evaluate the height argument
        let height_result = self.evaluate(&args[1]);
        let height = match height_result.as_number() {
            Some(h) if h > 0.0 => h,
            Some(_) => return EvalResult::Error(CellError::Value),
            None => {
                if let EvalResult::Error(e) = height_result {
                    return EvalResult::Error(e);
                }
                return EvalResult::Error(CellError::Value);
            }
        };

        // Evaluate the rows argument — can be a single number or array
        let rows_result = self.evaluate(&args[0]);
        let mut rows: Vec<u32> = Vec::new();

        match &rows_result {
            EvalResult::Number(n) => {
                let n = *n;
                if n < 1.0 || n != n.floor() {
                    return EvalResult::Error(CellError::Value);
                }
                rows.push((n as u32) - 1); // Convert 1-indexed to 0-indexed
            }
            EvalResult::Array(arr) => {
                for item in arr.iter() {
                    match item.as_number() {
                        Some(n) if n >= 1.0 && n == n.floor() => {
                            rows.push((n as u32) - 1);
                        }
                        _ => return EvalResult::Error(CellError::Value),
                    }
                }
            }
            EvalResult::Error(e) => return EvalResult::Error(e.clone()),
            _ => return EvalResult::Error(CellError::Value),
        }

        if rows.is_empty() {
            return EvalResult::Error(CellError::Value);
        }

        // Push the side-effect for the orchestrator to process
        self.ui_effects.borrow_mut().push(UiEffect::SetRowHeight {
            rows,
            height,
        });

        // Return the height as the cell's display value
        EvalResult::Number(height)
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