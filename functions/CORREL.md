# CORREL function

## Introduction
The CORREL function returns the Pearson correlation coefficient between two data sets. The correlation coefficient measures the strength and direction of the linear relationship between two variables, ranging from -1 (perfect negative correlation) to +1 (perfect positive correlation).

## Syntax
```
=CORREL(array1, array2)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array1 | Required | The first range of values. |
| array2 | Required | The second range of values. |

## Remarks
- array1 and array2 must have the same number of data points; otherwise, returns #N/A.
- If either array is empty or contains fewer than 2 data points, returns #DIV/0!.
- Text, logical values, and empty cells are ignored. Only cells containing numbers in both arrays at the same position are included.
- CORREL is equivalent to PEARSON.
- A value near 0 indicates no linear relationship.

## Example

| | A | B |
|---|---|---|
| 1 | **Temperature** | **Ice Cream Sales** |
| 2 | 20 | 100 |
| 3 | 25 | 150 |
| 4 | 30 | 200 |
| 5 | 35 | 280 |
| 6 | 40 | 350 |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =CORREL(A2:A6, B2:B6) | 0.9945 |

**Result:** Approximately 0.9945 (a very strong positive linear relationship between temperature and ice cream sales)
