# ERFC.PRECISE function

## Introduction
The ERFC.PRECISE function returns the complementary error function, which equals 1 - ERF.PRECISE(x). This function provides the same result as ERFC and is included for compatibility. It is defined as (2/sqrt(pi)) * integral from x to infinity of e^(-t^2) dt.

## Syntax
```
=ERFC.PRECISE(x)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The lower bound for integrating the complementary error function. |

## Remarks
- If **x** is non-numeric, ERFC.PRECISE returns a #VALUE! error.
- ERFC.PRECISE(x) = 1 - ERF.PRECISE(x).
- This function is functionally identical to ERFC.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **ERFC.PRECISE** |
| 2 | 1 | =ERFC.PRECISE(A2) |

**Result:** 0.157299 (approximately)

The formula returns the complementary error function at x = 1.
