# F.INV function

## Introduction
The F.INV function returns the inverse of the left-tailed F probability distribution. Given a probability and two sets of degrees of freedom, it returns the F-value x such that the cumulative F distribution up to x equals the given probability.

## Syntax
```
=F.INV(probability, deg_freedom1, deg_freedom2)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| probability | Required | A probability associated with the F cumulative distribution. Must be between 0 and 1 (inclusive). |
| deg_freedom1 | Required | The numerator degrees of freedom. Must be a positive integer >= 1. |
| deg_freedom2 | Required | The denominator degrees of freedom. Must be a positive integer >= 1. |

## Remarks
- If probability is < 0 or > 1, returns #NUM!.
- If deg_freedom1 or deg_freedom2 is less than 1, returns #NUM!.
- Degrees of freedom are truncated to integers.
- F.INV uses an iterative technique to find the value.

## Example

| | A | B |
|---|---|---|
| 1 | **Probability** | **F-Value** |
| 2 | 0.95 | =F.INV(A2, 5, 20) |

**Result:** Approximately 2.7109 (the F-value below which 95% of the distribution falls with 5 and 20 degrees of freedom)
