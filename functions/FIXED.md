# FIXED function

## Introduction

The FIXED function rounds a number to a specified number of decimal places, formats it as text, and optionally includes or omits thousands separators (commas).

## Syntax

```
=FIXED(number, [decimals], [no_commas])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The number to round and format. |
| decimals | Optional | The number of decimal places. Default is 2. |
| no_commas | Optional | If TRUE, commas are omitted from the result. Default is FALSE (commas included). |

## Remarks

- The result is a text string, not a number.
- Negative numbers are prefixed with a minus sign.

## Example

| | A | B |
|---|---|---|
| 1 | **Formula** | **Result** |
| 2 | =FIXED(1234.567, 2) | 1,234.57 |
| 3 | =FIXED(1234.567, 2, TRUE) | 1234.57 |
| 4 | =FIXED(1234.567, 0) | 1,235 |

**Result:** The number is formatted as text with the specified decimal places.
