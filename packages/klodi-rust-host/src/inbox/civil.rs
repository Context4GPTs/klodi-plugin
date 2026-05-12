//! Howard Hinnant's civil/Julian day arithmetic — shared helpers for
//! ISO8601 ↔ unix-seconds conversion without pulling chrono / time as
//! deps. Used by `inbox::filter` (parsing the gateway's `created_at`
//! into comparable integers) and `inbox::handlers` (rendering the
//! server-side `polled_at` field).
//!
//! Reference: https://howardhinnant.github.io/date_algorithms.html

/// Days from 1970-01-01 to the proleptic Gregorian `Y/M/D`. Returns
/// `None` for impossible dates (month 0/13, February 30, …) so callers
/// don't silently coerce malformed inputs.
pub(crate) fn days_from_civil(year: i64, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) {
        return None;
    }
    let max_day = days_in_month(year, month);
    if day == 0 || day > max_day {
        return None;
    }
    let (y, m) = if month <= 2 {
        (year - 1, month + 12)
    } else {
        (year, month)
    };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m as i64 - 3) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe - 719468)
}

/// Inverse of [`days_from_civil`]. Given a count of days from
/// 1970-01-01, return the proleptic Gregorian `(year, month, day)`.
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Render a unix-seconds timestamp as `YYYY-MM-DDTHH:MM:SSZ`. The shape
/// matches what the ZeroClaw gateway emits in `created_at`, so the
/// inbox's outbound JSON contract stays internally consistent.
pub(crate) fn format_unix_seconds(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let hour = sod / 3600;
    let minute = (sod % 3600) / 60;
    let second = sod % 60;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap_year(year) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_round_trips() {
        assert_eq!(days_from_civil(1970, 1, 1), Some(0));
        assert_eq!(civil_from_days(0), (1970, 1, 1));
    }

    #[test]
    fn rejects_impossible_dates() {
        assert!(days_from_civil(2026, 13, 1).is_none());
        assert!(days_from_civil(2026, 2, 30).is_none());
        assert!(days_from_civil(2026, 0, 1).is_none());
        assert!(days_from_civil(2026, 4, 31).is_none());
    }

    #[test]
    fn handles_leap_years_correctly() {
        assert_eq!(days_from_civil(2024, 2, 29).map(Some), Some(Some(19782)));
        assert!(days_from_civil(2023, 2, 29).is_none()); // not a leap year
        assert!(days_from_civil(2000, 2, 29).is_some()); // century leap
        assert!(days_from_civil(1900, 2, 29).is_none()); // not a leap year (century rule)
    }

    #[test]
    fn format_unix_seconds_anchors() {
        assert_eq!(format_unix_seconds(0), "1970-01-01T00:00:00Z");
        // 2026-05-12T10:00:00Z = 1_778_580_000 — same constant as the
        // anchor test in `inbox::filter`.
        assert_eq!(
            format_unix_seconds(1_778_580_000),
            "2026-05-12T10:00:00Z",
        );
    }
}
