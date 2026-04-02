# FORECAST.ETS function

## Introduction
The FORECAST.ETS function predicts a future value based on existing (historical) values using the AAA version of the Exponential Triple Smoothing (ETS) algorithm. This method accounts for trends and seasonal patterns in the data, making it more sophisticated than linear forecasting.

## Syntax
```
=FORECAST.ETS(target_date, values, timeline, [seasonality], [data_completion], [aggregation])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| target_date | Required | The date or numeric point for which to predict a value. |
| values | Required | The historical values (dependent data). |
| timeline | Required | The independent array of dates or numeric data points. Must be a consistent step between data points. |
| seasonality | Optional | The length of the seasonal pattern. 0 = no seasonality, 1 = auto-detect (default). A positive integer specifies the pattern length. |
| data_completion | Optional | 0 = treat missing points as zeros, 1 = interpolate missing points (default). |
| aggregation | Optional | How to aggregate multiple values at the same time point. 1=AVERAGE (default), 2=COUNT, 3=COUNTA, 4=MAX, 5=MEDIAN, 6=MIN, 7=SUM. |

## Remarks
- The timeline must have a consistent interval between points.
- At least two complete seasonal cycles of data are required for seasonal forecasting.
- If the timeline contains duplicate values, they are aggregated using the specified method.
- Returns #N/A if the data cannot support a forecast.

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
| 10 | =FORECAST.ETS(DATE(2025,7,1), B2:B7, A2:A7) | 207 |

**Result:** Approximately 207 (the forecasted sales for July 2025 based on the ETS algorithm)
