# STEYX function

## Introduction
The STEYX function returns the standard error of the predicted y-value for each x in a linear regression. It measures the amount of error in the prediction of y for an individual x, providing a gauge of the accuracy of the regression model.

## Syntax
```
=STEYX(known_y's, known_x's)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| known_y's | Required | The dependent data points (array or range). |
| known_x's | Required | The independent data points (array or range). |

## Remarks
- The two arrays must have the same number of data points; otherwise, returns #N/A.
- Requires at least 3 data points; otherwise, returns #DIV/0!.
- Text, logical values, and empty cells are ignored.
- A smaller STEYX value indicates a better fit of the regression line to the data.

## Example

| | A | B |
|---|---|---|
| 1 | **X** | **Y** |
| 2 | 1 | 3.1 |
| 3 | 2 | 5.8 |
| 4 | 3 | 7.2 |
| 5 | 4 | 10.5 |
| 6 | 5 | 12.1 |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =STEYX(B2:B6, A2:A6) | 0.5765 |

**Result:** Approximately 0.5765 (the standard error of the regression estimate)
