# PEARSON function

## Introduction
The PEARSON function returns the Pearson product-moment correlation coefficient r, which measures the linear dependence between two data sets. It is mathematically identical to the CORREL function.

## Syntax
```
=PEARSON(array1, array2)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array1 | Required | The first range of independent observations. |
| array2 | Required | The second range of dependent observations. |

## Remarks
- array1 and array2 must have the same number of data points; otherwise, returns #N/A.
- If either array is empty or has fewer than 2 data points, returns #DIV/0!.
- Text, logical values, and empty cells are ignored.
- The result ranges from -1 to +1. A value of 0 indicates no linear correlation.
- PEARSON is functionally identical to CORREL.

## Example

| | A | B |
|---|---|---|
| 1 | **Hours Studied** | **Exam Score** |
| 2 | 2 | 65 |
| 3 | 4 | 75 |
| 4 | 6 | 85 |
| 5 | 8 | 90 |
| 6 | 10 | 95 |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =PEARSON(A2:A6, B2:B6) | 0.9868 |

**Result:** Approximately 0.9868 (a very strong positive correlation between study hours and exam scores)
