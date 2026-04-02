# COUPNCD function

## Introduction

The COUPNCD function returns the next coupon date after the settlement date, as a serial date number. This is the date of the next interest payment the bondholder will receive.

Use COUPNCD to determine when the next coupon payment will occur for cash flow planning or bond settlement calculations.

## Syntax

```
=COUPNCD(settlement, maturity, frequency, [basis])
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
- If basis < 0 or basis > 4, COUPNCD returns a #NUM! error.
- The result is a serial date number. Format the cell as a date to display it properly.

## Example

### Example 1: Next coupon date

| | A | B |
|---|---|---|
| 1 | **Next Coupon Date** | |
| 2 | Settlement date | 4/15/2024 |
| 3 | Maturity date | 11/15/2030 |
| 4 | Frequency | 2 |
| 5 | Basis | 0 |
| 6 | | |
| 7 | **Formula** | **Result** |
| 8 | =COUPNCD(B2, B3, B4, B5) | 5/15/2024 |

**Result:** 5/15/2024

The next coupon payment date after the April 15, 2024 settlement is May 15, 2024. The bond pays semi-annually on May 15 and November 15, and the settlement falls just one month before the next payment.
