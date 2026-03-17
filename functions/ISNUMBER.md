# ISNUMBER function

## Introduction

The ISNUMBER function checks whether a value is a number and returns TRUE or FALSE. It tests any value, cell reference, or expression and determines if the result is numeric.

Use ISNUMBER to validate data entry, build conditional logic that behaves differently for numeric versus non-numeric values, or verify that a lookup or calculation produced a valid number. It is commonly used inside IF statements and with SEARCH or FIND to check if a text string contains a specific substring.

## Syntax

```
=ISNUMBER(value)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value | Required | The value, cell reference, or expression to test. |

## Remarks

- Dates and times are stored as numbers internally, so ISNUMBER returns TRUE for cells formatted as dates or times.
- Text representations of numbers (e.g., "123") return FALSE because they are stored as text.
- Error values return FALSE.
- Blank cells return FALSE.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Is Number?** |
| 2 | 42 | =ISNUMBER(A2) |
| 3 | Hello | =ISNUMBER(A3) |
| 4 | TRUE | =ISNUMBER(A4) |
| 5 | | =ISNUMBER(A5) |

**Result (B2):** TRUE
**Result (B3):** FALSE
**Result (B4):** FALSE
**Result (B5):** FALSE

The function returns TRUE only for the numeric value 42. Text, logical values, and blank cells all return FALSE.
