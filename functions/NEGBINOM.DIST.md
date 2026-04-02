# NEGBINOM.DIST function

## Introduction
The NEGBINOM.DIST function returns the negative binomial distribution, which models the probability of a given number of failures before a specified number of successes is reached. It is useful in quality control and reliability testing.

## Syntax
```
=NEGBINOM.DIST(number_f, number_s, probability_s, cumulative)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number_f | Required | The number of failures. Must be >= 0. |
| number_s | Required | The threshold number of successes. Must be >= 1. |
| probability_s | Required | The probability of success on each trial. Must be between 0 and 1 (exclusive). |
| cumulative | Required | TRUE = cumulative distribution function, FALSE = probability mass function. |

## Remarks
- number_f and number_s are truncated to integers.
- If number_f < 0, returns #NUM!.
- If number_s < 1, returns #NUM!.
- If probability_s is <= 0 or >= 1, returns #NUM!.

## Example

| | A | B |
|---|---|---|
| 1 | **Failures** | 5 |
| 2 | **Successes Threshold** | 10 |
| 3 | **Success Probability** | 0.6 |
| 4 | **Formula** | **Result** |
| 5 | =NEGBINOM.DIST(B1, B2, B3, FALSE) | 0.1023 |

**Result:** Approximately 0.1023 (there is a 10.23% probability of exactly 5 failures before 10 successes with a 60% success rate)
