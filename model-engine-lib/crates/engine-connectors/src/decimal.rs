//! Shared decimal rescaling helpers for row-to-Arrow conversion.
//!
//! Arrow stores `Decimal128` values as `i128` mantissas scaled by
//! `10^scale`. Database drivers hand us values at their own scale
//! (`rust_decimal::Decimal` for PostgreSQL NUMERIC and SQL Server
//! DECIMAL/NUMERIC; `f64` for SQL Server MONEY), so values must be rescaled
//! to the Arrow column's scale. All rescaling here uses checked arithmetic
//! and rounds half away from zero — silently wrong numbers are worse than
//! errors in an analytical engine.

use rust_decimal::Decimal;

use crate::error::{ConnectorError, ConnectorResult};

/// Default Arrow precision for a source `NUMERIC`/`DECIMAL` whose own precision
/// is unconstrained or unreported. 38 is the maximum an Arrow `Decimal128`
/// (an `i128` mantissa) can represent.
pub(crate) const DEFAULT_DECIMAL_PRECISION: u8 = 38;

/// Default Arrow scale for an unconstrained `NUMERIC`/`DECIMAL`. Scale 10
/// preserves fractional digits — defaulting to 0 would silently drop them,
/// the worst failure mode for an analytical engine.
pub(crate) const DEFAULT_DECIMAL_SCALE: i8 = 10;

/// Convert a `rust_decimal::Decimal` to an `i128` mantissa at the given
/// Arrow scale.
///
/// For example, the value `123.45` at target scale 2 is stored as `12345`.
/// When the target scale is smaller than the source scale, the value is
/// rounded half away from zero (`1.235` at scale 2 becomes `1.24`,
/// `-1.235` becomes `-1.24`).
///
/// Returns [`ConnectorError::DecimalOverflow`] if the rescaled mantissa
/// cannot be represented in an `i128`.
pub(crate) fn decimal_to_i128(d: &Decimal, target_scale: i8) -> ConnectorResult<i128> {
    let raw = d.mantissa();
    // rust_decimal scales are 0..=28, so this cast cannot truncate.
    let d_scale = d.scale() as i32;
    let diff = i32::from(target_scale) - d_scale;

    if diff > 0 {
        let factor = checked_pow10(diff as u32, d)?;
        raw.checked_mul(factor).ok_or_else(|| decimal_overflow(d))
    } else if diff < 0 {
        let factor = checked_pow10(diff.unsigned_abs(), d)?;
        let quotient = raw / factor;
        let remainder = raw % factor;
        // Round half away from zero. `factor` is 10^k with k >= 1, so it is
        // even and `factor / 2` is exact; comparing |remainder| against it
        // avoids the overflow that `2 * remainder` could hit near i128::MAX.
        if remainder.abs() >= factor / 2 {
            Ok(quotient + raw.signum())
        } else {
            Ok(quotient)
        }
    } else {
        Ok(raw)
    }
}

/// Convert an `f64` to an `i128` mantissa at the given Arrow scale,
/// rounding half away from zero.
///
/// Used for SQL Server MONEY/SMALLMONEY columns, which tiberius decodes to
/// `f64` (the raw fixed-point integer divided by `1e4`). At target scale 4
/// this exactly reconstructs the source mantissa for all values within
/// `f64`'s 53-bit integer range.
///
/// Returns [`ConnectorError::DecimalOverflow`] if the value is not finite
/// or the rescaled value does not fit in an `i128`.
pub(crate) fn f64_to_scaled_i128(value: f64, target_scale: i8) -> ConnectorResult<i128> {
    if !value.is_finite() {
        return Err(ConnectorError::DecimalOverflow {
            value: value.to_string(),
        });
    }
    // `f64::round` rounds half away from zero, matching decimal_to_i128.
    let scaled = (value * 10f64.powi(i32::from(target_scale))).round();
    // i128::MAX as f64 rounds up to 2^127, which is out of range; i128::MIN
    // as f64 is exactly -2^127. Reject anything at or beyond those bounds.
    if !scaled.is_finite() || scaled >= i128::MAX as f64 || scaled <= i128::MIN as f64 {
        return Err(ConnectorError::DecimalOverflow {
            value: value.to_string(),
        });
    }
    Ok(scaled as i128)
}

/// Compute `10^exp` as an `i128`, mapping overflow to `DecimalOverflow`.
fn checked_pow10(exp: u32, d: &Decimal) -> ConnectorResult<i128> {
    10i128.checked_pow(exp).ok_or_else(|| decimal_overflow(d))
}

