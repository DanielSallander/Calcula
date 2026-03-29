# PPMT function

## Introduction
The PPMT function returns the principal portion of a loan payment for a given period. Combined with IPMT, it allows you to build complete amortization schedules showing how each payment is split between principal reduction and interest.

## Syntax
```
=PPMT(rate, per, nper, pv, [fv], [type])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| rate | Required | The interest rate per period. |
| per | Required | The specific period for which to calculate principal. Must be between 1 and nper. |
| nper | Required | The total number of payment periods. |
| pv | Required | The present value (loan amount). |
| fv | Optional | The future value. Default is 0. |
| type | Optional | 0 or omitted = payments at end of period, 1 = payments at beginning of period. |

## Remarks
- The rate and nper must use consistent time units (e.g., monthly rate with monthly periods).
- PPMT + IPMT for the same period equals the total payment from PMT.
- Returns a negative value for payments made (cash outflow).

## Example

| | A | B |
|---|---|---|
| 1 | **Parameter** | **Value** |
| 2 | Annual rate | 6% |
| 3 | Period | 1 |
| 4 | Total periods | 36 |
| 5 | Loan amount | 10000 |
| 6 | **Principal** | =PPMT(B2/12, B3, B4, B5) |

**Result:** -254.22 (principal portion of the first monthly payment)
