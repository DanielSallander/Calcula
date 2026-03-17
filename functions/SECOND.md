# SECOND function

## Introduction

The SECOND function extracts the second from a time value and returns it as an integer between 0 and 59.

Use SECOND to isolate the seconds component from a time or datetime value for precise time measurements, duration calculations, or building timestamps with second-level accuracy.

## Syntax

```
=SECOND(serial_number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| serial_number | Required | A time value, datetime value, cell reference, or text string representing a time. |

## Remarks

- SECOND returns a value between 0 and 59.
- If serial_number is a date without a time component, SECOND returns 0.
- If serial_number is not a valid time or date, SECOND returns a #VALUE! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Time** | **Second** |
| 2 | 14:30:45 | =SECOND(A2) |
| 3 | 9:05:00 | =SECOND(A3) |

**Result (B2):** 45
**Result (B3):** 0
