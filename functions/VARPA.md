# VARPA function

## Introduction
The VARPA function calculates variance based on the entire population, including text and logical values. Unlike VARP, which ignores text and logical values in references, VARPA treats TRUE as 1, FALSE as 0, and text as 0.

## Syntax
```
=VARPA(value1, [value2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value1 | Required | The first value, cell reference, or range corresponding to a population. |
| value2, ... | Optional | Additional values, cell references, or ranges. Up to 255 arguments are supported. |

## Remarks
- TRUE is evaluated as 1, FALSE as 0.
- Text values in referenced cells are evaluated as 0.
- Empty cells are ignored.
- Uses the "n" method (population variance).
- For sample variance including text and logical values, use VARA.
- VARPA = STDEVPA^2.

## Example

| | A |
|---|---|
| 1 | **Values** |
| 2 | 10 |
| 3 | TRUE |
| 4 | FALSE |
| 5 | 20 |
| 6 | | |
| 7 | **Formula** | **Result** |
| 8 | =VARPA(A2:A5) | 63.6875 |

**Result:** Approximately 63.6875 (the population variance treating TRUE as 1 and FALSE as 0)
