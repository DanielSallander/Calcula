# TYPE function

## Introduction

The TYPE function returns a numeric code indicating the data type of a value. Each data type is assigned a specific number, allowing you to programmatically determine what kind of data a cell contains.

Use TYPE when you need to branch logic based on the kind of data in a cell, or when debugging formulas to understand what type of value an expression produces. It is more granular than using individual IS functions, as it distinguishes between numbers, text, logical values, errors, and arrays in a single call.

## Syntax

```
=TYPE(value)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value | Required | The value, cell reference, or expression whose type you want to determine. |

### Return values

| Code | Data Type |
|------|-----------|
| 1 | Number |
| 2 | Text |
| 4 | Logical (TRUE or FALSE) |
| 16 | Error |
| 64 | Array |

## Remarks

- TYPE does not distinguish between different numeric types (integers, decimals, dates, times all return 1).
- Dates and times are stored as numbers, so TYPE returns 1 for date/time values.
- TYPE returns 16 for any error type (#N/A, #VALUE!, #REF!, etc.).
- If value is a range that resolves to a single cell, TYPE returns the type of that cell's value.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Type Code** |
| 2 | 42 | =TYPE(A2) |
| 3 | Hello | =TYPE(A3) |
| 4 | TRUE | =TYPE(A4) |
| 5 | #N/A | =TYPE(A5) |

**Result (B2):** 1 (Number)
**Result (B3):** 2 (Text)
**Result (B4):** 4 (Logical)
**Result (B5):** 16 (Error)
