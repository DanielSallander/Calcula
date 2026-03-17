# ROW function

## Introduction

The ROW function returns the row number of a cell reference. When called without an argument, it returns the row number of the cell in which the formula appears.

Use ROW to generate sequential row numbers, create dynamic calculations that depend on a cell's position, or extract the row component from a reference. It is commonly used as a helper in array formulas and in combination with other functions like INDEX and INDIRECT.

## Syntax

```
=ROW([cell_ref])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| cell_ref | Optional | The cell or range whose row number you want. If omitted, returns the row number of the cell containing the formula. |

## Remarks

- If cell_ref is a range, ROW returns the row number of the first cell in the range.
- ROW is not volatile and only recalculates when its arguments change.

## Example

| | A | B |
|---|---|---|
| 1 | **Data** | **Row Number** |
| 2 | Alpha | =ROW() |
| 3 | Beta | =ROW() |
| 4 | Gamma | =ROW(A1) |

**Result (B2):** 2
**Result (B3):** 3
**Result (B4):** 1

In B2 and B3, ROW() returns the row of the cell containing the formula. In B4, ROW(A1) returns 1, the row number of cell A1.
