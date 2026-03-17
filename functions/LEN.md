# LEN function

## Introduction

The LEN function returns the number of characters in a text string, including spaces and punctuation. It provides a simple way to measure the length of any text value, which is fundamental to many text processing tasks.

LEN is frequently used in data validation to ensure inputs meet length requirements (such as postal codes or phone numbers), in combination with other text functions like MID and RIGHT to calculate dynamic positions, and to identify cells with unexpected content lengths during data cleaning.

## Syntax

```
=LEN(text)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | The text string whose length you want to determine. Spaces count as characters. |

## Remarks

- Spaces are counted as characters.
- If text is a number, it is first converted to text, and then its character count is returned.
- If text is an empty cell, LEN returns 0.

## Example

| | A | B |
|---|---|---|
| 1 | **Input** | **Length** |
| 2 | Hello World | =LEN(A2) |
| 3 | 12345 | =LEN(A3) |
| 4 | | =LEN(A4) |

**Result:** Cell B2 returns **11** (including the space), cell B3 returns **5**, and cell B4 returns **0** (empty cell).
