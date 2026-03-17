# ISFORMULA function

## Introduction

The ISFORMULA function checks whether a cell contains a formula and returns TRUE or FALSE. It examines the cell itself, not the result of the cell, so it returns TRUE regardless of what the formula evaluates to.

Use ISFORMULA to audit worksheets, identify which cells contain formulas versus hard-coded values, or build conditional formatting rules that visually distinguish formula cells from data cells. This is particularly useful for spreadsheet review and validation workflows.

## Syntax

```
=ISFORMULA(reference)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| reference | Required | A reference to the cell you want to test. |

## Remarks

- ISFORMULA returns TRUE if the referenced cell contains any formula, even if the formula results in an error.
- Blank cells and cells with constant values (numbers, text, logical values) return FALSE.
- If reference is not a valid cell reference, ISFORMULA returns a #VALUE! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Cell Content** | **Has Formula?** |
| 2 | =1+1 | =ISFORMULA(A2) |
| 3 | 100 | =ISFORMULA(A3) |
| 4 | Hello | =ISFORMULA(A4) |

**Result (B2):** TRUE (A2 contains a formula)
**Result (B3):** FALSE (A3 contains a constant number)
**Result (B4):** FALSE (A4 contains constant text)
