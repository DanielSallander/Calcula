# DOLLAR function

## Introduction

The DOLLAR function converts a number to text using the currency ($) format with the specified number of decimal places. The number is rounded and formatted with commas as thousands separators.

## Syntax

```
=DOLLAR(number, [decimals])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The number to format. |
| decimals | Optional | The number of decimal places. Default is 2. |

## Remarks

- The text follows Calcula's app locale (its regional setting): the currency symbol and its position, the decimal separator and the thousands separator are that region's. The examples below are en-US; in de-DE `=DOLLAR(1234.5)` gives `€ 1.234,50`, in sv-SE `1 234,50 kr`.
- Negative numbers are enclosed in parentheses in en-US and carry a leading minus sign in every other region.
- The result is a text string, not a number. Like TEXT, it is written when the formula calculates, so after changing the region it updates on the next recalculation (F9).
- Thousands separators are added automatically.

## Example

| | A | B |
|---|---|---|
| 1 | **Formula** | **Result** |
| 2 | =DOLLAR(1234.567) | $1,234.57 |
| 3 | =DOLLAR(1234.567, 1) | $1,234.6 |
| 4 | =DOLLAR(-99.5) | ($99.50) |

**Result:** The number is formatted as a currency text string with the $ symbol.
