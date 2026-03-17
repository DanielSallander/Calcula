# EOMONTH function

## Introduction

The EOMONTH function returns the last day of the month that is a specified number of months before or after a given start date. It always returns the final calendar day of the target month, regardless of the day in the start date.

Use EOMONTH to calculate month-end dates for financial reporting, billing cycles, contract expirations, or any scenario where you need to know the last day of a future or past month. It is especially useful because different months have different numbers of days, and EOMONTH handles this automatically.

## Syntax

```
=EOMONTH(start_date, months)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| start_date | Required | The starting date. |
| months | Required | The number of months before (negative) or after (positive) the start_date. Use 0 for the end of the current month. |

## Remarks

- EOMONTH(start_date, 0) returns the last day of the same month as start_date.
- Correctly handles leap years (February 29 in leap years, February 28 otherwise).
- If months is not an integer, it is truncated to an integer.
- If start_date is not a valid date, EOMONTH returns a #VALUE! error.
- Format the result cell as a date.

## Example

| | A | B |
|---|---|---|
| 1 | **Start Date** | **End of Month** |
| 2 | 2025-01-15 | =EOMONTH(A2, 0) |
| 3 | 2025-01-15 | =EOMONTH(A3, 1) |
| 4 | 2024-01-15 | =EOMONTH(A4, 1) |
| 5 | 2025-06-10 | =EOMONTH(A5, -3) |

**Result (B2):** January 31, 2025 (end of the current month)
**Result (B3):** February 28, 2025 (end of next month; 2025 is not a leap year)
**Result (B4):** February 29, 2024 (end of next month; 2024 is a leap year)
**Result (B5):** March 31, 2025 (end of month 3 months before June)
