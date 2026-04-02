# INTERCEPT function

## Introduction
The INTERCEPT function returns the y-intercept of the linear regression line through the given data points. The intercept is the predicted value of y when x equals zero.

## Syntax
```
=INTERCEPT(known_y's, known_x's)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| known_y's | Required | The dependent data points (array or range). |
| known_x's | Required | The independent data points (array or range). |

## Remarks
- The two arrays must have the same number of data points; otherwise, returns #N/A.
- If either array is empty, returns #DIV/0!.
- Text, logical values, and empty cells are ignored.
- The intercept is calculated using the least squares method.
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
| 9 | =INTERCEPT(B2:B6, A2:A6) | 77 |

**Result:** 77 (when month is 0, the predicted sales would be 77 units)
