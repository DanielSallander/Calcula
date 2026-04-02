# ODDFPRICE function

## Introduction

The ODDFPRICE function returns the price per $100 face value of a security with an odd (short or long) first period. When a bond's first coupon period is different from the regular period length, standard pricing formulas do not apply. ODDFPRICE handles this irregular first period correctly.

Use ODDFPRICE when pricing bonds that have a short or long first coupon period, which is common for newly issued securities.

## Syntax

```
=ODDFPRICE(settlement, maturity, issue, first_coupon, rate, yld, redemption, frequency, [basis])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| settlement | Required | The security's settlement date. |
| maturity | Required | The security's maturity date. |
| issue | Required | The security's issue date. |
| first_coupon | Required | The security's first coupon date. |
| rate | Required | The security's annual coupon rate. |
| yld | Required | The security's annual yield. |
| redemption | Required | The security's redemption value per $100 face value. |
| frequency | Required | The number of coupon payments per year. 1 = annual, 2 = semi-annual, 4 = quarterly. |
| basis | Optional | The day count basis to use. 0 or omitted = US (NASD) 30/360, 1 = Actual/actual, 2 = Actual/360, 3 = Actual/365, 4 = European 30/360. |

### Remarks

- Dates must be in chronological order: issue <= settlement < first_coupon <= maturity.
- Rate and yld must be >= 0. Redemption must be > 0.
- Frequency must be 1, 2, or 4.
- If basis < 0 or basis > 4, ODDFPRICE returns a #NUM! error.

## Example

### Example 1: Bond with a short first coupon period

| | A | B |
|---|---|---|
| 1 | **Odd First Period Price** | |
| 2 | Settlement date | 2/15/2024 |
| 3 | Maturity date | 6/15/2034 |
| 4 | Issue date | 1/15/2024 |
| 5 | First coupon | 6/15/2024 |
| 6 | Coupon rate | 5.00% |
| 7 | Yield | 5.50% |
| 8 | Redemption | 100 |
| 9 | Frequency | 2 |
| 10 | Basis | 0 |
| 11 | | |
| 12 | **Formula** | **Result** |
| 13 | =ODDFPRICE(B2, B3, B4, B5, B6, B7, B8, B9, B10) | $96.21 |

**Result:** $96.21

The bond with an odd (short) first coupon period is priced at $96.21 per $100 face value. The short first period (from issue to first coupon is less than a full semi-annual period) affects the pricing calculation compared to a standard bond.
