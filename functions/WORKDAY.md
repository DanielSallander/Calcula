# WORKDAY function

## Introduction

The WORKDAY function returns the date that is a specified number of working days before or after a start date, automatically skipping weekends (Saturday and Sunday). You can optionally specify holidays to also skip.

Use WORKDAY to calculate delivery dates, project deadlines, payment due dates, or any date that needs to account for business days only. It is the inverse of NETWORKDAYS -- while NETWORKDAYS counts the working days between two dates, WORKDAY finds the date that is a given number of working days away.

## Syntax

```
=WORKDAY(start_date, days, [holidays])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| start_date | Required | The starting date. |
| days | Required | The number of working days to add (positive) or subtract (negative). |
| holidays | Optional | A range or array of dates to exclude as non-working days (in addition to weekends). |

## Remarks

- If days is positive, WORKDAY moves forward. If negative, it moves backward.
- Weekends (Saturday and Sunday) are automatically skipped.
- If start_date is not a valid date, WORKDAY returns a #VALUE! error.
- Format the result cell as a date to see a readable date.
- For custom weekend definitions, use WORKDAY.INTL (if available).

## Example

| | A | B |
|---|---|---|
| 1 | **Order Date** | 2025-03-10 |
| 2 | **Business Days** | 5 |
| 3 | **Holiday** | 2025-03-14 |
| 4 | | |
| 5 | **Delivery (no holidays)** | =WORKDAY(B1, B2) |
| 6 | **Delivery (with holiday)** | =WORKDAY(B1, B2, B3) |

**Result (B5):** March 17, 2025 (Mon Mar 10 + 5 working days = Mon Mar 17, skipping Sat/Sun)
**Result (B6):** March 18, 2025 (same as above, but Mar 14 is a holiday, pushing the result one day further to Tue Mar 18)
