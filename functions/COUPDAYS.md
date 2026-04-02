# COUPDAYS function

## Introduction

The COUPDAYS function returns the number of days in the coupon period that contains the settlement date. This value is essential for accrued interest calculations, as it represents the total length of the current coupon period.

Use COUPDAYS to determine the length of the coupon period for bond pricing and accrued interest computations.

## Syntax

```
=COUPDAYS(settlement, maturity, frequency, [basis])
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
- If basis < 0 or basis > 4, COUPDAYS returns a #NUM! error.
- For 30/360 basis with semi-annual coupons, the result is always 180.

## Example

### Example 1: Days in the coupon period

| | A | B |
|---|---|---|
| 1 | **Coupon Period Length** | |
| 2 | Settlement date | 4/15/2024 |
| 3 | Maturity date | 11/15/2030 |
| 4 | Frequency | 2 |
| 5 | Basis | 0 |
| 6 | | |
| 7 | **Formula** | **Result** |
| 8 | =COUPDAYS(B2, B3, B4, B5) | 180 |

**Result:** 180 days

The coupon period containing the settlement date is 180 days long. With a semi-annual bond using 30/360 day count, each coupon period is exactly 180 days (6 months x 30 days).
