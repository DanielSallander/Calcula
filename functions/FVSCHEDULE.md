# FVSCHEDULE function

## Introduction
The FVSCHEDULE function returns the future value of an initial principal after applying a series of compound interest rates. Unlike FV which uses a constant rate, FVSCHEDULE handles variable rates, making it ideal for investments with changing annual returns.

## Syntax
```
=FVSCHEDULE(principal, schedule)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| principal | Required | The initial investment amount. |
| schedule | Required | An array or range of interest rates to apply sequentially. |

## Remarks
- Each rate in the schedule is applied in order: result = principal * (1 + rate1) * (1 + rate2) * ...
- Rates can be different for each period, including negative rates.
- Non-numeric values in the schedule are treated as 0.

## Example

| | A | B |
|---|---|---|
| 1 | **Year** | **Rate** |
| 2 | 1 | 5% |
| 3 | 2 | 8% |
| 4 | 3 | 3% |
| 5 | **FV of $1000** | =FVSCHEDULE(1000, B2:B4) |

**Result:** 1166.94 (1000 * 1.05 * 1.08 * 1.03)
