# GAMMA.INV function

## Introduction
The GAMMA.INV function returns the inverse of the gamma cumulative distribution. Given a probability, it returns the value x such that GAMMA.DIST(x, alpha, beta, TRUE) equals that probability.

## Syntax
```
=GAMMA.INV(probability, alpha, beta)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| probability | Required | The probability associated with the gamma distribution. Must be between 0 and 1 (inclusive). |
| alpha | Required | The shape parameter of the distribution. Must be > 0. |
| beta | Required | The scale parameter of the distribution. Must be > 0. |

## Remarks
- If probability is < 0 or > 1, returns #NUM!.
- If alpha or beta is <= 0, returns #NUM!.
- GAMMA.INV uses an iterative technique to find the value.

## Example

| | A | B |
|---|---|---|
| 1 | **Probability** | **Value** |
| 2 | 0.8753 | =GAMMA.INV(A2, 3, 2) |

**Result:** Approximately 10 (the value below which 87.53% of the gamma distribution falls with shape=3 and scale=2)
