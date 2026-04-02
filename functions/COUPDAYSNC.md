# COUPDAYSNC function

## Introduction

The COUPDAYSNC function returns the number of days from the settlement date to the next coupon date. This is the complement of COUPDAYBS within the current coupon period.

Use COUPDAYSNC to determine how long until the next coupon payment, which is useful for calculating the clean price of a bond or planning cash flows.

## Syntax

```
=COUPDAYSNC(settlement, maturity, frequency, [basis])
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
- If basis < 0 or basis > 4, COUPDAYSNC returns a #NUM! error.

## Example

### Example 1: Days from settlement to next coupon

| | A | B |
|---|---|---|
| 1 | **Days to Next Coupon** | |
| 2 | Settlement date | 4/15/2024 |
| 3 | Maturity date | 11/15/2030 |
| 4 | Frequency | 2 |
| 5 | Basis | 0 |
| 6 | | |
| 7 | **Formula** | **Result** |
| 8 | =COUPDAYSNC(B2, B3, B4, B5) | 30 |

**Result:** 30 days

There are 30 days from the settlement date (April 15, 2024) to the next coupon date (May 15, 2024). Combined with the COUPDAYBS result of 150, this equals the full 180-day coupon period.
