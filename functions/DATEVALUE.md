# DATEVALUE function

## Introduction

The DATEVALUE function converts a date represented as a text string into a date serial number. This is useful when dates are imported as text rather than as proper date values, which prevents them from being used in calculations.

Use DATEVALUE to convert text-formatted dates into numeric date values that can be used in date arithmetic, sorting, and other date functions. It is commonly needed when importing data from external sources where dates arrive as text strings.

## Syntax

```
=DATEVALUE(date_text)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| date_text | Required | A text string that represents a date. The text must be in a recognizable date format. |

## Remarks

- DATEVALUE ignores any time information in the text string; only the date portion is converted.
- The function recognizes date formats based on your system's regional settings.
- If date_text is not a recognizable date format, DATEVALUE returns a #VALUE! error.
- If the cell already contains a proper date value (not text), DATEVALUE is not needed.
- Format the result cell as a date to see the date displayed in a readable format.

## Example

| | A | B |
|---|---|---|
| 1 | **Date Text** | **Serial Number** |
| 2 | "2025-06-15" | =DATEVALUE(A2) |
| 3 | "March 1, 2025" | =DATEVALUE(A3) |
| 4 | "15/06/2025" | =DATEVALUE(A4) |

**Result (B2):** 45822 (serial number for June 15, 2025)
**Result (B3):** 45716 (serial number for March 1, 2025)
**Result (B4):** 45822 (serial number for June 15, 2025, depending on locale)

The returned serial numbers can be formatted as dates and used in date calculations. Note that date format recognition depends on your system's locale settings.
