# NETWORKDAYS function

## Introduction

The NETWORKDAYS function returns the number of whole working days between two dates, automatically excluding weekends (Saturday and Sunday). You can optionally specify a list of holidays to also exclude from the count.

Use NETWORKDAYS to calculate project durations in business days, determine delivery timelines, compute employee work days for payroll, or any scenario where you need to count only weekdays. It is a staple function in project management and HR calculations.

## Syntax

```
=NETWORKDAYS(start_date, end_date, [holidays])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| start_date | Required | The start date of the period. |
| end_date | Required | The end date of the period. |
| holidays | Optional | A range or array of dates to exclude as non-working days (in addition to weekends). |

## Remarks

- Both start_date and end_date are included in the count if they fall on working days.
- Weekends are always Saturday and Sunday. For custom weekend definitions, use NETWORKDAYS.INTL (if available).
- If start_date is after end_date, the result is a negative number.
- If any date argument is not a valid date, NETWORKDAYS returns a #VALUE! error.
- Holiday dates that fall on weekends do not reduce the count further (they are already excluded).

## Example

| | A | B |
|---|---|---|
| 1 | **Start Date** | 2025-01-06 |
| 2 | **End Date** | 2025-01-17 |
| 3 | **Holiday** | 2025-01-13 |
| 4 | | |
| 5 | **Working Days (no holidays)** | =NETWORKDAYS(B1, B2) |
| 6 | **Working Days (with holiday)** | =NETWORKDAYS(B1, B2, B3) |

**Result (B5):** 10 (two full work weeks: Jan 6-10 and Jan 13-17)
**Result (B6):** 9 (10 working days minus the 1 holiday on Jan 13)

The formula counts weekdays between the two dates. Adding the holiday reference removes January 13 from the count.
