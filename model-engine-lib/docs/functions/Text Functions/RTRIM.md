# RTRIM

Removes trailing characters from the right side of a text string.

## Syntax

```
RTRIM(text [, characters])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | The text expression to trim. |
| `characters` | *(Optional)* One or more characters to remove from the right side. Default is a single space `' '`. |

## Return value

The input text with the specified trailing characters removed.

## Remarks

- RTRIM is not part of standard DAX. It is a Calcula extension (available in Snowflake SQL).
- When `characters` is omitted, only trailing spaces are removed.
- Characters can be specified in any order — each character in the string is treated individually.
- RTRIM generates SQL as `RTRIM(text)` or `RTRIM(text, characters)`.
- For removing leading characters, see [LTRIM](LTRIM.md). For both sides, use [TRIM](TRIM.md).

## Example 1: Remove trailing spaces (default)

```
DEFINE CleanCode = RTRIM(t[code])
```

## Example 2: Remove trailing zeros and periods

```
DEFINE CleanPrice = RTRIM(t[price_text], "0.")
```

If `price_text` is `"$125.00"`, the result is `"$125"`.

## See also

- [LTRIM](LTRIM.md) — removes leading characters
- [TRIM](TRIM.md) — removes leading and trailing spaces
