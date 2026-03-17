# LEFT function

## Introduction

The LEFT function returns a specified number of characters from the beginning (left side) of a text string. It is useful for extracting prefixes, codes, or fixed-width fields from text data.

Common uses include extracting area codes from phone numbers, pulling country codes from product identifiers, isolating the first few characters of account numbers, and parsing fixed-format text data where fields occupy known positions.

## Syntax

```
=LEFT(text, [num_chars])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | The text string from which to extract characters. |
| num_chars | Optional | The number of characters to extract from the left. Defaults to 1 if omitted. |

## Remarks

- num_chars must be greater than or equal to 0. If 0, an empty string is returned.
- If num_chars exceeds the length of text, the entire text string is returned.
- LEFT counts each character as one, including spaces.
- If text is a number, it is treated as text for extraction purposes.

## Example

| | A | B |
|---|---|---|
| 1 | **Product Code** | **Category** |
| 2 | ELC-4821-A | =LEFT(A2, 3) |
| 3 | MEC-9910-B | =LEFT(A3, 3) |

**Result:** Cell B2 returns **"ELC"** and cell B3 returns **"MEC"**.

The function extracts the first 3 characters from each product code, which represent the product category prefix.
