# BINOM.INV function

## Introduction
The BINOM.INV function returns the smallest value for which the cumulative binomial distribution is greater than or equal to a criterion value. It is the inverse of the cumulative binomial distribution and is useful for determining the minimum number of successes needed to meet a probability threshold.

## Syntax
```
=BINOM.INV(trials, probability_s, alpha)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| trials | Required | The number of Bernoulli trials. Must be >= 0. |
| probability_s | Required | The probability of success on each trial. Must be between 0 and 1 (inclusive). |
| alpha | Required | The criterion value (cumulative probability threshold). Must be between 0 and 1 (inclusive). |

## Remarks
- If trials is not an integer, it is truncated.
- If trials < 0, probability_s < 0 or > 1, or alpha < 0 or > 1, returns #NUM!.
- Returns the smallest integer k such that BINOM.DIST(k, trials, probability_s, TRUE) >= alpha.

## Example

| | A | B |
|---|---|---|
| 1 | **Trials** | 100 |
| 2 | **Success Probability** | 0.5 |
| 3 | **Alpha** | 0.95 |
| 4 | **Formula** | **Result** |
| 5 | =BINOM.INV(B1, B2, B3) | 58 |

**Result:** 58 (the minimum number of successes out of 100 trials needed so that the cumulative probability reaches at least 95%)
