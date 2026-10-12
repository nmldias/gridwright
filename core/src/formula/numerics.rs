//! Comparison precision, without changing stored inputs or arithmetic results.
use std::cmp::Ordering;

/// Decimal scientific notation with fourteen fractional digits has fifteen significant
/// digits. Formatting avoids powers of ten overflowing/underflowing at f64's extremes.
/// This bounded conversion is shared with hash keys so equality is transitive and indexed
/// lookups agree with scalar lookups. Signed zero has one representation.
pub(crate) fn number_key(x: f64) -> String {
    format!("{:.14e}", if x == 0.0 { 0.0 } else { x })
}

pub fn numbers_equal(a: f64, b: f64) -> bool {
    a == b || (a.is_finite() && b.is_finite() && number_key(a) == number_key(b))
}

pub fn compare_numbers(a: f64, b: f64) -> Ordering {
    if numbers_equal(a, b) {
        Ordering::Equal
    } else {
        // Preserve the engine's existing NaN comparison behavior; formulas reject nonfinite
        // arithmetic results. Infinities are also used as unbounded validation endpoints.
        a.partial_cmp(&b).unwrap_or(Ordering::Equal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn significant_digits_and_extremes() {
        // Precision policy: https://learn.microsoft.com/en-us/office/troubleshoot/excel/floating-point-arithmetic-inaccurate-result
        for (a, b) in [(0.1+0.2, 0.3), (-0.0, 0.0), (9.999999999999999, 10.0),
                       (f64::MAX, f64::from_bits(f64::MAX.to_bits()-1))] {
            assert!(numbers_equal(a, b), "{a}, {b}");
            assert_eq!(number_key(a), number_key(b));
        }
        for (a, b) in [(0.0, f64::from_bits(1)), (1e-300, 2e-300),
                       (1.23456789012345, 1.23456789012346), (f64::MAX, f64::INFINITY)] {
            assert!(!numbers_equal(a, b));
            assert_eq!(compare_numbers(a, b), Ordering::Less);
        }
        assert!(!numbers_equal(f64::NAN, f64::NAN));
        assert!(numbers_equal(f64::INFINITY, f64::INFINITY));
    }
}
