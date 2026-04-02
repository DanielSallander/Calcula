# FORECAST.ETS.STAT function

## Introduction
The FORECAST.ETS.STAT function returns a statistical value related to the ETS forecasting model. It provides diagnostic information about the quality and parameters of the forecast model.

## Syntax
```
=FORECAST.ETS.STAT(values, timeline, statistic_type, [seasonality], [data_completion], [aggregation])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| values | Required | The historical values (dependent data). |
| timeline | Required | The independent array of dates or numeric data points. |
| statistic_type | Required | The type of statistic to return (1-8). |
| seasonality | Optional | The length of the seasonal pattern. 0 = no seasonality, 1 = auto-detect (default). |
| data_completion | Optional | 0 = treat missing points as zeros, 1 = interpolate (default). |
| aggregation | Optional | Aggregation method for duplicate time points. 1=AVERAGE (default), 2=COUNT, 3=COUNTA, 4=MAX, 5=MEDIAN, 6=MIN, 7=SUM. |

## Remarks
- statistic_type values: 1=Alpha (base smoothing), 2=Beta (trend smoothing), 3=Gamma (seasonal smoothing), 4=MASE (Mean Absolute Scaled Error), 5=SMAPE (Symmetric Mean Absolute Percentage Error), 6=MAE (Mean Absolute Error), 7=RMSE (Root Mean Squared Error), 8=Step size detected.
- Alpha, Beta, and Gamma are the smoothing parameters used by the ETS algorithm, each between 0 and 1.
- Lower error metrics (MASE, SMAPE, MAE, RMSE) indicate a better fitting model.

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
| 10 | =FORECAST.ETS.STAT(B2:B7, A2:A7, 1) | 0.85 |

**Result:** Approximately 0.85 (the Alpha smoothing parameter used by the ETS model, indicating how much weight is given to recent observations)
