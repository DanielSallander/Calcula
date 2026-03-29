# CONFIDENCE.NORM function

## Introduction
The CONFIDENCE.NORM function returns the margin of error for a confidence interval using a normal distribution. It is used when the population standard deviation is known, to determine how far a sample mean might be from the population mean.

## Syntax
```
=CONFIDENCE.NORM(alpha, standard_dev, size)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| alpha | Required | The significance level (e.g., 0.05 for 95% confidence). Must be between 0 and 1. |
| standard_dev | Required | The population standard deviation. Must be > 0. |
| size | Required | The sample size. Must be >= 1. |

## Remarks
- The confidence interval for the population mean is: sample_mean +/- CONFIDENCE.NORM.
- Alpha of 0.05 corresponds to a 95% confidence level.
- Returns #NUM! if alpha is outside (0, 1), standard_dev <= 0, or size < 1.

## Example

| | A | B |
|---|---|---|
| 1 | **Parameter** | **Value** |
| 2 | Alpha | 0.05 |
| 3 | Std Dev | 2.5 |
| 4 | Sample Size | 50 |
| 5 | **Margin** | =CONFIDENCE.NORM(B2, B3, B4) |

**Result:** Approximately 0.6929
