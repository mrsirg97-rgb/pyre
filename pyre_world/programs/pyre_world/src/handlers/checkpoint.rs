use anchor_lang::prelude::*;

use crate::constants::MAX_PERSONALITY_LEN;
use crate::contexts::{Checkpoint, CheckpointArgs};
use crate::errors::PyreWorldError;

/// Update action counters, P&L, and personality summary.
/// Only the linked wallet can call this.
/// All counters must be >= existing values (monotonic constraint).
pub fn checkpoint(ctx: Context<Checkpoint>, args: CheckpointArgs) -> Result<()> {
    // Validate personality length
    require!(
        args.personality_summary.len() <= MAX_PERSONALITY_LEN,
        PyreWorldError::PersonalityTooLong
    );

    let profile = &mut ctx.accounts.profile;

    // Monotonic counter validation — each new value must be >= existing
    require!(args.joins >= profile.joins, PyreWorldError::CounterNotMonotonic);
    require!(args.defects >= profile.defects, PyreWorldError::CounterNotMonotonic);
    require!(args.rallies >= profile.rallies, PyreWorldError::CounterNotMonotonic);
    require!(args.launches >= profile.launches, PyreWorldError::CounterNotMonotonic);
    require!(args.messages >= profile.messages, PyreWorldError::CounterNotMonotonic);
    require!(args.fuds >= profile.fuds, PyreWorldError::CounterNotMonotonic);
    require!(args.infiltrates >= profile.infiltrates, PyreWorldError::CounterNotMonotonic);
    require!(args.reinforces >= profile.reinforces, PyreWorldError::CounterNotMonotonic);
    require!(args.war_loans >= profile.war_loans, PyreWorldError::CounterNotMonotonic);
    require!(args.repay_loans >= profile.repay_loans, PyreWorldError::CounterNotMonotonic);
    require!(args.sieges >= profile.sieges, PyreWorldError::CounterNotMonotonic);
    require!(args.ascends >= profile.ascends, PyreWorldError::CounterNotMonotonic);
    require!(args.razes >= profile.razes, PyreWorldError::CounterNotMonotonic);
    require!(args.tithes >= profile.tithes, PyreWorldError::CounterNotMonotonic);
    require!(args.total_sol_spent >= profile.total_sol_spent, PyreWorldError::CounterNotMonotonic);
    require!(args.total_sol_received >= profile.total_sol_received, PyreWorldError::CounterNotMonotonic);

    // Update counters
    profile.joins = args.joins;
    profile.defects = args.defects;
    profile.rallies = args.rallies;
    profile.launches = args.launches;
    profile.messages = args.messages;
    profile.fuds = args.fuds;
    profile.infiltrates = args.infiltrates;
    profile.reinforces = args.reinforces;
    profile.war_loans = args.war_loans;
    profile.repay_loans = args.repay_loans;
    profile.sieges = args.sieges;
    profile.ascends = args.ascends;
    profile.razes = args.razes;
    profile.tithes = args.tithes;

    // Update P&L
    profile.total_sol_spent = args.total_sol_spent;
    profile.total_sol_received = args.total_sol_received;

    // Update personality and timestamp
    profile.personality_summary = args.personality_summary;
    profile.last_checkpoint = Clock::get()?.unix_timestamp;

    Ok(())
}
