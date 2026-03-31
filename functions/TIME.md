# TIME function

## Introduction

The TIME function returns a decimal number representing a particular time of day. The decimal number is a value from 0 (12:00:00 AM) to 0.99999 (11:59:59 PM).

## Syntax

```
=TIME(hour, minute, second)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| hour | Required | A number from 0 to 32767 representing the hour. Values greater than 23 will wrap around. |
| minute | Required | A number from 0 to 32767 representing the minute. Values greater than 59 will be converted to hours and minutes. |
| second | Required | A number from 0 to 32767 representing the second. Values greater than 59 will be converted to minutes and seconds. |

## Remarks

- Time values are a portion of a day. For example, 12:00 PM = 0.5.
- Hours, minutes, and seconds that exceed their normal ranges are carried over. For example, TIME(0, 0, 3600) equals TIME(1, 0, 0).
- The fractional part of the result represents the time as a fraction of a day (86400 seconds).

## Example

| | A | B |
|---|---|---|
| 1 | **Formula** | **Result** |
| 2 | =TIME(12, 0, 0) | 0.5 |
| 3 | =TIME(16, 30, 0) | 0.6875 |

**Result:** Cell A2 returns **0.5** (representing 12:00 PM, or half a day).
