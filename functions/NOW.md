# NOW function

## Introduction

The NOW function returns the current date and time as a serial number. The integer portion represents the date, and the decimal portion represents the time. The cell can be formatted to display the date, time, or both in any desired format.

Use NOW when you need a timestamp that includes both the date and the time of day. It is useful for logging when a calculation was last performed, calculating elapsed time, or creating timestamps in reports. If you only need the date without the time component, use TODAY() instead.

## Syntax

```
=NOW()
```

The NOW function takes no arguments. The parentheses are required.

## Remarks

- NOW is a volatile function and recalculates every time the worksheet recalculates.
- The returned serial number includes both date and time. Format the cell appropriately to see the desired display.
- The date and time are based on your computer's system clock.
- To extract just the time from NOW, use: `=NOW()-TODAY()` or use the HOUR, MINUTE, and SECOND functions.

## Example

| | A | B |
|---|---|---|
| 1 | **Description** | **Value** |
| 2 | Current Date/Time | =NOW() |
| 3 | Date Only | =INT(NOW()) |
| 4 | Time Only | =NOW()-INT(NOW()) |

**Result (B2):** The current date and time (e.g., 2026-03-16 14:30:45)
**Result (B3):** Today's date as a serial number
**Result (B4):** The current time as a decimal fraction of a day

NOW updates each time the worksheet recalculates, providing a continuously current timestamp.
