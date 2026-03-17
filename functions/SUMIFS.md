# SUMIFS function

## Introduction
The SUMIFS function sums values in a range that satisfy multiple conditions simultaneously. Unlike SUMIF, which supports only one condition, SUMIFS allows you to apply two or more criteria across different columns, making it ideal for multi-dimensional analysis such as summing sales for a specific product in a specific region, or totaling expenses within a date range and category.

SUMIFS uses AND logic, meaning all specified conditions must be met for a value to be included in the sum.

## Syntax
```
=SUMIFS(sum_range, criteria_range1, criteria1, [criteria_range2, criteria2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| sum_range | Required | The range of cells to sum. |
| criteria_range1 | Required | The first range to evaluate against its paired criteria. |
| criteria1 | Required | The condition applied to criteria_range1. |
| criteria_range2, criteria2, ... | Optional | Additional range/criteria pairs. Up to 127 pairs supported. |

### Criteria examples
- `">1000"` -- values greater than 1000.
- `"North"` -- text matching "North".
- `"<>"&""` -- non-blank cells.

## Remarks
- All criteria ranges must have the same number of rows and columns as **sum_range**.
- Criteria are case-insensitive for text.
- Wildcard characters (* and ?) are supported in text criteria.
- If no cells meet all the criteria, SUMIFS returns 0.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Region** | **Product** | **Revenue** |
| 2 | North | Widget | 5000 |
| 3 | South | Gadget | 7200 |
| 4 | North | Gadget | 3100 |
| 5 | South | Widget | 6400 |
| 6 | North | Widget | 4800 |

| | E | F |
|---|---|---|
| 1 | **North Widget Total** | =SUMIFS(C2:C6, A2:A6, "North", B2:B6, "Widget") |

**Result:** 9800

The formula sums revenue only where the region is "North" AND the product is "Widget" (rows 2 and 6: 5000 + 4800).
