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
use crate::dependency_extractor::{BinaryOperator, Expression, UnaryOperator, Value};
use crate::grid::Grid;
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
}

impl<'a> MultiSheetContext<'a> {
    /// Creates a new multi-sheet context.
    pub fn new(current_sheet: String) -> Self {
        MultiSheetContext {
            grids: HashMap::new(),
            current_sheet,
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
}

/// The formula evaluator.
/// Holds a reference to the grid for cell lookups.
pub struct Evaluator<'a> {
    grid: &'a Grid,
    /// Optional multi-sheet context for cross-sheet references
    multi_sheet: Option<MultiSheetContext<'a>>,
}

impl<'a> Evaluator<'a> {
    /// Creates a new Evaluator with a reference to the grid.
    /// For single-sheet evaluation (backward compatible).
    pub fn new(grid: &'a Grid) -> Self {
        Evaluator {
            grid,
            multi_sheet: None,
        }
    }

    /// Creates a new Evaluator with multi-sheet support.
    pub fn with_multi_sheet(grid: &'a Grid, context: MultiSheetContext<'a>) -> Self {
        Evaluator {
            grid,
            multi_sheet: Some(context),
        }
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
            Expression::FunctionCall { name, args } => self.eval_function(name, args),
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

    /// Evaluates a function call.
    fn eval_function(&self, name: &str, args: &[Expression]) -> EvalResult {
        let name_upper = name.to_uppercase();

        match name_upper.as_str() {
            // Aggregate functions
            "SUM" => self.fn_sum(args),
            "AVERAGE" | "AVG" => self.fn_average(args),
            "MIN" => self.fn_min(args),
            "MAX" => self.fn_max(args),
            "COUNT" => self.fn_count(args),
            "COUNTA" => self.fn_counta(args),

            // Logical functions
            "IF" => self.fn_if(args),
            "AND" => self.fn_and(args),
            "OR" => self.fn_or(args),
            "NOT" => self.fn_not(args),
            "TRUE" => EvalResult::Boolean(true),
            "FALSE" => EvalResult::Boolean(false),

            // Math functions
            "ABS" => self.fn_abs(args),
            "ROUND" => self.fn_round(args),
            "FLOOR" => self.fn_floor(args),
            "CEILING" | "CEIL" => self.fn_ceiling(args),
            "SQRT" => self.fn_sqrt(args),
            "POWER" | "POW" => self.fn_power(args),
            "MOD" => self.fn_mod(args),
            "INT" => self.fn_int(args),
            "SIGN" => self.fn_sign(args),

            // Text functions
            "LEN" => self.fn_len(args),
            "UPPER" => self.fn_upper(args),
            "LOWER" => self.fn_lower(args),
            "TRIM" => self.fn_trim(args),
            "CONCATENATE" | "CONCAT" => self.fn_concatenate(args),
            "LEFT" => self.fn_left(args),
            "RIGHT" => self.fn_right(args),
            "MID" => self.fn_mid(args),
            "REPT" => self.fn_rept(args),
            "TEXT" => self.fn_text(args),

            // Information functions
            "ISNUMBER" => self.fn_isnumber(args),
            "ISTEXT" => self.fn_istext(args),
            "ISBLANK" => self.fn_isblank(args),
            "ISERROR" => self.fn_iserror(args),

            _ => EvalResult::Error(CellError::Name),
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
            name: "SUM".to_string(),
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
            name: "SUM".to_string(),
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
            name: "SUM".to_string(),
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
            name: "SUM".to_string(),
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
}