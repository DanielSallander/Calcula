// FILENAME: core\persistence\src\xlsx_reader.rs

use crate::{PersistenceError, SavedCell, SavedCellValue, Sheet, Workbook};
use calamine::{open_workbook, Data, Reader, Xlsx};
use engine::style::CellStyle;
use std::collections::HashMap;
use std::path::Path;

pub fn load_xlsx(path: &Path) -> Result<Workbook, PersistenceError> {
    let mut workbook: Xlsx<_> = open_workbook(path)?;
    let sheet_names = workbook.sheet_names().to_vec();

    if sheet_names.is_empty() {
        return Err(PersistenceError::InvalidFormat(
            "Workbook contains no sheets".to_string(),
        ));
    }

    let mut sheets = Vec::new();

    for sheet_name in &sheet_names {
        let range = workbook
            .worksheet_range(sheet_name)
            .map_err(|e| PersistenceError::InvalidFormat(e.to_string()))?;

        let mut cells = HashMap::new();

        for (row_idx, row) in range.rows().enumerate() {
            for (col_idx, cell) in row.iter().enumerate() {
                let saved_value = match cell {
                    Data::Empty => continue,
                    Data::String(s) => SavedCellValue::Text(s.clone()),
                    Data::Float(f) => SavedCellValue::Number(*f),
                    Data::Int(i) => SavedCellValue::Number(*i as f64),
                    Data::Bool(b) => SavedCellValue::Boolean(*b),
                    Data::Error(e) => SavedCellValue::Error(format!("{:?}", e)),
                    Data::DateTime(dt) => SavedCellValue::Number(dt.as_f64()),
                    Data::DateTimeIso(s) => SavedCellValue::Text(s.clone()),
                    Data::DurationIso(s) => SavedCellValue::Text(s.clone()),
                };

                // Try to get formula if available
                let formula = workbook
                    .worksheet_formula(sheet_name)
                    .ok()
                    .and_then(|formulas| {
                        formulas
                            .get((row_idx, col_idx))
                            .map(|f| format!("={}", f))
                    });

                cells.insert(
                    (row_idx as u32, col_idx as u32),
                    SavedCell {
                        value: saved_value,
                        formula,
                        style_index: 0,
                    },
                );
            }
        }

        sheets.push(Sheet {
            name: sheet_name.clone(),
            cells,
            column_widths: HashMap::new(),
            row_heights: HashMap::new(),
            styles: vec![CellStyle::new()],
        });
    }

    Ok(Workbook {
        sheets,
        active_sheet: 0,
    })
}