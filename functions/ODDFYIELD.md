# ODDFYIELD function

## Introduction

The ODDFYIELD function returns the yield of a security with an odd (short or long) first period. It is the counterpart of ODDFPRICE, calculating the yield to maturity when the first coupon period is irregular.

Use ODDFYIELD to determine the yield on a bond that has an irregular first coupon period, given its market price.

## Syntax

```
=ODDFYIELD(settlement, maturity, issue, first_coupon, rate, pr, redemption, frequency, [basis])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| settlement | Required | The security's settlement date. |
| maturity | Required | The security's maturity date. |
| issue | Required | The security's issue date. |
| first_coupon | Required | The security's first coupon date. |
| rate | Required | The security's annual coupon rate. |
| pr | Required | The security's price per $100 face value. |
| redemption | Required | The security's redemption value per $100 face value. |
| frequency | Required | The number of coupon payments per year. 1 = annual, 2 = semi-annual, 4 = quarterly. |
| basis | Optional | The day count basis to use. 0 or omitted = US (NASD) 30/360, 1 = Actual/actual, 2 = Actual/360, 3 = Actual/365, 4 = European 30/360. |

### Remarks

- Dates must be in chronological order: issue <= settlement < first_coupon <= maturity.
- Rate must be >= 0. Pr and redemption must be > 0.
- Frequency must be 1, 2, or 4.
- If basis < 0 or basis > 4, ODDFYIELD returns a #NUM! error.
- ODDFYIELD is calculated through iteration and may return a #NUM! error if it cannot converge.

## Example

### Example 1: Yield on a bond with an odd first period

| | A | B |
|---|---|---|
| 1 | **Odd First Period Yield** | |
| 2 | Settlement date | 2/15/2024 |
| 3 | Maturity date | 6/15/2034 |
| 4 | Issue date | 1/15/2024 |
| 5 | First coupon | 6/15/2024 |
| 6 | Coupon rate | 5.00% |
| 7 | Price | $96.21 |
| 8 | Redemption | 100 |
| 9 | Frequency | 2 |
| 10 | Basis | 0 |
| 11 | | |
| 12 | **Formula** | **Result** |
| 13 | =ODDFYIELD(B2, B3, B4, B5, B6, B7, B8, B9, B10) | 5.50% |

**Result:** 5.50%

The bond with an odd first coupon period, priced at $96.21, yields 5.50% to maturity. The irregular first period is accounted for in the yield calculation.
