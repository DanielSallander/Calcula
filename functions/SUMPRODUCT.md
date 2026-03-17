# SUMPRODUCT function

## Introduction
The SUMPRODUCT function multiplies corresponding elements across two or more arrays and returns the sum of those products. It is extremely versatile and commonly used for weighted averages, conditional sums without helper columns, and matrix-style calculations.

In business contexts, SUMPRODUCT is frequently used to calculate total revenue from price and quantity columns, compute weighted scores, or perform multi-criteria lookups without needing SUMIFS.

## Syntax
```
=SUMPRODUCT(array1, [array2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array1 | Required | The first array or range whose elements you want to multiply and then sum. |
| array2, ... | Optional | Additional arrays or ranges. Each must have the same dimensions as array1. Up to 255 arrays. |

## Remarks
- All arrays must have the same dimensions; otherwise, SUMPRODUCT returns a #VALUE! error.
- Non-numeric entries in an array are treated as zero.
- If only one array is provided, SUMPRODUCT simply sums its elements.
- SUMPRODUCT does not require Ctrl+Shift+Enter (it is not an array formula).

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Item** | **Price** | **Quantity** |
| 2 | Laptop | 899 | 12 |
| 3 | Monitor | 349 | 25 |
| 4 | Keyboard | 79 | 50 |
| 5 | Mouse | 29 | 50 |
| 6 | **Total Revenue** | =SUMPRODUCT(B2:B5, C2:C5) | |

**Result:** 24063

The formula multiplies each item's price by its quantity (899x12 + 349x25 + 79x50 + 29x50) and sums the results to produce total revenue.
