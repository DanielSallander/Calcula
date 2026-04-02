# CHISQ.INV.RT function

## Introduction
The CHISQ.INV.RT function returns the inverse of the right-tailed probability of the chi-squared distribution. Given a right-tail probability and degrees of freedom, it returns the chi-squared value x such that the probability of exceeding x equals the given probability.

## Syntax
```
=CHISQ.INV.RT(probability, deg_freedom)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| probability | Required | The right-tailed probability. Must be between 0 and 1 (inclusive). |
| deg_freedom | Required | The number of degrees of freedom. Must be a positive integer between 1 and 10^10. |

## Remarks
- If probability is < 0 or > 1, returns #NUM!.
- If deg_freedom is less than 1, returns #NUM!.
- deg_freedom is truncated to an integer.
- CHISQ.INV.RT(p, df) = CHISQ.INV(1 - p, df).

## Example

| | A | B |
|---|---|---|
| 1 | **Significance Level** | **Critical Value** |
| 2 | 0.05 | =CHISQ.INV.RT(A2, 10) |

**Result:** Approximately 18.307 (the critical chi-squared value for a right-tailed test at the 5% significance level with 10 degrees of freedom)
