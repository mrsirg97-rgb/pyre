use anchor_lang::prelude::*;

use crate::constants::{AGENT_SEED, MAX_PERSONALITY_LEN};
use crate::contexts::{Checkpoint, CheckpointArgs};
use crate::errors::PyreWorldError;
use crate::state::AgentProfile;

/// Update action counters, P&L, and personality summary.
/// Only the linked wallet can call this.
/// All counters must be >= existing values (monotonic constraint).
///
/// Uses UncheckedAccount for the profile to support migration from
/// pre-P&L accounts (old PDAs are 16 bytes shorter). The handler
/// validates the PDA, resizes if needed, then deserializes.
pub fn checkpoint(ctx: Context<Checkpoint>, args: CheckpointArgs) -> Result<()> {
    require!(
        args.personality_summary.len() <= MAX_PERSONALITY_LEN,
        PyreWorldError::PersonalityTooLong
    );

    let profile_info = ctx.accounts.profile.to_account_info();

    // ── Validate PDA ──
    // Read creator from raw bytes (8 discriminator + 32 creator)
    let data = profile_info.try_borrow_data()?;
    require!(data.len() >= 40, PyreWorldError::WalletLinkMismatch);
    let creator_bytes: [u8; 32] = data[8..40].try_into().unwrap();
    let creator = Pubkey::from(creator_bytes);

    // Read linked_wallet from raw bytes (8 disc + 32 creator + 32 authority + 32 linked_wallet)
    require!(data.len() >= 104, PyreWorldError::WalletLinkMismatch);
    let lw_bytes: [u8; 32] = data[72..104].try_into().unwrap();
    let linked_wallet = Pubkey::from(lw_bytes);
    drop(data);

    let (expected_pda, _bump) = Pubkey::find_program_address(
        &[AGENT_SEED, creator.as_ref()],
        ctx.program_id,
    );
    require!(
        *profile_info.key == expected_pda,
        PyreWorldError::WalletLinkMismatch
    );
    require!(
        ctx.accounts.signer.key() == linked_wallet,
        PyreWorldError::WalletLinkMismatch
    );

    // ── Resize if needed (pre-P&L migration) ──
    let current_len = profile_info.data_len();
    let new_len = AgentProfile::LEN;

    if current_len < new_len {
        let rent = Rent::get()?;
        let new_minimum_balance = rent.minimum_balance(new_len);
        let current_balance = profile_info.lamports();

        if current_balance < new_minimum_balance {
            let diff = new_minimum_balance - current_balance;
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.signer.to_account_info(),
                        to: profile_info.clone(),
                    },
                ),
                diff,
            )?;
        }

        profile_info.resize(new_len)?;
    }

    // ── Deserialize (now safe — account is the right size) ──
    let mut data = profile_info.try_borrow_mut_data()?;
    let mut profile = AgentProfile::try_deserialize(&mut &data[..])
        .map_err(|_| error!(PyreWorldError::WalletLinkMismatch))?;

    // ── Monotonic counter validation ──
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

    // ── Update fields ──
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
    profile.total_sol_spent = args.total_sol_spent;
    profile.total_sol_received = args.total_sol_received;
    profile.personality_summary = args.personality_summary;
    profile.last_checkpoint = Clock::get()?.unix_timestamp;

    // ── Serialize back ──
    let mut writer = &mut data[..];
    profile.try_serialize(&mut writer)
        .map_err(|_| error!(PyreWorldError::WalletLinkMismatch))?;

    Ok(())
}
