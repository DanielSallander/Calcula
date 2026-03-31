# UNICODE function

## Introduction

The UNICODE function returns the Unicode code point (number) for the first character of a text string. This is the Unicode equivalent of the CODE function.

## Syntax

```
=UNICODE(text)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | The text string whose first character's code point is returned. |

## Remarks

- Only the first character of the text string is evaluated.
- If text is empty, a #VALUE! error is returned.

## Example

| | A | B |
|---|---|---|
| 1 | **Text** | **Code** |
| 2 | A | =UNICODE(A2) |
| 3 | Hello | =UNICODE(A3) |

**Result:** Cell B2 returns **65** and cell B3 returns **72** (the code for "H").
