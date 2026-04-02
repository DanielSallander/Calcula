# T.TEST function

## Introduction
The T.TEST function returns the probability associated with a Student's t-test. It determines whether two samples are likely to come from populations with the same mean, making it a key tool for comparing group means in statistical analysis.

## Syntax
```
=T.TEST(array1, array2, tails, type)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array1 | Required | The first data set. |
| array2 | Required | The second data set. |
| tails | Required | 1 for a one-tailed test, 2 for a two-tailed test. |
| type | Required | 1 = paired t-test, 2 = two-sample equal variance (homoscedastic), 3 = two-sample unequal variance (heteroscedastic). |

## Remarks
- If tails is not 1 or 2, returns #NUM!.
- If type is not 1, 2, or 3, returns #NUM!.
- For a paired test (type=1), array1 and array2 must have the same number of data points.
- Text, logical values, and empty cells in the arrays are ignored.
- If an array has fewer than 2 data points, returns #N/A.

## Example

| | A | B |
|---|---|---|
| 1 | **Before** | **After** |
| 2 | 78 | 82 |
| 3 | 85 | 88 |
| 4 | 90 | 92 |
| 5 | 72 | 79 |
| 6 | 81 | 85 |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =T.TEST(A2:A6, B2:B6, 2, 1) | 0.0036 |

**Result:** Approximately 0.0036 (the two-tailed p-value for a paired t-test, suggesting a statistically significant difference between the before and after scores)
