# LOGNORM.INV function

## Introduction
The LOGNORM.INV function returns the inverse of the lognormal cumulative distribution. Given a probability, it returns the value x such that the cumulative lognormal distribution up to x equals that probability.

## Syntax
```
=LOGNORM.INV(probability, mean, standard_dev)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| probability | Required | A probability associated with the lognormal distribution. Must be between 0 and 1 (exclusive). |
| mean | Required | The mean of ln(x). |
| standard_dev | Required | The standard deviation of ln(x). Must be > 0. |

## Remarks
- If probability is <= 0 or >= 1, returns #NUM!.
- If standard_dev is <= 0, returns #NUM!.
- LOGNORM.INV(p, mean, sd) = EXP(mean + sd * NORM.S.INV(p)).

## Example

| | A | B |
|---|---|---|
| 1 | **Probability** | **Value** |
| 2 | 0.0390 | =LOGNORM.INV(A2, 3.5, 1.2) |

**Result:** Approximately 4 (the value below which 3.9% of the lognormal distribution falls with mean=3.5 and standard_dev=1.2)
