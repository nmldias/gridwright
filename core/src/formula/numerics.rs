//! Excel numerics in one place: comparison at 15 significant digits, decimal rounding
//! (ROUND and friends, TEXT, FIXED, DOLLAR) and number → text as Excel's General format.
//! Stored inputs and arithmetic results are never changed by these helpers.
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

/// A finite number as fifteen significant decimal digits: `neg`, `digits` (< 10^15) × 10^`exp`.
/// Ties at the sixteenth digit round away from zero, as Excel and JavaScript do (Rust's
/// formatter rounds them to even), so the engine and the browser show the same text.
struct Dec15 {
    neg: bool,
    digits: u64,
    exp: i32,
}

fn dec15(x: f64) -> Dec15 {
    let s = format!("{:.14e}", x.abs());
    let (m, e) = s.split_once('e').unwrap_or((&s, "0"));
    let mut digits: u64 = m.replace('.', "").parse().unwrap_or(0);
    let mut exp: i32 = e.parse::<i32>().unwrap_or(0) - 14;
    if digits % 2 == 0 && digits != 0 {
        // An exact tie needs the sixteenth digit to be 5 with nothing after it.
        let wide = format!("{:.29e}", x.abs());
        let w: String = wide.split('e').next().unwrap_or("").replace('.', "");
        if w.len() == 30 && w.as_bytes()[15] == b'5' && w[16..].bytes().all(|c| c == b'0') && w[..15].parse::<u64>().ok() == Some(digits) {
            digits += 1;
            if digits == 1_000_000_000_000_000 {
                digits /= 10;
                exp += 1;
            }
        }
    }
    Dec15 { neg: x < 0.0 && digits != 0, digits, exp }
}

/// The number as Excel keeps it: rounded to 15 significant digits. Used where a result is
/// built by arithmetic on decimal operands (MROUND, CEILING, FLOOR) so 7×0.1 is 0.7.
pub fn normalize15(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return if x == 0.0 { 0.0 } else { x };
    }
    let d = dec15(x);
    let v: f64 = format!("{}e{}", d.digits, d.exp).parse().unwrap_or(x);
    if d.neg { -v } else { v }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Rounding {
    /// ROUND, TEXT, FIXED, DOLLAR: half away from zero.
    HalfAway,
    /// ROUNDUP: away from zero.
    Up,
    /// ROUNDDOWN, TRUNC: towards zero.
    Down,
}

/// `x` rounded at `places` decimals (negative: left of the point) on its 15-digit decimal
/// value: `(neg, m, scale)` with the result m × 10^scale. `None` when no digit is dropped.
fn round_dec(x: f64, places: i32, mode: Rounding) -> Option<(bool, u128, i32)> {
    let d = dec15(x);
    let target = -places;
    if d.exp >= target {
        return None;
    }
    let k = (target - d.exp) as u32;
    let digits = d.digits as u128;
    let (q, rest, half) = if k >= 16 {
        (0, digits, false)
    } else {
        let p = 10u128.pow(k);
        (digits / p, digits % p, digits % p >= p / 2)
    };
    let m = match mode {
        Rounding::HalfAway => q + half as u128,
        Rounding::Up => q + (rest != 0) as u128,
        Rounding::Down => q,
    };
    Some((d.neg, m, target))
}

/// ROUND, ROUNDUP, ROUNDDOWN and TRUNC as Excel computes them: on the decimal value the
/// number shows, so ROUND(1.005, 2) is 1.01 and ROUND(2.675, 2) is 2.68. `places` is
/// truncated to an integer, like Excel's num_digits.
pub fn round_decimal(x: f64, places: f64, mode: Rounding) -> f64 {
    if !x.is_finite() || x == 0.0 || places.is_nan() {
        return x;
    }
    let places = places.trunc().clamp(-400.0, 400.0) as i32;
    match round_dec(x, places, mode) {
        None => x,
        Some((_, 0, _)) => 0.0,
        Some((neg, m, scale)) => {
            let v: f64 = format!("{}e{}", m, scale).parse().unwrap_or(f64::INFINITY);
            if neg { -v } else { v }
        }
    }
}

/// |x| with exactly `places` decimals, rounded half away from zero on its 15-digit value
/// (digits past the fifteenth are zeros, as Excel shows them). Large numbers are written out.
pub fn fixed_abs(x: f64, places: usize) -> String {
    if !x.is_finite() {
        return format!("{}", x.abs());
    }
    let (m, scale) = match round_dec(x, places as i32, Rounding::HalfAway) {
        Some((_, m, s)) => (m, s),
        None => {
            let d = dec15(x);
            (d.digits as u128, d.exp)
        }
    };
    let mut s = m.to_string();
    if m != 0 {
        s.push_str(&"0".repeat((scale + places as i32).max(0) as usize));
    }
    if places == 0 {
        return s;
    }
    if s.len() <= places {
        s = format!("{}{}", "0".repeat(places + 1 - s.len()), s);
    }
    let (i, f) = s.split_at(s.len() - places);
    format!("{}.{}", i, f)
}

/// Number → text as Excel's General format writes it without a column width (what `&`,
/// CONCAT, a pivot key or a re-written formula literal show): up to 15 significant
/// digits, no trailing zeros, scientific notation from 1E+15 and below 1E-9.
pub fn general_text(x: f64) -> String {
    if x.is_nan() {
        return "#NUM!".into();
    }
    if !x.is_finite() {
        return format!("{}", x);
    }
    if x == 0.0 {
        return "0".into();
    }
    if x == x.trunc() && x.abs() < 1e15 {
        return format!("{}", x as i64);
    }
    let d = dec15(x);
    let (mut digits, mut exp) = (d.digits, d.exp);
    while digits % 10 == 0 {
        digits /= 10;
        exp += 1;
    }
    let ds = digits.to_string();
    let sci = exp + ds.len() as i32 - 1;
    let sign = if d.neg { "-" } else { "" };
    if sci >= 15 || sci < -9 {
        let mant = if ds.len() > 1 { format!("{}.{}", &ds[..1], &ds[1..]) } else { ds };
        return format!("{}{}E{}{:02}", sign, mant, if sci < 0 { '-' } else { '+' }, sci.abs());
    }
    if exp >= 0 {
        format!("{}{}{}", sign, ds, "0".repeat(exp as usize))
    } else {
        let places = (-exp) as usize;
        let padded = if ds.len() <= places { format!("{}{}", "0".repeat(places + 1 - ds.len()), ds) } else { ds };
        let (i, f) = padded.split_at(padded.len() - places);
        format!("{}{}.{}", sign, i, f)
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
