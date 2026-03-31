# EURO function

## Introduction

The EURO function converts a number to text using the euro currency format. It works exactly like the DOLLAR function but uses the euro sign instead of the dollar sign. The number is rounded and formatted with commas as thousands separators.

## Syntax

```
=EURO(number, [decimals])
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
| 2 | =EURO(1234.567) | &euro;1,234.57 |
| 3 | =EURO(1234.567, 1) | &euro;1,234.6 |
| 4 | =EURO(-99.5) | (&euro;99.50) |

**Result:** The number is formatted as a currency text string with the euro sign.
