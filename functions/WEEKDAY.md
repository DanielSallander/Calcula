# WEEKDAY function

## Introduction

The WEEKDAY function returns the day of the week for a given date as a number. Different return types allow you to choose numbering schemes that start on Sunday, Monday, or other days.

Use WEEKDAY to determine which day of the week a date falls on, create conditional formatting for weekends, filter out non-working days, or build scheduling logic that depends on the day of the week.

## Syntax

```
=WEEKDAY(serial_number, [return_type])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| serial_number | Required | A date value, cell reference, or text string representing a date. |
| return_type | Optional | A number that determines the numbering scheme. Default is 1. |

### return_type values

| Value | Day Numbering |
|-------|--------------|
| 1 | Sunday = 1, Monday = 2, ... Saturday = 7 (default) |
| 2 | Monday = 1, Tuesday = 2, ... Sunday = 7 |
| 3 | Monday = 0, Tuesday = 1, ... Sunday = 6 |
| 11 | Monday = 1, Tuesday = 2, ... Sunday = 7 |
| 12 | Tuesday = 1, Wednesday = 2, ... Monday = 7 |
| 13 | Wednesday = 1, Thursday = 2, ... Tuesday = 7 |
| 14 | Thursday = 1, Friday = 2, ... Wednesday = 7 |
| 15 | Friday = 1, Saturday = 2, ... Thursday = 7 |
| 16 | Saturday = 1, Sunday = 2, ... Friday = 7 |
| 17 | Sunday = 1, Monday = 2, ... Saturday = 7 |

## Remarks

- If serial_number is not a valid date, WEEKDAY returns a #VALUE! error.
- Return types 2 and 11 produce the same result (Monday = 1 through Sunday = 7).

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Date** | **Day (type 1)** | **Day (type 2)** |
| 2 | 2025-03-16 | =WEEKDAY(A2, 1) | =WEEKDAY(A2, 2) |
| 3 | 2025-03-17 | =WEEKDAY(A3, 1) | =WEEKDAY(A3, 2) |

**Result (B2):** 1 (Sunday, with Sunday=1 numbering)
**Result (C2):** 7 (Sunday, with Monday=1 numbering)
**Result (B3):** 2 (Monday, with Sunday=1 numbering)
**Result (C3):** 1 (Monday, with Monday=1 numbering)
