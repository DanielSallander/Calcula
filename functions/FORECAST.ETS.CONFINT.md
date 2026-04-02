# FORECAST.ETS.CONFINT function

## Introduction
The FORECAST.ETS.CONFINT function returns a confidence interval for a forecast value at a specified target date. It quantifies the uncertainty in the ETS forecast, giving a range within which the actual value is expected to fall at a given confidence level.

## Syntax
```
=FORECAST.ETS.CONFINT(target_date, values, timeline, [confidence_level], [seasonality], [data_completion], [aggregation])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| target_date | Required | The date or numeric point for which to calculate the confidence interval. |
| values | Required | The historical values (dependent data). |
| timeline | Required | The independent array of dates or numeric data points. |
| confidence_level | Optional | The confidence level for the interval. Must be between 0 and 1 (exclusive). Default is 0.95 (95%). |
| seasonality | Optional | The length of the seasonal pattern. 0 = no seasonality, 1 = auto-detect (default). |
| data_completion | Optional | 0 = treat missing points as zeros, 1 = interpolate (default). |
| aggregation | Optional | Aggregation method for duplicate time points. 1=AVERAGE (default), 2=COUNT, 3=COUNTA, 4=MAX, 5=MEDIAN, 6=MIN, 7=SUM. |

## Remarks
- The confidence interval is returned as a single value representing half the width of the interval. The full range is: forecast +/- confidence interval.
- A higher confidence level produces a wider interval.
- Forecasts further into the future typically have wider confidence intervals.

## Example

| | A | B |
|---|---|---|
| 1 | **Date** | **Sales** |
| 2 | 2025-01-01 | 150 |
| 3 | 2025-02-01 | 160 |
| 4 | 2025-03-01 | 180 |
| 5 | 2025-04-01 | 170 |
| 6 | 2025-05-01 | 190 |
| 7 | 2025-06-01 | 200 |
| 8 | | |
| 9 | **Formula** | **Result** |
| 10 | =FORECAST.ETS.CONFINT(DATE(2025,7,1), B2:B7, A2:A7, 0.95) | 25.3 |

**Result:** Approximately 25.3 (the 95% confidence interval half-width; the forecast of ~207 has a 95% confidence range of approximately 181.7 to 232.3)
