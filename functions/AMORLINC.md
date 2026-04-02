# AMORLINC function

## Introduction

The AMORLINC function returns the depreciation for each accounting period using a linear (straight-line) prorated method. This function is primarily used in French accounting systems and prorates the depreciation based on the date of purchase within the first period.

Use AMORLINC for assets under French accounting rules where straight-line depreciation with prorated first and last periods is required.

## Syntax

```
=AMORLINC(cost, date_purchased, first_period, salvage, period, rate, [basis])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| cost | Required | The cost of the asset. |
| date_purchased | Required | The date the asset was purchased. |
| first_period | Required | The date of the end of the first period. |
| salvage | Required | The salvage value at the end of the asset's life. |
| period | Required | The period for which to calculate depreciation (zero-based). |
| rate | Required | The rate of depreciation. |
| basis | Optional | The day count basis to use. 0 or omitted = US (NASD) 30/360, 1 = Actual/actual, 2 = Actual/360, 3 = Actual/365, 4 = European 30/360. |

### Remarks

- Cost must be >= 0. Salvage must be >= 0.
- Salvage must be less than cost.
- Period and rate must be >= 0.
- If basis < 0 or basis > 4, AMORLINC returns a #NUM! error.
- The first and last periods are prorated based on the purchase date. Full periods in between receive the standard annual depreciation amount.

## Example

### Example 1: Linear prorated depreciation (French method)

| | A | B |
|---|---|---|
| 1 | **Linear Depreciation** | |
| 2 | Cost | $10,000 |
| 3 | Date purchased | 6/15/2024 |
| 4 | End of first period | 12/31/2024 |
| 5 | Salvage value | $1,000 |
| 6 | Period | 0 |
| 7 | Rate | 20% |
| 8 | Basis | 0 |
| 9 | | |
| 10 | **Formula** | **Result** |
| 11 | =AMORLINC(B2, B3, B4, B5, B6, B7, B8) | $1,089 |

**Result:** $1,089

The depreciation for the first period (period 0) is $1,089, prorated because the asset was purchased in the middle of the year. A full year of depreciation would be $2,000 (20% of $10,000), but only the portion from June 15 to December 31 is applied.
