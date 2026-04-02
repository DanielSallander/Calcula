# GAMMALN function

## Introduction
The GAMMALN function returns the natural logarithm of the Gamma function. Using the logarithm avoids the very large numbers that the Gamma function can produce, making it useful in calculations involving factorials of large numbers.

## Syntax
```
=GAMMALN(x)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The value for which to calculate the natural log of the Gamma function. Must be > 0. |

## Remarks
- If x is <= 0, returns #NUM!.
- GAMMALN(x) = LN(GAMMA(x)).
- Useful in statistical computations where the Gamma function values would be too large to represent directly.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **LN(Gamma)** |
| 2 | 10 | =GAMMALN(A2) |

**Result:** Approximately 12.8018 (the natural logarithm of GAMMA(10) = LN(362880))
