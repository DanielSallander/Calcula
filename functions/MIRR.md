# MIRR function

## Introduction
The MIRR function returns the modified internal rate of return for a series of periodic cash flows. Unlike IRR, MIRR accounts for different rates for financing costs (negative cash flows) and reinvestment returns (positive cash flows), providing a more realistic measure.

## Syntax
```
=MIRR(values, finance_rate, reinvest_rate)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| values | Required | A range of cash flows. Must contain at least one positive and one negative value. |
| finance_rate | Required | The interest rate paid on negative cash flows (cost of borrowing). |
| reinvest_rate | Required | The interest rate earned on positive cash flows (reinvestment return). |

## Remarks
- Values must contain at least one positive and one negative value; otherwise returns #DIV/0!.
- Cash flows are assumed to occur at regular intervals (end of each period).
- MIRR avoids the multiple-solution problem that IRR can have with alternating cash flows.

## Example

| | A | B |
|---|---|---|
| 1 | **Period** | **Cash Flow** |
| 2 | 0 | -120000 |
| 3 | 1 | 39000 |
| 4 | 2 | 30000 |
| 5 | 3 | 21000 |
| 6 | 4 | 37000 |
| 7 | **MIRR** | =MIRR(B2:B6, 0.10, 0.12) |

**Result:** Approximately 4.85%
