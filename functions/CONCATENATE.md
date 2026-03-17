# CONCATENATE function

## Introduction

The CONCATENATE function joins two or more text strings into a single string. It is one of the most fundamental text manipulation functions, enabling you to combine values from different cells, insert separators, and build dynamic labels or identifiers from component parts.

Common uses include combining first and last names into a full name, building file paths or URLs from components, creating composite keys for lookups, and assembling formatted strings from mixed data. Note that the ampersand operator (&) can also be used to join text and is often more concise for simple cases.

## Syntax

```
=CONCATENATE(text1, [text2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text1 | Required | The first text string, cell reference, or value to join. |
| text2, ... | Optional | Additional text strings to join. Up to 255 arguments can be provided. |

## Remarks

- Numbers and dates are automatically converted to text when used as arguments.
- CONCATENATE does not automatically add spaces or separators between strings. You must include them explicitly (e.g., `" "`).
- If any argument is an error value, CONCATENATE returns that error.
- The ampersand operator (&) provides equivalent functionality: `=A1 & " " & B1` is the same as `=CONCATENATE(A1, " ", B1)`.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **First Name** | **Last Name** | **Full Name** |
| 2 | John | Smith | =CONCATENATE(A2, " ", B2) |
| 3 | Maria | Garcia | =CONCATENATE(A3, " ", B3) |

**Result:** Cell C2 returns **"John Smith"** and cell C3 returns **"Maria Garcia"**.

The function joins the first name, a space character, and the last name into a single text string.
