# PV function

## Introduction

The PV function returns the present value of an investment -- the total amount that a series of future payments is worth right now. Present value is a fundamental concept in finance based on the time value of money: a dollar received today is worth more than a dollar received in the future.

Use PV to determine how much a series of future cash flows is worth today, to compare investment alternatives, or to calculate the lump sum equivalent of an annuity. For example, you might use PV to determine whether it is better to receive a lump sum today or a series of annual payments over 20 years.

## Syntax

```
=PV(rate, nper, pmt, [fv], [type])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| rate | Required | The interest rate per period. For monthly payments at 6% annual, use 6%/12. |
| nper | Required | The total number of payment periods. |
| pmt | Required | The payment made each period. This value cannot change over the life of the investment. Typically includes principal and interest but no other fees. |
| fv | Optional | The future value, or cash balance you want to attain after the last payment. If omitted, fv is assumed to be 0. |
| type | Optional | When payments are due. 0 or omitted = end of period. 1 = beginning of period. |

### Sign Conventions

- **Cash you pay out** (payments, deposits) should be entered as **negative** numbers.
- **Cash you receive** (income, withdrawals) should be entered as **positive** numbers.

For example, if you are making payments of $500/month, enter pmt as -500. PV will return a positive number, representing the current value of those outgoing payments.

### Remarks

- Ensure that rate and nper use the same time units (e.g., both monthly or both annual).
- PV and FV are complementary: PV calculates the value now, FV calculates the value in the future.

## Example

### Example 1: Present value of an annuity

A settlement offers you $2,000 per month for 5 years. What is this worth today if the discount rate is 6% annually?

| | A | B |
|---|---|---|
| 1 | **Settlement Valuation** | |
| 2 | Annual discount rate | 6% |
| 3 | Years | 5 |
| 4 | Monthly payment received | $2,000 |
| 5 | | |
| 6 | **Formula** | **Result** |
| 7 | =PV(B2/12, B3*12, -B4) | $103,451.18 |

**Result:** $103,451.18

The present value of receiving $2,000 per month for 5 years at a 6% annual rate is approximately $103,451.18. This means a lump sum of $103,451 today is financially equivalent to those monthly payments. The pmt is entered as negative because it represents cash flowing toward you.

### Example 2: How much can you borrow?

If you can afford payments of $1,500 per month for 20 years and the rate is 5% annually, how large a loan can you take?

| | A | B |
|---|---|---|
| 1 | **Formula** | **Result** |
| 2 | =PV(5%/12, 20*12, -1500) | $227,612.97 |

**Result:** $227,612.97

You can borrow approximately $227,613 with a $1,500 monthly payment over 20 years at 5% annual interest.
