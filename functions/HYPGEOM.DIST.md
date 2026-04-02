# HYPGEOM.DIST function

## Introduction
The HYPGEOM.DIST function returns the hypergeometric distribution, which models the probability of a given number of successes in a sample drawn without replacement from a finite population. It is used when sampling without replacement from a known population.

## Syntax
```
=HYPGEOM.DIST(sample_s, number_sample, population_s, number_pop, cumulative)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| sample_s | Required | The number of successes in the sample. |
| number_sample | Required | The size of the sample. |
| population_s | Required | The number of successes in the population. |
| number_pop | Required | The population size. |
| cumulative | Required | TRUE = cumulative distribution function, FALSE = probability mass function. |

## Remarks
- All arguments are truncated to integers.
- If any argument is non-numeric, returns #VALUE!.
- If sample_s < 0 or sample_s > MIN(number_sample, population_s), returns #NUM!.
- If number_sample <= 0 or number_sample > number_pop, returns #NUM!.
- If population_s <= 0 or population_s > number_pop, returns #NUM!.
- If number_pop <= 0, returns #NUM!.

## Example

| | A | B |
|---|---|---|
| 1 | **Description** | **Value** |
| 2 | Successes in sample | 3 |
| 3 | Sample size | 5 |
| 4 | Successes in population | 10 |
| 5 | Population size | 50 |
| 6 | **Formula** | **Result** |
| 7 | =HYPGEOM.DIST(B2, B3, B4, B5, FALSE) | 0.2153 |

**Result:** Approximately 0.2153 (there is a 21.53% probability of drawing exactly 3 successes in a sample of 5 from a population of 50 containing 10 successes)
