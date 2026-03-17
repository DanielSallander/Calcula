# CLEAN function

## Introduction

The CLEAN function removes all non-printable characters from a text string. Non-printable characters are those with ASCII codes 0 through 31, which can appear when importing data from external sources, databases, or other applications. These invisible characters can cause unexpected behavior in formulas, comparisons, and display.

CLEAN is an essential data cleaning tool, often used in combination with TRIM (which removes extra spaces). Together, they handle the most common text quality issues encountered when working with imported or pasted data. Note that CLEAN does not remove all invisible characters; certain Unicode non-printable characters (codes above 127) may not be affected.

## Syntax

```
=CLEAN(text)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | The text string from which to remove non-printable characters. |

## Remarks

- CLEAN removes characters with ASCII codes 0 through 31 (control characters).
- It does not remove non-breaking spaces (character 160) or other Unicode whitespace characters. Use SUBSTITUTE with CHAR(160) to handle non-breaking spaces.
- CLEAN is often combined with TRIM for thorough text cleaning: `=TRIM(CLEAN(A1))`.

## Example

| | A | B |
|---|---|---|
| 1 | **Raw Data** | **Cleaned** |
| 2 | (text with embedded control characters) | =CLEAN(A2) |

**Result:** Cell B2 returns the text from A2 with all non-printable control characters removed.

If cell A2 contains "Sales" followed by a line feed character (CHAR(10)) and "Report", the CLEAN function returns "SalesReport". To preserve spacing, you might use `=TRIM(CLEAN(SUBSTITUTE(A2, CHAR(10), " ")))` to replace line feeds with spaces first.
