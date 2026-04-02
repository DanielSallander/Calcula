# PRICE function

## Introduction

The PRICE function returns the price per $100 face value of a security that pays periodic interest. This is the clean price (excluding accrued interest) of a bond based on its yield to maturity.

Use PRICE to determine what you should pay for a bond given a desired yield, or to compare the theoretical price of a bond against its market price.

## Syntax

```
=PRICE(settlement, maturity, rate, yld, redemption, frequency, [basis])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| settlement | Required | The security's settlement date (the date the buyer acquires the bond). |
| maturity | Required | The security's maturity date (the date the bond expires). |
| rate | Required | The security's annual coupon rate. |
| yld | Required | The security's annual yield to maturity. |
| redemption | Required | The security's redemption value per $100 face value. |
| frequency | Required | The number of coupon payments per year. 1 = annual, 2 = semi-annual, 4 = quarterly. |
| basis | Optional | The day count basis to use. 0 or omitted = US (NASD) 30/360, 1 = Actual/actual, 2 = Actual/360, 3 = Actual/365, 4 = European 30/360. |

### Remarks

- Settlement must be before maturity.
- Rate and yld must be >= 0.
- Redemption must be > 0.
- Frequency must be 1, 2, or 4.
- If basis < 0 or basis > 4, PRICE returns a #NUM! error.
- The price returned is the clean price (does not include accrued interest).

## Example

### Example 1: Bond pricing

Calculate the clean price of a semi-annual bond.

| | A | B |
|---|---|---|
| 1 | **Bond Price** | |
| 2 | Settlement date | 2/15/2024 |
| 3 | Maturity date | 11/15/2032 |
| 4 | Coupon rate | 5.75% |
| 5 | Yield | 6.50% |
| 6 | Redemption | 100 |
| 7 | Frequency | 2 |
| 8 | Basis | 0 |
| 9 | | |
| 10 | **Formula** | **Result** |
| 11 | =PRICE(B2, B3, B4, B5, B6, B7, B8) | $95.07 |

**Result:** $95.07

The bond trades at a discount ($95.07 per $100 face value) because the yield (6.50%) is higher than the coupon rate (5.75%). When yields exceed the coupon rate, investors pay less than par to achieve the higher effective return.
