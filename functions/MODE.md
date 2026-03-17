# MODE function

## Introduction

The MODE function returns the most frequently occurring, or repetitive, value in a range of data. MODE is useful when you want to find the most common value in a data set, such as the most popular product size, the most common defect count, or the most frequent rating given by customers.

When analyzing survey responses or categorical numeric data, MODE provides a quick way to identify the value that appears most often. Unlike AVERAGE and MEDIAN, which describe the center of a distribution, MODE identifies the peak -- the most "popular" value.

## Syntax

```
=MODE(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range for which you want to calculate the mode. |
| number2, ... | Optional | Additional numbers, cell references, or ranges. Up to 255 arguments are supported. |

### Remarks

- Arguments can be numbers, names, or references that contain numbers.
- If a cell reference argument contains text, logical values, or empty cells, those values are ignored.
- If the data set contains no duplicate values (no value appears more than once), MODE returns the #N/A error.
- If multiple values occur with the same highest frequency (a multimodal data set), MODE returns the first such value encountered.
- Arguments that are error values or text that cannot be translated into numbers cause errors.

## Example

| | A | B |
|---|---|---|
| 1 | **Customer Rating (1-5)** | |
| 2 | 4 | |
| 3 | 5 | |
| 4 | 3 | |
| 5 | 4 | |
| 6 | 4 | |
| 7 | 5 | |
| 8 | 3 | |
| 9 | 4 | |
| 10 | | |
| 11 | **Formula** | **Result** |
| 12 | =MODE(A2:A9) | 4 |

**Result:** 4

The rating of 4 appears four times, which is more than any other rating. This tells the business that the most common customer sentiment is a 4 out of 5 rating.
