# F.INV.RT function

## Introduction
The F.INV.RT function returns the inverse of the right-tailed F probability distribution. Given a right-tail probability and two sets of degrees of freedom, it returns the critical F-value for hypothesis testing.

## Syntax
```
=F.INV.RT(probability, deg_freedom1, deg_freedom2)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| probability | Required | The right-tailed probability. Must be between 0 and 1 (inclusive). |
| deg_freedom1 | Required | The numerator degrees of freedom. Must be a positive integer >= 1. |
| deg_freedom2 | Required | The denominator degrees of freedom. Must be a positive integer >= 1. |

## Remarks
- If probability is < 0 or > 1, returns #NUM!.
- If deg_freedom1 or deg_freedom2 is less than 1, returns #NUM!.
- Degrees of freedom are truncated to integers.
- F.INV.RT(p, df1, df2) = F.INV(1 - p, df1, df2).

## Example

| | A | B |
|---|---|---|
| 1 | **Significance Level** | **Critical F-Value** |
| 2 | 0.05 | =F.INV.RT(A2, 5, 20) |

**Result:** Approximately 2.7109 (the critical F-value for a right-tailed test at the 5% significance level)
