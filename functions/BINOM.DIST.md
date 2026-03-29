# BINOM.DIST function

## Introduction
The BINOM.DIST function returns the binomial distribution probability. It calculates the probability of a specific number of successes in a fixed number of independent trials, each with the same probability of success.

## Syntax
```
=BINOM.DIST(number_s, trials, probability_s, cumulative)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number_s | Required | The number of successes. |
| trials | Required | The number of independent trials. |
| probability_s | Required | The probability of success on each trial (between 0 and 1). |
| cumulative | Required | TRUE = cumulative probability (at most number_s successes), FALSE = exact probability. |

## Remarks
- number_s and trials are truncated to integers.
- Returns #NUM! if number_s < 0, number_s > trials, or probability_s is outside 0-1.
- Useful for quality control, coin flips, pass/fail scenarios.

## Example

| | A | B |
|---|---|---|
| 1 | **Successes** | **Probability** |
| 2 | 6 | =BINOM.DIST(A2, 10, 0.5, FALSE) |

**Result:** Approximately 0.2051 (probability of exactly 6 heads in 10 coin flips)
