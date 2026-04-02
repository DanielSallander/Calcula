# T.INV.2T function

## Introduction
The T.INV.2T function returns the two-tailed inverse of the Student's t-distribution. Given a probability and degrees of freedom, it returns the positive t-value t such that the probability of falling outside the range [-t, t] equals the given probability.

## Syntax
```
=T.INV.2T(probability, deg_freedom)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| probability | Required | The two-tailed probability associated with the t-distribution. Must be between 0 and 1 (exclusive). |
| deg_freedom | Required | The number of degrees of freedom. Must be a positive integer >= 1. |

## Remarks
- If probability is <= 0 or >= 1, returns #NUM!.
- If deg_freedom is less than 1, returns #NUM!.
- deg_freedom is truncated to an integer.
- T.INV.2T always returns a positive value.
- T.INV.2T(p, df) = T.INV(1 - p/2, df).
- Commonly used to find critical values for two-tailed t-tests and confidence intervals.

## Example

| | A | B |
|---|---|---|
| 1 | **Probability** | **Critical t-Value** |
| 2 | 0.05 | =T.INV.2T(A2, 20) |

**Result:** Approximately 2.0860 (the critical value for a two-tailed test at the 5% significance level with 20 degrees of freedom)
