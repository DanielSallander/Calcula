# CODE function

## Introduction

The CODE function returns the numeric character code for the first character in a text string. The code corresponds to the character set used by your operating system (typically Windows-1252 or Unicode). CODE is the inverse of the CHAR function.

CODE is useful for sorting or comparing characters based on their numeric values, identifying non-printable or unexpected characters in data, and performing character-level data validation or transformation logic.

## Syntax

```
=CODE(text)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | The text string for which you want the code of the first character. |

## Remarks

- Only the first character of the string is evaluated. If text contains multiple characters, the rest are ignored.
- On Windows, the result corresponds to the Windows-1252 (ANSI) character set for standard characters.
- If text is an empty string, CODE returns a #VALUE! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Character** | **Code** |
| 2 | A | =CODE(A2) |
| 3 | a | =CODE(A3) |
| 4 | Hello | =CODE(A4) |

**Result:** Cell B2 returns **65**, cell B3 returns **97**, and cell B4 returns **72** (the code for "H", the first character).
