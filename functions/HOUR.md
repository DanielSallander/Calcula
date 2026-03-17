# HOUR function

## Introduction

The HOUR function extracts the hour from a time value and returns it as an integer between 0 (12:00 AM) and 23 (11:00 PM).

Use HOUR to isolate the hour component from a time or datetime value for time-based analysis, scheduling logic, or grouping data by hour of day. It is commonly used in workforce scheduling, time tracking, and analyzing activity patterns throughout the day.

## Syntax

```
=HOUR(serial_number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| serial_number | Required | A time value, datetime value, cell reference, or text string representing a time. |

## Remarks

- HOUR returns a value between 0 and 23 (24-hour format).
- If serial_number is a date without a time component, HOUR returns 0.
- If serial_number is not a valid time or date, HOUR returns a #VALUE! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Time** | **Hour** |
| 2 | 14:30:00 | =HOUR(A2) |
| 3 | 9:15:00 | =HOUR(A3) |
| 4 | 0:45:00 | =HOUR(A4) |

**Result (B2):** 14
**Result (B3):** 9
**Result (B4):** 0
