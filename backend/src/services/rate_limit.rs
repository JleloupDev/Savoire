// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Limitation de debit : un seau de jetons par cle (compte, adresse, vault),
// plein d'une minute de jetons et rempli au fil de l'eau, comme le limiteur
// d'ASP.NET Core qu'utilisait le serveur .NET (TokenBucketRateLimiter) :
//  - au moins 60 par minute : ceil(n/60) jetons chaque seconde ;
//  - moins : un jeton toutes les 60/n secondes.
// Depassement : refus, avec le delai avant le prochain jeton.

use std::time::{Duration, Instant};

use dashmap::DashMap;

struct Bucket {
    tokens: f64,
    per_minute: i64,
    last: Instant,
}

impl Bucket {
    fn period_and_tokens(per_minute: i64) -> (Duration, f64) {
        if per_minute < 60 {
            (Duration::from_secs_f64(60.0 / per_minute as f64), 1.0)
        } else {
            (Duration::from_secs(1), (per_minute as f64 / 60.0).ceil())
        }
    }

    fn refill(&mut self, now: Instant) {
        let (period, per) = Self::period_and_tokens(self.per_minute);
        let periods = (now.duration_since(self.last).as_secs_f64() / period.as_secs_f64()).floor();
        if periods >= 1.0 {
            self.tokens = (self.tokens + periods * per).min(self.per_minute as f64);
            self.last += period.mul_f64(periods);
        }
    }
}

#[derive(Default)]
pub struct RateLimiter {
    buckets: DashMap<String, Bucket>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Prend un jeton du seau `key` (`per_minute` jetons par minute). Ok, ou le
    /// nombre de secondes a attendre. `per_minute <= 0` : pas de limite.
    pub fn try_acquire(&self, key: &str, per_minute: i64) -> Result<(), u64> {
        if per_minute <= 0 {
            return Ok(());
        }
        let now = Instant::now();
        let mut b = self
            .buckets
            .entry(key.to_string())
            .or_insert_with(|| Bucket { tokens: per_minute as f64, per_minute, last: now });
        if b.per_minute != per_minute {
            b.per_minute = per_minute;
            b.tokens = b.tokens.min(per_minute as f64);
        }
        b.refill(now);
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            return Ok(());
        }
        let (period, _) = Bucket::period_and_tokens(per_minute);
        let wait = period.saturating_sub(now.duration_since(b.last));
        Err(wait.as_secs_f64().ceil().max(1.0) as u64)
    }

    /// Oublie les seaux pleins depuis longtemps (appele de temps en temps).
    pub fn sweep(&self) {
        let now = Instant::now();
        self.buckets.retain(|_, b| now.duration_since(b.last) < Duration::from_secs(600));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_empties_then_refuses() {
        let l = RateLimiter::new();
        for _ in 0..3 {
            assert!(l.try_acquire("k", 3).is_ok());
        }
        let wait = l.try_acquire("k", 3).unwrap_err();
        assert!((1..=20).contains(&wait));
        assert!(l.try_acquire("other", 3).is_ok());
        assert!(l.try_acquire("free", 0).is_ok());
    }

    #[test]
    fn fast_bucket_refills_each_second() {
        let mut b = Bucket { tokens: 0.0, per_minute: 120, last: Instant::now() - Duration::from_millis(2100) };
        b.refill(Instant::now());
        assert_eq!(b.tokens, 4.0);
    }
}
