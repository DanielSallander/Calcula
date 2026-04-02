# ODDLPRICE function

## Introduction

The ODDLPRICE function returns the price per $100 face value of a security with an odd (short or long) last coupon period. When a bond's final coupon period differs from the regular period length, standard pricing formulas do not apply. ODDLPRICE handles this irregular last period correctly.

Use ODDLPRICE when pricing bonds that have a short or long last coupon period before maturity.

## Syntax

```
=ODDLPRICE(settlement, maturity, last_interest, rate, yld, redemption, frequency, [basis])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| settlement | Required | The security's settlement date. |
| maturity | Required | The security's maturity date. |
| last_interest | Required | The security's last coupon date before maturity. |
| rate | Required | The security's annual coupon rate. |
| yld | Required | The security's annual yield. |
| redemption | Required | The security's redemption value per $100 face value. |
| frequency | Required | The number of coupon payments per year. 1 = annual, 2 = semi-annual, 4 = quarterly. |
| basis | Optional | The day count basis to use. 0 or omitted = US (NASD) 30/360, 1 = Actual/actual, 2 = Actual/360, 3 = Actual/365, 4 = European 30/360. |

### Remarks

- Dates must be in chronological order: last_interest < settlement < maturity.
- Rate and yld must be >= 0. Redemption must be > 0.
- Frequency must be 1, 2, or 4.
- If basis < 0 or basis > 4, ODDLPRICE returns a #NUM! error.

## Example

### Example 1: Bond with an odd last coupon period

| | A | B |
|---|---|---|
| 1 | **Odd Last Period Price** | |
| 2 | Settlement date | 5/1/2034 |
| 3 | Maturity date | 8/15/2034 |
| 4 | Last coupon date | 3/15/2034 |
| 5 | Coupon rate | 5.00% |
| 6 | Yield | 5.50% |
| 7 | Redemption | 100 |
| 8 | Frequency | 2 |
| 9 | Basis | 0 |
| 10 | | |
| 11 | **Formula** | **Result** |
| 12 | =ODDLPRICE(B2, B3, B4, B5, B6, B7, B8, B9) | $99.86 |

**Result:** $99.86

The bond with an odd last coupon period is priced at $99.86 per $100 face value. The irregular final period between the last coupon date and maturity is properly accounted for in the calculation.
