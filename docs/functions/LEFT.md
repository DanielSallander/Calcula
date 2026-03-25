# LEFT

Returns the specified number of characters from the start of a text string.

## Syntax

```
LEFT(text [, num_chars])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | The text string from which to extract characters. |
| `num_chars` | Optional. The number of characters to extract from the left. Defaults to 1. |

## Return value

A text string containing the first `num_chars` characters from `text`.

## Remarks

- Generates a SQL `LEFT(text, num_chars)` expression internally.
- If `num_chars` is greater than the length of `text`, the entire string is returned.
- If `num_chars` is 0, an empty string is returned.
- If `text` is NULL, the result is NULL.

## Example 1: Extract product category prefix

Get the first 2 characters of a product number as a category code.

```
DEFINE CategoryCode = LEFT(dim_product[productnumber], 2)
```

## Example 2: Get first character

Extract the first character of a product name (default num_chars = 1).

```
DEFINE Initial = LEFT(dim_product[name])
```

## See also

- [RIGHT](RIGHT.md) -- extract characters from the end of text
- [MID](MID.md) -- extract characters from the middle of text
- [LEN](LEN.md) -- return the length of a text string
- [FIND](FIND.md) -- find the position of text within another string
