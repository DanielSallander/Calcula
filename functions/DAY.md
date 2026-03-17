# DAY function

## Introduction

The DAY function extracts the day of the month from a date serial number and returns it as an integer between 1 and 31.

Use DAY to isolate the day component from a date for calculations such as determining payment due dates, scheduling reminders, or extracting day-of-month information for reporting purposes.

## Syntax

```
=DAY(serial_number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| serial_number | Required | A date serial number, cell reference containing a date, or a text string that represents a date. |

## Remarks

- DAY returns a value between 1 and 31.
- If serial_number is not a valid date, DAY returns a #VALUE! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Date** | **Day** |
| 2 | 2025-08-20 | =DAY(A2) |
| 3 | 2025-02-28 | =DAY(A3) |

**Result (B2):** 20
**Result (B3):** 28
