# XNPV function

## Introduction
The XNPV function returns the net present value for a schedule of cash flows that is not necessarily periodic. Unlike NPV which assumes equal intervals between cash flows, XNPV uses specific dates, making it suitable for irregular payment schedules.

## Syntax
```
=XNPV(rate, values, dates)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| rate | Required | The discount rate to apply. |
| values | Required | A range of cash flows corresponding to the dates. |
| dates | Required | A range of dates corresponding to the cash flows. |

## Remarks
- The first date is the basis for discounting; all other cash flows are discounted back to this date.
- Dates must be valid and the first date must be the earliest.
- Values and dates must have the same number of elements.
- Returns #NUM! if any date precedes the first date.

## Example

| | A | B |
|---|---|---|
| 1 | **Date** | **Cash Flow** |
| 2 | 2024-01-01 | -10000 |
| 3 | 2024-06-15 | 3000 |
| 4 | 2025-01-01 | 4000 |
| 5 | 2025-09-01 | 5000 |
| 6 | **XNPV** | =XNPV(0.08, B2:B5, A2:A5) |

**Result:** Approximately 788.65
