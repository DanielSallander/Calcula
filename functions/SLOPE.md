# SLOPE function

## Introduction
The SLOPE function returns the slope of the linear regression line through the given data points. The slope represents the rate of change of the dependent variable per unit change in the independent variable.

## Syntax
```
=SLOPE(known_y's, known_x's)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| known_y's | Required | The dependent data points (array or range). |
| known_x's | Required | The independent data points (array or range). |

## Remarks
- The two arrays must have the same number of data points; otherwise, returns #N/A.
- If either array is empty, returns #DIV/0!.
- Text, logical values, and empty cells are ignored.
- The slope is calculated using the least squares method.
- The regression equation is: y = SLOPE * x + INTERCEPT.

## Example

| | A | B |
|---|---|---|
| 1 | **Month** | **Sales** |
| 2 | 1 | 100 |
| 3 | 2 | 120 |
| 4 | 3 | 145 |
| 5 | 4 | 160 |
| 6 | 5 | 185 |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =SLOPE(B2:B6, A2:A6) | 21 |

**Result:** 21 (sales increase by approximately 21 units per month)
