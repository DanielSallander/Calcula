# AVERAGEA function

## Introduction
The AVERAGEA function calculates the average of its arguments, including text and logical values. Unlike AVERAGE, which ignores text and logical values in references, AVERAGEA treats TRUE as 1, FALSE as 0, and text as 0.

## Syntax
```
=AVERAGEA(value1, [value2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value1 | Required | The first value, cell reference, or range for which to calculate the average. |
| value2, ... | Optional | Additional values, cell references, or ranges. Up to 255 arguments are supported. |

## Remarks
- TRUE is evaluated as 1, FALSE as 0.
- Text values in referenced cells are evaluated as 0.
- Empty cells are ignored.
- Arguments that contain error values cause AVERAGEA to return an error.
- Text typed directly into the argument list (e.g., "hello") causes a #VALUE! error.

## Example

| | A |
|---|---|
| 1 | **Values** |
| 2 | 10 |
| 3 | TRUE |
| 4 | FALSE |
| 5 | Text |
| 6 | 20 |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =AVERAGEA(A2:A6) | 6.2 |

**Result:** 6.2 (calculated as (10 + 1 + 0 + 0 + 20) / 5 = 31/5)
