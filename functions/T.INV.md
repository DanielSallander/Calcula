# T.INV function

## Introduction
The T.INV function returns the left-tailed inverse of the Student's t-distribution. Given a probability and degrees of freedom, it returns the t-value such that the cumulative t-distribution up to that value equals the probability.

## Syntax
```
=T.INV(probability, deg_freedom)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| probability | Required | The probability associated with the left tail of the t-distribution. Must be between 0 and 1 (exclusive). |
| deg_freedom | Required | The number of degrees of freedom. Must be a positive integer >= 1. |

## Remarks
- If probability is <= 0 or >= 1, returns #NUM!.
- If deg_freedom is less than 1, returns #NUM!.
- deg_freedom is truncated to an integer.
- T.INV returns a negative value when probability < 0.5 and a positive value when probability > 0.5.
- For the two-tailed inverse, use T.INV.2T.

## Example

| | A | B |
|---|---|---|
| 1 | **Probability** | **t-Value** |
| 2 | 0.05 | =T.INV(A2, 20) |

**Result:** Approximately -1.7247 (the t-value below which 5% of the distribution falls with 20 degrees of freedom)
