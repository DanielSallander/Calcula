# NPER function

## Introduction

The NPER function returns the number of periods required for an investment or loan based on periodic, constant payments and a constant interest rate. This function answers the question: "How long will it take?"

Use NPER to determine how many months or years it will take to pay off a loan, or how long you need to invest to reach a savings goal. For example, if you are paying $800 per month toward a credit card balance of $15,000 at 18% annual interest, NPER tells you exactly how many months until the balance is zero.

## Syntax

```
=NPER(rate, pmt, pv, [fv], [type])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| rate | Required | The interest rate per period. |
| pmt | Required | The payment made each period. Must remain constant over the life of the investment. |
| pv | Required | The present value, or the lump-sum amount that a series of future payments is worth right now. |
| fv | Optional | The future value, or the cash balance you want to attain after the last payment. If omitted, fv is assumed to be 0. |
| type | Optional | When payments are due. 0 or omitted = end of period. 1 = beginning of period. |

### Sign Conventions

- **Cash outflows** (payments you make, deposits) should be **negative**.
- **Cash inflows** (money you receive, loan proceeds) should be **positive**.

For a loan: pv is positive (you received the loan), pmt is negative (you make payments), and fv is 0 (loan fully repaid).

For a savings plan: pv is 0 or negative (initial deposit), pmt is negative (regular deposits), and fv is positive (target balance).

### Remarks

- Ensure that rate and pmt use consistent time units. For monthly payments at an annual rate of 6%, use 6%/12 as the rate.
- NPER returns the number of periods, which may not be a whole number. For example, 54.3 months means you will need 55 monthly payments (with the last one being a partial payment).

## Example

### Example 1: Paying off a loan

How many months to pay off a $20,000 personal loan at 8% annual interest with monthly payments of $400?

| | A | B |
|---|---|---|
| 1 | **Loan Payoff Calculator** | |
| 2 | Annual interest rate | 8% |
| 3 | Monthly payment | -$400 |
| 4 | Loan balance | $20,000 |
| 5 | | |
| 6 | **Formula** | **Result** |
| 7 | =NPER(B2/12, B3, B4) | 62.7 |

**Result:** Approximately 62.7 months (about 5 years and 3 months)

It will take approximately 63 monthly payments of $400 to fully pay off the $20,000 loan at 8% annual interest.

### Example 2: Time to reach a savings goal

How many months do you need to save $200 per month at 5% annual interest to accumulate $30,000?

| | A | B |
|---|---|---|
| 1 | **Formula** | **Result** |
| 2 | =NPER(5%/12, -200, 0, 30000) | 116.1 |

**Result:** Approximately 116.1 months (about 9 years and 8 months)

You need to save for about 9 years and 8 months, making $200 monthly deposits at 5% annual interest, to accumulate $30,000.
