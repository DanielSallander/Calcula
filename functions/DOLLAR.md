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

- Negative numbers are enclosed in parentheses.
- The result is a text string, not a number.
- Thousands separators (commas) are added automatically.

## Example

| | A | B |
|---|---|---|
| 1 | **Formula** | **Result** |
| 2 | =DOLLAR(1234.567) | $1,234.57 |
| 3 | =DOLLAR(1234.567, 1) | $1,234.6 |
| 4 | =DOLLAR(-99.5) | ($99.50) |

**Result:** The number is formatted as a currency text string with the $ symbol.
