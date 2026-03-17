# UPPER function

## Introduction

The UPPER function converts all lowercase letters in a text string to uppercase. Non-alphabetic characters such as numbers, spaces, and punctuation are not affected. This function is useful for standardizing text data to a consistent case format.

Common uses include normalizing user input for consistent storage, preparing text for case-sensitive comparisons, formatting codes and identifiers to uppercase conventions, and cleaning imported data where casing is inconsistent.

## Syntax

```
=UPPER(text)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | The text string to convert to uppercase. Can be a cell reference, text value, or formula that returns text. |

## Remarks

- Numbers and non-alphabetic characters within the text are not changed.
- UPPER does not affect characters that are already uppercase.

## Example

| | A | B |
|---|---|---|
| 1 | **Input** | **Uppercase** |
| 2 | john smith | =UPPER(A2) |
| 3 | Order-4521a | =UPPER(A3) |

**Result:** Cell B2 returns **"JOHN SMITH"** and cell B3 returns **"ORDER-4521A"**.

All lowercase letters are converted to uppercase while numbers, hyphens, and spaces remain unchanged.
