# NORM.INV function

## Introduction
The NORM.INV function returns the inverse of the normal cumulative distribution for a specified mean and standard deviation. Given a probability, it returns the value x such that the cumulative normal distribution up to x equals that probability.

## Syntax
```
=NORM.INV(probability, mean, standard_dev)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| probability | Required | A probability corresponding to the normal distribution. Must be between 0 and 1 (exclusive). |
| mean | Required | The arithmetic mean of the distribution. |
| standard_dev | Required | The standard deviation of the distribution. Must be > 0. |

## Remarks
- If probability is <= 0 or >= 1, returns #NUM!.
- If standard_dev is <= 0, returns #NUM!.
- NORM.INV uses an iterative search technique to find the value x such that NORM.DIST(x, mean, standard_dev, TRUE) = probability.
- For the standard normal distribution (mean=0, standard_dev=1), use NORM.S.INV.

## Example

| | A | B |
|---|---|---|
| 1 | **Probability** | **Value** |
| 2 | 0.9088 | =NORM.INV(A2, 40, 1.5) |

**Result:** Approximately 42 (the value below which 90.88% of the distribution falls)
