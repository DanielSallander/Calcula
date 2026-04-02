# ERF function

## Introduction
The ERF function returns the error function integrated between a lower limit and an upper limit. The error function is used in probability, statistics, and partial differential equations. It is defined as (2/sqrt(pi)) * integral from lower_limit to upper_limit of e^(-t^2) dt.

## Syntax
```
=ERF(lower_limit, [upper_limit])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| lower_limit | Required | The lower bound for integrating ERF. |
| upper_limit | Optional | The upper bound for integrating ERF. If omitted, ERF integrates from 0 to **lower_limit**. |

## Remarks
- If either argument is non-numeric, ERF returns a #VALUE! error.
- When **upper_limit** is omitted, the function returns erf(lower_limit) = (2/sqrt(pi)) * integral from 0 to lower_limit of e^(-t^2) dt.
- When **upper_limit** is provided, the result is erf(upper_limit) - erf(lower_limit).

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **ERF** |
| 2 | 1 | =ERF(A2) |

**Result:** 0.842701 (approximately)

The formula returns the error function integrated from 0 to 1.
