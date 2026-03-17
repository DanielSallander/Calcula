# YEAR function

## Introduction

The YEAR function extracts the year from a date serial number and returns it as an integer. The returned value is a four-digit year in the range 1900 to 9999.

Use YEAR to isolate the year component from a date for grouping, filtering, or calculations that depend on the year. It is commonly used in reports to group data by year, calculate ages, or determine fiscal years.

## Syntax

```
=YEAR(serial_number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| serial_number | Required | A date serial number, cell reference containing a date, or a text string that represents a date. |

## Remarks

- If serial_number is not a valid date, YEAR returns a #VALUE! error.
- YEAR works with the date portion only; any time component is ignored.

## Example

| | A | B |
|---|---|---|
| 1 | **Date** | **Year** |
| 2 | 2025-08-20 | =YEAR(A2) |
| 3 | 2023-01-01 | =YEAR(A3) |

**Result (B2):** 2025
**Result (B3):** 2023
