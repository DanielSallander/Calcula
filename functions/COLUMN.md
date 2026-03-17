# COLUMN function

## Introduction

The COLUMN function returns the column number of a cell reference. When called without an argument, it returns the column number of the cell in which the formula appears.

Use COLUMN to determine the position of a cell within a worksheet, generate sequential column numbers, or create formulas that adapt based on their horizontal position. It is often used with INDEX, CHOOSE, and other functions that require a column number as input.

## Syntax

```
=COLUMN([cell_ref])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| cell_ref | Optional | The cell or range whose column number you want. If omitted, returns the column number of the cell containing the formula. |

## Remarks

- If cell_ref is a range, COLUMN returns the column number of the first cell in the range.
- Column A is 1, column B is 2, and so on.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Data** | **Data** | **Column Number** |
| 2 | X | Y | =COLUMN(A2) |
| 3 | | | =COLUMN(B2) |
| 4 | | | =COLUMN() |

**Result (C2):** 1
**Result (C3):** 2
**Result (C4):** 3

COLUMN(A2) returns 1 (column A), COLUMN(B2) returns 2 (column B), and COLUMN() in cell C4 returns 3 (column C, where the formula resides).
