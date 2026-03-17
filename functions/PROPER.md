# PROPER function

## Introduction

The PROPER function capitalizes the first letter of each word in a text string and converts all other letters to lowercase. A "word" is defined as any sequence of characters following a space or non-alphabetic character. This provides a quick way to convert text to title case.

PROPER is commonly used to standardize names and addresses that were entered in all caps or all lowercase, clean up imported customer data, and format titles or headings. Note that PROPER may over-capitalize certain words (such as "of", "the", or "and") and may incorrectly capitalize letters after apostrophes (e.g., "O'Brien" would correctly become "O'Brien", but "mcdonald" becomes "Mcdonald" rather than "McDonald").

## Syntax

```
=PROPER(text)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | The text string to convert to proper case. Can be a cell reference, text value, or formula that returns text. |

## Remarks

- Numbers and non-alphabetic characters are not changed, but they act as word boundaries.
- PROPER always capitalizes the character immediately following a non-letter character, which may produce unexpected results for names like "McDonald" or acronyms.

## Example

| | A | B |
|---|---|---|
| 1 | **Input** | **Proper Case** |
| 2 | JOHN SMITH | =PROPER(A2) |
| 3 | new york city | =PROPER(A3) |
| 4 | 123 main street | =PROPER(A4) |

**Result:** Cell B2 returns **"John Smith"**, cell B3 returns **"New York City"**, and cell B4 returns **"123 Main Street"**.
