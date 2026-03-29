# CUMPRINC function

## Introduction
The CUMPRINC function returns the cumulative principal paid on a loan between two periods. It is useful for calculating how much of the loan balance has been reduced over a specific range of payments.

## Syntax
```
=CUMPRINC(rate, nper, pv, start_period, end_period, type)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| rate | Required | The interest rate per period. |
| nper | Required | The total number of payment periods. |
| pv | Required | The present value (loan amount). |
| start_period | Required | The first period in the calculation (1-based). |
| end_period | Required | The last period in the calculation. |
| type | Required | 0 = payments at end of period, 1 = payments at beginning of period. |

## Remarks
- Returns a negative value representing cash paid out.
- start_period and end_period must be between 1 and nper.
- All arguments must be positive values except type.
- CUMIPMT + CUMPRINC for the same range equals the total payments made.

## Example

| | A | B |
|---|---|---|
| 1 | **Parameter** | **Value** |
| 2 | Rate (monthly) | 0.5% |
| 3 | Periods | 360 |
| 4 | Loan | 200000 |
| 5 | **Year 1 principal** | =CUMPRINC(B2, B3, B4, 1, 12, 0) |

**Result:** Approximately -2514.86 (total principal paid in the first 12 months)
