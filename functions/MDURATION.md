# MDURATION function

## Introduction

The MDURATION function returns the modified Macaulay duration of a security with an assumed par value of $100. Modified duration measures the percentage change in a bond's price for a 1% change in yield. It is derived from Macaulay duration and is the most commonly used measure of interest rate sensitivity.

Use MDURATION to estimate how much a bond's price will change when interest rates move, or to compare the interest rate risk of different fixed-income securities.

## Syntax

```
=MDURATION(settlement, maturity, coupon, yld, frequency, [basis])
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
- If basis < 0 or basis > 4, MDURATION returns a #NUM! error.
- Modified duration = Macaulay duration / (1 + yld/frequency).
- A modified duration of 7 means the bond's price will change approximately 7% for every 1% change in yield.

## Example

### Example 1: Modified duration of a bond

| | A | B |
|---|---|---|
| 1 | **Modified Duration** | |
| 2 | Settlement date | 1/1/2024 |
| 3 | Maturity date | 1/1/2034 |
| 4 | Coupon rate | 5.00% |
| 5 | Yield | 5.00% |
| 6 | Frequency | 2 |
| 7 | Basis | 0 |
| 8 | | |
| 9 | **Formula** | **Result** |
| 10 | =MDURATION(B2, B3, B4, B5, B6, B7) | 7.80 |

**Result:** 7.80 years

The modified duration of 7.80 means that for every 1% increase in yield, the bond's price will decrease by approximately 7.80%, and vice versa. This is slightly less than the Macaulay duration because of the yield adjustment in the denominator.
