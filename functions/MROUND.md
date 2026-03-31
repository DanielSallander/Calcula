# MROUND function

## Introduction

The MROUND function rounds a number to the nearest specified multiple. For example, MROUND(7, 5) rounds 7 to the nearest multiple of 5, returning 5.

## Syntax

```
=MROUND(number, multiple)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The value to round. |
| multiple | Required | The multiple to which you want to round number. |

## Remarks

- MROUND rounds up or down to the nearest multiple.
- Number and multiple must have the same sign. If they have different signs, a #VALUE! error is returned.
- If multiple is 0, the result is 0.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Result** |
| 2 | 7 | =MROUND(A2, 5) |
| 3 | 13.25 | =MROUND(A3, 0.5) |
| 4 | -6 | =MROUND(A4, -3) |

**Result:** Cell B2 returns **5**, cell B3 returns **13.5**, and cell B4 returns **-6**.
