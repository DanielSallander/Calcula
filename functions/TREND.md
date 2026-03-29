# TREND function

## Introduction
The TREND function returns values along a linear trend by performing least-squares regression. It can predict new y-values based on known data points, making it useful for forecasting sales, growth, or any linear relationship.

## Syntax
```
=TREND(known_y's, [known_x's], [new_x's], [const])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| known_y's | Required | The set of known y-values (dependent variable). |
| known_x's | Optional | The set of known x-values (independent variable). Defaults to {1, 2, 3, ...}. |
| new_x's | Optional | New x-values for which to predict y-values. Defaults to known_x's. |
| const | Optional | TRUE or omitted = calculate the y-intercept normally, FALSE = force y-intercept to 0. |

## Remarks
- Returns an array of predicted y-values that spills.
- Can handle multiple independent variables (multiple regression) when known_x's has multiple columns.
- If known_y's and known_x's have different dimensions, returns #REF!.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Month** | **Sales** | **Predicted** |
| 2 | 1 | 100 | =TREND(B2:B5, A2:A5, A2:A6) |
| 3 | 2 | 150 | |
| 4 | 3 | 180 | |
| 5 | 4 | 220 | |
| 6 | 5 | | |

**Result:** Predicted values along the best-fit line, including a forecast for month 5
