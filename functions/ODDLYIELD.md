# ODDLYIELD function

## Introduction

The ODDLYIELD function returns the yield of a security with an odd (short or long) last coupon period. It is the counterpart of ODDLPRICE, calculating the yield to maturity when the final coupon period is irregular.

Use ODDLYIELD to determine the yield on a bond that has an irregular last coupon period, given its market price.

## Syntax

```
=ODDLYIELD(settlement, maturity, last_interest, rate, pr, redemption, frequency, [basis])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| settlement | Required | The security's settlement date. |
| maturity | Required | The security's maturity date. |
| last_interest | Required | The security's last coupon date before maturity. |
| rate | Required | The security's annual coupon rate. |
| pr | Required | The security's price per $100 face value. |
| redemption | Required | The security's redemption value per $100 face value. |
| frequency | Required | The number of coupon payments per year. 1 = annual, 2 = semi-annual, 4 = quarterly. |
| basis | Optional | The day count basis to use. 0 or omitted = US (NASD) 30/360, 1 = Actual/actual, 2 = Actual/360, 3 = Actual/365, 4 = European 30/360. |

### Remarks

- Dates must be in chronological order: last_interest < settlement < maturity.
- Rate must be >= 0. Pr and redemption must be > 0.
- Frequency must be 1, 2, or 4.
- If basis < 0 or basis > 4, ODDLYIELD returns a #NUM! error.

## Example

### Example 1: Yield on a bond with an odd last period

| | A | B |
|---|---|---|
| 1 | **Odd Last Period Yield** | |
| 2 | Settlement date | 5/1/2034 |
| 3 | Maturity date | 8/15/2034 |
| 4 | Last coupon date | 3/15/2034 |
| 5 | Coupon rate | 5.00% |
| 6 | Price | $99.86 |
| 7 | Redemption | 100 |
| 8 | Frequency | 2 |
| 9 | Basis | 0 |
| 10 | | |
| 11 | **Formula** | **Result** |
| 12 | =ODDLYIELD(B2, B3, B4, B5, B6, B7, B8, B9) | 5.50% |

**Result:** 5.50%

The bond with an odd last coupon period, priced at $99.86, yields 5.50% to maturity. The irregular final period is accounted for in the yield calculation.
