# RATE function

## Introduction

The RATE function returns the interest rate per period of an annuity. RATE is calculated by iteration and can have zero or more solutions. If the successive results of RATE do not converge, the function returns an error.

Use RATE when you know the payment amount, the number of periods, and the present or future value, but need to determine the implied interest rate. This is useful for comparing loan offers, determining the return on an investment, or back-calculating the rate from known payment terms.

## Syntax

```
=RATE(nper, pmt, pv, [fv], [type], [guess])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| nper | Required | The total number of payment periods in the annuity. |
| pmt | Required | The payment made each period. Must remain constant over the life of the annuity. |
| pv | Required | The present value -- the lump-sum amount that a series of future payments is worth right now. |
| fv | Optional | The future value, or cash balance you want after the last payment. If omitted, fv is assumed to be 0 (e.g., the future value of a fully repaid loan is 0). |
| type | Optional | When payments are due. 0 or omitted = end of period. 1 = beginning of period. |
| guess | Optional | Your guess for what the rate will be. If omitted, 0.1 (10%) is used. |

### Sign Conventions

- **Cash outflows** (payments you make) should be **negative**.
- **Cash inflows** (money you receive) should be **positive**.

For a loan: pv is positive (you receive the loan), pmt is negative (you make payments).

### Remarks

- RATE returns the rate per period. To get an annual rate from monthly payments, multiply the result by 12.
- If RATE does not converge, try a different guess value.
- Ensure that nper, pmt, and rate use consistent time units.

## Example

### Example 1: Finding the interest rate on a car loan

You borrow $25,000 for a car and make monthly payments of $485 for 5 years. What is the annual interest rate?

| | A | B |
|---|---|---|
| 1 | **Car Loan Rate Finder** | |
| 2 | Loan amount | $25,000 |
| 3 | Monthly payment | -$485 |
| 4 | Loan term (months) | 60 |
| 5 | | |
| 6 | **Formula** | **Result** |
| 7 | =RATE(B4, B3, B2) * 12 | 5.37% |

**Result:** Approximately 5.37% annual interest rate

RATE returns the monthly rate, which is multiplied by 12 to get the annual rate. The loan amount (pv) is positive because you receive the money, and the payment (pmt) is negative because you pay it out.

### Example 2: Return on a savings plan

You deposit $300 per month into an account for 10 years and end up with $50,000. What annual rate of return did you earn?

| | A | B |
|---|---|---|
| 1 | **Formula** | **Result** |
| 2 | =RATE(120, -300, 0, 50000) * 12 | 4.98% |

**Result:** Approximately 4.98% annual return

The 120 periods are months (10 years x 12), the payment is -300 (cash outflow), pv is 0 (starting from nothing), and fv is 50,000 (the target balance).
