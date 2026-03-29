# POISSON.DIST function

## Introduction
The POISSON.DIST function returns the Poisson distribution probability. It models the probability of a given number of events occurring in a fixed interval when events happen at a known constant mean rate and independently of each other.

## Syntax
```
=POISSON.DIST(x, mean, cumulative)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The number of events. Must be >= 0. |
| mean | Required | The expected number of events (lambda). Must be >= 0. |
| cumulative | Required | TRUE = cumulative probability (at most x events), FALSE = exact probability. |

## Remarks
- x is truncated to an integer.
- Returns #NUM! if x < 0 or mean < 0.
- Commonly used for modeling arrivals, defects, or rare events over a time period.

## Example

| | A | B |
|---|---|---|
| 1 | **Events** | **Probability** |
| 2 | 3 | =POISSON.DIST(A2, 5, FALSE) |

**Result:** Approximately 0.1404 (probability of exactly 3 events when average is 5)
