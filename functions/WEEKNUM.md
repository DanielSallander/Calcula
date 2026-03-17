# WEEKNUM function

## Introduction

The WEEKNUM function returns the week number of a specific date within the year. The week containing January 1 is considered week 1 by default, though different return types allow you to specify which day starts the week.

Use WEEKNUM for weekly reporting, grouping data by week, scheduling, and any analysis that requires organizing dates into week numbers. It is commonly used in project management, sales tracking, and time series analysis.

## Syntax

```
=WEEKNUM(serial_number, [return_type])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| serial_number | Required | A date value, cell reference, or text string representing a date. |
| return_type | Optional | A number that specifies which day is considered the start of the week. Default is 1. |

### return_type values

| Value | Week Starts On |
|-------|---------------|
| 1 | Sunday (default) |
| 2 | Monday |
| 11 | Monday |
| 12 | Tuesday |
| 13 | Wednesday |
| 14 | Thursday |
| 15 | Friday |
| 16 | Saturday |
| 17 | Sunday |
| 21 | Monday (ISO 8601 week numbering) |

## Remarks

- Return type 21 uses ISO 8601 week numbering, where week 1 is the week containing the first Thursday of the year. This can result in dates in early January belonging to week 52 or 53 of the previous year.
- For return types other than 21, week 1 always contains January 1.
- If serial_number is not a valid date, WEEKNUM returns a #VALUE! error.
- Return types 1 and 17 produce the same result; types 2 and 11 also produce the same result.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Date** | **Week (Sun start)** | **Week (ISO)** |
| 2 | 2025-01-01 | =WEEKNUM(A2, 1) | =WEEKNUM(A2, 21) |
| 3 | 2025-03-16 | =WEEKNUM(A3, 1) | =WEEKNUM(A3, 21) |
| 4 | 2025-12-31 | =WEEKNUM(A4, 1) | =WEEKNUM(A4, 21) |

**Result (B2):** 1 (January 1 is in week 1 with Sunday-start counting)
**Result (C2):** 1 (January 1, 2025 is a Wednesday, falling in ISO week 1)
**Result (B3):** 12
**Result (C3):** 11
**Result (B4):** 53
**Result (C4):** 1 (under ISO rules, Dec 31, 2025 may fall in week 1 of the following year)

The difference between standard and ISO week numbering can cause the same date to have different week numbers, especially near the start and end of the year.
