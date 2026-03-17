# MEDIAN function

## Introduction

The MEDIAN function returns the median (middle value) of a set of numbers. The median is the number in the middle of a sorted list of values -- half the numbers are greater than the median and half are less.

MEDIAN is useful when you want a measure of central tendency that is not affected by extreme values (outliers). For example, if you are analyzing household incomes in a region, the median gives a more representative "typical" value than the average, because a few very high incomes can skew the average significantly upward.

## Syntax

```
=MEDIAN(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range for which you want the median. |
| number2, ... | Optional | Additional numbers, cell references, or ranges. Up to 255 arguments are supported. |

### Remarks

- If the total number of values is odd, MEDIAN returns the middle value.
- If the total number of values is even, MEDIAN returns the average of the two middle values.
- Arguments can be numbers, names, or references that contain numbers.
- Logical values and text representations of numbers typed directly into the argument list are counted.
- If a cell reference argument contains text, logical values, or empty cells, those values are ignored.
- Arguments that are error values or text that cannot be translated into numbers cause errors.

## Example

| | A | B |
|---|---|---|
| 1 | **Test Scores** | |
| 2 | 72 | |
| 3 | 85 | |
| 4 | 90 | |
| 5 | 88 | |
| 6 | 95 | |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =MEDIAN(A2:A6) | 88 |

**Result:** 88

The five test scores sorted are 72, 85, 88, 90, 95. Since there is an odd number of values, the median is the middle value: 88.

If there were an even number of scores, for example =MEDIAN(72, 85, 90, 95), the result would be 87.5 (the average of 85 and 90).
