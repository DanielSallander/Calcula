# VALUE function

## Introduction

The VALUE function converts a text string that represents a number into an actual numeric value. This is essential when data imported from external sources, text files, or web pages arrives as text rather than numbers, preventing you from performing calculations on it.

Common scenarios include converting currency strings (after removing the currency symbol), parsing numeric data from CSV imports that were stored as text, and converting formatted number strings back to calculable values. If a cell shows a number but is left-aligned or has a green triangle indicating it is stored as text, VALUE can convert it.

## Syntax

```
=VALUE(text)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | A text string, or a reference to a cell containing a text string, that represents a number. |

## Remarks

- The text can include number formatting characters such as decimal points, commas (as thousands separators), percent signs, and currency symbols, depending on your locale settings.
- If text cannot be interpreted as a number, VALUE returns a #VALUE! error.
- Date and time strings in recognized formats are converted to their serial number equivalents.

## Example

| | A | B |
|---|---|---|
| 1 | **Text Value** | **Numeric Value** |
| 2 | 1234.56 | =VALUE(A2) |
| 3 | 75% | =VALUE(A3) |
| 4 | abc | =VALUE(A4) |

**Result:** Cell B2 returns **1234.56**, cell B3 returns **0.75**, and cell B4 returns **#VALUE!** because "abc" cannot be converted to a number.
