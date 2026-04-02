# RRI function

## Introduction

The RRI function returns an equivalent interest rate for the growth of an investment over a specified number of periods. It calculates the compound annual growth rate (CAGR) or per-period growth rate needed to grow from a present value to a future value.

Use RRI to determine the rate of return on an investment when you know the starting value, ending value, and number of periods.

## Syntax

```
=RRI(nper, pv, fv)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| nper | Required | The number of periods for the investment. |
| pv | Required | The present value of the investment. |
| fv | Required | The future value of the investment. |

### Remarks

- Nper must be > 0.
- Pv must not be 0.
- RRI uses the formula: (fv/pv)^(1/nper) - 1.
- Unlike RATE, RRI does not consider periodic payments; it only works with lump-sum growth.

## Example

### Example 1: Calculate compound annual growth rate

| | A | B |
|---|---|---|
| 1 | **CAGR Calculation** | |
| 2 | Number of years | 10 |
| 3 | Starting value | $50,000 |
| 4 | Ending value | $85,000 |
| 5 | | |
| 6 | **Formula** | **Result** |
| 7 | =RRI(B2, B3, B4) | 5.45% |

**Result:** 5.45%

An investment that grew from $50,000 to $85,000 over 10 years achieved a compound annual growth rate of 5.45%. This is the constant annual rate that would produce the same total growth.

### Example 2: Quarterly growth rate

| | A | B |
|---|---|---|
| 1 | **Formula** | **Result** |
| 2 | =RRI(20, 1000, 1500) | 2.05% |

**Result:** 2.05% per quarter

Over 20 quarters (5 years), an investment grew from $1,000 to $1,500 at a rate of 2.05% per quarter.
