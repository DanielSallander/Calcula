# UNICHAR

Returns the Unicode character corresponding to a given code point number.

## Syntax

```
UNICHAR(number)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `number` | An integer representing a Unicode code point. |

## Return value

A single-character text string corresponding to the given Unicode code point.

## Remarks

- Generates a SQL `CHR(number)` expression internally.
- Common code points: 10 = line feed, 32 = space, 65 = "A", 97 = "a".
- Use [UNICODE](UNICODE.md) for the reverse operation (character to code point).
- If `number` is NULL, the result is NULL.

## Example 1: Insert a special character

Create a line-break character for use in concatenated text.

```
DEFINE LineBreak = UNICHAR(10)
```

## Example 2: Build text with a bullet character

Concatenate a bullet point (Unicode 8226) with a label.

```
DEFINE BulletItem = CONCATENATE(UNICHAR(8226), " Item description")
```

## See also

- [UNICODE](UNICODE.md) -- return the code point of the first character
- [CONCATENATE](CONCATENATE.md) -- join text strings
- [COMBINEVALUES](COMBINEVALUES.md) -- join text with a delimiter
