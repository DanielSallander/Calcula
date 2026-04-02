# ACCRINTM function

## Introduction

The ACCRINTM function returns the accrued interest for a security that pays interest at maturity. Unlike ACCRINT which is for periodic coupon-paying securities, ACCRINTM is used for zero-coupon or discount securities where all interest is paid at the maturity date.

Use ACCRINTM to calculate accrued interest on Treasury bills, commercial paper, or other discount instruments that pay interest only at maturity.

## Syntax

```
=ACCRINTM(issue, settlement, rate, par, [basis])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| issue | Required | The security's issue date. |
| settlement | Required | The security's maturity date. |
| rate | Required | The security's annual coupon rate. |
| par | Required | The security's par (face) value. If omitted, par is assumed to be $1,000. |
| basis | Optional | The day count basis to use. 0 or omitted = US (NASD) 30/360, 1 = Actual/actual, 2 = Actual/360, 3 = Actual/365, 4 = European 30/360. |

### Remarks

- Dates should be entered as serial date numbers or references to cells containing dates.
- Rate and par must be positive numbers.
- If issue >= settlement, ACCRINTM returns a #NUM! error.
- If rate <= 0 or par <= 0, ACCRINTM returns a #NUM! error.
- If basis < 0 or basis > 4, ACCRINTM returns a #NUM! error.

## Example

### Example 1: Interest at maturity

Calculate the accrued interest on a security issued April 1, 2024 maturing on October 1, 2024.

| | A | B |
|---|---|---|
| 1 | **Interest at Maturity** | |
| 2 | Issue date | 4/1/2024 |
| 3 | Maturity date | 10/1/2024 |
| 4 | Annual rate | 5% |
| 5 | Par value | $1,000 |
| 6 | Basis | 0 |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =ACCRINTM(B2, B3, B4, B5, B6) | $25.00 |

**Result:** $25.00

The security accrues $25.00 in interest from the issue date to the maturity date, based on a 5% annual rate on a $1,000 par value over 6 months using the 30/360 day count convention.
