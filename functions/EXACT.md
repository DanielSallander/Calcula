# EXACT function

## Introduction

The EXACT function compares two text strings and returns TRUE if they are identical, including case, and FALSE otherwise. Unlike the equals operator (=), which is case-insensitive, EXACT performs a strict case-sensitive comparison.

EXACT is useful for data validation where case matters, such as verifying that passwords match, comparing case-sensitive codes or identifiers, checking that formatted text entries conform to a required pattern, and auditing data for exact matches between two sources.

## Syntax

```
=EXACT(text1, text2)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text1 | Required | The first text string to compare. |
| text2 | Required | The second text string to compare. |

## Remarks

- EXACT is case-sensitive: "Hello" and "hello" are not considered equal.
- EXACT compares characters only. Formatting differences (such as bold or color) are ignored.
- Numbers are converted to text before comparison.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **String 1** | **String 2** | **Match** |
| 2 | Apple | Apple | =EXACT(A2, B2) |
| 3 | Apple | apple | =EXACT(A3, B3) |
| 4 | ABC-100 | ABC-100 | =EXACT(A4, B4) |

**Result:** Cell C2 returns **TRUE**, cell C3 returns **FALSE** (different case), and cell C4 returns **TRUE**.

The case-sensitive comparison in row 3 detects that "Apple" and "apple" differ in their first character's casing.
