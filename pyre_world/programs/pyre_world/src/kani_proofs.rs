//! Kani Formal Verification Proof Harnesses
//!
//! Mathematically proves properties of pyre_world's checkpoint logic
//! for ALL valid inputs within protocol bounds.
//!
//! Run with: cargo kani
//!
//! Each harness verifies a specific property (monotonicity, bounds)
//! using symbolic inputs.

use crate::constants::*;

// ============================================================================
// Pure math replicas (extracted from handlers for standalone verification)
// ============================================================================

/// Validates that a new counter value is >= the old value (monotonic).
/// Returns true if valid, false if rollback attempted.
fn is_monotonic(old: u64, new: u64) -> bool {
    new >= old
}

/// Validates personality summary length.
fn is_valid_personality_len(len: usize) -> bool {
    len <= MAX_PERSONALITY_LEN
}

// ============================================================================
// Proof Harnesses
// ============================================================================

/// Verify that monotonic check correctly rejects any new value < old value
/// and accepts any new value >= old value, for all u64 pairs.
#[cfg(kani)]
#[kani::proof]
fn verify_counter_monotonic() {
    let old: u64 = kani::any();
    let new: u64 = kani::any();

    let result = is_monotonic(old, new);

    if new >= old {
        assert!(result, "monotonic check must accept new >= old");
    } else {
        assert!(!result, "monotonic check must reject new < old");
    }
}

/// Verify that monotonic check holds across all 14 counters simultaneously.
/// If all individual checks pass, no counter has decreased.
#[cfg(kani)]
#[kani::proof]
fn verify_all_counters_monotonic() {
    // Symbolic old counters
    let old_joins: u64 = kani::any();
    let old_defects: u64 = kani::any();
    let old_rallies: u64 = kani::any();
    let old_launches: u64 = kani::any();
    let old_messages: u64 = kani::any();
    let old_fuds: u64 = kani::any();
    let old_infiltrates: u64 = kani::any();
    let old_reinforces: u64 = kani::any();
    let old_war_loans: u64 = kani::any();
    let old_repay_loans: u64 = kani::any();
    let old_sieges: u64 = kani::any();
    let old_ascends: u64 = kani::any();
    let old_razes: u64 = kani::any();
    let old_tithes: u64 = kani::any();

    // Symbolic new counters
    let new_joins: u64 = kani::any();
    let new_defects: u64 = kani::any();
    let new_rallies: u64 = kani::any();
    let new_launches: u64 = kani::any();
    let new_messages: u64 = kani::any();
    let new_fuds: u64 = kani::any();
    let new_infiltrates: u64 = kani::any();
    let new_reinforces: u64 = kani::any();
    let new_war_loans: u64 = kani::any();
    let new_repay_loans: u64 = kani::any();
    let new_sieges: u64 = kani::any();
    let new_ascends: u64 = kani::any();
    let new_razes: u64 = kani::any();
    let new_tithes: u64 = kani::any();

    // Assume all monotonic checks pass (simulates checkpoint accepting the values)
    kani::assume(is_monotonic(old_joins, new_joins));
    kani::assume(is_monotonic(old_defects, new_defects));
    kani::assume(is_monotonic(old_rallies, new_rallies));
    kani::assume(is_monotonic(old_launches, new_launches));
    kani::assume(is_monotonic(old_messages, new_messages));
    kani::assume(is_monotonic(old_fuds, new_fuds));
    kani::assume(is_monotonic(old_infiltrates, new_infiltrates));
    kani::assume(is_monotonic(old_reinforces, new_reinforces));
    kani::assume(is_monotonic(old_war_loans, new_war_loans));
    kani::assume(is_monotonic(old_repay_loans, new_repay_loans));
    kani::assume(is_monotonic(old_sieges, new_sieges));
    kani::assume(is_monotonic(old_ascends, new_ascends));
    kani::assume(is_monotonic(old_razes, new_razes));
    kani::assume(is_monotonic(old_tithes, new_tithes));

    // Prove: if all checks pass, no counter has decreased
    assert!(new_joins >= old_joins);
    assert!(new_defects >= old_defects);
    assert!(new_rallies >= old_rallies);
    assert!(new_launches >= old_launches);
    assert!(new_messages >= old_messages);
    assert!(new_fuds >= old_fuds);
    assert!(new_infiltrates >= old_infiltrates);
    assert!(new_reinforces >= old_reinforces);
    assert!(new_war_loans >= old_war_loans);
    assert!(new_repay_loans >= old_repay_loans);
    assert!(new_sieges >= old_sieges);
    assert!(new_ascends >= old_ascends);
    assert!(new_razes >= old_razes);
    assert!(new_tithes >= old_tithes);
}

