# NORM.S.INV function

## Introduction
The NORM.S.INV function returns the inverse of the standard normal cumulative distribution (mean=0, standard deviation=1). Given a probability, it returns the z-score such that the cumulative standard normal distribution up to that z-score equals the probability.

## Syntax
```
=NORM.S.INV(probability)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| probability | Required | A probability corresponding to the standard normal distribution. Must be between 0 and 1 (exclusive). |

## Remarks
- If probability is <= 0 or >= 1, returns #NUM!.
- Equivalent to NORM.INV(probability, 0, 1).
- Commonly used to find critical z-values for confidence intervals and hypothesis tests.

## Example

| | A | B |
|---|---|---|
| 1 | **Probability** | **Z-Score** |
| 2 | 0.975 | =NORM.S.INV(A2) |

**Result:** Approximately 1.96 (the z-score below which 97.5% of the standard normal distribution falls)
