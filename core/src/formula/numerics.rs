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
    if a == b {
        return true;
    }
    if !(a.is_finite() && b.is_finite()) {
        return false;
    }
    // Two numbers with the same 15-digit key are both within half a unit of its 15th digit, so
    // they differ by at most ~1.0000001e-14 of the larger magnitude (opposite signs never share a
    // key). Anything further apart is unequal without formatting: the usual case in sorts,
    // criteria and lookups. Below ~2.5e-310 the product can round towards zero, but there
    // adjacent doubles are already more than 1e-14 apart relatively, so the answer still holds.
    let scale = a.abs().max(b.abs());
    if (a - b).abs() > scale * 2e-14 {
        return false;
    }
    number_key(a) == number_key(b)
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

    #[test]
    fn quick_inequality_agrees_with_the_key() {
        // The pre-check in numbers_equal only skips work: for every pair it must give the same
        // answer as comparing the 15-digit keys. Pairs a few doubles apart and at relative
        // distances around the 1e-14 boundary, across magnitudes, signs and digit roll-overs.
        let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut bases = vec![0.3, 1.0, 10.0, 9.999999999999996, 1.005, 123456789012345.5, 1e15, 2.5e-310, 1e-300, 1e300];
        for _ in 0..4000 {
            let mant = (next() >> 11) as f64 / (1u64 << 53) as f64 * 9.0 + 1.0;
            let exp = (next() % 600) as i32 - 300;
            bases.push(mant * 10f64.powi(exp));
        }
        let rel = [0.0, 1e-16, 5e-15, 9.9e-15, 1e-14, 1.01e-14, 1.5e-14, 2e-14, 3e-14, 1e-13];
        let mut checked = 0;
        for &x in &bases {
            for s in [1.0, -1.0] {
                let a = x * s;
                let mut others: Vec<f64> = (1..=4).flat_map(|k| [f64::from_bits(a.to_bits() + k), f64::from_bits(a.to_bits() - k)]).collect();
                others.extend(rel.iter().flat_map(|r| [a * (1.0 + r), a * (1.0 - r)]));
                others.push(-a);
                for b in others.into_iter().filter(|b| b.is_finite()) {
                    let by_key = a == b || number_key(a) == number_key(b);
                    assert_eq!(numbers_equal(a, b), by_key, "{a:e} vs {b:e}");
                    checked += 1;
                }
            }
        }
        assert!(checked > 100_000);
    }
}
