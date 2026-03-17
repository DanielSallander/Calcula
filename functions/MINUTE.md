# MINUTE function

## Introduction

The MINUTE function extracts the minute from a time value and returns it as an integer between 0 and 59.

Use MINUTE to isolate the minute component from a time or datetime value for precise time calculations, rounding times to specific intervals, or building time-based reports with minute-level granularity.

## Syntax

```
=MINUTE(serial_number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| serial_number | Required | A time value, datetime value, cell reference, or text string representing a time. |

## Remarks

- MINUTE returns a value between 0 and 59.
- If serial_number is a date without a time component, MINUTE returns 0.
- If serial_number is not a valid time or date, MINUTE returns a #VALUE! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Time** | **Minute** |
| 2 | 14:30:45 | =MINUTE(A2) |
| 3 | 9:05:00 | =MINUTE(A3) |

**Result (B2):** 30
**Result (B3):** 5
