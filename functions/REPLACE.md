# REPLACE function

## Introduction

The REPLACE function replaces a specified number of characters within a text string with a new text string, based on a starting position. Unlike SUBSTITUTE, which finds and replaces specific text content, REPLACE works by character position, making it ideal when you know exactly where in the string the replacement should occur.

REPLACE is useful for modifying fixed-format data, such as masking portions of account numbers, updating specific segments of structured codes, or inserting characters at known positions within a string.

## Syntax

```
=REPLACE(old_text, start_num, num_chars, new_text)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| old_text | Required | The original text string in which to replace characters. |
| start_num | Required | The position of the first character to replace. The first character is position 1. |
| num_chars | Required | The number of characters to replace, starting from start_num. |
| new_text | Required | The text to insert in place of the removed characters. |

## Remarks

- If start_num is less than 1, REPLACE returns a #VALUE! error.
- If num_chars is negative, REPLACE returns a #VALUE! error.
- Setting num_chars to 0 inserts new_text at the start_num position without removing any characters.
- If start_num exceeds the length of old_text, new_text is appended at the end.

## Example

| | A | B |
|---|---|---|
| 1 | **Account Number** | **Masked** |
| 2 | 4532-8821-0045 | =REPLACE(A2, 1, 9, "****-****") |
| 3 | 7710-3349-1122 | =REPLACE(A3, 1, 9, "****-****") |

**Result:** Cell B2 returns **"****-****-0045"** and cell B3 returns **"****-****-1122"**.

The first 9 characters of each account number are replaced with a masked pattern, leaving only the last segment visible for identification.
