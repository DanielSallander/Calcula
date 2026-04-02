# FORECAST.LINEAR function

## Introduction
The FORECAST.LINEAR function predicts a future value along a linear trend by using existing values. It calculates the predicted y-value for a given x-value using a linear regression of the known data points.

## Syntax
```
=FORECAST.LINEAR(x, known_y's, known_x's)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The data point for which to predict a value. |
| known_y's | Required | The dependent array or range of data (known y-values). |
| known_x's | Required | The independent array or range of data (known x-values). |

## Remarks
- known_y's and known_x's must have the same number of data points; otherwise, returns #N/A.
- If the variance of known_x's is zero, returns #DIV/0!.
- Text, logical values, and empty cells are ignored.
- The prediction is based on the linear regression: y = SLOPE * x + INTERCEPT.
- This function replaces the older FORECAST function.

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
| 9 | =FORECAST.LINEAR(6, B2:B6, A2:A6) | 203 |

**Result:** 203 (the predicted sales for month 6 based on the linear trend)
