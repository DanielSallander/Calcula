# LOWER function

## Introduction

The LOWER function converts all uppercase letters in a text string to lowercase. Non-alphabetic characters such as numbers, spaces, and punctuation are not affected. It is the counterpart of the UPPER function and is useful for normalizing text to a consistent lowercase format.

Common uses include standardizing email addresses, creating URL-friendly slugs, normalizing search terms for case-insensitive matching, and cleaning data imported from systems that store text in all caps.

## Syntax

```
=LOWER(text)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | The text string to convert to lowercase. Can be a cell reference, text value, or formula that returns text. |

## Remarks

- Numbers and non-alphabetic characters within the text are not changed.
- LOWER does not affect characters that are already lowercase.

## Example

| | A | B |
|---|---|---|
| 1 | **Input** | **Lowercase** |
| 2 | JOHN.SMITH@EXAMPLE.COM | =LOWER(A2) |
| 3 | Mixed Case TEXT | =LOWER(A3) |

**Result:** Cell B2 returns **"john.smith@example.com"** and cell B3 returns **"mixed case text"**.

All uppercase letters are converted to lowercase while punctuation, numbers, and spaces remain unchanged.