/// Build a `DecimalOverflow` error for the given source value.
fn decimal_overflow(d: &Decimal) -> ConnectorError {
    ConnectorError::DecimalOverflow {
        value: d.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::*;

    fn dec(s: &str) -> Decimal {
        Decimal::from_str(s).expect("valid test decimal")
    }

    #[test]
    fn upscale_multiplies_mantissa_exactly() {
        // 123.45 (scale 2) at target scale 4 -> 1234500
        assert_eq!(decimal_to_i128(&dec("123.45"), 4).unwrap(), 1_234_500);
    }

    #[test]
    fn same_scale_returns_mantissa_unchanged() {
        assert_eq!(decimal_to_i128(&dec("123.45"), 2).unwrap(), 12_345);
    }

    #[test]
    fn downscale_exact_value_has_no_rounding() {
        // 1.2300 (scale 4) at target scale 2 -> 123
        assert_eq!(decimal_to_i128(&dec("1.2300"), 2).unwrap(), 123);
    }

    #[test]
    fn downscale_rounds_half_away_from_zero_positive() {
        // 1.235 -> 1.24 at scale 2
        assert_eq!(decimal_to_i128(&dec("1.235"), 2).unwrap(), 124);
        // 1.2349 -> 1.23 at scale 2
        assert_eq!(decimal_to_i128(&dec("1.2349"), 2).unwrap(), 123);
        // 1.236 -> 1.24
        assert_eq!(decimal_to_i128(&dec("1.236"), 2).unwrap(), 124);
    }

    #[test]
    fn downscale_rounds_half_away_from_zero_negative() {
        // -1.235 -> -1.24 at scale 2
        assert_eq!(decimal_to_i128(&dec("-1.235"), 2).unwrap(), -124);
        // -1.2349 -> -1.23 at scale 2
        assert_eq!(decimal_to_i128(&dec("-1.2349"), 2).unwrap(), -123);
    }

    #[test]
    fn downscale_to_scale_zero_rounds() {
        assert_eq!(decimal_to_i128(&dec("123.99"), 0).unwrap(), 124);
        assert_eq!(decimal_to_i128(&dec("-123.5"), 0).unwrap(), -124);
        assert_eq!(decimal_to_i128(&dec("123.49"), 0).unwrap(), 123);
    }

    #[test]
    fn upscale_overflow_returns_error() {
        // Decimal::MAX has mantissa ~7.9e28 at scale 0; scaling to 10
        // requires multiplying by 1e10 -> ~7.9e38 > i128::MAX (~1.7e38).
        let err = decimal_to_i128(&Decimal::MAX, 10).unwrap_err();
        assert!(matches!(err, ConnectorError::DecimalOverflow { .. }));
        let err = decimal_to_i128(&Decimal::MIN, 10).unwrap_err();
        assert!(matches!(err, ConnectorError::DecimalOverflow { .. }));
    }

    #[test]
    fn upscale_large_mantissa_within_range_succeeds() {
        // Mantissa 7.9e28 at scale 0 scaled to 9 -> ~7.9e37, still < i128::MAX.
        let max = Decimal::MAX;
        let result = decimal_to_i128(&max, 9).unwrap();
        assert_eq!(result, max.mantissa() * 10i128.pow(9));
    }

    #[test]
    fn f64_money_value_reconstructs_mantissa_at_scale_4() {
        // tiberius decodes MONEY as raw_i64 / 1e4.
        let raw: i64 = 9_876_543_210_123;
        let value = raw as f64 / 1e4;
        assert_eq!(f64_to_scaled_i128(value, 4).unwrap(), i128::from(raw));
    }

    #[test]
    fn f64_rounds_half_away_from_zero() {
        assert_eq!(f64_to_scaled_i128(1.25, 1).unwrap(), 13);
        assert_eq!(f64_to_scaled_i128(-1.25, 1).unwrap(), -13);
    }

    #[test]
    fn f64_negative_money_value_converts() {
        assert_eq!(f64_to_scaled_i128(-123.4567, 4).unwrap(), -1_234_567);
    }

    #[test]
    fn f64_non_finite_returns_error() {
        assert!(matches!(
            f64_to_scaled_i128(f64::NAN, 4),
            Err(ConnectorError::DecimalOverflow { .. })
        ));
        assert!(matches!(
            f64_to_scaled_i128(f64::INFINITY, 4),
            Err(ConnectorError::DecimalOverflow { .. })
        ));
    }

    #[test]
    fn f64_overflow_returns_error() {
        assert!(matches!(
            f64_to_scaled_i128(f64::MAX, 4),
            Err(ConnectorError::DecimalOverflow { .. })
        ));
        assert!(matches!(
            f64_to_scaled_i128(-f64::MAX, 4),
            Err(ConnectorError::DecimalOverflow { .. })
        ));
    }
}
