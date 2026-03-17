# MID function

## Introduction

The MID function returns a specific number of characters from a text string, starting at a position you specify. Unlike LEFT and RIGHT, which extract from the ends of a string, MID can extract characters from any position within the text.

MID is essential for parsing structured text data where the information you need is embedded in the middle of a string. Common uses include extracting month or day components from date strings, pulling middle portions of serial numbers, and reading specific fields from fixed-width formatted data.

## Syntax

```
=MID(text, start_num, num_chars)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | The text string from which to extract characters. |
| start_num | Required | The position of the first character to extract. The first character in text has a start_num of 1. |
| num_chars | Required | The number of characters to extract. |

## Remarks

- If start_num is greater than the length of text, MID returns an empty string.
- If start_num is less than 1, MID returns a #VALUE! error.
- If num_chars is negative, MID returns a #VALUE! error.
- If start_num plus num_chars exceeds the length of text, MID returns all characters from start_num to the end of the string.

## Example

| | A | B |
|---|---|---|
| 1 | **Serial Number** | **Batch Code** |
| 2 | PRD-2024-0817-X | =MID(A2, 5, 4) |
| 3 | PRD-2023-1130-Y | =MID(A3, 5, 4) |

**Result:** Cell B2 returns **"2024"** and cell B3 returns **"2023"**.

The function starts at position 5 (after "PRD-") and extracts 4 characters, which represent the year portion of the serial number.
