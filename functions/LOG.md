# LOG function

## Introduction
The LOG function returns the logarithm of a number to a specified base. Logarithms are the inverse of exponentiation and are used extensively in scientific calculations, signal processing (decibels), data scaling, and growth analysis. When no base is specified, LOG defaults to base 10.

## Syntax
```
=LOG(number, [base])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The positive number for which you want the logarithm. |
| base | Optional | The base of the logarithm. Defaults to 10 if omitted. |

## Remarks
- If **number** <= 0, LOG returns a #NUM! error.
- If **base** <= 0 or **base** = 1, LOG returns a #NUM! error.
- LOG(number, 10) is equivalent to LOG10(number).
- LOG(number, EXP(1)) is equivalent to LN(number).
- LOG(b^x, b) = x.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Log Base 2** |
| 2 | 8 | =LOG(A2, 2) |
| 3 | 1024 | =LOG(A3, 2) |
| 4 | 100 | =LOG(A4) |

**Results:**
- B2: 3 (2^3 = 8)
- B3: 10 (2^10 = 1024)
- B4: 2 (10^2 = 100, using default base 10)
