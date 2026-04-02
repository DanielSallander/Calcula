# STDEVA function

## Introduction
The STDEVA function estimates the standard deviation based on a sample, including text and logical values. Unlike STDEV, which ignores text and logical values in references, STDEVA treats TRUE as 1, FALSE as 0, and text as 0.

## Syntax
```
=STDEVA(value1, [value2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value1 | Required | The first value, cell reference, or range corresponding to a sample. |
| value2, ... | Optional | Additional values, cell references, or ranges. Up to 255 arguments are supported. |

## Remarks
- TRUE is evaluated as 1, FALSE as 0.
- Text values in referenced cells are evaluated as 0.
- Empty cells are ignored.
- Uses the "n-1" method (sample standard deviation).
- For population standard deviation including text and logical values, use STDEVPA.

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
| 8 | =STDEVA(A2:A5) | 9.2154 |

**Result:** Approximately 9.2154 (the sample standard deviation treating TRUE as 1 and FALSE as 0)
