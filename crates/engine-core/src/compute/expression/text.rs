//! Text function enum and its SQL rendering.

use super::*;

/// Text functions for use in expressions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TextFunction {
    /// Concatenate text strings: `CONCATENATE(text1, text2, ...)`.
    /// Extended from DAX to accept arbitrary number of arguments.
    Concatenate,
    /// Combine values with a delimiter: `COMBINEVALUES(delimiter, text1, text2, ...)`.
    CombineValues,
    /// Case-sensitive comparison: `EXACT(text1, text2)`.
    Exact,
    /// Find position (case-sensitive): `FIND(find_text, within_text [, start_pos])`.
    /// Returns 1-based position or error if not found.
    Find,
    /// Round number and format as text: `FIXED(number [, decimals [, no_commas]])`.
    Fixed,
    /// Left substring: `LEFT(text [, num_chars])`.
    Left,
    /// String length: `LEN(text)`.
    Len,
    /// Convert to lowercase: `LOWER(text)`.
    Lower,
    /// Substring from middle: `MID(text, start_pos, num_chars)`.
    Mid,
    /// Replace by position: `REPLACE(old_text, start_pos, num_chars, new_text)`.
    Replace,
    /// Repeat text: `REPT(text, number_times)`.
    Rept,
    /// Right substring: `RIGHT(text [, num_chars])`.
    Right,
    /// Find position (case-insensitive): `SEARCH(find_text, within_text [, start_pos])`.
    Search,
    /// Replace occurrences of text: `SUBSTITUTE(text, old_text, new_text [, instance_num])`.
    Substitute,
    /// Remove leading/trailing spaces: `TRIM(text)`.
    Trim,
    /// Unicode character from code point: `UNICHAR(number)`.
    Unichar,
    /// Unicode code point of first character: `UNICODE(text)`.
    Unicode,
    /// Convert to uppercase: `UPPER(text)`.
    Upper,
    /// Convert text to number: `VALUE(text)`.
    Value,
    /// Remove leading characters: `LTRIM(text [, characters])`.
    /// Snowflake extension. Default removes spaces.
    Ltrim,
    /// Remove trailing characters: `RTRIM(text [, characters])`.
    /// Snowflake extension. Default removes spaces.
    Rtrim,
    /// Left-pad to length: `LPAD(text, length [, pad])`.
    /// Snowflake extension. Default pads with spaces.
    Lpad,
    /// Right-pad to length: `RPAD(text, length [, pad])`.
    /// Snowflake extension. Default pads with spaces.
    Rpad,
    /// Reverse a string: `REVERSE(text)`.
    /// Snowflake extension.
    Reverse,
    /// Number of segments in a `PATH(...)` string: `PATHLENGTH(path)`.
    /// NULL path yields NULL.
    PathLength,
    /// The n-th (1-based, root-first) segment of a `PATH(...)` string:
    /// `PATHITEM(path, n)`. Out-of-range positions yield an empty string.
    PathItem,
    /// Extract part of a delimited string: `SPLIT(text, delimiter, part_number)`.
    /// Maps to SQL `SPLIT_PART`. Part number is 1-based. Snowflake extension.
    Split,
    /// Format a value as text: `FORMAT(value, format_string)`.
    /// Maps to SQL `TO_CHAR(value, format)` for dates, `CAST` for numbers.
    Format,
    /// Check if text contains a substring: `CONTAINS(text, search)`.
    /// Returns boolean. Case-insensitive.
    Contains,
    /// Check if text starts with a prefix: `STARTSWITH(text, prefix)`.
    /// Returns boolean.
    StartsWith,
    /// Check if text ends with a suffix: `ENDSWITH(text, suffix)`.
    /// Returns boolean.
    EndsWith,
    /// Capitalize first letter of each word: `INITCAP(text)`.
    InitCap,
}

impl TextFunction {
    /// Render as a SQL function call with the given arguments.
    ///
    /// # Errors
    ///
    /// Returns an error if any argument cannot be rendered as scalar SQL
    /// (see [`Expression::to_sql_string`]).
    pub fn to_sql(&self, args: &[Expression]) -> EngineResult<String> {
        let strs = args
            .iter()
            .map(|a| a.to_sql_string())
            .collect::<EngineResult<Vec<String>>>()?;
        Ok(self.to_sql_strs(&strs))
    }

