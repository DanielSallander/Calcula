# SYD function

## Introduction
The SYD function returns the sum-of-years-digits depreciation of an asset for a specified period. This accelerated depreciation method allocates more depreciation in earlier years and less in later years, reflecting how many assets lose value more quickly when new.

## Syntax
```
=SYD(cost, salvage, life, per)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| cost | Required | The initial cost of the asset. |
| salvage | Required | The value at the end of the asset's useful life. |
| life | Required | The number of periods in the asset's useful life. |
| per | Required | The period for which to calculate depreciation. Must be between 1 and life. |

## Remarks
- The formula is: (cost - salvage) * (life - per + 1) / (life * (life + 1) / 2).
- The sum of all periods' depreciation equals cost minus salvage.
- Returns #NUM! if salvage < 0, life <= 0, or per is outside the valid range.

## Example

| | A | B |
|---|---|---|
| 1 | **Year** | **Depreciation** |
| 2 | 1 | =SYD(30000, 5000, 5, 1) |
| 3 | 2 | =SYD(30000, 5000, 5, 2) |

**Result:** B2 = 8333.33 (year 1), B3 = 6666.67 (year 2)
