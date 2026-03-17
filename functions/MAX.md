# MAX function

## Introduction
The MAX function returns the largest numeric value from a set of values or a range of cells. It is commonly used to find peak values in datasets, such as the highest sales figure, the maximum temperature recorded, or the top score in an assessment.

MAX ignores empty cells, text, and logical values within range references, focusing exclusively on numeric data.

## Syntax
```
=MAX(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range to examine. |
| number2, ... | Optional | Additional numbers, references, or ranges. Up to 255 arguments. |

## Remarks
- Text and logical values in cell references are ignored.
- If arguments contain no numeric values, MAX returns 0.
- Error values in arguments cause MAX to return an error.
- Logical values and text representations of numbers typed directly as arguments are evaluated.

## Example

| | A | B |
|---|---|---|
| 1 | **Month** | **Units Sold** |
| 2 | January | 340 |
| 3 | February | 285 |
| 4 | March | 410 |
| 5 | April | 395 |
| 6 | **Peak Month** | =MAX(B2:B5) |

**Result:** 410

The formula returns 410, the highest number of units sold across the four months (March).
