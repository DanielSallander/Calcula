# CONFIDENCE.T function

## Introduction
The CONFIDENCE.T function returns the margin of error for a confidence interval using the Student's t-distribution. It is used when the population standard deviation is unknown and estimated from a small sample.

## Syntax
```
=CONFIDENCE.T(alpha, standard_dev, size)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| alpha | Required | The significance level (e.g., 0.05 for 95% confidence). Must be between 0 and 1. |
| standard_dev | Required | The sample standard deviation. Must be > 0. |
| size | Required | The sample size. Must be >= 2. |

## Remarks
- The confidence interval for the population mean is: sample_mean +/- CONFIDENCE.T.
- Uses the t-distribution, which produces wider intervals than CONFIDENCE.NORM for small samples.
- Returns #NUM! if alpha is outside (0, 1), standard_dev <= 0, or size < 2.
- Size must be at least 2 because the t-distribution requires at least 1 degree of freedom.

## Example

| | A | B |
|---|---|---|
| 1 | **Parameter** | **Value** |
| 2 | Alpha | 0.05 |
| 3 | Std Dev | 2.5 |
| 4 | Sample Size | 10 |
| 5 | **Margin** | =CONFIDENCE.T(B2, B3, B4) |

**Result:** Approximately 1.7882
