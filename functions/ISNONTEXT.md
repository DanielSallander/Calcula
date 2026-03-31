# ISNONTEXT function

## Introduction

The ISNONTEXT function returns TRUE if the value is not text. This includes numbers, logical values, errors, and empty cells. It is the inverse of ISTEXT.

## Syntax

```
=ISNONTEXT(value)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value | Required | The value to check. Can be a cell reference, number, text, or any other value. |

## Remarks

- Returns TRUE for numbers, logical values, errors, and empty cells.
- Returns FALSE only for text values.
- This is the opposite of the ISTEXT function.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Is Non-Text?** |
| 2 | 42 | =ISNONTEXT(A2) |
| 3 | Hello | =ISNONTEXT(A3) |
| 4 | TRUE | =ISNONTEXT(A4) |

**Result:** Cell B2 returns **TRUE**, cell B3 returns **FALSE**, and cell B4 returns **TRUE**.
