# PROB function

## Introduction
The PROB function returns the probability that values in a range are between two limits. It sums the probabilities associated with values that fall within the specified range.

## Syntax
```
=PROB(x_range, prob_range, lower_limit, [upper_limit])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x_range | Required | The range of numeric values with associated probabilities. |
| prob_range | Required | The range of probabilities associated with each value in x_range. Each probability must be between 0 and 1, and the sum must equal 1. |
| lower_limit | Required | The lower bound of the value range. |
| upper_limit | Optional | The upper bound of the value range. If omitted, PROB returns the probability of being exactly equal to lower_limit. |

## Remarks
- If any probability in prob_range is < 0 or > 1, returns #NUM!.
- If the sum of probabilities in prob_range does not equal 1, returns #NUM!.
- x_range and prob_range must have the same number of data points.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Probability** |
| 2 | 0 | 0.10 |
| 3 | 1 | 0.20 |
| 4 | 2 | 0.30 |
| 5 | 3 | 0.25 |
| 6 | 4 | 0.15 |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =PROB(A2:A6, B2:B6, 1, 3) | 0.75 |

**Result:** 0.75 (there is a 75% probability that the value falls between 1 and 3, inclusive)
