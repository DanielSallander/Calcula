# ERF.PRECISE function

## Introduction
The ERF.PRECISE function returns the error function integrated between 0 and a specified limit. Unlike ERF, this function always integrates from 0 and accepts only one limit. It is defined as (2/sqrt(pi)) * integral from 0 to x of e^(-t^2) dt.

## Syntax
```
=ERF.PRECISE(x)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The upper bound for integrating the error function. |

## Remarks
- If **x** is non-numeric, ERF.PRECISE returns a #VALUE! error.
- If **x** is negative, the function returns a negative value (the error function is an odd function).
- ERF.PRECISE(x) is equivalent to ERF(0, x) or ERF(x) when ERF is called with one argument.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **ERF.PRECISE** |
| 2 | 1 | =ERF.PRECISE(A2) |

**Result:** 0.842701 (approximately)

The formula returns the error function integrated from 0 to 1, which is the same as ERF(1).
