# COVARIANCE.P function

## Introduction
The COVARIANCE.P function returns the population covariance, which measures the degree to which two variables change together. A positive covariance means the variables tend to move in the same direction; a negative covariance means they tend to move in opposite directions.

## Syntax
```
=COVARIANCE.P(array1, array2)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array1 | Required | The first range of integer values. |
| array2 | Required | The second range of integer values. |

## Remarks
- array1 and array2 must have the same number of data points; otherwise, returns #N/A.
- If either array is empty, returns #DIV/0!.
- Text, logical values, and empty cells are ignored.
- COVARIANCE.P divides by n (population covariance). Use COVARIANCE.S for sample covariance (divides by n-1).

## Example

| | A | B |
|---|---|---|
| 1 | **X** | **Y** |
| 2 | 3 | 9 |
| 3 | 5 | 11 |
| 4 | 7 | 14 |
| 5 | 9 | 16 |
| 6 | | |
| 7 | **Formula** | **Result** |
| 8 | =COVARIANCE.P(A2:A5, B2:B5) | 5.25 |

**Result:** 5.25 (the population covariance between X and Y)
