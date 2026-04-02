# ERFC function

## Introduction
The ERFC function returns the complementary error function, which equals 1 - ERF(x). The complementary error function is used in probability and statistics, particularly for calculating tail probabilities of the normal distribution. It is defined as (2/sqrt(pi)) * integral from x to infinity of e^(-t^2) dt.

## Syntax
```
=ERFC(x)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The lower bound for integrating the complementary error function. |

## Remarks
- If **x** is non-numeric, ERFC returns a #VALUE! error.
- ERFC(x) = 1 - ERF(x).

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **ERFC** |
| 2 | 1 | =ERFC(A2) |

**Result:** 0.157299 (approximately)

The formula returns the complementary error function at x = 1, which is 1 - ERF(1) = 1 - 0.842701 = 0.157299.
