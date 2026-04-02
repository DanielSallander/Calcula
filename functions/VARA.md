# VARA function

## Introduction
The VARA function estimates variance based on a sample, including text and logical values. Unlike VAR, which ignores text and logical values in references, VARA treats TRUE as 1, FALSE as 0, and text as 0.

## Syntax
```
=VARA(value1, [value2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value1 | Required | The first value, cell reference, or range corresponding to a sample. |
| value2, ... | Optional | Additional values, cell references, or ranges. Up to 255 arguments are supported. |

## Remarks
- TRUE is evaluated as 1, FALSE as 0.
- Text values in referenced cells are evaluated as 0.
- Empty cells are ignored.
- Uses the "n-1" method (sample variance, Bessel's correction).
- For population variance including text and logical values, use VARPA.
- VARA = STDEVA^2.

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
| 8 | =VARA(A2:A5) | 84.9167 |

**Result:** Approximately 84.9167 (the sample variance treating TRUE as 1 and FALSE as 0)
