# MONTH function

## Introduction

The MONTH function extracts the month from a date serial number and returns it as an integer between 1 (January) and 12 (December).

Use MONTH to isolate the month component from a date for grouping data by month, creating monthly summaries, or building date-based conditional logic. It is frequently used in pivot-style calculations, seasonal analysis, and financial reporting.

## Syntax

```
=MONTH(serial_number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| serial_number | Required | A date serial number, cell reference containing a date, or a text string that represents a date. |

## Remarks

- MONTH returns a value between 1 and 12.
- If serial_number is not a valid date, MONTH returns a #VALUE! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Date** | **Month** |
| 2 | 2025-08-20 | =MONTH(A2) |
| 3 | 2025-12-01 | =MONTH(A3) |

**Result (B2):** 8
**Result (B3):** 12
