# DB function

## Introduction

The DB function returns the depreciation of an asset for a specified period using the fixed-declining balance method. This is an accelerated depreciation method that applies a constant depreciation rate to the asset's declining book value each period, resulting in higher depreciation in earlier periods and lower depreciation in later periods.

Use DB when you want a depreciation method that front-loads the expense, which more closely reflects the way many assets (such as vehicles and technology equipment) actually lose value. This method is also used for tax purposes in some jurisdictions.

## Syntax

```
=DB(cost, salvage, life, period, [month])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| cost | Required | The initial cost of the asset. |
| salvage | Required | The value at the end of the depreciation period (residual value). |
| life | Required | The number of periods over which the asset is being depreciated (useful life). |
| period | Required | The period for which you want to calculate the depreciation. Period must use the same units as life. |
| month | Optional | The number of months in the first year. If omitted, 12 is assumed. Use this when the asset is placed in service partway through the year. |

### Remarks

- DB calculates a fixed depreciation rate using the formula: rate = 1 - ((salvage / cost) ^ (1 / life)), rounded to three decimal places.
- The depreciation for the first period accounts for the month argument (prorated if the asset was not in service for the full year).
- The depreciation for the last period may also be prorated to cover the remaining months.
- If cost is 0, DB returns 0. If salvage is greater than or equal to cost, DB returns 0.
- Period must be between 1 and life (or life + 1 if month < 12).

## Example

| | A | B |
|---|---|---|
| 1 | **Fixed-Declining Balance Depreciation** | |
| 2 | Cost | $50,000 |
| 3 | Salvage value | $5,000 |
| 4 | Useful life (years) | 5 |
| 5 | | |
| 6 | **Period** | **Depreciation** |
| 7 | =DB(B2, B3, B4, 1) | $18,950.00 |
| 8 | =DB(B2, B3, B4, 2) | $11,769.95 |
| 9 | =DB(B2, B3, B4, 3) | $7,309.34 |
| 10 | =DB(B2, B3, B4, 4) | $4,539.10 |
| 11 | =DB(B2, B3, B4, 5) | $2,819.68 |

**Result:** The depreciation expense decreases each year. Year 1 has the highest depreciation ($18,950) and Year 5 has the lowest ($2,820). The total depreciation over 5 years equals $45,388, which is approximately cost minus salvage ($50,000 - $5,000 = $45,000), with a small rounding difference.

### Example with partial first year

If the asset is placed in service in April (9 months remaining in the first year):

```
=DB(50000, 5000, 5, 1, 9)
```

**Result:** $14,212.50

The first-year depreciation is prorated for 9 months instead of 12. An additional period (year 6) will capture the remaining 3 months of depreciation.
