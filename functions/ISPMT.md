# ISPMT function

## Introduction

The ISPMT function calculates the interest paid during a specific period of an investment or loan where the principal is repaid in equal installments. Unlike IPMT which works with standard annuity payments (equal total payments), ISPMT is designed for loans with equal principal payments where the interest portion decreases each period.

Use ISPMT when you have a loan with straight-line principal reduction (equal principal payments) and need to know the interest portion for a specific period.

## Syntax

```
=ISPMT(rate, per, nper, pv)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| rate | Required | The interest rate per period. |
| per | Required | The period for which you want the interest. Must be between 0 and nper. |
| nper | Required | The total number of payment periods. |
| pv | Required | The present value (principal amount of the loan). |

### Remarks

- Per is zero-based (0 = first period, nper-1 = last period).
- The function returns a negative number for loans (positive pv), representing interest paid.
- Unlike IPMT, ISPMT assumes equal principal repayment each period, so interest decreases linearly.

## Example

### Example 1: Interest in a specific period

| | A | B |
|---|---|---|
| 1 | **Interest Payment** | |
| 2 | Annual rate | 6% |
| 3 | Period | 1 |
| 4 | Total periods | 36 |
| 5 | Loan amount | $100,000 |
| 6 | | |
| 7 | **Formula** | **Result** |
| 8 | =ISPMT(B2/12, B3, B4, B5) | -$486.11 |

**Result:** -$486.11

In the second month (period 1, zero-based) of a $100,000 loan at 6% annual interest over 36 months with equal principal payments, the interest portion is $486.11. The value is negative because it represents money paid out.
