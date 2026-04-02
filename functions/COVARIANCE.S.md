# COVARIANCE.S function

## Introduction
The COVARIANCE.S function returns the sample covariance, which measures the degree to which two variables change together based on a sample. It uses n-1 (Bessel's correction) in the denominator to provide an unbiased estimate of the population covariance.

## Syntax
```
=COVARIANCE.S(array1, array2)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array1 | Required | The first range of sample values. |
| array2 | Required | The second range of sample values. |

## Remarks
- array1 and array2 must have the same number of data points; otherwise, returns #N/A.
- Requires at least 2 data points; otherwise, returns #DIV/0!.
- Text, logical values, and empty cells are ignored.
- COVARIANCE.S divides by n-1 (sample covariance). Use COVARIANCE.P for population covariance (divides by n).

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
| 8 | =COVARIANCE.S(A2:A5, B2:B5) | 7 |

**Result:** 7 (the sample covariance between X and Y)
