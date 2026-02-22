//! FILENAME: core/engine/src/custom_format.rs
//! PURPOSE: Excel-compatible custom number format parser and formatter.
//! CONTEXT: This module implements the full custom number format syntax used in
//! Excel's "Format Cells" dialog. It parses user-defined format strings like
//! `#,##0.00;[Red]-#,##0.00;"Zero";@` and produces formatted display output
//! with optional color overrides. The formatting is non-destructive — it only
//! changes the visual representation, not the underlying cell value.

use crate::number_format::format_number;
use crate::style::NumberFormat;

// ============================================================================
// DATA STRUCTURES
// ============================================================================

/// A parsed token from a format string section.
#[derive(Debug, Clone, PartialEq)]
pub enum FormatToken {
    /// `0` — Display a digit; pad with 0 if no digit present
    DigitZero,
    /// `#` — Display a digit only if significant
    DigitHash,
    /// `?` — Display a digit; pad with space if no digit present
    DigitSpace,
    /// `.` — Decimal point
    DecimalPoint,
    /// `,` — Thousands separator (contextual: may also be scaling)
    Comma,
    /// `%` — Percentage (multiplies value by 100)
    Percent,
    /// `E+` or `E-` or `e+` or `e-` — Scientific notation
    Scientific { show_plus: bool },
    /// Literal text (from "quoted", \escaped, or passthrough chars)
    Literal(String),
    /// `@` — Text placeholder (replaced by cell's text content)
    TextPlaceholder,
    /// `_x` — Add space equal to width of character x
    SpaceWidth(char),
    /// `*x` — Repeat character x to fill cell width
    RepeatFill(char),
    /// `/` — Fraction separator
    FractionSeparator,

    // Date tokens
    DateYear4,       // yyyy
    DateYear2,       // yy
    DateMonth2,      // mm  (when context = date)
    DateMonth1,      // m   (when context = date)
    DateMonthName3,  // mmm
    DateMonthName4,  // mmmm
    DateMonthName1,  // mmmmm
    DateDay2,        // dd
    DateDay1,        // d
    DateDayName3,    // ddd
    DateDayName4,    // dddd

    // Time tokens
    TimeHour2,    // hh (or HH)
    TimeHour1,    // h  (or H)
    TimeMinute2,  // mm (when context = time, adjacent to h/s)
    TimeMinute1,  // m  (when context = time, adjacent to h/s)
    TimeSecond2,  // ss
    TimeSecond1,  // s
    AmPm,         // AM/PM, am/pm, A/P, a/p
    ElapsedHours,   // [h] or [hh]
    ElapsedMinutes, // [m] or [mm]
    ElapsedSeconds, // [s] or [ss]
}

/// A color specified via [Color] tokens in a format string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormatColor {
    Black,
    Blue,
    Cyan,
    Green,
    Magenta,
    Red,
    White,
    Yellow,
}

/// A condition specified via [>100] style tokens.
#[derive(Debug, Clone, PartialEq)]
pub struct FormatCondition {
    pub operator: ConditionOp,
    pub value: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConditionOp {
    Equal,
    NotEqual,
    GreaterThan,
    GreaterThanOrEqual,
    LessThan,
    LessThanOrEqual,
}

/// A single section of a format string (up to 4 sections separated by `;`).
#[derive(Debug, Clone)]
pub struct FormatSection {
    pub tokens: Vec<FormatToken>,
    pub color: Option<FormatColor>,
    pub condition: Option<FormatCondition>,
    /// Number of trailing commas (each divides by 1000)
    pub scale_divisor: u32,
    /// Whether this section contains a percent sign
    pub has_percent: bool,
    /// Whether this section contains date/time tokens
    pub is_datetime: bool,
    /// Whether this section has digit placeholders
    pub has_digits: bool,
    /// Whether this section has a text placeholder (@)
    pub has_text_placeholder: bool,
    /// Whether this section has scientific notation
    pub has_scientific: bool,
}

/// A fully parsed custom number format (1-4 sections).
#[derive(Debug, Clone)]
pub struct ParsedCustomFormat {
    pub positive: FormatSection,
    pub negative: Option<FormatSection>,
    pub zero: Option<FormatSection>,
    pub text: Option<FormatSection>,
    pub has_conditions: bool,
}

/// Result of formatting a value: display text + optional color override.
#[derive(Debug, Clone)]
pub struct FormatResult {
    pub text: String,
    pub color: Option<FormatColor>,
}

// ============================================================================
// COLOR UTILITIES
// ============================================================================

/// Convert a FormatColor to a CSS hex color string.
pub fn format_color_to_css(color: &FormatColor) -> &'static str {
    match color {
        FormatColor::Black => "#000000",
        FormatColor::Blue => "#0000ff",
        FormatColor::Cyan => "#00ffff",
        FormatColor::Green => "#008000",
        FormatColor::Magenta => "#ff00ff",
        FormatColor::Red => "#ff0000",
        FormatColor::White => "#ffffff",
        FormatColor::Yellow => "#ffff00",
    }
}

/// Try to parse a color name from a bracket token.
fn parse_color_name(name: &str) -> Option<FormatColor> {
    match name.to_lowercase().as_str() {
        "black" => Some(FormatColor::Black),
        "blue" => Some(FormatColor::Blue),
        "cyan" => Some(FormatColor::Cyan),
        "green" => Some(FormatColor::Green),
        "magenta" => Some(FormatColor::Magenta),
        "red" => Some(FormatColor::Red),
        "white" => Some(FormatColor::White),
        "yellow" => Some(FormatColor::Yellow),
        _ => None,
    }
}

/// Try to parse a condition from a bracket token like ">100", "<=50".
fn parse_condition(content: &str) -> Option<FormatCondition> {
    let s = content.trim();
    if s.is_empty() {
        return None;
    }

    let (op, rest) = if s.starts_with(">=") {
        (ConditionOp::GreaterThanOrEqual, &s[2..])
    } else if s.starts_with("<=") {
        (ConditionOp::LessThanOrEqual, &s[2..])
    } else if s.starts_with("<>") {
        (ConditionOp::NotEqual, &s[2..])
    } else if s.starts_with('>') {
        (ConditionOp::GreaterThan, &s[1..])
    } else if s.starts_with('<') {
        (ConditionOp::LessThan, &s[1..])
    } else if s.starts_with('=') {
        (ConditionOp::Equal, &s[1..])
    } else {
        return None;
    };

    rest.trim().parse::<f64>().ok().map(|value| FormatCondition {
        operator: op,
        value,
    })
}

fn evaluate_condition(condition: &FormatCondition, value: f64) -> bool {
    match condition.operator {
        ConditionOp::Equal => (value - condition.value).abs() < f64::EPSILON,
        ConditionOp::NotEqual => (value - condition.value).abs() >= f64::EPSILON,
        ConditionOp::GreaterThan => value > condition.value,
        ConditionOp::GreaterThanOrEqual => value >= condition.value,
        ConditionOp::LessThan => value < condition.value,
        ConditionOp::LessThanOrEqual => value <= condition.value,
    }
}

// ============================================================================
// PARSER
// ============================================================================

