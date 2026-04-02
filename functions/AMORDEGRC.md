# AMORDEGRC function

## Introduction

The AMORDEGRC function returns the depreciation for each accounting period using a degressive (declining) depreciation coefficient. This function is primarily used in French accounting systems. It applies a depreciation coefficient that varies based on the asset's useful life.

Use AMORDEGRC for assets under French accounting rules where degressive depreciation is required.

## Syntax

```
=AMORDEGRC(cost, date_purchased, first_period, salvage, period, rate, [basis])
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
- If basis < 0 or basis > 4, AMORDEGRC returns a #NUM! error.
- The depreciation coefficient depends on the asset life: 1.0 for life of 3-4 years, 1.5 for 5-6 years, 2.0 for more than 6 years.
- This function applies rounding to the depreciation amount based on the asset's useful life.

## Example

### Example 1: Degressive depreciation (French method)

| | A | B |
|---|---|---|
| 1 | **Degressive Depreciation** | |
| 2 | Cost | $10,000 |
| 3 | Date purchased | 6/15/2024 |
| 4 | End of first period | 12/31/2024 |
| 5 | Salvage value | $1,000 |
| 6 | Period | 0 |
| 7 | Rate | 20% |
| 8 | Basis | 0 |
| 9 | | |
| 10 | **Formula** | **Result** |
| 11 | =AMORDEGRC(B2, B3, B4, B5, B6, B7, B8) | $1,092 |

**Result:** $1,092

The depreciation for the first period (period 0) is $1,092 using the French degressive method. The coefficient applied depends on the useful life implied by the depreciation rate.
