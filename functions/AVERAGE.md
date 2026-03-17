# AVERAGE function

## Introduction
The AVERAGE function returns the arithmetic mean of its arguments. It divides the sum of all numeric values by the count of those values. This function is widely used in data analysis, performance tracking, and reporting to determine central tendency.

Common applications include calculating average test scores, mean monthly revenue, average order value, and typical processing times.

## Syntax
```
=AVERAGE(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range for which you want the average. |
| number2, ... | Optional | Additional numbers, cell references, or ranges. Up to 255 arguments. |

## Remarks
- Cells containing text, logical values, or empty cells within a range reference are ignored.
- If a text or logical value is typed directly as an argument, it causes a #VALUE! error.
- If no cells contain numeric values, AVERAGE returns a #DIV/0! error.
- AVERAGE counts each cell with a numeric value, so zeros are included in both the sum and the count.

## Example

| | A | B |
|---|---|---|
| 1 | **Month** | **Revenue** |
| 2 | January | 42000 |
| 3 | February | 38500 |
| 4 | March | 45200 |
| 5 | April | 41000 |
| 6 | **Average** | =AVERAGE(B2:B5) |

**Result:** 41675

The formula calculates the mean monthly revenue across four months: (42000 + 38500 + 45200 + 41000) / 4.
