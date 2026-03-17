# EDATE function

## Introduction

The EDATE function returns the date that is a specified number of months before or after a given start date. The returned date has the same day-of-month as the start date, adjusted if necessary for shorter months.

Use EDATE to calculate maturity dates, payment due dates, subscription renewal dates, or any date that is a fixed number of months from a reference date. It is widely used in financial calculations, contract management, and scheduling.

## Syntax

```
=EDATE(start_date, months)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| start_date | Required | The starting date. |
| months | Required | The number of months before (negative) or after (positive) the start_date. |

## Remarks

- If months is positive, EDATE moves forward in time. If negative, it moves backward.
- If the resulting month has fewer days than the start date's day, the last day of the resulting month is returned. For example, EDATE("2025-01-31", 1) returns February 28, 2025.
- If start_date is not a valid date, EDATE returns a #VALUE! error.
- If months is not an integer, it is truncated to an integer.
- Format the result cell as a date to display it in a readable format.

## Example

| | A | B |
|---|---|---|
| 1 | **Start Date** | **Result** |
| 2 | 2025-01-15 | =EDATE(A2, 3) |
| 3 | 2025-01-31 | =EDATE(A3, 1) |
| 4 | 2025-06-15 | =EDATE(A4, -2) |

**Result (B2):** April 15, 2025 (3 months after January 15)
**Result (B3):** February 28, 2025 (since February has no 31st day, the last day of the month is returned)
**Result (B4):** April 15, 2025 (2 months before June 15)