    /// Render as a SQL function call with pre-rendered string arguments.
    pub fn to_sql_strs(&self, args: &[String]) -> String {
        match self {
            Self::Concatenate => {
                format!("CONCAT({})", args.join(", "))
            }
            Self::CombineValues => {
                // First arg is delimiter, rest are values.
                if args.len() < 2 {
                    return "''".to_string();
                }
                let delimiter = &args[0];
                let values = &args[1..];
                // CONCAT_WS(delimiter, val1, val2, ...)
                format!("CONCAT_WS({delimiter}, {})", values.join(", "))
            }
            Self::Exact => {
                // Case-sensitive comparison: returns boolean.
                format!("({} = {})", args[0], args[1])
            }
            Self::Find => {
                // STRPOS(within_text, find_text) — 1-based.
                // With optional start_pos, use STRPOS on substring.
                if args.len() >= 3 {
                    // STRPOS(SUBSTRING(within FROM start), find) + start - 1
                    format!(
                        "(STRPOS(SUBSTRING({} FROM {}), {}) + {} - 1)",
                        args[1], args[2], args[0], args[2]
                    )
                } else {
                    format!("STRPOS({}, {})", args[1], args[0])
                }
            }
            Self::Fixed => {
                // CAST(ROUND(number, decimals) AS VARCHAR)
                let decimals = args.get(1).map(|s| s.as_str()).unwrap_or("2");
                format!("CAST(ROUND({}, {decimals}) AS VARCHAR)", args[0])
            }
            Self::Left => {
                let n = args.get(1).map(|s| s.as_str()).unwrap_or("1");
                format!("LEFT({}, {n})", args[0])
            }
            Self::Len => format!("LENGTH({})", args[0]),
            Self::Lower => format!("LOWER({})", args[0]),
            Self::Mid => {
                // SUBSTRING(text FROM start FOR length)
                format!("SUBSTRING({} FROM {} FOR {})", args[0], args[1], args[2])
            }
            Self::Replace => {
                // OVERLAY(old_text PLACING new_text FROM start FOR num_chars)
                format!(
                    "OVERLAY({} PLACING {} FROM {} FOR {})",
                    args[0], args[3], args[1], args[2]
                )
            }
            Self::Rept => format!("REPEAT({}, {})", args[0], args[1]),
            Self::Right => {
                let n = args.get(1).map(|s| s.as_str()).unwrap_or("1");
                format!("RIGHT({}, {n})", args[0])
            }
            Self::Search => {
                // Case-insensitive: STRPOS(LOWER(within), LOWER(find))
                if args.len() >= 3 {
                    format!(
                        "(STRPOS(LOWER(SUBSTRING({} FROM {})), LOWER({})) + {} - 1)",
                        args[1], args[2], args[0], args[2]
                    )
                } else {
                    format!("STRPOS(LOWER({}), LOWER({}))", args[1], args[0])
                }
            }
            Self::Substitute => {
                // REPLACE(text, old_text, new_text) — SQL standard.
                // instance_num is ignored (replaces all, like SQL REPLACE).
                format!("REPLACE({}, {}, {})", args[0], args[1], args[2])
            }
            Self::Trim => format!("TRIM({})", args[0]),
            Self::Unichar => format!("CHR({})", args[0]),
            Self::Unicode => format!("ASCII({})", args[0]),
            Self::Upper => format!("UPPER({})", args[0]),
            Self::Value => format!("CAST({} AS DOUBLE)", args[0]),
            Self::Ltrim => {
                if args.len() >= 2 {
                    format!("LTRIM({}, {})", args[0], args[1])
                } else {
                    format!("LTRIM({})", args[0])
                }
            }
            Self::Rtrim => {
                if args.len() >= 2 {
                    format!("RTRIM({}, {})", args[0], args[1])
                } else {
                    format!("RTRIM({})", args[0])
                }
            }
            Self::Lpad => {
                if args.len() >= 3 {
                    format!("LPAD({}, {}, {})", args[0], args[1], args[2])
                } else {
                    format!("LPAD({}, {})", args[0], args[1])
                }
            }
            Self::Rpad => {
                if args.len() >= 3 {
                    format!("RPAD({}, {}, {})", args[0], args[1], args[2])
                } else {
                    format!("RPAD({}, {})", args[0], args[1])
                }
            }
            Self::Reverse => format!("REVERSE({})", args[0]),
            Self::PathLength => format!(
                "(CASE WHEN {a} IS NULL THEN NULL ELSE                  LENGTH({a}) - LENGTH(REPLACE({a}, '|', '')) + 1 END)",
                a = args[0]
            ),
            Self::PathItem => format!("SPLIT_PART({}, '|', {})", args[0], args[1]),
            Self::Split => {
                format!("SPLIT_PART({}, {}, {})", args[0], args[1], args[2])
            }
            Self::Format => {
                // TO_CHAR works in DataFusion for date formatting.
                // For numbers, falls back to CAST.
                format!("TO_CHAR({}, {})", args[0], args[1])
            }
            Self::Contains => {
                // Case-insensitive: POSITION(LOWER(search) IN LOWER(text)) > 0
                format!("(POSITION(LOWER({}) IN LOWER({})) > 0)", args[1], args[0])
            }
            Self::StartsWith => {
                format!("(LEFT({}, LENGTH({})) = {})", args[0], args[1], args[1])
            }
            Self::EndsWith => {
                format!("(RIGHT({}, LENGTH({})) = {})", args[0], args[1], args[1])
            }
            Self::InitCap => format!("INITCAP({})", args[0]),
        }
    }
}

