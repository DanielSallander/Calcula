# EFFECT function

## Introduction
The EFFECT function returns the effective annual interest rate given the nominal annual rate and the number of compounding periods per year. It is essential for comparing financial products that compound at different frequencies.

## Syntax
```
=EFFECT(nominal_rate, npery)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| nominal_rate | Required | The nominal annual interest rate. |
| npery | Required | The number of compounding periods per year. |

## Remarks
- Formula: (1 + nominal_rate / npery)^npery - 1.
- Returns #NUM! if nominal_rate <= 0 or npery < 1.
- npery is truncated to an integer.
- The effective rate is always greater than or equal to the nominal rate when compounding more than once per year.

## Example

| | A | B |
|---|---|---|
| 1 | **Nominal Rate** | **Effective Rate** |
| 2 | 6% | =EFFECT(A2, 12) |

**Result:** Approximately 6.17% (6% nominal compounded monthly)
