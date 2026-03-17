# DATE function

## Introduction

The DATE function creates a date serial number from individual year, month, and day components. It is the standard way to construct a date value from separate numeric parts, ensuring a valid date regardless of locale or date formatting settings.

Use DATE when you have year, month, and day values in separate cells or calculations and need to combine them into a proper date. It is also useful for date arithmetic, as you can add or subtract months or days by manipulating the arguments. DATE automatically adjusts for overflow -- for example, specifying month 13 rolls over to January of the following year.

## Syntax

```
=DATE(year, month, day)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| year | Required | The year. Values 0-1899 are added to 1900; values 1900-9999 are used directly. |
| month | Required | The month (1-12). Values outside this range roll forward or backward into adjacent years. |
| day | Required | The day (1-31). Values outside the valid range for the given month roll forward or backward. |

## Remarks

- If month is greater than 12, DATE rolls into the next year. For example, DATE(2025, 14, 1) equals February 1, 2026.
- If day exceeds the number of days in the given month, DATE rolls into the next month. For example, DATE(2025, 1, 32) equals February 1, 2025.
- Negative month or day values roll backward. For example, DATE(2025, 0, 1) equals December 1, 2024.
- Two-digit years (0-99) are interpreted as 1900-1999. Use four-digit years to avoid ambiguity.

## Example

| | A | B | C | D |
|---|---|---|---|---|
| 1 | **Year** | **Month** | **Day** | **Date** |
| 2 | 2025 | 6 | 15 | =DATE(A2, B2, C2) |
| 3 | 2025 | 13 | 1 | =DATE(A3, B3, C3) |

**Result (D2):** June 15, 2025
**Result (D3):** January 1, 2026 (month 13 rolls over to January of the next year)