/// Parse a custom format string into a structured ParsedCustomFormat.
pub fn parse_custom_format(format_str: &str) -> Result<ParsedCustomFormat, String> {
    // Handle empty/whitespace format
    if format_str.trim().is_empty() {
        return Ok(ParsedCustomFormat {
            positive: empty_section(),
            negative: None,
            zero: None,
            text: None,
            has_conditions: false,
        });
    }

    // Split into sections by unquoted semicolons
    let raw_sections = split_sections(format_str);

    if raw_sections.is_empty() {
        return Ok(ParsedCustomFormat {
            positive: empty_section(),
            negative: None,
            zero: None,
            text: None,
            has_conditions: false,
        });
    }

    // Parse each section
    let mut sections: Vec<FormatSection> = Vec::new();
    for raw in &raw_sections {
        sections.push(parse_section(raw)?);
    }

    // Check if any section has conditions
    let has_conditions = sections.iter().any(|s| s.condition.is_some());

    // Assign sections based on count
    let (positive, negative, zero, text) = match sections.len() {
        1 => (sections.remove(0), None, None, None),
        2 => {
            let s0 = sections.remove(0);
            let s1 = sections.remove(0);
            (s0, Some(s1), None, None)
        }
        3 => {
            let s0 = sections.remove(0);
            let s1 = sections.remove(0);
            let s2 = sections.remove(0);
            (s0, Some(s1), Some(s2), None)
        }
        _ => {
            let s0 = sections.remove(0);
            let s1 = sections.remove(0);
            let s2 = sections.remove(0);
            let s3 = sections.remove(0);
            (s0, Some(s1), Some(s2), Some(s3))
        }
    };

    Ok(ParsedCustomFormat {
        positive,
        negative,
        zero,
        text,
        has_conditions,
    })
}

/// Split a format string by unquoted, unescaped semicolons.
fn split_sections(s: &str) -> Vec<String> {
    let mut sections = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    let mut in_quotes = false;
    let mut in_bracket = false;

    while i < chars.len() {
        let ch = chars[i];

        if ch == '"' && !in_bracket {
            in_quotes = !in_quotes;
            current.push(ch);
        } else if ch == '\\' && !in_quotes && !in_bracket && i + 1 < chars.len() {
            // Escaped character
            current.push(ch);
            current.push(chars[i + 1]);
            i += 1;
        } else if ch == '[' && !in_quotes {
            in_bracket = true;
            current.push(ch);
        } else if ch == ']' && !in_quotes {
            in_bracket = false;
            current.push(ch);
        } else if ch == ';' && !in_quotes && !in_bracket {
            sections.push(current.clone());
            current.clear();
        } else {
            current.push(ch);
        }

        i += 1;
    }

    // Push the last section
    sections.push(current);
    sections
}

/// Parse a single format section string into a FormatSection.
fn parse_section(section_str: &str) -> Result<FormatSection, String> {
    let mut color: Option<FormatColor> = None;
    let mut condition: Option<FormatCondition> = None;
    let mut tokens: Vec<FormatToken> = Vec::new();

    let chars: Vec<char> = section_str.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        let ch = chars[i];

        match ch {
            // Bracket tokens: [Color], [Condition], [h], [m], [s]
            '[' => {
                let bracket_end = find_bracket_end(&chars, i);
                if let Some(end) = bracket_end {
                    let content: String = chars[i + 1..end].iter().collect();

                    // Try elapsed time tokens
                    let lower = content.to_lowercase();
                    if lower == "h" || lower == "hh" {
                        tokens.push(FormatToken::ElapsedHours);
                    } else if lower == "m" || lower == "mm" {
                        tokens.push(FormatToken::ElapsedMinutes);
                    } else if lower == "s" || lower == "ss" {
                        tokens.push(FormatToken::ElapsedSeconds);
                    } else if let Some(c) = parse_color_name(&content) {
                        // Color token
                        color = Some(c);
                    } else if let Some(cond) = parse_condition(&content) {
                        // Condition token
                        condition = Some(cond);
                    }
                    // else: unknown bracket token, ignore

                    i = end + 1;
                } else {
                    // No matching bracket, treat as literal
                    tokens.push(FormatToken::Literal("[".to_string()));
                    i += 1;
                }
            }

            // Quoted literal strings
            '"' => {
                let mut lit = String::new();
                i += 1;
                while i < len && chars[i] != '"' {
                    lit.push(chars[i]);
                    i += 1;
                }
                if i < len {
                    i += 1; // skip closing quote
                }
                if !lit.is_empty() {
                    tokens.push(FormatToken::Literal(lit));
                }
            }

            // Backslash escape
            '\\' => {
                if i + 1 < len {
                    tokens.push(FormatToken::Literal(chars[i + 1].to_string()));
                    i += 2;
                } else {
                    i += 1;
                }
            }

            // Digit placeholders
            '0' => {
                tokens.push(FormatToken::DigitZero);
                i += 1;
            }
            '#' => {
                tokens.push(FormatToken::DigitHash);
                i += 1;
            }
            '?' => {
                tokens.push(FormatToken::DigitSpace);
                i += 1;
            }

            // Decimal point
            '.' => {
                tokens.push(FormatToken::DecimalPoint);
                i += 1;
            }

            // Comma (thousands separator or scaling)
            ',' => {
                tokens.push(FormatToken::Comma);
                i += 1;
            }

            // Percent
            '%' => {
                tokens.push(FormatToken::Percent);
                i += 1;
            }

            // Scientific notation
            'E' | 'e' => {
                if i + 1 < len && (chars[i + 1] == '+' || chars[i + 1] == '-') {
                    tokens.push(FormatToken::Scientific {
                        show_plus: chars[i + 1] == '+',
                    });
                    i += 2;
                } else {
                    // Not scientific notation, treat as literal
                    tokens.push(FormatToken::Literal(ch.to_string()));
                    i += 1;
                }
            }

            // Text placeholder
            '@' => {
                tokens.push(FormatToken::TextPlaceholder);
                i += 1;
            }

            // Space width
            '_' => {
                if i + 1 < len {
                    tokens.push(FormatToken::SpaceWidth(chars[i + 1]));
                    i += 2;
                } else {
                    i += 1;
                }
            }

            // Repeat fill
            '*' => {
                if i + 1 < len {
                    tokens.push(FormatToken::RepeatFill(chars[i + 1]));
                    i += 2;
                } else {
                    i += 1;
                }
            }

            // Fraction separator
            '/' => {
                tokens.push(FormatToken::FractionSeparator);
                i += 1;
            }

            // Date/time: y
            'y' | 'Y' => {
                let count = count_consecutive_ci(&chars, i, 'y');
                if count >= 4 {
                    tokens.push(FormatToken::DateYear4);
                } else {
                    tokens.push(FormatToken::DateYear2);
                }
                i += count;
            }

            // Date/time: m (ambiguous - resolved later)
            'm' | 'M' => {
                let count = count_consecutive_ci(&chars, i, 'm');
                match count {
                    1 => tokens.push(FormatToken::DateMonth1),
                    2 => tokens.push(FormatToken::DateMonth2),
                    3 => tokens.push(FormatToken::DateMonthName3),
                    4 => tokens.push(FormatToken::DateMonthName4),
                    _ => tokens.push(FormatToken::DateMonthName1), // 5+
                }
                i += count;
            }

            // Date: d
            'd' | 'D' => {
                let count = count_consecutive_ci(&chars, i, 'd');
                match count {
                    1 => tokens.push(FormatToken::DateDay1),
                    2 => tokens.push(FormatToken::DateDay2),
                    3 => tokens.push(FormatToken::DateDayName3),
                    _ => tokens.push(FormatToken::DateDayName4), // 4+
                }
                i += count;
            }

            // Time: h
            'h' | 'H' => {
                let count = count_consecutive_ci(&chars, i, 'h');
                if count >= 2 {
                    tokens.push(FormatToken::TimeHour2);
                } else {
                    tokens.push(FormatToken::TimeHour1);
                }
                i += count;
            }

            // Time: s
            's' | 'S' => {
                let count = count_consecutive_ci(&chars, i, 's');
                if count >= 2 {
                    tokens.push(FormatToken::TimeSecond2);
                } else {
                    tokens.push(FormatToken::TimeSecond1);
                }
                i += count;
            }

            // AM/PM
            'A' | 'a' => {
                let remaining: String = chars[i..].iter().collect();
                let upper = remaining.to_uppercase();
                if upper.starts_with("AM/PM") {
                    tokens.push(FormatToken::AmPm);
                    i += 5;
                } else if upper.starts_with("A/P") {
                    tokens.push(FormatToken::AmPm);
                    i += 3;
                } else {
                    tokens.push(FormatToken::Literal(ch.to_string()));
                    i += 1;
                }
            }

            // Common literal pass-through characters
            ' ' | ':' | '-' | '(' | ')' | '+' | '$' | '!' | '~' | '{' | '}' | '<' | '>'
            | '=' | '^' | '&' | '\'' | '`' => {
                tokens.push(FormatToken::Literal(ch.to_string()));
                i += 1;
            }

            // Currency and other Unicode characters pass through as literals
            _ => {
                tokens.push(FormatToken::Literal(ch.to_string()));
                i += 1;
            }
        }
    }

    // Resolve m/mm ambiguity: if adjacent to h or s tokens, they are minutes
    resolve_minute_month_ambiguity(&mut tokens);

    // Analyze the section for metadata
    let has_percent = tokens.iter().any(|t| matches!(t, FormatToken::Percent));
    let has_scientific = tokens.iter().any(|t| matches!(t, FormatToken::Scientific { .. }));
    let is_datetime = tokens.iter().any(|t| {
        matches!(
            t,
            FormatToken::DateYear4
                | FormatToken::DateYear2
                | FormatToken::DateMonth1
                | FormatToken::DateMonth2
                | FormatToken::DateMonthName3
                | FormatToken::DateMonthName4
                | FormatToken::DateMonthName1
                | FormatToken::DateDay1
                | FormatToken::DateDay2
                | FormatToken::DateDayName3
                | FormatToken::DateDayName4
                | FormatToken::TimeHour1
                | FormatToken::TimeHour2
                | FormatToken::TimeMinute1
                | FormatToken::TimeMinute2
                | FormatToken::TimeSecond1
                | FormatToken::TimeSecond2
                | FormatToken::AmPm
                | FormatToken::ElapsedHours
                | FormatToken::ElapsedMinutes
                | FormatToken::ElapsedSeconds
        )
    });
    let has_digits = tokens.iter().any(|t| {
        matches!(
            t,
            FormatToken::DigitZero | FormatToken::DigitHash | FormatToken::DigitSpace
        )
    });
    let has_text_placeholder = tokens.iter().any(|t| matches!(t, FormatToken::TextPlaceholder));

    // Calculate scale divisor (trailing commas after last digit placeholder)
    let scale_divisor = count_trailing_comma_scale(&tokens);

    // Remove the trailing commas that are used for scaling (not thousands separators)
    remove_trailing_scale_commas(&mut tokens);

    Ok(FormatSection {
        tokens,
        color,
        condition,
        scale_divisor,
        has_percent,
        is_datetime,
        has_digits,
        has_text_placeholder,
        has_scientific,
    })
}

