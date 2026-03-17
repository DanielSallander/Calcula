# RAND function

## Introduction
The RAND function generates a random decimal number between 0 (inclusive) and 1 (exclusive). Each time the worksheet recalculates, RAND produces a new random value. It is useful for simulations, random sampling, generating test data, and Monte Carlo analysis. To get random numbers in a different range, combine RAND with arithmetic (e.g., multiply and add).

## Syntax
```
=RAND()
```

This function takes no arguments.

## Remarks
- RAND is volatile: it recalculates every time the worksheet recalculates, producing a new value each time.
- The generated number is >= 0 and < 1.
- To generate a random number between a and b: `=RAND()*(b-a)+a`.
- To freeze a random value, copy the cell and paste as values.
- For random integers between two values, use RANDBETWEEN instead.

## Example

| | A | B |
|---|---|---|
| 1 | **Scenario** | **Random Factor** |
| 2 | Simulation 1 | =RAND() |
| 3 | Simulation 2 | =RAND() |
| 4 | Simulation 3 | =RAND() |

**Result:** Each cell returns a different random decimal between 0 and 1, such as 0.7281, 0.1543, 0.9067. Values change each time the sheet recalculates.
