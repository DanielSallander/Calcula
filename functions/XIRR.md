# XIRR function

## Introduction
The XIRR function returns the internal rate of return for a schedule of cash flows that is not necessarily periodic. Unlike IRR which assumes equal intervals, XIRR uses specific dates to calculate the annualized return, making it ideal for irregular investment cash flows.

## Syntax
```
=XIRR(values, dates, [guess])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| values | Required | A range of cash flows. Must contain at least one positive and one negative value. |
| dates | Required | A range of dates corresponding to the cash flows. |
| guess | Optional | An initial guess for the rate. Default is 0.1 (10%). |

## Remarks
- Values and dates must have the same number of elements.
- The first date should be the earliest; values must include at least one positive and one negative.
- XIRR uses an iterative method and may return #NUM! if it cannot converge.
- The result is an annualized rate regardless of the period between dates.

## Example

| | A | B |
|---|---|---|
| 1 | **Date** | **Cash Flow** |
| 2 | 2024-01-01 | -10000 |
| 3 | 2024-06-01 | 2750 |
| 4 | 2025-01-01 | 4250 |
| 5 | 2025-07-01 | 5000 |
| 6 | **XIRR** | =XIRR(B2:B5, A2:A5) |

**Result:** Approximately 25.5%