fn empty_section() -> FormatSection {
    FormatSection {
        tokens: vec![],
        color: None,
        condition: None,
        scale_divisor: 0,
        has_percent: false,
        is_datetime: false,
        has_digits: false,
        has_text_placeholder: false,
        has_scientific: false,
    }
}

/// Find the matching `]` bracket, respecting nested quotes.
fn find_bracket_end(chars: &[char], start: usize) -> Option<usize> {
    let mut i = start + 1;
    while i < chars.len() {
        if chars[i] == ']' {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Count consecutive occurrences of a character (case-insensitive).
fn count_consecutive_ci(chars: &[char], start: usize, target: char) -> usize {
    let lower = target.to_lowercase().next().unwrap();
    let upper = target.to_uppercase().next().unwrap();
    let mut count = 0;
    let mut i = start;
    while i < chars.len() && (chars[i] == lower || chars[i] == upper) {
        count += 1;
        i += 1;
    }
    count
}

/// Resolve the m/mm ambiguity: if m/mm appears right after h/hh or right before s/ss,
/// it should be minutes (TimeMinute), not months (DateMonth).
fn resolve_minute_month_ambiguity(tokens: &mut Vec<FormatToken>) {
    let len = tokens.len();
    if len == 0 {
        return;
    }

    // Build a list of indices that should be converted to minutes
    let mut convert_to_minutes: Vec<usize> = Vec::new();

    for i in 0..len {
        let is_m1 = matches!(tokens[i], FormatToken::DateMonth1);
        let is_m2 = matches!(tokens[i], FormatToken::DateMonth2);

        if !is_m1 && !is_m2 {
            continue;
        }

        // Check if preceded by an hour token (skip over literals/SpaceWidth)
        let preceded_by_hour = find_prev_significant(tokens, i).map_or(false, |pi| {
            matches!(
                tokens[pi],
                FormatToken::TimeHour1 | FormatToken::TimeHour2 | FormatToken::ElapsedHours
            )
        });

        // Check if followed by a second token (skip over literals/SpaceWidth)
        let followed_by_second = find_next_significant(tokens, i).map_or(false, |ni| {
            matches!(
                tokens[ni],
                FormatToken::TimeSecond1 | FormatToken::TimeSecond2 | FormatToken::ElapsedSeconds
            )
        });

        if preceded_by_hour || followed_by_second {
            convert_to_minutes.push(i);
        }
    }

    for idx in convert_to_minutes {
        tokens[idx] = match tokens[idx] {
            FormatToken::DateMonth1 => FormatToken::TimeMinute1,
            FormatToken::DateMonth2 => FormatToken::TimeMinute2,
            _ => tokens[idx].clone(),
        };
    }
}

/// Find the previous "significant" token index (skipping Literal, SpaceWidth, RepeatFill).
fn find_prev_significant(tokens: &[FormatToken], from: usize) -> Option<usize> {
    if from == 0 {
        return None;
    }
    let mut i = from - 1;
    loop {
        match &tokens[i] {
            FormatToken::Literal(_) | FormatToken::SpaceWidth(_) | FormatToken::RepeatFill(_) => {
                if i == 0 {
                    return None;
                }
                i -= 1;
            }
            _ => return Some(i),
        }
    }
}

/// Find the next "significant" token index (skipping Literal, SpaceWidth, RepeatFill).
fn find_next_significant(tokens: &[FormatToken], from: usize) -> Option<usize> {
    let mut i = from + 1;
    while i < tokens.len() {
        match &tokens[i] {
            FormatToken::Literal(_) | FormatToken::SpaceWidth(_) | FormatToken::RepeatFill(_) => {
                i += 1;
            }
            _ => return Some(i),
        }
    }
    None
}

/// Count trailing commas after the last digit placeholder (for scaling).
fn count_trailing_comma_scale(tokens: &[FormatToken]) -> u32 {
    // Find the position of the last digit placeholder or decimal point
    let last_digit_pos = tokens.iter().rposition(|t| {
        matches!(
            t,
            FormatToken::DigitZero
                | FormatToken::DigitHash
                | FormatToken::DigitSpace
                | FormatToken::DecimalPoint
        )
    });

    if let Some(pos) = last_digit_pos {
        // Count consecutive commas immediately after the last digit placeholder
        let mut count = 0u32;
        let mut i = pos + 1;
        while i < tokens.len() {
            if matches!(tokens[i], FormatToken::Comma) {
                count += 1;
                i += 1;
            } else {
                break;
            }
        }
        count
    } else {
        0
    }
}

/// Remove trailing commas used for scaling (they are not thousands separators).
fn remove_trailing_scale_commas(tokens: &mut Vec<FormatToken>) {
    let last_digit_pos = tokens.iter().rposition(|t| {
        matches!(
            t,
            FormatToken::DigitZero
                | FormatToken::DigitHash
                | FormatToken::DigitSpace
                | FormatToken::DecimalPoint
        )
    });

    if let Some(pos) = last_digit_pos {
        // Remove consecutive commas immediately after the last digit placeholder
        let mut remove_start = None;
        let mut remove_end = pos + 1;
        let mut i = pos + 1;
        while i < tokens.len() {
            if matches!(tokens[i], FormatToken::Comma) {
                if remove_start.is_none() {
                    remove_start = Some(i);
                }
                remove_end = i + 1;
                i += 1;
            } else {
                break;
            }
        }

        if let Some(start) = remove_start {
            tokens.drain(start..remove_end);
        }
    }
}

// ============================================================================
// FORMATTER — NUMBER
// ============================================================================

/// Apply a parsed format to a numeric value.
pub fn apply_custom_format_number(value: f64, format: &ParsedCustomFormat) -> FormatResult {
    // Select the appropriate section
    let section = select_section_for_number(value, format);

    // Handle empty section (hidden format: ;;;)
    if section.tokens.is_empty() {
        return FormatResult {
            text: String::new(),
            color: section.color,
        };
    }

    // If this is a datetime section, delegate to date/time formatting
    if section.is_datetime {
        return format_datetime_section(value, section);
    }

    // If no digit placeholders and no text placeholder, it's all literals
    if !section.has_digits && !section.has_text_placeholder {
        let text = render_literals_only(section);
        return FormatResult {
            text,
            color: section.color,
        };
    }

    // Scientific notation
    if section.has_scientific {
        return format_scientific_section(value, section);
    }

    // Apply scaling
    let mut num = value.abs();
    if section.scale_divisor > 0 {
        let divisor = 1000f64.powi(section.scale_divisor as i32);
        num /= divisor;
    }

    // Apply percentage
    if section.has_percent {
        num *= 100.0;
    }

    // Count digit placeholders on each side of the decimal point
    let (int_placeholders, dec_placeholders) = count_digit_placeholders(&section.tokens);

    // Round to the required decimal places
    num = round_to_places(num, dec_placeholders as u32);

    // Split into integer and fractional parts
    let int_part = num.floor() as u64;
    let frac_part = num - num.floor();

    // Build the integer digit string
    let int_str = if int_part == 0 && int_placeholders == 0 {
        String::new()
    } else {
        int_part.to_string()
    };

    // Build the fractional digit string
    let frac_str = if dec_placeholders > 0 {
        let multiplied = (frac_part * 10f64.powi(dec_placeholders as i32)).round() as u64;
        format!("{:0>width$}", multiplied, width = dec_placeholders)
    } else {
        String::new()
    };

    // Walk tokens and emit formatted output
    let text = render_number_tokens(
        &section.tokens,
        &int_str,
        &frac_str,
        int_placeholders,
        value < 0.0,
        section,
    );

    FormatResult {
        text,
        color: section.color,
    }
}

/// Select the section to use based on the value.
fn select_section_for_number<'a>(
    value: f64,
    format: &'a ParsedCustomFormat,
) -> &'a FormatSection {
    if format.has_conditions {
        // Evaluate conditions on sections
        if let Some(ref cond) = format.positive.condition {
            if evaluate_condition(cond, value) {
                return &format.positive;
            }
        } else {
            // No condition on positive section: use if nothing else matches
        }

        if let Some(ref neg) = format.negative {
            if let Some(ref cond) = neg.condition {
                if evaluate_condition(cond, value) {
                    return neg;
                }
            }
        }

        if let Some(ref zero) = format.zero {
            if let Some(ref cond) = zero.condition {
                if evaluate_condition(cond, value) {
                    return zero;
                }
            }
        }

        // If conditions were present but none matched, use the last section without a condition
        // or the positive section as fallback
        if let Some(ref zero) = format.zero {
            if zero.condition.is_none() {
                return zero;
            }
        }
        if let Some(ref neg) = format.negative {
            if neg.condition.is_none() {
                return neg;
            }
        }
        return &format.positive;
    }

    // Standard routing by sign
    if value > 0.0 || (value == 0.0 && format.zero.is_none()) {
        &format.positive
    } else if value < 0.0 {
        format.negative.as_ref().unwrap_or(&format.positive)
    } else {
        // value == 0.0 and zero section exists
        format.zero.as_ref().unwrap_or(&format.positive)
    }
}

/// Count digit placeholders before and after the decimal point.
fn count_digit_placeholders(tokens: &[FormatToken]) -> (usize, usize) {
    let mut before_decimal = 0;
    let mut after_decimal = 0;
    let mut past_decimal = false;

    for token in tokens {
        match token {
            FormatToken::DecimalPoint => {
                past_decimal = true;
            }
            FormatToken::DigitZero | FormatToken::DigitHash | FormatToken::DigitSpace => {
                if past_decimal {
                    after_decimal += 1;
                } else {
                    before_decimal += 1;
                }
            }
            _ => {}
        }
    }

    (before_decimal, after_decimal)
}

/// Round a number to a given number of decimal places.
fn round_to_places(value: f64, places: u32) -> f64 {
    let multiplier = 10f64.powi(places as i32);
    (value * multiplier).round() / multiplier
}

/// Render the number tokens into a formatted string.
fn render_number_tokens(
    tokens: &[FormatToken],
    int_str: &str,
    frac_str: &str,
    int_placeholder_count: usize,
    is_negative: bool,
    section: &FormatSection,
) -> String {
    let mut result = String::new();
    let int_digits: Vec<char> = int_str.chars().collect();
    let frac_digits: Vec<char> = frac_str.chars().collect();

    // Determine if we need to add a negative sign.
    // Only add if this is the positive section being used for a negative number
    // (i.e., no explicit negative section was provided).
    let need_negative_sign = is_negative && !has_explicit_negative_marker(tokens);

    if need_negative_sign {
        result.push('-');
    }

    // Walk through the tokens
    let mut int_digit_idx: isize = int_digits.len() as isize - int_placeholder_count as isize;
    let mut frac_digit_idx: usize = 0;
    let mut past_decimal = false;

    // Track whether we need to insert thousands separators
    let has_thousands = has_thousands_separator(tokens);

    for token in tokens {
        match token {
            FormatToken::DigitZero => {
                if !past_decimal {
                    // Integer part
                    if int_digit_idx >= 0 && (int_digit_idx as usize) < int_digits.len() {
                        result.push(int_digits[int_digit_idx as usize]);
                    } else {
                        result.push('0');
                    }
                    int_digit_idx += 1;
                } else {
                    // Fractional part
                    if frac_digit_idx < frac_digits.len() {
                        result.push(frac_digits[frac_digit_idx]);
                    } else {
                        result.push('0');
                    }
                    frac_digit_idx += 1;
                }
            }
            FormatToken::DigitHash => {
                if !past_decimal {
                    if int_digit_idx >= 0 && (int_digit_idx as usize) < int_digits.len() {
                        result.push(int_digits[int_digit_idx as usize]);
                    }
                    // else: suppress (show nothing)
                    int_digit_idx += 1;
                } else {
                    if frac_digit_idx < frac_digits.len() {
                        let ch = frac_digits[frac_digit_idx];
                        // Suppress trailing zeros for # in fraction
                        let remaining: String =
                            frac_digits[frac_digit_idx..].iter().collect();
                        if remaining.trim_end_matches('0').is_empty() {
                            // All remaining are zeros, suppress
                        } else {
                            result.push(ch);
                        }
                    }
                    frac_digit_idx += 1;
                }
            }
            FormatToken::DigitSpace => {
                if !past_decimal {
                    if int_digit_idx >= 0 && (int_digit_idx as usize) < int_digits.len() {
                        result.push(int_digits[int_digit_idx as usize]);
                    } else {
                        result.push(' ');
                    }
                    int_digit_idx += 1;
                } else {
                    if frac_digit_idx < frac_digits.len() {
                        let ch = frac_digits[frac_digit_idx];
                        let remaining: String =
                            frac_digits[frac_digit_idx..].iter().collect();
                        if remaining.trim_end_matches('0').is_empty() {
                            result.push(' ');
                        } else {
                            result.push(ch);
                        }
                    } else {
                        result.push(' ');
                    }
                    frac_digit_idx += 1;
                }
            }
            FormatToken::DecimalPoint => {
                past_decimal = true;
                result.push('.');

                // Before rendering fractional digits, we need to flush any remaining
                // integer digits that haven't been consumed (when the number has more
                // digits than placeholders)
            }
            FormatToken::Comma => {
                // In the token stream, commas within the digit section are thousands
                // separators. They are handled by the digit rendering logic, not emitted
                // directly. So we skip them here.
                // (Trailing commas for scaling were already removed.)
            }
            FormatToken::Percent => {
                result.push('%');
            }
            FormatToken::Literal(s) => {
                result.push_str(s);
            }
            FormatToken::TextPlaceholder => {
                // @ in a number section — ignore for numbers
            }
            FormatToken::SpaceWidth(_) => {
                result.push(' ');
            }
            FormatToken::RepeatFill(_) => {
                // Repeat fill is typically handled by the renderer for column-fill.
                // We emit a single space as a placeholder.
                result.push(' ');
            }
            FormatToken::FractionSeparator => {
                result.push('/');
            }
            FormatToken::Scientific { .. } => {
                // Handled separately in format_scientific_section
            }
            // Date/time tokens shouldn't appear in a number section,
            // but if they do, treat as literals
            _ => {}
        }
    }

    // If the number has more integer digits than placeholders, we need to prepend them
    // This is handled by the int_digit_idx logic above starting from a negative index,
    // but we need to also insert thousands separators if applicable
    if has_thousands {
        result = insert_thousands_separators_in_result(&result);
    }

    result
}

/// Check if the token list contains any explicit negative marker (minus sign, parentheses).
fn has_explicit_negative_marker(tokens: &[FormatToken]) -> bool {
    // A section that wraps in parens or contains a minus literal is explicitly handling negatives
    let mut has_open_paren = false;
    let mut has_close_paren = false;
    let mut has_minus = false;

    for token in tokens {
        if let FormatToken::Literal(s) = token {
            if s == "(" {
                has_open_paren = true;
            }
            if s == ")" {
                has_close_paren = true;
            }
            if s == "-" {
                has_minus = true;
            }
        }
    }

    has_minus || (has_open_paren && has_close_paren)
}

/// Check if thousands separators are present in the digit section.
fn has_thousands_separator(tokens: &[FormatToken]) -> bool {
    // A comma between digit placeholders (before the decimal point) = thousands separator
    let mut saw_digit = false;
    let mut past_decimal = false;

    for token in tokens {
        match token {
            FormatToken::DecimalPoint => {
                past_decimal = true;
            }
            FormatToken::DigitZero | FormatToken::DigitHash | FormatToken::DigitSpace => {
                saw_digit = true;
            }
            FormatToken::Comma if saw_digit && !past_decimal => {
                return true;
            }
            _ => {}
        }
    }
    false
}

/// Insert thousands separators into the integer portion of a formatted result.
fn insert_thousands_separators_in_result(formatted: &str) -> String {
    // Find the integer portion (before '.' or before end)
    let dot_pos = formatted.find('.');
    let (prefix, int_start, int_end) = find_integer_portion(formatted, dot_pos);

    if int_end <= int_start {
        return formatted.to_string();
    }

    let int_portion = &formatted[int_start..int_end];

    // Only insert separators in the digit portion
    let digits_only: String = int_portion.chars().filter(|c| c.is_ascii_digit()).collect();

    if digits_only.len() <= 3 {
        return formatted.to_string();
    }

    // Rebuild with separators
    let mut result = String::new();
    result.push_str(prefix);

    // Insert commas into the digit string
    let digit_count = digits_only.len();
    for (i, ch) in digits_only.chars().enumerate() {
        if i > 0 && (digit_count - i) % 3 == 0 {
            result.push(',');
        }
        result.push(ch);
    }

    if let Some(pos) = dot_pos {
        result.push_str(&formatted[pos..]);
    } else {
        // Append any trailing non-digit characters
        let suffix_start = int_end;
        if suffix_start < formatted.len() {
            result.push_str(&formatted[suffix_start..]);
        }
    }

    result
}

/// Find the start and end byte positions of the integer portion in a formatted string.
/// Returns (prefix_before_digits, integer_start, integer_end).
fn find_integer_portion(formatted: &str, dot_pos: Option<usize>) -> (&str, usize, usize) {
    let end = dot_pos.unwrap_or(formatted.len());

    // Find the first digit
    let start = formatted[..end]
        .find(|c: char| c.is_ascii_digit())
        .unwrap_or(end);

    // Find the prefix (everything before the first digit)
    let prefix = &formatted[..start];

    // Find the end of the consecutive digit run
    let digit_end = formatted[start..end]
        .find(|c: char| !c.is_ascii_digit())
        .map(|p| start + p)
        .unwrap_or(end);

    (prefix, start, digit_end)
}

/// Render a section that contains only literal tokens (no digit placeholders).
fn render_literals_only(section: &FormatSection) -> String {
    let mut result = String::new();
    for token in &section.tokens {
        match token {
            FormatToken::Literal(s) => result.push_str(s),
            FormatToken::SpaceWidth(_) => result.push(' '),
            FormatToken::Percent => result.push('%'),
            _ => {}
        }
    }
    result
}

// ============================================================================
// FORMATTER — SCIENTIFIC NOTATION
// ============================================================================

fn format_scientific_section(value: f64, section: &FormatSection) -> FormatResult {
    let num = value.abs();

    // Count digit placeholders after E
    let (_, dec_places) = count_digit_placeholders(&section.tokens);

    // Find the scientific token to determine show_plus
    let show_plus = section
        .tokens
        .iter()
        .find_map(|t| match t {
            FormatToken::Scientific { show_plus } => Some(*show_plus),
            _ => None,
        })
        .unwrap_or(true);

    // Format using Rust's scientific notation
    let formatted = if dec_places > 0 {
        format!("{:.prec$E}", num, prec = dec_places)
    } else {
        format!("{:.0E}", num)
    };

    // Adjust the E notation format
    let text = if show_plus {
        formatted.replace('E', "E+").replace("E+-", "E-")
    } else {
        formatted.replace("E+", "E").replace("E-", "E-")
    };

    let text = if value < 0.0 {
        format!("-{}", text)
    } else {
        text
    };

    FormatResult {
        text,
        color: section.color,
    }
}

// ============================================================================
// FORMATTER — DATE/TIME
// ============================================================================

fn format_datetime_section(value: f64, section: &FormatSection) -> FormatResult {
    // Excel serial date: days since Dec 30, 1899
    let days = value.floor() as i64;
    let time_fraction = value.fract().abs();
    let total_seconds = (time_fraction * 86400.0).round() as u64;

    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;

    // For elapsed time formats
    let total_minutes = total_seconds / 60;
    let total_hours = total_seconds / 3600;

    // Date components
    let date_parts = if days >= 1 {
        serial_to_date(days)
    } else {
        None
    };
    let (year, month, day) = date_parts.unwrap_or((1900, 1, 1));

    // Day of week (0=Sunday)
    let dow = day_of_week(year, month, day);

    // 12-hour clock
    let is_pm = hours >= 12;
    let hours_12 = if hours == 0 {
        12
    } else if hours > 12 {
        hours - 12
    } else {
        hours
    };

    // Check if AM/PM token is present to determine 12h vs 24h
    let has_ampm = section.tokens.iter().any(|t| matches!(t, FormatToken::AmPm));

    let mut result = String::new();

    for token in &section.tokens {
        match token {
            FormatToken::DateYear4 => {
                result.push_str(&format!("{:04}", year));
            }
            FormatToken::DateYear2 => {
                result.push_str(&format!("{:02}", year % 100));
            }
            FormatToken::DateMonth2 => {
                result.push_str(&format!("{:02}", month));
            }
            FormatToken::DateMonth1 => {
                result.push_str(&month.to_string());
            }
            FormatToken::DateMonthName3 => {
                result.push_str(month_name_short(month));
            }
            FormatToken::DateMonthName4 => {
                result.push_str(month_name_full(month));
            }
            FormatToken::DateMonthName1 => {
                result.push_str(&month_name_full(month)[..1]);
            }
            FormatToken::DateDay2 => {
                result.push_str(&format!("{:02}", day));
            }
            FormatToken::DateDay1 => {
                result.push_str(&day.to_string());
            }
            FormatToken::DateDayName3 => {
                result.push_str(day_name_short(dow));
            }
            FormatToken::DateDayName4 => {
                result.push_str(day_name_full(dow));
            }
            FormatToken::TimeHour2 => {
                if has_ampm {
                    result.push_str(&format!("{:02}", hours_12));
                } else {
                    result.push_str(&format!("{:02}", hours));
                }
            }
            FormatToken::TimeHour1 => {
                if has_ampm {
                    result.push_str(&hours_12.to_string());
                } else {
                    result.push_str(&hours.to_string());
                }
            }
            FormatToken::TimeMinute2 => {
                result.push_str(&format!("{:02}", minutes));
            }
            FormatToken::TimeMinute1 => {
                result.push_str(&minutes.to_string());
            }
            FormatToken::TimeSecond2 => {
                result.push_str(&format!("{:02}", seconds));
            }
            FormatToken::TimeSecond1 => {
                result.push_str(&seconds.to_string());
            }
            FormatToken::AmPm => {
                result.push_str(if is_pm { "PM" } else { "AM" });
            }
            FormatToken::ElapsedHours => {
                result.push_str(&total_hours.to_string());
            }
            FormatToken::ElapsedMinutes => {
                result.push_str(&total_minutes.to_string());
            }
            FormatToken::ElapsedSeconds => {
                result.push_str(&total_seconds.to_string());
            }
            FormatToken::Literal(s) => {
                result.push_str(s);
            }
            FormatToken::SpaceWidth(_) => {
                result.push(' ');
            }
            _ => {}
        }
    }

    FormatResult {
        text: result,
        color: section.color,
    }
}

/// Convert an Excel serial date number to (year, month, day).
/// Excel dates: 1 = January 1, 1900.
/// Handles Excel's leap year bug (day 60 = Feb 29, 1900 which didn't exist).
fn serial_to_date(serial: i64) -> Option<(i32, u32, u32)> {
    if serial < 1 {
        return None;
    }
    // Adjust for Excel's leap year bug
    let adjusted = if serial >= 60 { serial - 1 } else { serial };
    days_to_ymd(adjusted)
}

fn days_to_ymd(days: i64) -> Option<(i32, u32, u32)> {
    if days < 1 {
        return None;
    }

    let mut remaining = days;
    let mut year = 1900i32;

    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining <= days_in_year {
            break;
        }
        remaining -= days_in_year;
        year += 1;
    }

    let month_days: [i64; 12] = if is_leap_year(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut month = 1u32;
    for &md in &month_days {
        if remaining <= md {
            return Some((year, month, remaining as u32));
        }
        remaining -= md;
        month += 1;
    }

    None
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

/// Calculate day of week for a date (0=Sunday, 6=Saturday).
/// Uses Tomohiko Sakamoto's algorithm.
fn day_of_week(year: i32, month: u32, day: u32) -> u32 {
    let t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    let y = if month < 3 { year - 1 } else { year };
    ((y + y / 4 - y / 100 + y / 400 + t[(month - 1) as usize] + day as i32) % 7) as u32
}

fn month_name_short(month: u32) -> &'static str {
    match month {
        1 => "Jan",
        2 => "Feb",
        3 => "Mar",
        4 => "Apr",
        5 => "May",
        6 => "Jun",
        7 => "Jul",
        8 => "Aug",
        9 => "Sep",
        10 => "Oct",
        11 => "Nov",
        12 => "Dec",
        _ => "???",
    }
}

fn month_name_full(month: u32) -> &'static str {
    match month {
        1 => "January",
        2 => "February",
        3 => "March",
        4 => "April",
        5 => "May",
        6 => "June",
        7 => "July",
        8 => "August",
        9 => "September",
        10 => "October",
        11 => "November",
        12 => "December",
        _ => "???",
    }
}

