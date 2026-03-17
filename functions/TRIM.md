# TRIM function

## Introduction

The TRIM function removes all leading and trailing spaces from a text string and reduces any internal runs of multiple spaces to a single space. It does not remove non-breaking spaces (character 160) or other whitespace characters such as tabs and line breaks.

TRIM is invaluable for data cleaning, especially when working with data imported from external sources, databases, or web pages where extra spaces are common. Unwanted spaces can cause lookup functions to fail, text comparisons to return incorrect results, and concatenated strings to appear misaligned.

## Syntax

```
=TRIM(text)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | The text string from which to remove extra spaces. |

## Remarks

- TRIM removes standard space characters (ASCII 32) only. To remove non-breaking spaces (ASCII 160), use SUBSTITUTE to replace CHAR(160) with a regular space first, then apply TRIM.
- Leading spaces, trailing spaces, and consecutive internal spaces are all handled.

## Example

| | A | B |
|---|---|---|
| 1 | **Raw Data** | **Cleaned** |
| 2 | &nbsp;&nbsp;&nbsp;Hello&nbsp;&nbsp;&nbsp;World&nbsp;&nbsp; | =TRIM(A2) |

**Result:** Cell B2 returns **"Hello World"**.

The leading spaces, trailing spaces, and extra internal spaces are all removed, leaving a clean single-spaced string.
