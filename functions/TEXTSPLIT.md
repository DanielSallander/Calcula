# TEXTSPLIT function

## Introduction
The TEXTSPLIT function splits a text string into an array of substrings using specified column and row delimiters. It is the inverse of TEXTJOIN and is useful for parsing structured text data like CSV values or delimited lists into individual cells.

## Syntax
```
=TEXTSPLIT(text, col_delimiter, [row_delimiter], [ignore_empty], [match_mode], [pad_with])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | The text string to split. |
| col_delimiter | Required | The delimiter to split columns. Use an array for multiple delimiters. |
| row_delimiter | Optional | The delimiter to split rows. Use an array for multiple delimiters. |
| ignore_empty | Optional | TRUE to ignore consecutive delimiters. Default is FALSE. |
| match_mode | Optional | 0 = case-sensitive (default), 1 = case-insensitive. |
| pad_with | Optional | Value to use for padding. Default is #N/A. |

## Remarks
- Returns a spilled array of values.
- If row_delimiter is omitted, the result is a single-row array.
- When both col_delimiter and row_delimiter are provided, the result is a 2D array.
- Empty strings between consecutive delimiters produce empty cells unless ignore_empty is TRUE.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Data** | | |
| 2 | Jan,Feb,Mar | =TEXTSPLIT(A2, ",") | |

**Result:** B2 = "Jan", C2 = "Feb", D2 = "Mar" (spills across columns)