fn day_name_short(dow: u32) -> &'static str {
    match dow {
        0 => "Sun",
        1 => "Mon",
        2 => "Tue",
        3 => "Wed",
        4 => "Thu",
        5 => "Fri",
        6 => "Sat",
        _ => "???",
    }
}

fn day_name_full(dow: u32) -> &'static str {
    match dow {
        0 => "Sunday",
        1 => "Monday",
        2 => "Tuesday",
        3 => "Wednesday",
        4 => "Thursday",
        5 => "Friday",
        6 => "Saturday",
        _ => "???",
    }
}

// ============================================================================
// FORMATTER — TEXT
// ============================================================================

/// Apply a parsed format to a text value (uses the text section with @).
pub fn apply_custom_format_text(text: &str, format: &ParsedCustomFormat) -> FormatResult {
    // Use the text section (4th section) if available
    if let Some(ref text_section) = format.text {
        let mut result = String::new();

        if text_section.tokens.is_empty() {
            return FormatResult {
                text: String::new(),
                color: text_section.color,
            };
        }

        for token in &text_section.tokens {
            match token {
                FormatToken::TextPlaceholder => {
                    result.push_str(text);
                }
                FormatToken::Literal(s) => {
                    result.push_str(s);
                }
                FormatToken::SpaceWidth(_) => {
                    result.push(' ');
                }
                _ => {}
            }
        }

        FormatResult {
            text: result,
            color: text_section.color,
        }
    } else {
        // No text section — display text unformatted
        FormatResult {
            text: text.to_string(),
            color: None,
        }
    }
}

