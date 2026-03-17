# RIGHT function

## Introduction

The RIGHT function returns a specified number of characters from the end (right side) of a text string. It is the counterpart of the LEFT function and is useful for extracting suffixes, trailing codes, or the last portion of fixed-format data.

Common uses include extracting file extensions from filenames, pulling the last digits of an account number, isolating check digits, and reading version suffixes from identifiers.

## Syntax

```
=RIGHT(text, [num_chars])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | The text string from which to extract characters. |
| num_chars | Optional | The number of characters to extract from the right. Defaults to 1 if omitted. |

## Remarks

- num_chars must be greater than or equal to 0. If 0, an empty string is returned.
- If num_chars exceeds the length of text, the entire text string is returned.
- RIGHT counts each character as one, including spaces.

## Example

| | A | B |
|---|---|---|
| 1 | **Filename** | **Extension** |
| 2 | report.pdf | =RIGHT(A2, 3) |
| 3 | data.xlsx | =RIGHT(A3, 4) |

**Result:** Cell B2 returns **"pdf"** and cell B3 returns **"xlsx"**.

The function extracts the file extension characters from the right side of each filename string.
