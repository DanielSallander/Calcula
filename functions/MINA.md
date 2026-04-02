# MINA function

## Introduction
The MINA function returns the smallest value in a set of values, including logical values and text. Unlike MIN, which ignores text and logical values in references, MINA treats TRUE as 1, FALSE as 0, and text as 0.

## Syntax
```
=MINA(value1, [value2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value1 | Required | The first value, cell reference, or range to examine. |
| value2, ... | Optional | Additional values, cell references, or ranges. Up to 255 arguments are supported. |

## Remarks
- TRUE is evaluated as 1, FALSE as 0.
- Text values in referenced cells are evaluated as 0.
- Empty cells are ignored.
- If the arguments contain no values, MINA returns 0.
- Use MIN if you want to ignore text and logical values in references.

## Example

| | A |
|---|---|
| 1 | **Values** |
| 2 | 5 |
| 3 | TRUE |
| 4 | 3 |
| 5 | Text |
| 6 | | |
| 7 | **Formula** | **Result** |
| 8 | =MINA(A2:A5) | 0 |

**Result:** 0 (text is treated as 0, which is the smallest value among 5, 1, 3, and 0)
