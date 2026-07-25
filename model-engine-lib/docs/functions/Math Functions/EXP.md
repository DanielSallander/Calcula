# EXP

Returns e raised to the power of a given number, where e is the mathematical constant approximately equal to 2.71828.

## Syntax

```
EXP(number)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `number` | A numeric expression representing the exponent. Can be a literal, column reference, aggregation, or any expression that produces a number. |

## Return value

A positive number — e raised to the power of the input.

## Remarks

- EXP is the inverse of [LN](LN.md). For any value x, `LN(EXP(x))` returns x.
- EXP(0) returns 1. EXP(1) returns approximately 2.71828.
- Generates SQL `EXP(x)` when pushed to the data source.
- EXP forces local computation when the argument contains aggregation functions.

## Example 1: Euler's number

Return the value of e.

```
DEFINE E = EXP(1)
```

## Example 2: Continuous growth model

Apply continuous compounding to an aggregated growth rate.

```
DEFINE Growth Factor = EXP(SUM(fact_sales[growth_rate]))
```

## See also

- [LN](LN.md) — natural logarithm (inverse of EXP)
- [POWER](POWER.md) — raise any base to a power
- [LOG](LOG.md) — logarithm to a specified base
