# REPT function

## Introduction

The REPT function repeats a text string a specified number of times. It provides a simple way to generate repeated character patterns, create text-based visual indicators, and build padding strings.

Common uses include creating simple in-cell bar charts using repeated characters (like "|" or "*"), generating separator lines, padding text to a fixed width, and building repeated patterns for data formatting. REPT is often combined with other text functions for creative text manipulation.

## Syntax

```
=REPT(text, number_times)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | The text string to repeat. |
| number_times | Required | The number of times to repeat the text. Must be a positive number or 0. Decimal values are truncated to integers. |

## Remarks

- If number_times is 0, REPT returns an empty string.
- If number_times is negative, REPT returns a #VALUE! error.
- The result of REPT is limited to 32,767 characters. If the repeated string would exceed this limit, REPT returns a #VALUE! error.
- Decimal values for number_times are truncated (not rounded) to the nearest integer.

## Example

| | A | B |
|---|---|---|
| 1 | **Score** | **Bar Chart** |
| 2 | 7 | =REPT("*", A2) |
| 3 | 4 | =REPT("*", A3) |
| 4 | 10 | =REPT("*", A4) |

**Result:** Cell B2 returns **"*******"** (7 asterisks), cell B3 returns **"****"** (4 asterisks), and cell B4 returns **"**********"** (10 asterisks).

This creates a simple text-based bar chart where the length of the asterisk string visually represents the score value.
