# SLN function

## Introduction

The SLN function returns the straight-line depreciation of an asset for one period. Straight-line depreciation is the simplest and most commonly used depreciation method. It allocates an equal amount of depreciation expense to each period of the asset's useful life.

Use SLN when you need to calculate annual depreciation for accounting, tax planning, or financial projections. For example, if your company purchases equipment for $50,000 with a 10-year useful life and a salvage value of $5,000, SLN calculates the annual depreciation expense.

## Syntax

```
=SLN(cost, salvage, life)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| cost | Required | The initial cost of the asset. |
| salvage | Required | The value at the end of the depreciation period (sometimes called the residual or scrap value). |
| life | Required | The number of periods over which the asset is depreciated (the useful life of the asset). |

### Remarks

- The formula used is: SLN = (cost - salvage) / life
- All arguments must be positive numbers.
- Life must not be zero; otherwise a division-by-zero error occurs.
- SLN returns the same depreciation amount for every period.

## Example

| | A | B |
|---|---|---|
| 1 | **Asset Depreciation** | |
| 2 | Purchase cost | $120,000 |
| 3 | Salvage value | $15,000 |
| 4 | Useful life (years) | 7 |
| 5 | | |
| 6 | **Formula** | **Result** |
| 7 | =SLN(B2, B3, B4) | $15,000 |

**Result:** $15,000

The annual straight-line depreciation expense is $15,000. This is calculated as ($120,000 - $15,000) / 7 = $15,000 per year. The same amount is recorded as a depreciation expense each year for 7 years.