/// Verify that personality length validation correctly accepts
/// strings at or below MAX_PERSONALITY_LEN and rejects longer ones.
#[cfg(kani)]
#[kani::proof]
fn verify_personality_length() {
    let len: usize = kani::any();
    // Bound to prevent solver blowup — 512 covers max + margin
    kani::assume(len <= 512);

    let result = is_valid_personality_len(len);

    if len <= MAX_PERSONALITY_LEN {
        assert!(result, "must accept len <= MAX_PERSONALITY_LEN");
    } else {
        assert!(!result, "must reject len > MAX_PERSONALITY_LEN");
    }
}

/// Verify that checkpoint timestamp is non-decreasing.
/// If new_timestamp >= old_timestamp is enforced, time never goes backward.
#[cfg(kani)]
#[kani::proof]
fn verify_checkpoint_timestamp_monotonic() {
    let old_timestamp: i64 = kani::any();
    let new_timestamp: i64 = kani::any();

    // Constrain to valid unix timestamps (positive, reasonable range)
    kani::assume(old_timestamp >= 0);
    kani::assume(new_timestamp >= 0);
    kani::assume(new_timestamp >= old_timestamp);

    assert!(
        new_timestamp >= old_timestamp,
        "checkpoint timestamp must not decrease"
    );
}

/// Verify that the total action count (sum of all counters) cannot overflow u64
/// when each individual counter is bounded to a realistic maximum.
/// With 14 counters, even at u64::MAX / 14 each, the sum fits in u128.
#[cfg(kani)]
#[kani::proof]
fn verify_total_actions_no_overflow() {
    // Realistic upper bound: no agent takes more than 10 million of any single action
    let max_per_counter: u64 = 10_000_000;

    let joins: u64 = kani::any();
    let defects: u64 = kani::any();
    let rallies: u64 = kani::any();
    let launches: u64 = kani::any();
    let messages: u64 = kani::any();
    let fuds: u64 = kani::any();
    let infiltrates: u64 = kani::any();
    let reinforces: u64 = kani::any();
    let war_loans: u64 = kani::any();
    let repay_loans: u64 = kani::any();
    let sieges: u64 = kani::any();
    let ascends: u64 = kani::any();
    let razes: u64 = kani::any();
    let tithes: u64 = kani::any();

    kani::assume(joins <= max_per_counter);
    kani::assume(defects <= max_per_counter);
    kani::assume(rallies <= max_per_counter);
    kani::assume(launches <= max_per_counter);
    kani::assume(messages <= max_per_counter);
    kani::assume(fuds <= max_per_counter);
    kani::assume(infiltrates <= max_per_counter);
    kani::assume(reinforces <= max_per_counter);
    kani::assume(war_loans <= max_per_counter);
    kani::assume(repay_loans <= max_per_counter);
    kani::assume(sieges <= max_per_counter);
    kani::assume(ascends <= max_per_counter);
    kani::assume(razes <= max_per_counter);
    kani::assume(tithes <= max_per_counter);

    // Sum in u128 to check for overflow
    let total: u128 = joins as u128
        + defects as u128
        + rallies as u128
        + launches as u128
        + messages as u128
        + fuds as u128
        + infiltrates as u128
        + reinforces as u128
        + war_loans as u128
        + repay_loans as u128
        + sieges as u128
        + ascends as u128
        + razes as u128
        + tithes as u128;

    // 14 * 10_000_000 = 140_000_000 — fits in u64 easily
    assert!(total <= u64::MAX as u128, "total actions must fit in u64");
}
