# VDB function

## Introduction
The VDB function returns the depreciation of an asset for any period you specify, including partial periods, using the double-declining balance method. It can optionally switch to straight-line depreciation when that yields a larger deduction.

## Syntax
```
=VDB(cost, salvage, life, start_period, end_period, [factor], [no_switch])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| cost | Required | The initial cost of the asset. |
| salvage | Required | The value at the end of the asset's useful life. |
| life | Required | The number of periods in the asset's useful life. |
| start_period | Required | The starting period (can be fractional). |
| end_period | Required | The ending period (can be fractional). |
| factor | Optional | The rate of depreciation. Default is 2 (double-declining balance). |
| no_switch | Optional | FALSE or omitted = switch to straight-line when beneficial, TRUE = never switch. |

## Remarks
- Supports fractional periods, unlike DDB which only handles whole periods.
- The depreciation returned is for the interval from start_period to end_period.
- When no_switch is FALSE, the function automatically switches to straight-line when it produces a larger depreciation.

## Example

| | A | B |
|---|---|---|
| 1 | **Period** | **Depreciation** |
| 2 | Year 1 | =VDB(10000, 1000, 5, 0, 1) |
| 3 | Year 1-3 | =VDB(10000, 1000, 5, 0, 3) |

**Result:** B2 = 4000 (first year), B3 = 7600 (cumulative years 1-3)
