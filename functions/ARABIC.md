# ARABIC function

## Introduction

The ARABIC function converts a Roman numeral text string to an Arabic numeral. This is the inverse of the ROMAN function.

## Syntax

```
=ARABIC(text)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | A string containing a Roman numeral (e.g., "MCMXCIV"). |

## Remarks

- The function is case-insensitive ("mcmxciv" and "MCMXCIV" both work).
- If text is an empty string, 0 is returned.
- A leading minus sign is supported for negative values (e.g., "-X" returns -10).
- If text contains invalid characters, a #VALUE! error is returned.

## Example

| | A | B |
|---|---|---|
| 1 | **Roman** | **Arabic** |
| 2 | MCMXCIV | =ARABIC(A2) |
| 3 | XLII | =ARABIC(A3) |

**Result:** Cell B2 returns **1994** and cell B3 returns **42**.
