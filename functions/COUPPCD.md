# COUPPCD function

## Introduction

The COUPPCD function returns the previous coupon date before the settlement date, as a serial date number. This is the date of the most recent interest payment before the bond was acquired.

Use COUPPCD to determine when the last coupon was paid, which is essential for calculating accrued interest that the buyer must pay to the seller at settlement.

## Syntax

```
=COUPPCD(settlement, maturity, frequency, [basis])
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
- If basis < 0 or basis > 4, COUPPCD returns a #NUM! error.
- The result is a serial date number. Format the cell as a date to display it properly.

## Example

### Example 1: Previous coupon date

| | A | B |
|---|---|---|
| 1 | **Previous Coupon Date** | |
| 2 | Settlement date | 4/15/2024 |
| 3 | Maturity date | 11/15/2030 |
| 4 | Frequency | 2 |
| 5 | Basis | 0 |
| 6 | | |
| 7 | **Formula** | **Result** |
| 8 | =COUPPCD(B2, B3, B4, B5) | 11/15/2023 |

**Result:** 11/15/2023

The previous coupon date before the April 15, 2024 settlement was November 15, 2023. Interest has been accruing since this date, and the buyer must compensate the seller for the accrued interest from November 15, 2023 to April 15, 2024.
