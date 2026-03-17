# DDB function

## Introduction

The DDB function returns the depreciation of an asset for a specified period using the double-declining balance method or another specified factor. The double-declining balance method is an accelerated depreciation approach that depreciates assets more heavily in the earlier years of their useful life. It applies a multiple of the straight-line rate to the declining book value each period.

Use DDB for assets that lose value quickly in the early years, such as vehicles, computer equipment, or machinery. The "double" in double-declining balance refers to the default factor of 2, which is twice the straight-line rate. You can customize the factor to use other accelerated methods, such as 1.5 (150% declining balance).

## Syntax

```
=DDB(cost, salvage, life, period, [factor])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| cost | Required | The initial cost of the asset. |
| salvage | Required | The value at the end of the depreciation period (residual value). |
| life | Required | The number of periods over which the asset is being depreciated (useful life). |
| period | Required | The period for which you want to calculate depreciation. Must use the same units as life. |
| factor | Optional | The rate at which the balance declines. If omitted, 2 is assumed (double-declining balance). Use 1.5 for 150% declining balance, 3 for triple-declining, etc. |

### Remarks

- DDB uses the formula: depreciation = min(book_value * (factor / life), book_value - salvage). This ensures the book value never drops below the salvage value.
- All arguments must be positive numbers.
- DDB does not prorate the first or last period. If you need prorated first-year depreciation, consider using DB.
- If you want to switch to straight-line depreciation when it exceeds the declining balance amount (a common practice), you need to implement that logic manually.

## Example

### Example 1: Standard double-declining balance

| | A | B |
|---|---|---|
| 1 | **Double-Declining Balance Depreciation** | |
| 2 | Cost | $80,000 |
| 3 | Salvage value | $8,000 |
| 4 | Useful life (years) | 5 |
| 5 | | |
| 6 | **Year** | **Depreciation** |
| 7 | =DDB(B2, B3, B4, 1) | $32,000.00 |
| 8 | =DDB(B2, B3, B4, 2) | $19,200.00 |
| 9 | =DDB(B2, B3, B4, 3) | $11,520.00 |
| 10 | =DDB(B2, B3, B4, 4) | $6,912.00 |
| 11 | =DDB(B2, B3, B4, 5) | $2,368.00 |

**Result:** Depreciation is highest in Year 1 ($32,000) and decreases each year. The Year 5 depreciation is capped so the book value does not fall below the salvage value of $8,000.

### Example 2: Using a custom factor (150% declining balance)

```
=DDB(80000, 8000, 5, 1, 1.5)
```

**Result:** $24,000

With a factor of 1.5, the first-year depreciation is $24,000, which is less aggressive than the default double-declining rate but still accelerated compared to straight-line ($14,400/year).
