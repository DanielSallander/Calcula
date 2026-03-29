# GROWTH function

## Introduction
The GROWTH function returns values along an exponential growth trend. It fits an exponential curve (y = b * m^x) to known data and predicts new y-values, making it ideal for forecasting data that grows by a percentage, such as population or compound revenue growth.

## Syntax
```
=GROWTH(known_y's, [known_x's], [new_x's], [const])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| known_y's | Required | The set of known y-values (dependent variable). Must be positive. |
| known_x's | Optional | The set of known x-values (independent variable). Defaults to {1, 2, 3, ...}. |
| new_x's | Optional | New x-values for which to predict y-values. Defaults to known_x's. |
| const | Optional | TRUE or omitted = calculate b normally, FALSE = force b to 1. |

## Remarks
- Returns an array of predicted y-values that spills.
- All known_y's values must be positive; the function returns #NUM! otherwise.
- For linear trends, use TREND instead.

## Example

| | A | B |
|---|---|---|
| 1 | **Year** | **Revenue** |
| 2 | 1 | 1000 |
| 3 | 2 | 1200 |
| 4 | 3 | 1440 |
| 5 | **Year 4** | =GROWTH(B2:B4, A2:A4, 4) |

**Result:** Approximately 1728 (20% compound growth)
