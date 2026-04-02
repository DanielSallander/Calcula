# CHISQ.INV function

## Introduction
The CHISQ.INV function returns the inverse of the left-tailed probability of the chi-squared distribution. Given a probability and degrees of freedom, it returns the chi-squared value x such that the cumulative chi-squared distribution up to x equals the given probability.

## Syntax
```
=CHISQ.INV(probability, deg_freedom)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| probability | Required | A probability associated with the chi-squared distribution. Must be between 0 and 1 (inclusive). |
| deg_freedom | Required | The number of degrees of freedom. Must be a positive integer between 1 and 10^10. |

## Remarks
- If probability is < 0 or > 1, returns #NUM!.
- If deg_freedom is less than 1, returns #NUM!.
- deg_freedom is truncated to an integer.
- CHISQ.INV uses an iterative technique to find the value x such that CHISQ.DIST(x, df, TRUE) = probability.

## Example

| | A | B |
|---|---|---|
| 1 | **Probability** | **Chi-Squared Value** |
| 2 | 0.95 | =CHISQ.INV(A2, 10) |

**Result:** Approximately 18.307 (the chi-squared value below which 95% of the distribution falls with 10 degrees of freedom)
