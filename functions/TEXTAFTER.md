# TEXTAFTER function

## Introduction
The TEXTAFTER function returns the text that occurs after a specified delimiter. It is useful for extracting the latter portion of text strings, such as getting a last name from a full name or extracting a file extension from a filename.

## Syntax
```
=TEXTAFTER(text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | The text string to search within. |
| delimiter | Required | The delimiter to search for. Can be an array of delimiters. |
| instance_num | Optional | Which instance of the delimiter to match. Default is 1. Negative values search from the end. |
| match_mode | Optional | 0 = case-sensitive (default), 1 = case-insensitive. |
| match_end | Optional | 0 = do not match start of text (default), 1 = treat start of text as a delimiter. |
| if_not_found | Optional | Value to return if delimiter is not found. Default is #N/A. |

## Remarks
- Returns #N/A if the delimiter is not found and if_not_found is not specified.
- An instance_num of 0 returns #VALUE!.
- Negative instance_num counts from the end of the string.

## Example

| | A | B |
|---|---|---|
| 1 | **Email** | **Domain** |
| 2 | user@example.com | =TEXTAFTER(A2, "@") |

**Result:** "example.com"
