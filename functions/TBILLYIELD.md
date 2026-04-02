# TBILLYIELD function

## Introduction

The TBILLYIELD function returns the yield for a Treasury bill. Given the price and dates, it calculates the discount rate at which the T-bill is trading.

Use TBILLYIELD to determine the discount yield on a Treasury bill when you know its market price.

## Syntax

```
=TBILLYIELD(settlement, maturity, pr)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| settlement | Required | The Treasury bill's settlement date. |
| maturity | Required | The Treasury bill's maturity date. Must be within one year of settlement. |
| pr | Required | The Treasury bill's price per $100 face value. |

### Remarks

- Settlement must be before maturity.
- Maturity cannot be more than one year after settlement.
- Pr must be > 0.
- If any argument is invalid, TBILLYIELD returns a #NUM! error.

## Example

### Example 1: Treasury bill yield

| | A | B |
|---|---|---|
| 1 | **T-Bill Yield** | |
| 2 | Settlement date | 3/15/2024 |
| 3 | Maturity date | 9/15/2024 |
| 4 | Price | $97.32 |
| 5 | | |
| 6 | **Formula** | **Result** |
| 7 | =TBILLYIELD(B2, B3, B4) | 5.25% |

**Result:** 5.25%

The Treasury bill priced at $97.32 per $100 face value with approximately 184 days to maturity has a discount yield of 5.25%. This is the annualized return based on the 360-day year convention used for T-bill discount rates.
