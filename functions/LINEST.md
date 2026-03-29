# LINEST function

## Introduction
The LINEST function performs linear regression and returns an array of statistics describing the best-fit straight line (y = mx + b) through the data. It provides slope, intercept, and optionally R-squared, standard errors, and F-statistic.

## Syntax
```
=LINEST(known_y's, [known_x's], [const], [stats])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| known_y's | Required | The set of known y-values. |
| known_x's | Optional | The set of known x-values. Defaults to {1, 2, 3, ...}. |
| const | Optional | TRUE or omitted = calculate intercept normally, FALSE = force intercept to 0. |
| stats | Optional | FALSE or omitted = return only slope and intercept, TRUE = return full regression statistics. |

## Remarks
- With stats=FALSE, returns a 1-row array: {slope, intercept}.
- With stats=TRUE, returns a 5-row array: row 1 = coefficients, row 2 = standard errors, row 3 = R-squared and standard error of y, row 4 = F-statistic and degrees of freedom, row 5 = regression SS and residual SS.
- For multiple regression, known_x's can have multiple columns; the result includes one slope per variable.

## Example

| | A | B |
|---|---|---|
| 1 | **X** | **Y** |
| 2 | 1 | 3 |
| 3 | 2 | 5 |
| 4 | 3 | 7 |
| 5 | **Result** | =LINEST(B2:B4, A2:A4) |

**Result:** {2, 1} (slope = 2, intercept = 1, i.e., y = 2x + 1)
