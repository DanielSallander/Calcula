# COUPDAYBS function

## Introduction

The COUPDAYBS function returns the number of days from the beginning of the coupon period to the settlement date. This is useful for calculating accrued interest and for understanding where a settlement date falls within a coupon period.

Use COUPDAYBS when you need to determine how many days of interest have accrued since the last coupon payment date.

## Syntax

```
=COUPDAYBS(settlement, maturity, frequency, [basis])
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
- If basis < 0 or basis > 4, COUPDAYBS returns a #NUM! error.

## Example

### Example 1: Days from coupon start to settlement

| | A | B |
|---|---|---|
| 1 | **Coupon Days (Beginning to Settlement)** | |
| 2 | Settlement date | 4/15/2024 |
| 3 | Maturity date | 11/15/2030 |
| 4 | Frequency | 2 |
| 5 | Basis | 0 |
| 6 | | |
| 7 | **Formula** | **Result** |
| 8 | =COUPDAYBS(B2, B3, B4, B5) | 150 |

**Result:** 150 days

There are 150 days from the beginning of the current coupon period (November 15, 2023) to the settlement date (April 15, 2024) using the 30/360 day count convention.
