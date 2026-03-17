# ABS function

## Introduction
The ABS function returns the absolute value of a number -- that is, the number without its sign. It converts negative numbers to positive while leaving positive numbers and zero unchanged. ABS is commonly used in financial calculations to determine the magnitude of variances, in distance computations, and whenever you need to ignore the direction of a value.

## Syntax
```
=ABS(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The number whose absolute value you want. |

## Remarks
- If **number** is not numeric, ABS returns a #VALUE! error.
- ABS(0) returns 0.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Budget** | **Actual** | **Variance** |
| 2 | 50000 | 47500 | =ABS(A2-B2) |

**Result:** 2500

The formula calculates the absolute difference between the budget and actual figures, showing the magnitude of the variance regardless of whether spending was over or under budget.