impl std::fmt::Display for TextFunction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Concatenate => write!(f, "CONCATENATE"),
            Self::CombineValues => write!(f, "COMBINEVALUES"),
            Self::Exact => write!(f, "EXACT"),
            Self::Find => write!(f, "FIND"),
            Self::Fixed => write!(f, "FIXED"),
            Self::Left => write!(f, "LEFT"),
            Self::Len => write!(f, "LEN"),
            Self::Lower => write!(f, "LOWER"),
            Self::Mid => write!(f, "MID"),
            Self::Replace => write!(f, "REPLACE"),
            Self::Rept => write!(f, "REPT"),
            Self::Right => write!(f, "RIGHT"),
            Self::Search => write!(f, "SEARCH"),
            Self::Substitute => write!(f, "SUBSTITUTE"),
            Self::Trim => write!(f, "TRIM"),
            Self::Unichar => write!(f, "UNICHAR"),
            Self::Unicode => write!(f, "UNICODE"),
            Self::Upper => write!(f, "UPPER"),
            Self::Value => write!(f, "VALUE"),
            Self::Ltrim => write!(f, "LTRIM"),
            Self::Rtrim => write!(f, "RTRIM"),
            Self::Lpad => write!(f, "LPAD"),
            Self::Rpad => write!(f, "RPAD"),
            Self::Reverse => write!(f, "REVERSE"),
            Self::PathLength => write!(f, "PATHLENGTH"),
            Self::PathItem => write!(f, "PATHITEM"),
            Self::Split => write!(f, "SPLIT"),
            Self::Format => write!(f, "FORMAT"),
            Self::Contains => write!(f, "CONTAINS"),
            Self::StartsWith => write!(f, "STARTSWITH"),
            Self::EndsWith => write!(f, "ENDSWITH"),
            Self::InitCap => write!(f, "INITCAP"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Text function tests ---

    #[test]
    fn text_concatenate_sql() {
        let expr = text_fn(
            TextFunction::Concatenate,
            vec![col("a"), col("b"), col("c")],
        );
        assert_eq!(expr.to_sql_string().unwrap(), "CONCAT(\"a\", \"b\", \"c\")");
    }

    #[test]
    fn text_combinevalues_sql() {
        let expr = text_fn(
            TextFunction::CombineValues,
            vec![lit_str("-"), col("a"), col("b")],
        );
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "CONCAT_WS('-', \"a\", \"b\")"
        );
    }

    #[test]
    fn text_exact_sql() {
        let expr = text_fn(TextFunction::Exact, vec![col("a"), col("b")]);
        assert_eq!(expr.to_sql_string().unwrap(), "(\"a\" = \"b\")");
    }

    #[test]
    fn text_find_sql() {
        let expr = text_fn(TextFunction::Find, vec![lit_str("x"), col("text")]);
        assert_eq!(expr.to_sql_string().unwrap(), "STRPOS(\"text\", 'x')");
    }

    #[test]
    fn text_find_with_start_sql() {
        let expr = text_fn(
            TextFunction::Find,
            vec![lit_str("x"), col("text"), lit_int(5)],
        );
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "(STRPOS(SUBSTRING(\"text\" FROM 5), 'x') + 5 - 1)"
        );
    }

    #[test]
    fn text_left_sql() {
        let expr = text_fn(TextFunction::Left, vec![col("name"), lit_int(3)]);
        assert_eq!(expr.to_sql_string().unwrap(), "LEFT(\"name\", 3)");
    }

    #[test]
    fn text_len_sql() {
        let expr = text_fn(TextFunction::Len, vec![col("name")]);
        assert_eq!(expr.to_sql_string().unwrap(), "LENGTH(\"name\")");
    }

    #[test]
    fn text_lower_upper_sql() {
        assert_eq!(
            text_fn(TextFunction::Lower, vec![col("name")])
                .to_sql_string()
                .unwrap(),
            "LOWER(\"name\")"
        );
        assert_eq!(
            text_fn(TextFunction::Upper, vec![col("name")])
                .to_sql_string()
                .unwrap(),
            "UPPER(\"name\")"
        );
    }

    #[test]
    fn text_mid_sql() {
        let expr = text_fn(TextFunction::Mid, vec![col("text"), lit_int(2), lit_int(4)]);
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "SUBSTRING(\"text\" FROM 2 FOR 4)"
        );
    }

    #[test]
    fn text_replace_sql() {
        let expr = text_fn(
            TextFunction::Replace,
            vec![col("text"), lit_int(3), lit_int(2), lit_str("XX")],
        );
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "OVERLAY(\"text\" PLACING 'XX' FROM 3 FOR 2)"
        );
    }

    #[test]
    fn text_rept_sql() {
        let expr = text_fn(TextFunction::Rept, vec![lit_str("ab"), lit_int(3)]);
        assert_eq!(expr.to_sql_string().unwrap(), "REPEAT('ab', 3)");
    }

    #[test]
    fn text_right_sql() {
        let expr = text_fn(TextFunction::Right, vec![col("name"), lit_int(2)]);
        assert_eq!(expr.to_sql_string().unwrap(), "RIGHT(\"name\", 2)");
    }

    #[test]
    fn text_search_sql() {
        let expr = text_fn(TextFunction::Search, vec![lit_str("X"), col("text")]);
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "STRPOS(LOWER(\"text\"), LOWER('X'))"
        );
    }

    #[test]
    fn text_substitute_sql() {
        let expr = text_fn(
            TextFunction::Substitute,
            vec![col("text"), lit_str("old"), lit_str("new")],
        );
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "REPLACE(\"text\", 'old', 'new')"
        );
    }

    #[test]
    fn text_trim_sql() {
        let expr = text_fn(TextFunction::Trim, vec![col("name")]);
        assert_eq!(expr.to_sql_string().unwrap(), "TRIM(\"name\")");
    }

    #[test]
    fn text_unichar_sql() {
        let expr = text_fn(TextFunction::Unichar, vec![lit_int(65)]);
        assert_eq!(expr.to_sql_string().unwrap(), "CHR(65)");
    }

    #[test]
    fn text_unicode_sql() {
        let expr = text_fn(TextFunction::Unicode, vec![lit_str("A")]);
        assert_eq!(expr.to_sql_string().unwrap(), "ASCII('A')");
    }

    #[test]
    fn text_value_sql() {
        let expr = text_fn(TextFunction::Value, vec![col("price_text")]);
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "CAST(\"price_text\" AS DOUBLE)"
        );
    }

    #[test]
    fn text_fixed_sql() {
        let expr = text_fn(TextFunction::Fixed, vec![col("amount"), lit_int(2)]);
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "CAST(ROUND(\"amount\", 2) AS VARCHAR)"
        );
    }

    #[test]
    fn text_ltrim_sql() {
        let expr = text_fn(TextFunction::Ltrim, vec![col("name")]);
        assert_eq!(expr.to_sql_string().unwrap(), "LTRIM(\"name\")");
        let expr = text_fn(TextFunction::Ltrim, vec![col("name"), lit_str("0#")]);
        assert_eq!(expr.to_sql_string().unwrap(), "LTRIM(\"name\", '0#')");
    }

    #[test]
    fn text_rtrim_sql() {
        let expr = text_fn(TextFunction::Rtrim, vec![col("price")]);
        assert_eq!(expr.to_sql_string().unwrap(), "RTRIM(\"price\")");
        let expr = text_fn(TextFunction::Rtrim, vec![col("price"), lit_str("0.")]);
        assert_eq!(expr.to_sql_string().unwrap(), "RTRIM(\"price\", '0.')");
    }

    #[test]
    fn text_lpad_sql() {
        let expr = text_fn(TextFunction::Lpad, vec![col("id"), lit_int(5)]);
        assert_eq!(expr.to_sql_string().unwrap(), "LPAD(\"id\", 5)");
        let expr = text_fn(
            TextFunction::Lpad,
            vec![col("id"), lit_int(5), lit_str("0")],
        );
        assert_eq!(expr.to_sql_string().unwrap(), "LPAD(\"id\", 5, '0')");
    }

    #[test]
    fn text_rpad_sql() {
        let expr = text_fn(TextFunction::Rpad, vec![col("code"), lit_int(10)]);
        assert_eq!(expr.to_sql_string().unwrap(), "RPAD(\"code\", 10)");
        let expr = text_fn(
            TextFunction::Rpad,
            vec![col("code"), lit_int(10), lit_str("*")],
        );
        assert_eq!(expr.to_sql_string().unwrap(), "RPAD(\"code\", 10, '*')");
    }

    #[test]
    fn text_reverse_sql() {
        let expr = text_fn(TextFunction::Reverse, vec![col("text")]);
        assert_eq!(expr.to_sql_string().unwrap(), "REVERSE(\"text\")");
    }

    #[test]
    fn text_split_sql() {
        let expr = text_fn(
            TextFunction::Split,
            vec![col("path"), lit_str("/"), lit_int(2)],
        );
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "SPLIT_PART(\"path\", '/', 2)"
        );
    }
}
