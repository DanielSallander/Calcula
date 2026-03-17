# ISBLANK function

## Introduction

The ISBLANK function checks whether a cell is empty and returns TRUE or FALSE. A cell is considered blank only if it contains absolutely nothing -- no value, no formula, and no empty string.

Use ISBLANK to detect empty cells before performing calculations, build conditional formatting rules, or validate that required fields have been filled in. It is commonly used in data entry forms and dashboards to highlight missing information.

## Syntax

```
=ISBLANK(value)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value | Required | The cell reference or value to test. |

## Remarks

- A cell containing an empty string ("") is NOT considered blank; ISBLANK returns FALSE.
- A cell containing a formula that returns an empty string is NOT blank.
- A cell containing a space character is NOT blank.
- Only truly empty cells return TRUE.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Is Blank?** |
| 2 | | =ISBLANK(A2) |
| 3 | 0 | =ISBLANK(A3) |
| 4 | Hello | =ISBLANK(A4) |

**Result (B2):** TRUE
**Result (B3):** FALSE
**Result (B4):** FALSE

Only the truly empty cell A2 returns TRUE. A cell containing 0 or text is not blank.
