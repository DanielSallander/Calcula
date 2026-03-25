# UNICODE

Returns the Unicode code point number of the first character in a text string.

## Syntax

```
UNICODE(text)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | A text string. The code point of the first character is returned. |

## Return value

An integer representing the Unicode code point of the first character in `text`.

## Remarks

- Generates a SQL `ASCII(text)` expression internally. Despite the SQL function name, modern databases return full Unicode code points, not just ASCII values.
- If `text` is an empty string, the behavior is database-dependent (typically returns 0 or NULL).
- If `text` is NULL, the result is NULL.
- Use [UNICHAR](UNICHAR.md) for the reverse operation (code point to character).

## Example 1: Get the code point of the first character

Return the Unicode value of the first character in a product name.

```
DEFINE FirstCharCode = UNICODE(dim_product[name])
```

## Example 2: Classify by initial character range

Determine whether a product name starts with a letter A-M or N-Z.

```
DEFINE NameHalf = IF(UNICODE(UPPER(dim_product[name])) < 78, "A-M", "N-Z")
```

## See also

- [UNICHAR](UNICHAR.md) -- return the character for a code point
- [LEFT](LEFT.md) -- extract the first characters of a text string
- [UPPER](UPPER.md) -- convert text to uppercase
