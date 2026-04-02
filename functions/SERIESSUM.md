# SERIESSUM function

## Introduction
The SERIESSUM function returns the sum of a power series based on the formula: SERIESSUM = coefficient_1 * x^n + coefficient_2 * x^(n+m) + coefficient_3 * x^(n+2m) + ... Many mathematical functions can be approximated by a power series expansion.

## Syntax
```
=SERIESSUM(x, n, m, coefficients)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The input value to the power series. |
| n | Required | The initial power to which **x** is raised. |
| m | Required | The step by which to increment **n** for each term in the series. |
| coefficients | Required | A set of coefficients by which each successive power of **x** is multiplied. The number of values in **coefficients** determines the number of terms in the power series. |

## Remarks
- If any argument is non-numeric, SERIESSUM returns a #VALUE! error.
- The series is: coefficients[1]*x^n + coefficients[2]*x^(n+m) + coefficients[3]*x^(n+2m) + ...

## Example

| | A | B | C | D |
|---|---|---|---|---|
| 1 | **Coeff 1** | **Coeff 2** | **Coeff 3** | **Coeff 4** |
| 2 | 1 | -1/2 | 1/24 | -1/720 |

Formula: =SERIESSUM(PI()/4, 0, 2, A2:D2)

**Result:** 0.707103 (approximately)

This approximates cos(PI/4) using the first four terms of the Taylor series expansion for cosine: 1 - x^2/2! + x^4/4! - x^6/6!.
