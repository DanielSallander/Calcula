//! FILENAME: core/calcula-format/src/cell_ref.rs
//! Converts between (row, col) coordinates and A1-style cell references.

/// Convert a 0-based column index to a column letter (A, B, ..., Z, AA, AB, ...).
pub fn col_to_letters(col: u32) -> String {
    let mut result = String::new();
    let mut c = col;
    loop {
        result.insert(0, (b'A' + (c % 26) as u8) as char);
        if c < 26 {
            break;
        }
        c = c / 26 - 1;
    }
    result
}

/// Convert a (row, col) pair to an A1-style reference (e.g., (0, 0) -> "A1").
pub fn to_a1(row: u32, col: u32) -> String {
    format!("{}{}", col_to_letters(col), row + 1)
}

/// Parse an A1-style reference back to (row, col). Returns None if invalid.
pub fn from_a1(reference: &str) -> Option<(u32, u32)> {
    let bytes = reference.as_bytes();
    let mut col: u32 = 0;
    let mut i = 0;

    // Parse column letters
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        let c = bytes[i].to_ascii_uppercase() - b'A';
        col = col * 26 + c as u32 + 1;
        i += 1;
    }

    if i == 0 || col == 0 {
        return None;
    }
    col -= 1; // Convert to 0-based

    // Parse row number
    let row_str = &reference[i..];
    let row: u32 = row_str.parse().ok()?;
    if row == 0 {
        return None;
    }

    Some((row - 1, col))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_col_to_letters() {
        assert_eq!(col_to_letters(0), "A");
        assert_eq!(col_to_letters(1), "B");
        assert_eq!(col_to_letters(25), "Z");
        assert_eq!(col_to_letters(26), "AA");
        assert_eq!(col_to_letters(27), "AB");
        assert_eq!(col_to_letters(701), "ZZ");
        assert_eq!(col_to_letters(702), "AAA");
    }

    #[test]
    fn test_to_a1() {
        assert_eq!(to_a1(0, 0), "A1");
        assert_eq!(to_a1(0, 1), "B1");
        assert_eq!(to_a1(9, 2), "C10");
        assert_eq!(to_a1(0, 26), "AA1");
    }

    #[test]
    fn test_from_a1() {
        assert_eq!(from_a1("A1"), Some((0, 0)));
        assert_eq!(from_a1("B1"), Some((0, 1)));
        assert_eq!(from_a1("C10"), Some((9, 2)));
        assert_eq!(from_a1("AA1"), Some((0, 26)));
        assert_eq!(from_a1(""), None);
        assert_eq!(from_a1("A0"), None);
        assert_eq!(from_a1("123"), None);
    }

    #[test]
    fn test_roundtrip() {
        for row in 0..100 {
            for col in 0..100 {
                let a1 = to_a1(row, col);
                let (r, c) = from_a1(&a1).unwrap();
                assert_eq!((r, c), (row, col), "Failed roundtrip for ({}, {})", row, col);
            }
        }
    }
}
