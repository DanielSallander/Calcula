# FV function

## Introduction

The FV function returns the future value of an investment based on periodic, constant payments and a constant interest rate. Future value is the value of a current asset or series of cash flows at a specified date in the future, based on an assumed growth rate.

Use FV to calculate how much your savings will grow over time, to project the value of regular investments, or to determine the balance of a loan at a future point. For example, if you invest $500 per month in a retirement account earning 7% annually, FV tells you how much you will have accumulated after 25 years.

## Syntax

```
=FV(rate, nper, pmt, [pv], [type])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| rate | Required | The interest rate per period. For monthly compounding at 8% annual, use 8%/12. |
| nper | Required | The total number of payment periods. |
| pmt | Required | The payment made each period. This value cannot change over the life of the investment. Enter as a negative number for deposits. |
| pv | Optional | The present value, or lump-sum amount, that a series of future payments is worth right now. If omitted, pv is assumed to be 0. |
| type | Optional | When payments are due. 0 or omitted = end of period. 1 = beginning of period. |

### Sign Conventions

- **Cash you pay out** (deposits, investments) should be entered as **negative** numbers.
- **Cash you receive** (withdrawals, loan proceeds) should be entered as **positive** numbers.

FV returns a positive number when the result represents money you will receive, and a negative number when it represents money you owe.

### Remarks

- Ensure that rate and nper use consistent time units.
- If pmt is for deposits into savings, it should be negative. If pv is an initial deposit, it should also be negative.

## Example

### Example 1: Retirement savings

You invest $500 per month into a retirement fund earning 7% annually for 25 years. How much will you have?

| | A | B |
|---|---|---|
| 1 | **Retirement Projection** | |
| 2 | Annual interest rate | 7% |
| 3 | Years | 25 |
| 4 | Monthly contribution | $500 |
| 5 | | |
| 6 | **Formula** | **Result** |
| 7 | =FV(B2/12, B3*12, -B4) | $405,528.25 |

**Result:** $405,528.25

After 25 years of investing $500 per month at 7% annually, your retirement fund will grow to approximately $405,528. The payment is entered as negative because it represents money you are depositing (cash outflow).

### Example 2: Lump sum with additional contributions

You deposit $10,000 today and add $200 per month for 15 years at 5% annual interest.

| | A | B |
|---|---|---|
| 1 | **Formula** | **Result** |
| 2 | =FV(5%/12, 15*12, -200, -10000) | $74,264.48 |

**Result:** $74,264.48

The initial $10,000 deposit plus $200 monthly contributions over 15 years at 5% grows to approximately $74,264. Both pv and pmt are negative because they represent money you pay into the account.
