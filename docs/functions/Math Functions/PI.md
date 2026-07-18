# PI

Returns the value of Pi, the mathematical constant approximately equal to 3.14159265358979.

## Syntax

```
PI()
```

### Parameters

None. PI takes no arguments.

## Return value

A number — the value of Pi (3.14159265358979...).

## Remarks

- PI is a constant function. It always returns the same value.
- Generates SQL `PI()` when pushed to the data source.
- Useful in geometric and trigonometric calculations within measures.

## Example 1: Area of a circle

Calculate area from a radius column.

```
DEFINE Area = SUM(ITERATE(dim_shapes, PI() * POWER(dim_shapes[radius], 2)))
```

## Example 2: Degrees to radians conversion factor

```
DEFINE DegreesToRad = PI() / 180
```

## See also

- [POWER](POWER.md) — raise a number to a power
- [ROUND](ROUND.md) — round to a given number of decimal places
