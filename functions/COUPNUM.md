# COUPNUM function

## Introduction

The COUPNUM function returns the number of coupon payments remaining between the settlement date and the maturity date. Any fractional coupon period is rounded up to the next whole coupon.

Use COUPNUM to determine how many coupon payments a bondholder will receive from the settlement date through maturity.

## Syntax

```
=COUPNUM(settlement, maturity, frequency, [basis])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| settlement | Required | The security's settlement date. |
| maturity | Required | The security's maturity date. |
| frequency | Required | The number of coupon payments per year. 1 = annual, 2 = semi-annual, 4 = quarterly. |
| basis | Optional | The day count basis to use. 0 or omitted = US (NASD) 30/360, 1 = Actual/actual, 2 = Actual/360, 3 = Actual/365, 4 = European 30/360. |

### Remarks

- Settlement must be before maturity.
- Frequency must be 1, 2, or 4.
- If basis < 0 or basis > 4, COUPNUM returns a #NUM! error.
- The result is always rounded up to the nearest whole number.

## Example

### Example 1: Number of remaining coupons

| | A | B |
|---|---|---|
| 1 | **Remaining Coupons** | |
| 2 | Settlement date | 4/15/2024 |
| 3 | Maturity date | 11/15/2030 |
| 4 | Frequency | 2 |
| 5 | Basis | 0 |
| 6 | | |
| 7 | **Formula** | **Result** |
| 8 | =COUPNUM(B2, B3, B4, B5) | 13 |

**Result:** 13

There are 13 remaining coupon payments between the settlement date and maturity. The bond pays semi-annually, and the remaining period of approximately 6.5 years yields 13 coupon payments.
