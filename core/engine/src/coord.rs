//! FILENAME: core/engine/src/coord.rs
//! PURPOSE: Utilities for converting between spreadsheet coordinate formats.
//! CONTEXT: This module provides functions to convert between A1-style notation
//! (e.g., "A1", "AA100") and 0-based (row, col) numeric indices used internally.
//! Column "A" = 0, "B" = 1, ..., "Z" = 25, "AA" = 26, etc.
//! Row 1 in A1 notation = row 0 internally.

/// A cell coordinate as (row, col) with 0-based indices.
pub type CellCoord = (u32, u32);

/// Converts a column string (e.g., "A", "AA", "ABC") to a 0-based column index.
/// "A" -> 0, "B" -> 1, ..., "Z" -> 25, "AA" -> 26, "AB" -> 27, etc.
///
/// # Arguments
/// * `col_str` - The column string in uppercase letters.
///
/// # Returns
/// The 0-based column index.
///
/// # Panics
/// Panics if the string contains non-alphabetic characters.
pub fn col_to_index(col_str: &str) -> u32 {
    let mut result: u32 = 0;
    for c in col_str.chars() {
        let digit = (c.to_ascii_uppercase() as u32) - ('A' as u32) + 1;
        result = result * 26 + digit;
    }
    result - 1 // Convert to 0-based
}

/// Converts a 0-based column index to a column string.
/// 0 -> "A", 1 -> "B", ..., 25 -> "Z", 26 -> "AA", 27 -> "AB", etc.
///
/// # Arguments
/// * `col_index` - The 0-based column index.
///
/// # Returns
/// The column string in uppercase letters.
pub fn index_to_col(mut col_index: u32) -> String {
    let mut result = String::new();
    loop {
        let remainder = col_index % 26;
        result.insert(0, (b'A' + remainder as u8) as char);
        if col_index < 26 {
            break;
        }
        col_index = col_index / 26 - 1;
    }
    result
}

/// Converts an A1-style reference to a 0-based (row, col) coordinate.
/// "A1" -> (0, 0), "B2" -> (1, 1), "AA100" -> (99, 26)
///
/// # Arguments
/// * `col_str` - The column part (e.g., "A", "AA").
/// * `row_num` - The 1-based row number from the reference.
///
/// # Returns
/// A tuple (row, col) with 0-based indices.
pub fn a1_to_coord(col_str: &str, row_num: u32) -> CellCoord {
    let col = col_to_index(col_str);
    let row = row_num - 1; // Convert 1-based to 0-based
    (row, col)
}

/// Converts a 0-based (row, col) coordinate to an A1-style reference string.
/// (0, 0) -> "A1", (1, 1) -> "B2", (99, 26) -> "AA100"
///
/// # Arguments
/// * `coord` - The (row, col) tuple with 0-based indices.
///
/// # Returns
/// The A1-style reference string.
pub fn coord_to_a1(coord: CellCoord) -> String {
    let (row, col) = coord;
    let col_str = index_to_col(col);
    let row_num = row + 1; // Convert 0-based to 1-based
    format!("{}{}", col_str, row_num)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_col_to_index() {
        assert_eq!(col_to_index("A"), 0);
        assert_eq!(col_to_index("B"), 1);
        assert_eq!(col_to_index("Z"), 25);
        assert_eq!(col_to_index("AA"), 26);
        assert_eq!(col_to_index("AB"), 27);
        assert_eq!(col_to_index("AZ"), 51);
        assert_eq!(col_to_index("BA"), 52);
        assert_eq!(col_to_index("ZZ"), 701);
        assert_eq!(col_to_index("AAA"), 702);
    }

    #[test]
    fn test_index_to_col() {
        assert_eq!(index_to_col(0), "A");
        assert_eq!(index_to_col(1), "B");
        assert_eq!(index_to_col(25), "Z");
        assert_eq!(index_to_col(26), "AA");
        assert_eq!(index_to_col(27), "AB");
        assert_eq!(index_to_col(51), "AZ");
        assert_eq!(index_to_col(52), "BA");
        assert_eq!(index_to_col(701), "ZZ");
        assert_eq!(index_to_col(702), "AAA");
    }

    #[test]
    fn test_roundtrip() {
        for i in 0..1000 {
            let col_str = index_to_col(i);
            let back = col_to_index(&col_str);
            assert_eq!(back, i, "Roundtrip failed for index {}", i);
        }
    }

    #[test]
    fn test_a1_to_coord() {
        assert_eq!(a1_to_coord("A", 1), (0, 0));
        assert_eq!(a1_to_coord("B", 2), (1, 1));
        assert_eq!(a1_to_coord("AA", 100), (99, 26));
        assert_eq!(a1_to_coord("Z", 50), (49, 25));
    }

    #[test]
    fn test_coord_to_a1() {
        assert_eq!(coord_to_a1((0, 0)), "A1");
        assert_eq!(coord_to_a1((1, 1)), "B2");
        assert_eq!(coord_to_a1((99, 26)), "AA100");
        assert_eq!(coord_to_a1((49, 25)), "Z50");
    }
}