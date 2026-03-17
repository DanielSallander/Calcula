# LOG10 function

## Introduction
The LOG10 function returns the base-10 (common) logarithm of a number. Base-10 logarithms are widely used in scientific notation, pH calculations in chemistry, decibel measurements in acoustics, and Richter scale readings in seismology. LOG10 is equivalent to LOG(number, 10).

## Syntax
```
=LOG10(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The positive number for which you want the base-10 logarithm. |

## Remarks
- If **number** <= 0, LOG10 returns a #NUM! error.
- LOG10(10) = 1, LOG10(100) = 2, LOG10(1000) = 3, and so on.
- LOG10(1) = 0.

## Example

| | A | B |
|---|---|---|
| 1 | **Sound Intensity** | **Decibels** |
| 2 | 0.001 | =10*LOG10(A2/0.000000000001) |

**Result:** 90

The formula converts sound intensity to decibels using the standard formula dB = 10 * log10(I / I_ref), where I_ref is the reference intensity (10^-12). An intensity of 0.001 W/m^2 corresponds to 90 dB.
