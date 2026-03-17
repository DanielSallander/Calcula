# SUBSTITUTE function

## Introduction

The SUBSTITUTE function replaces occurrences of a specified text string with a new text string. You can optionally specify which occurrence to replace; if omitted, all occurrences are replaced. SUBSTITUTE is case-sensitive in its matching.

SUBSTITUTE is particularly useful for cleaning and transforming text data, such as removing unwanted characters, replacing delimiters, correcting misspellings, and standardizing formatting. Unlike REPLACE, which works by character position, SUBSTITUTE works by matching the actual text content, making it more intuitive when you know what text to change but not its exact position.

## Syntax

```
=SUBSTITUTE(text, old_text, new_text, [instance_num])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | The text string or cell reference containing text in which to make substitutions. |
| old_text | Required | The text to find and replace. Case-sensitive. |
| new_text | Required | The replacement text. |
| instance_num | Optional | Specifies which occurrence of old_text to replace. If omitted, all occurrences are replaced. |

## Remarks

- SUBSTITUTE is case-sensitive: "ABC" and "abc" are treated as different strings.
- If old_text is not found in text, the original text is returned unchanged.
- instance_num must be a positive integer. If specified, only that particular occurrence is replaced.

## Example

| | A | B |
|---|---|---|
| 1 | **Original** | **Updated** |
| 2 | 2023/01/15 | =SUBSTITUTE(A2, "/", "-") |
| 3 | Q1-Q2-Q3-Q4 | =SUBSTITUTE(A3, "-", ", ", 2) |

**Result:** Cell B2 returns **"2023-01-15"** (all slashes replaced with dashes). Cell B3 returns **"Q1-Q2, Q3-Q4"** (only the second hyphen is replaced with a comma and space).

In the first example, all occurrences of "/" are replaced. In the second example, only the second occurrence of "-" is replaced because instance_num is set to 2.
