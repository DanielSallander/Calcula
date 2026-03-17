# PMT function

## Introduction

The PMT function calculates the periodic payment for a loan or investment based on constant payments and a constant interest rate. This is one of the most widely used financial functions, essential for loan amortization, mortgage planning, and savings goal calculations.

Use PMT to determine the monthly payment on a mortgage, the quarterly payment on a car loan, or the regular deposit needed to reach a savings target. The function accounts for both principal repayment and interest charges over the life of the loan.

## Syntax

```
=PMT(rate, nper, pv, [fv], [type])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| rate | Required | The interest rate per period. For example, for an annual rate of 6% with monthly payments, use 6%/12 = 0.005. |
| nper | Required | The total number of payment periods. For a 30-year mortgage with monthly payments, use 30*12 = 360. |
| pv | Required | The present value -- the total amount that a series of future payments is worth now. For a loan, this is the loan amount. |
| fv | Optional | The future value, or the cash balance you want to attain after the last payment. For a loan, this is typically 0 (default). For a savings plan, this is the target amount. |
| type | Optional | When payments are due. 0 or omitted = end of period (ordinary annuity). 1 = beginning of period (annuity due). |

### Sign Conventions

PMT follows standard financial sign conventions:

- **Cash you pay out** (deposits, loan payments) is represented as **negative** numbers.
- **Cash you receive** (loan proceeds, withdrawals) is represented as **positive** numbers.

For a loan: pv is positive (you receive the loan amount), and PMT returns a negative number (you pay out each period).

For a savings plan: fv is positive (you want to accumulate money), and PMT returns a negative number (you deposit each period).

### Remarks

- Make sure rate and nper use consistent time units. If you make monthly payments on a loan with an annual interest rate of 6%, use 6%/12 for rate and multiply the number of years by 12 for nper.
- The payment returned by PMT includes principal and interest but no taxes, fees, or reserve payments.

## Example

### Example 1: Monthly mortgage payment

| | A | B |
|---|---|---|
| 1 | **Mortgage Calculator** | |
| 2 | Annual interest rate | 5.5% |
| 3 | Loan term (years) | 30 |
| 4 | Loan amount | $350,000 |
| 5 | | |
| 6 | **Formula** | **Result** |
| 7 | =PMT(B2/12, B3*12, B4) | -$1,987.26 |

**Result:** -$1,987.26

The monthly mortgage payment is $1,987.26. The result is negative because it represents cash flowing out (a payment you make). The annual rate is divided by 12 for monthly periods, and the years are multiplied by 12 for total monthly periods.

### Example 2: Monthly savings deposit

| | A | B |
|---|---|---|
| 1 | **Savings Goal** | |
| 2 | Annual interest rate | 4% |
| 3 | Years to save | 10 |
| 4 | Current savings | $0 |
| 5 | Target amount | $50,000 |
| 6 | | |
| 7 | **Formula** | **Result** |
| 8 | =PMT(B2/12, B3*12, B4, -B5) | -$340.96 |

**Result:** -$340.96

You need to deposit $340.96 per month for 10 years at 4% annual interest to accumulate $50,000. Note that fv is entered as negative (-B5) because the target balance represents money you want to have (cash inflow at the end).
