# IPMT function

## Introduction
The IPMT function returns the interest portion of a loan payment for a given period. It is useful for building amortization schedules where you need to separate each payment into its interest and principal components.

## Syntax
```
=IPMT(rate, per, nper, pv, [fv], [type])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| rate | Required | The interest rate per period. |
| per | Required | The specific period for which to calculate interest. Must be between 1 and nper. |
| nper | Required | The total number of payment periods. |
| pv | Required | The present value (loan amount). |
| fv | Optional | The future value. Default is 0. |
| type | Optional | 0 or omitted = payments at end of period, 1 = payments at beginning of period. |

## Remarks
- The rate and nper must use consistent time units (e.g., monthly rate with monthly periods).
- IPMT + PPMT for the same period equals the total payment from PMT.
- Returns a negative value for payments made (cash outflow).

## Example

| | A | B |
|---|---|---|
| 1 | **Parameter** | **Value** |
| 2 | Annual rate | 6% |
| 3 | Period | 1 |
| 4 | Total periods | 36 |
| 5 | Loan amount | 10000 |
| 6 | **Interest** | =IPMT(B2/12, B3, B4, B5) |

**Result:** -50.00 (interest portion of the first monthly payment)
