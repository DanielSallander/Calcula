# DURATION function

## Introduction

The DURATION function returns the Macaulay duration of a security with an assumed par value of $100. Duration measures the weighted average time until a bond's cash flows are received, expressed in years. It is a key measure of a bond's sensitivity to interest rate changes.

Use DURATION to assess interest rate risk, compare bonds with different maturities and coupon rates, or to construct immunized portfolios.

## Syntax

```
=DURATION(settlement, maturity, coupon, yld, frequency, [basis])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| settlement | Required | The security's settlement date. |
| maturity | Required | The security's maturity date. |
| coupon | Required | The security's annual coupon rate. |
| yld | Required | The security's annual yield. |
| frequency | Required | The number of coupon payments per year. 1 = annual, 2 = semi-annual, 4 = quarterly. |
| basis | Optional | The day count basis to use. 0 or omitted = US (NASD) 30/360, 1 = Actual/actual, 2 = Actual/360, 3 = Actual/365, 4 = European 30/360. |

### Remarks

- Settlement must be before maturity.
- Coupon and yld must be >= 0.
- Frequency must be 1, 2, or 4.
- If basis < 0 or basis > 4, DURATION returns a #NUM! error.
- Higher coupon rates result in shorter duration. Longer maturities result in longer duration.
- Duration is always less than or equal to the time to maturity (equal only for zero-coupon bonds).

## Example

### Example 1: Macaulay duration of a bond

| | A | B |
|---|---|---|
| 1 | **Bond Duration** | |
| 2 | Settlement date | 1/1/2024 |
| 3 | Maturity date | 1/1/2034 |
| 4 | Coupon rate | 5.00% |
| 5 | Yield | 5.00% |
| 6 | Frequency | 2 |
| 7 | Basis | 0 |
| 8 | | |
| 9 | **Formula** | **Result** |
| 10 | =DURATION(B2, B3, B4, B5, B6, B7) | 7.99 |

**Result:** 7.99 years

The bond has a Macaulay duration of approximately 8 years, meaning the weighted average time to receive cash flows is 8 years. Although the bond matures in 10 years, the periodic coupon payments reduce the effective time-weighted exposure.
