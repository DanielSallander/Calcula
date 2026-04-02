# RSQ function

## Introduction
The RSQ function returns the square of the Pearson product-moment correlation coefficient (R-squared or coefficient of determination). R-squared indicates what proportion of the variance in the dependent variable is explained by the independent variable in a linear regression.

## Syntax
```
=RSQ(known_y's, known_x's)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| known_y's | Required | The dependent data points (array or range). |
| known_x's | Required | The independent data points (array or range). |

## Remarks
- The two arrays must have the same number of data points; otherwise, returns #N/A.
- If either array is empty, returns #DIV/0!.
- Text, logical values, and empty cells are ignored.
- RSQ = CORREL(known_y's, known_x's)^2.
- An R-squared of 1 means the regression perfectly fits the data; 0 means no linear relationship.

## Example

| | A | B |
|---|---|---|
| 1 | **Advertising ($)** | **Revenue ($)** |
| 2 | 1000 | 5000 |
| 3 | 2000 | 7500 |
| 4 | 3000 | 10200 |
| 5 | 4000 | 12800 |
| 6 | 5000 | 15100 |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =RSQ(B2:B6, A2:A6) | 0.9990 |

**Result:** Approximately 0.9990 (99.9% of the variance in revenue is explained by advertising spend)
