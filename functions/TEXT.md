# TEXT function

## Introduction

The TEXT function converts a numeric value to text using a specified number format. This allows you to control exactly how numbers, dates, and times are displayed within text strings. The result is a text value, not a number, so it cannot be used directly in calculations.

TEXT is essential when you need to embed formatted numbers in text strings, such as building sentences that include currency amounts, displaying dates in specific formats, padding numbers with leading zeros, or creating labels that combine text with formatted values. It is one of the most versatile formatting functions available.

## Syntax

```
=TEXT(value, format_text)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value | Required | The numeric value to format. Can be a number, date, or cell reference. |
| format_text | Required | The number format string to apply, enclosed in quotation marks. Uses the same format codes as cell number formatting. |

## Common Format Codes

| Format Code | Description | Example |
|-------------|-------------|---------|
| `0` | Digit placeholder (displays zeros) | `TEXT(5, "000")` = "005" |
| `#` | Digit placeholder (no leading zeros) | `TEXT(5, "###")` = "5" |
| `0.00` | Two decimal places | `TEXT(3.1, "0.00")` = "3.10" |
| `#,##0` | Thousands separator | `TEXT(1234, "#,##0")` = "1,234" |
| `$#,##0.00` | Currency format | `TEXT(1234, "$#,##0.00")` = "$1,234.00" |
| `0%` | Percentage | `TEXT(0.25, "0%")` = "25%" |
| `yyyy-mm-dd` | Date format | `TEXT(45000, "yyyy-mm-dd")` = "2023-03-14" |
| `hh:mm:ss` | Time format | `TEXT(0.75, "hh:mm:ss")` = "18:00:00" |

## Remarks

- The result of TEXT is always a text string, even if it looks like a number.
- format_text must be a valid number format string. Invalid formats may produce unexpected results.
- Since TEXT returns text, you cannot perform arithmetic on the result. Use VALUE to convert it back if needed.

## Example

| | A | B |
|---|---|---|
| 1 | **Amount** | **Formatted** |
| 2 | 1234567.8 | =TEXT(A2, "$#,##0.00") |
| 3 | 0.156 | =TEXT(A3, "0.0%") |
| 4 | | ="Invoice dated " & TEXT(TODAY(), "mmmm d, yyyy") |

**Result:** Cell B2 returns **"$1,234,567.80"**, cell B3 returns **"15.6%"**, and cell B4 returns something like **"Invoice dated March 16, 2026"**.

The TEXT function formats each value according to the specified format string, converting it to a displayable text representation.
