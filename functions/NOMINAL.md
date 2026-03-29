# NOMINAL function

## Introduction
The NOMINAL function returns the nominal annual interest rate given the effective annual rate and the number of compounding periods per year. It is the inverse of the EFFECT function, useful for converting between effective and nominal rates.

## Syntax
```
=NOMINAL(effect_rate, npery)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| effect_rate | Required | The effective annual interest rate. |
| npery | Required | The number of compounding periods per year. |

## Remarks
- Formula: npery * ((1 + effect_rate)^(1/npery) - 1).
- Returns #NUM! if effect_rate <= 0 or npery < 1.
- npery is truncated to an integer.
- NOMINAL(EFFECT(rate, n), n) returns the original rate.

## Example

| | A | B |
|---|---|---|
| 1 | **Effective Rate** | **Nominal Rate** |
| 2 | 6.17% | =NOMINAL(A2, 12) |

**Result:** Approximately 6.00% (the nominal rate that yields 6.17% effective with monthly compounding)
