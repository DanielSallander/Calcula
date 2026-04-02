# FORECAST.ETS.SEASONALITY function

## Introduction
The FORECAST.ETS.SEASONALITY function returns the length of the seasonal pattern that the ETS algorithm detects in the time series data. This is useful for understanding the periodicity in your data before creating forecasts.

## Syntax
```
=FORECAST.ETS.SEASONALITY(values, timeline, [data_completion], [aggregation])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| values | Required | The historical values (dependent data). |
| timeline | Required | The independent array of dates or numeric data points. |
| data_completion | Optional | 0 = treat missing points as zeros, 1 = interpolate (default). |
| aggregation | Optional | Aggregation method for duplicate time points. 1=AVERAGE (default), 2=COUNT, 3=COUNTA, 4=MAX, 5=MEDIAN, 6=MIN, 7=SUM. |

## Remarks
- Returns 0 if no seasonal pattern is detected.
- Returns 1 if the data step is not consistent enough to determine seasonality.
- The detected seasonality is the same value the FORECAST.ETS function uses when seasonality is set to auto-detect (1).

## Example

| | A | B |
|---|---|---|
| 1 | **Month** | **Sales** |
| 2 | 1 | 100 |
| 3 | 2 | 120 |
| 4 | 3 | 140 |
| 5 | ... | ... |
| 6 | 24 | 280 |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =FORECAST.ETS.SEASONALITY(B2:B25, A2:A25) | 12 |

**Result:** 12 (the algorithm detected a 12-period seasonal cycle, consistent with monthly data repeating annually)
