# F.TEST function

## Introduction
The F.TEST function returns the p-value of an F-test, which compares the variances of two data sets. It determines whether two samples have significantly different variances, which is useful before performing a t-test that assumes equal variances.

## Syntax
```
=F.TEST(array1, array2)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array1 | Required | The first array or range of data. |
| array2 | Required | The second array or range of data. |

## Remarks
- If either array has fewer than 2 data points, returns #DIV/0!.
- Text, logical values, and empty cells in the arrays are ignored.
- F.TEST returns the two-tailed probability that the variances of array1 and array2 are not significantly different.
- A small p-value (e.g., < 0.05) suggests the variances are significantly different.

## Example

| | A | B |
|---|---|---|
| 1 | **Group A** | **Group B** |
| 2 | 6 | 8 |
| 3 | 7 | 5 |
| 4 | 9 | 10 |
| 5 | 5 | 7 |
| 6 | 8 | 9 |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =F.TEST(A2:A6, B2:B6) | 0.6489 |

**Result:** Approximately 0.6489 (the variances of the two groups are not significantly different)
