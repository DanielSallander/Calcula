# TODAY function

## Introduction

The TODAY function returns the current date as a serial number. The serial number is the date value used internally by spreadsheet applications, where each day is represented by a sequential integer. The cell can be formatted to display the date in any desired format.

Use TODAY to insert a date that automatically updates every time the worksheet recalculates. It is commonly used in age calculations, days-remaining countdowns, conditional formatting based on the current date, and any formula that needs to reference "today."

## Syntax

```
=TODAY()
```

The TODAY function takes no arguments. The parentheses are required.

## Remarks

- TODAY is a volatile function and recalculates every time the worksheet recalculates.
- The returned value is a date serial number. Format the cell as a date to display it in a readable format.
- TODAY returns only the date portion (no time). Use NOW() if you need both date and time.
- The date is based on your computer's system clock.

## Example

| | A | B |
|---|---|---|
| 1 | **Description** | **Value** |
| 2 | Today's Date | =TODAY() |
| 3 | Birth Date | 1990-06-15 |
| 4 | Age in Days | =TODAY()-B3 |
| 5 | Age in Years | =DATEDIF(B3, TODAY(), "Y") |

**Result (B2):** The current date (e.g., 2026-03-16)
**Result (B4):** Number of days since June 15, 1990
**Result (B5):** Age in complete years

The TODAY function updates automatically each day, so the age calculations always reflect the current date.
