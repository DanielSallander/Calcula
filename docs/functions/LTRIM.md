# LTRIM

Removes leading characters from the left side of a text string.

## Syntax

```
LTRIM(text [, characters])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | The text expression to trim. |
| `characters` | *(Optional)* One or more characters to remove from the left side. Default is a single space `' '`. |

## Return value

The input text with the specified leading characters removed.

## Remarks

- LTRIM is not part of standard DAX. It is a Calcula extension (available in Snowflake SQL).
- When `characters` is omitted, only leading spaces are removed.
- Characters can be specified in any order — each character in the string is treated individually.
- A space in the characters parameter does not remove other whitespace types (tabs, line endings); these must be listed explicitly.
- LTRIM generates SQL as `LTRIM(text)` or `LTRIM(text, characters)`.
- For removing trailing characters, see [RTRIM](RTRIM.md). For both sides, use [TRIM](TRIM.md).

## Example 1: Remove leading spaces (default)

```
DEFINE CleanName = LTRIM(t[name])
```

## Example 2: Remove leading zeros and hash signs

```
DEFINE CleanId = LTRIM(t[raw_id], "0#")
```

If `raw_id` is `"##000123"`, the result is `"123"`.

## See also

- [RTRIM](RTRIM.md) — removes trailing characters
- [TRIM](TRIM.md) — removes leading and trailing spaces