// ============================================================================
// PUBLIC CONVENIENCE FUNCTIONS
// ============================================================================

/// Format a value using a custom format string (convenience wrapper).
/// Returns FormatResult with display text and optional color.
pub fn format_custom_value(value: f64, format_str: &str) -> FormatResult {
    match parse_custom_format(format_str) {
        Ok(parsed) => apply_custom_format_number(value, &parsed),
        Err(_) => FormatResult {
            text: format_number(value, &NumberFormat::General),
            color: None,
        },
    }
}

/// Format a text value using a custom format string (convenience wrapper).
pub fn format_custom_text(text: &str, format_str: &str) -> FormatResult {
    match parse_custom_format(format_str) {
        Ok(parsed) => apply_custom_format_text(text, &parsed),
        Err(_) => FormatResult {
            text: text.to_string(),
            color: None,
        },
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // --- Parser tests ---

    #[test]
    fn test_parse_single_section() {
        let parsed = parse_custom_format("0.00").unwrap();
        assert!(parsed.negative.is_none());
        assert!(parsed.zero.is_none());
        assert!(parsed.text.is_none());
        assert!(parsed.positive.has_digits);
    }

    #[test]
    fn test_parse_two_sections() {
        let parsed = parse_custom_format("0.00;(0.00)").unwrap();
        assert!(parsed.negative.is_some());
        assert!(parsed.zero.is_none());
        assert!(parsed.text.is_none());
    }

    #[test]
    fn test_parse_three_sections() {
        let parsed = parse_custom_format("0.00;-0.00;\"Zero\"").unwrap();
        assert!(parsed.negative.is_some());
        assert!(parsed.zero.is_some());
        assert!(parsed.text.is_none());
    }

    #[test]
    fn test_parse_four_sections() {
        let parsed = parse_custom_format("0.00;-0.00;\"Zero\";@").unwrap();
        assert!(parsed.negative.is_some());
        assert!(parsed.zero.is_some());
        assert!(parsed.text.is_some());
    }

    #[test]
    fn test_parse_color_token() {
        let parsed = parse_custom_format("[Red]0.00").unwrap();
        assert_eq!(parsed.positive.color, Some(FormatColor::Red));
    }

    #[test]
    fn test_parse_condition_token() {
        let parsed = parse_custom_format("[>=100]0.00").unwrap();
        assert!(parsed.positive.condition.is_some());
        let cond = parsed.positive.condition.as_ref().unwrap();
        assert_eq!(cond.operator, ConditionOp::GreaterThanOrEqual);
        assert_eq!(cond.value, 100.0);
    }

    #[test]
    fn test_parse_quoted_literal() {
        let parsed = parse_custom_format("0.00\" USD\"").unwrap();
        let has_usd_literal = parsed.positive.tokens.iter().any(|t| {
            matches!(t, FormatToken::Literal(s) if s == " USD")
        });
        assert!(has_usd_literal);
    }

    #[test]
    fn test_parse_backslash_escape() {
        let parsed = parse_custom_format("0.00\\$").unwrap();
        let has_dollar = parsed.positive.tokens.iter().any(|t| {
            matches!(t, FormatToken::Literal(s) if s == "$")
        });
        assert!(has_dollar);
    }

    #[test]
    fn test_parse_hidden_format() {
        let parsed = parse_custom_format(";;;").unwrap();
        // All sections should be empty (hidden)
        assert!(parsed.positive.tokens.is_empty());
        assert!(parsed.negative.as_ref().unwrap().tokens.is_empty());
        assert!(parsed.zero.as_ref().unwrap().tokens.is_empty());
        assert!(parsed.text.as_ref().unwrap().tokens.is_empty());
    }

    #[test]
    fn test_parse_trailing_commas() {
        let parsed = parse_custom_format("0.0,,").unwrap();
        assert_eq!(parsed.positive.scale_divisor, 2);
    }

    #[test]
    fn test_parse_m_ambiguity_after_h() {
        let parsed = parse_custom_format("h:mm").unwrap();
        let has_minute = parsed
            .positive
            .tokens
            .iter()
            .any(|t| matches!(t, FormatToken::TimeMinute2));
        assert!(has_minute, "m after h should be minutes, not months");
    }

    #[test]
    fn test_parse_m_ambiguity_before_s() {
        let parsed = parse_custom_format("mm:ss").unwrap();
        let has_minute = parsed
            .positive
            .tokens
            .iter()
            .any(|t| matches!(t, FormatToken::TimeMinute2));
        assert!(has_minute, "m before s should be minutes, not months");
    }

    #[test]
    fn test_parse_m_as_month() {
        let parsed = parse_custom_format("yyyy-mm-dd").unwrap();
        let has_month = parsed
            .positive
            .tokens
            .iter()
            .any(|t| matches!(t, FormatToken::DateMonth2));
        assert!(has_month, "m near y/d should be months, not minutes");
    }

    #[test]
    fn test_parse_at_symbol() {
        let parsed = parse_custom_format(";;;@\" text\"").unwrap();
        let text_section = parsed.text.as_ref().unwrap();
        let has_at = text_section
            .tokens
            .iter()
            .any(|t| matches!(t, FormatToken::TextPlaceholder));
        assert!(has_at);
    }

    // --- Formatting tests ---

    #[test]
    fn test_digit_zero_placeholder() {
        let result = format_custom_value(5.0, "000");
        assert_eq!(result.text, "005");
    }

    #[test]
    fn test_digit_zero_with_decimal() {
        let result = format_custom_value(42.5, "000.00");
        assert_eq!(result.text, "042.50");
    }

    #[test]
    fn test_digit_hash_placeholder() {
        let result = format_custom_value(42.5, "#.##");
        assert_eq!(result.text, "42.5");
    }

    #[test]
    fn test_digit_hash_integer() {
        let result = format_custom_value(1234.0, "#");
        assert_eq!(result.text, "1234");
    }

    #[test]
    fn test_digit_space_placeholder() {
        let result = format_custom_value(5.0, "??0");
        assert_eq!(result.text, "  5");
    }

    #[test]
    fn test_thousands_separator() {
        let result = format_custom_value(1234.0, "#,##0");
        assert_eq!(result.text, "1,234");
    }

    #[test]
    fn test_thousands_separator_large() {
        let result = format_custom_value(1234567.0, "#,##0");
        assert_eq!(result.text, "1,234,567");
    }

    #[test]
    fn test_thousands_with_decimals() {
        let result = format_custom_value(1234.56, "#,##0.00");
        assert_eq!(result.text, "1,234.56");
    }

    #[test]
    fn test_percentage() {
        let result = format_custom_value(0.5, "0%");
        assert_eq!(result.text, "50%");
    }

    #[test]
    fn test_percentage_with_decimals() {
        let result = format_custom_value(0.1234, "0.00%");
        assert_eq!(result.text, "12.34%");
    }

    #[test]
    fn test_scaling_one_comma() {
        let result = format_custom_value(1500000.0, "0.0,");
        assert_eq!(result.text, "1500.0");
    }

    #[test]
    fn test_scaling_two_commas() {
        let result = format_custom_value(1500000.0, "0.0,,");
        assert_eq!(result.text, "1.5");
    }

    #[test]
    fn test_scaling_with_literal() {
        let result = format_custom_value(1500000.0, "0.0,,\" M\"");
        assert_eq!(result.text, "1.5 M");
    }

    #[test]
    fn test_positive_negative_sections() {
        let result_pos = format_custom_value(1234.0, "#,##0;(#,##0)");
        assert_eq!(result_pos.text, "1,234");

        let result_neg = format_custom_value(-1234.0, "#,##0;(#,##0)");
        assert_eq!(result_neg.text, "(1,234)");
    }

    #[test]
    fn test_zero_section() {
        let result = format_custom_value(0.0, "#,##0;-#,##0;\"Zero\"");
        assert_eq!(result.text, "Zero");
    }

    #[test]
    fn test_text_section() {
        let parsed = parse_custom_format("0.00;-0.00;\"Zero\";@\" text\"").unwrap();
        let result = apply_custom_format_text("hello", &parsed);
        assert_eq!(result.text, "hello text");
    }

    #[test]
    fn test_color_positive() {
        let result = format_custom_value(42.0, "[Green]0.00");
        assert_eq!(result.color, Some(FormatColor::Green));
        assert_eq!(result.text, "42.00");
    }

    #[test]
    fn test_color_negative() {
        let result = format_custom_value(-42.0, "0.00;[Red]-0.00");
        assert_eq!(result.color, Some(FormatColor::Red));
    }

    #[test]
    fn test_conditional_format() {
        let result_high = format_custom_value(150.0, "[>=100][Green]0;[Red]0");
        assert_eq!(result_high.color, Some(FormatColor::Green));
        assert_eq!(result_high.text, "150");

        let result_low = format_custom_value(50.0, "[>=100][Green]0;[Red]0");
        assert_eq!(result_low.color, Some(FormatColor::Red));
        assert_eq!(result_low.text, "50");
    }

    #[test]
    fn test_literal_text_prefix() {
        let result = format_custom_value(42.5, "\"Total: \"0.00");
        assert_eq!(result.text, "Total: 42.50");
    }

    #[test]
    fn test_literal_text_suffix() {
        let result = format_custom_value(1234.0, "$#,##0\" USD\"");
        assert_eq!(result.text, "$1,234 USD");
    }

    #[test]
    fn test_hidden_format() {
        let result = format_custom_value(42.0, ";;;");
        assert_eq!(result.text, "");
    }

    #[test]
    fn test_hidden_format_negative() {
        let result = format_custom_value(-42.0, ";;;");
        assert_eq!(result.text, "");
    }

    #[test]
    fn test_hidden_format_zero() {
        let result = format_custom_value(0.0, ";;;");
        assert_eq!(result.text, "");
    }

    #[test]
    fn test_scientific_notation() {
        let result = format_custom_value(1234.0, "0.00E+00");
        assert!(result.text.contains("E+"), "Expected scientific notation, got: {}", result.text);
    }

    #[test]
    fn test_negative_with_auto_sign() {
        // Single section format - negative should get auto minus
        let result = format_custom_value(-42.0, "0.00");
        assert_eq!(result.text, "-42.00");
    }

    #[test]
    fn test_negative_with_explicit_parens() {
        // Two section format - negative section has explicit parens
        let result = format_custom_value(-42.0, "0.00;(0.00)");
        assert_eq!(result.text, "(42.00)");
    }

    #[test]
    fn test_zero_as_positive() {
        // Two section format: zero uses positive section
        let result = format_custom_value(0.0, "#,##0;(#,##0)");
        assert_eq!(result.text, "0");
    }

    #[test]
    fn test_simple_integer() {
        let result = format_custom_value(42.0, "0");
        assert_eq!(result.text, "42");
    }

    #[test]
    fn test_large_number() {
        let result = format_custom_value(9999999.0, "#,##0");
        assert_eq!(result.text, "9,999,999");
    }

    #[test]
    fn test_small_decimal() {
        let result = format_custom_value(0.123, "0.000");
        assert_eq!(result.text, "0.123");
    }

    #[test]
    fn test_hash_suppresses_leading_zeros() {
        let result = format_custom_value(0.5, "#.00");
        // # suppresses the leading 0 before decimal
        assert_eq!(result.text, ".50");
    }

    #[test]
    fn test_zero_forces_leading_zeros() {
        let result = format_custom_value(0.5, "0.00");
        assert_eq!(result.text, "0.50");
    }

    #[test]
    fn test_space_width_token() {
        let result = format_custom_value(42.0, "0.00_)");
        assert!(result.text.contains(' '), "Expected trailing space");
    }

    #[test]
    fn test_currency_format() {
        let result = format_custom_value(1234.56, "$#,##0.00");
        assert_eq!(result.text, "$1,234.56");
    }

    #[test]
    fn test_empty_format_string() {
        let result = format_custom_value(42.0, "");
        assert_eq!(result.text, "");
    }

    #[test]
    fn test_text_only_format() {
        let parsed = parse_custom_format(";;;@").unwrap();
        let result = apply_custom_format_text("hello", &parsed);
        assert_eq!(result.text, "hello");
    }

    #[test]
    fn test_text_with_decoration() {
        let parsed = parse_custom_format(";;;\">> \"@\" <<\"").unwrap();
        let result = apply_custom_format_text("hello", &parsed);
        assert_eq!(result.text, ">> hello <<");
    }

    #[test]
    fn test_condition_with_color() {
        let fmt = "[>=100][Green]0;[<=50][Red]0;[Blue]0";
        let result_high = format_custom_value(150.0, fmt);
        assert_eq!(result_high.color, Some(FormatColor::Green));

        let result_low = format_custom_value(30.0, fmt);
        assert_eq!(result_low.color, Some(FormatColor::Red));

        let result_mid = format_custom_value(75.0, fmt);
        assert_eq!(result_mid.color, Some(FormatColor::Blue));
    }

    // --- Date/Time tests ---

    #[test]
    fn test_date_format_iso() {
        // Jan 15, 2024 = serial 45306
        let result = format_custom_value(45306.0, "yyyy-mm-dd");
        assert_eq!(result.text, "2024-01-15");
    }

    #[test]
    fn test_time_format() {
        // 0.5625 = 13:30:00
        let result = format_custom_value(0.5625, "hh:mm:ss");
        assert_eq!(result.text, "13:30:00");
    }

    #[test]
    fn test_time_format_12h() {
        // 0.5625 = 1:30 PM
        let result = format_custom_value(0.5625, "h:mm AM/PM");
        assert_eq!(result.text, "1:30 PM");
    }

    #[test]
    fn test_month_name_short() {
        let result = format_custom_value(45306.0, "dd-mmm-yyyy");
        assert_eq!(result.text, "15-Jan-2024");
    }

    #[test]
    fn test_month_name_full() {
        let result = format_custom_value(45306.0, "mmmm d, yyyy");
        assert_eq!(result.text, "January 15, 2024");
    }
}
