# PDURATION function

## Introduction

The PDURATION function returns the number of periods required for an investment to reach a specified value, given a constant interest rate per period. It calculates the time needed for a present value to grow to a future value through compound interest.

Use PDURATION to determine how long it will take for an investment to reach a target amount at a given growth rate.

## Syntax

```
=PDURATION(rate, pv, fv)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| rate | Required | The interest rate per period. |
| pv | Required | The present value of the investment. |
| fv | Required | The desired future value of the investment. |

### Remarks

- Rate must be > 0.
- Pv and fv must be > 0.
- If any argument is <= 0, PDURATION returns a #NUM! error.
- PDURATION uses the formula: log(fv/pv) / log(1+rate).

## Example

### Example 1: Years to double an investment

| | A | B |
|---|---|---|
| 1 | **Time to Reach Target** | |
| 2 | Annual rate | 6% |
| 3 | Present value | $10,000 |
| 4 | Future value | $20,000 |
| 5 | | |
| 6 | **Formula** | **Result** |
| 7 | =PDURATION(B2, B3, B4) | 11.90 |

**Result:** 11.90 years

It takes approximately 11.9 years for $10,000 to double to $20,000 at a 6% annual interest rate. This is consistent with the "Rule of 72" approximation (72/6 = 12 years).

### Example 2: Monthly compounding

| | A | B |
|---|---|---|
| 1 | **Formula** | **Result** |
| 2 | =PDURATION(8%/12, 5000, 15000) | 165.35 |

**Result:** 165.35 months (approximately 13.8 years)

At 8% annual interest compounded monthly, it takes about 165 months for $5,000 to grow to $15,000.
