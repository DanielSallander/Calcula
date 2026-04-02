# BETA.INV function

## Introduction
The BETA.INV function returns the inverse of the cumulative beta distribution. Given a probability, it returns the value x such that BETA.DIST(x, alpha, beta, TRUE, A, B) equals that probability.

## Syntax
```
=BETA.INV(probability, alpha, beta, [A], [B])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| probability | Required | A probability associated with the beta distribution. Must be between 0 and 1 (inclusive). |
| alpha | Required | The first shape parameter of the distribution. Must be > 0. |
| beta | Required | The second shape parameter of the distribution. Must be > 0. |
| A | Optional | The lower bound of the interval. Default is 0. |
| B | Optional | The upper bound of the interval. Default is 1. |

## Remarks
- If probability is < 0 or > 1, returns #NUM!.
- If alpha or beta is <= 0, returns #NUM!.
- If A = B, returns #NUM!.
- BETA.INV uses an iterative technique to find the value.

## Example

| | A | B |
|---|---|---|
| 1 | **Probability** | **Value** |
| 2 | 0.6630 | =BETA.INV(A2, 2, 5) |

**Result:** Approximately 0.4 (the value below which 66.3% of the beta distribution falls with alpha=2 and beta=5)
