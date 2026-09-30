use std::cmp::Ordering;

fn parts(ts: &str) -> (u64, u64) {
    let (seconds, micros) = ts.split_once('.').unwrap_or((ts, "0"));
    (seconds.parse().unwrap_or(0), format!("{micros:0<6}").parse().unwrap_or(0))
}

pub fn compare(a: &str, b: &str) -> Ordering {
    parts(a).cmp(&parts(b))
}

pub fn is_after(ts: &str, other: &str) -> bool {
    compare(ts, other) == Ordering::Greater
}

pub fn max<'a>(a: &'a str, b: &'a str) -> &'a str {
    if is_after(b, a) { b } else { a }
}

pub fn preceding(ts: &str) -> String {
    let (seconds, micros) = parts(ts);
    if micros > 0 {
        format!("{seconds}.{:06}", micros - 1)
    } else {
        format!("{}.999999", seconds.saturating_sub(1))
    }
}

pub fn seconds(ts: &str) -> i64 {
    parts(ts).0 as i64
}
