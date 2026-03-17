# NUMBERVALUE function

## Introduction

The NUMBERVALUE function converts a text string representing a number into a numeric value, using specified decimal and group separators. This is particularly important when working with data from different locales where number formatting conventions differ. For example, many European countries use a comma as the decimal separator and a period as the thousands separator, which is the opposite of the US convention.

Use NUMBERVALUE when importing or processing international data where numeric strings follow a different formatting convention than your system locale. It provides explicit control over how the text-to-number conversion interprets separators, unlike the VALUE function which relies on system locale settings.

## Syntax

```
=NUMBERVALUE(text, [decimal_separator], [group_separator])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | The text string to convert to a number. |
| decimal_separator | Optional | The character used as the decimal separator in the text. Defaults to the system locale's decimal separator (typically "." in English locales). |
| group_separator | Optional | The character used as the thousands/group separator in the text. Defaults to the system locale's group separator (typically "," in English locales). |

## Remarks

- If the decimal_separator or group_separator is more than one character, only the first character is used.
- If an empty string ("") is passed for a separator, the system default for that separator is used.
- If the text contains characters that are not valid for a number (other than the specified separators, digits, percent signs, and leading/trailing spaces), NUMBERVALUE returns a #VALUE! error.
- A trailing percent sign (%) divides the result by 100.

## Example

| | A | B |
|---|---|---|
| 1 | **European Format** | **Numeric Value** |
| 2 | 1.234,56 | =NUMBERVALUE(A2, ",", ".") |
| 3 | 9.876.543,21 | =NUMBERVALUE(A3, ",", ".") |

**Result:** Cell B2 returns **1234.56** and cell B3 returns **9876543.21**.

The function interprets the comma as a decimal separator and the period as a group (thousands) separator, correctly converting European-formatted numbers to standard numeric values.
