# T function

## Introduction

The T function tests whether a value is text and returns the text if it is, or an empty string ("") if it is not. This function is primarily used for compatibility with other spreadsheet applications and for ensuring that a value is treated as text in formulas.

T can be useful as a defensive measure in complex formulas where you want to ensure that only text values pass through, or when you need to convert non-text values to empty strings for concatenation or display purposes. In most modern scenarios, direct type checking with ISTEXT is more common.

## Syntax

```
=T(value)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value | Required | The value to test. If it is text, the text is returned. If it is any other data type, an empty string is returned. |

## Remarks

- If value is a text string, T returns that text string.
- If value is a number, logical value, error, or empty cell, T returns an empty string ("").
- T does not convert values to text; it only passes through values that are already text.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **T Result** |
| 2 | Hello | =T(A2) |
| 3 | 42 | =T(A3) |
| 4 | TRUE | =T(A4) |

**Result:** Cell B2 returns **"Hello"**, cell B3 returns **""** (empty string), and cell B4 returns **""** (empty string).

Only the text value in A2 is returned as-is. The number and logical value produce empty strings because they are not text.
