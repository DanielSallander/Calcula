# TIMEVALUE function

## Introduction

The TIMEVALUE function converts a time represented as a text string into a decimal number between 0 and 0.99999999, representing the fraction of a 24-hour day. This allows text-formatted times to be used in time calculations.

Use TIMEVALUE when you receive time data as text strings (e.g., from imported files or user input) and need to convert them to numeric time values for arithmetic operations, sorting, or use with other time functions.

## Syntax

```
=TIMEVALUE(time_text)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| time_text | Required | A text string that represents a time in a recognized format. |

## Remarks

- TIMEVALUE returns a decimal between 0 (midnight) and 0.99999... (23:59:59).
- Any date information in the text string is ignored; only the time portion is converted.
- If time_text is not a recognizable time format, TIMEVALUE returns a #VALUE! error.
- To see the result as a time, format the cell with a time format.

## Example

| | A | B |
|---|---|---|
| 1 | **Time Text** | **Decimal Value** |
| 2 | "6:00 AM" | =TIMEVALUE(A2) |
| 3 | "12:00 PM" | =TIMEVALUE(A3) |
| 4 | "18:30:00" | =TIMEVALUE(A4) |

**Result (B2):** 0.25 (6:00 AM is 25% of a day)
**Result (B3):** 0.5 (12:00 PM is 50% of a day)
**Result (B4):** 0.770833... (18:30 is approximately 77% of a day)
