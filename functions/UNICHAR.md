# UNICHAR function

## Introduction

The UNICHAR function returns the Unicode character for a given numeric code point. This is the Unicode equivalent of the CHAR function, supporting the full Unicode range.

## Syntax

```
=UNICHAR(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The Unicode code point of the character to return. |

## Remarks

- If the number does not correspond to a valid Unicode character, a #VALUE! error is returned.
- Common code points: 65 = "A", 8364 = euro sign, 9829 = heart symbol.

## Example

| | A | B |
|---|---|---|
| 1 | **Code** | **Character** |
| 2 | 65 | =UNICHAR(A2) |
| 3 | 8364 | =UNICHAR(A3) |

**Result:** Cell B2 returns **"A"** and cell B3 returns the euro sign.
