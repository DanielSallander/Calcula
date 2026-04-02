# BINOM.DIST.RANGE function

## Introduction
The BINOM.DIST.RANGE function returns the probability of a trial result using a binomial distribution. It calculates the probability that the number of successes falls within a specified range, making it more convenient than summing individual BINOM.DIST results.

## Syntax
```
=BINOM.DIST.RANGE(trials, probability_s, number_s, [number_s2])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| trials | Required | The number of independent trials. Must be >= 0. |
| probability_s | Required | The probability of success on each trial. Must be between 0 and 1 (inclusive). |
| number_s | Required | The minimum number of successes in the range. |
| number_s2 | Optional | The maximum number of successes in the range. If omitted, returns the probability of exactly number_s successes. |

## Remarks
- If trials, number_s, or number_s2 are not integers, they are truncated.
- If trials < 0, probability_s < 0 or > 1, or number_s < 0, returns #NUM!.
- If number_s2 is provided and number_s2 < number_s, returns 0.
- Equivalent to the sum of BINOM.DIST(k, trials, probability_s, FALSE) for k from number_s to number_s2.

## Example

| | A | B |
|---|---|---|
| 1 | **Trials** | 60 |
| 2 | **Probability** | 0.5 |
| 3 | **Min Successes** | 25 |
| 4 | **Max Successes** | 35 |
| 5 | **Formula** | **Result** |
| 6 | =BINOM.DIST.RANGE(B1, B2, B3, B4) | 0.8487 |

**Result:** Approximately 0.8487 (there is an 84.87% probability of getting between 25 and 35 successes in 60 trials with 50% success rate)
