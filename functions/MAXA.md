# MAXA function

## Introduction
The MAXA function returns the largest value in a set of values, including logical values and text. Unlike MAX, which ignores text and logical values in references, MAXA treats TRUE as 1, FALSE as 0, and text as 0.

## Syntax
```
=MAXA(value1, [value2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value1 | Required | The first value, cell reference, or range to examine. |
| value2, ... | Optional | Additional values, cell references, or ranges. Up to 255 arguments are supported. |

## Remarks
- TRUE is evaluated as 1, FALSE as 0.
- Text values in referenced cells are evaluated as 0.
- Empty cells are ignored.
- If the arguments contain no values, MAXA returns 0.
- Use MAX if you want to ignore text and logical values in references.

## Example

| | A |
|---|---|
| 1 | **Values** |
| 2 | -5 |
| 3 | TRUE |
| 4 | -3 |
| 5 | Text |
| 6 | | |
| 7 | **Formula** | **Result** |
| 8 | =MAXA(A2:A5) | 1 |

**Result:** 1 (TRUE is treated as 1, which is the largest value among -5, 1, -3, and 0)
