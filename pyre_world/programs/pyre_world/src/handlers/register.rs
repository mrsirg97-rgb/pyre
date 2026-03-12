use anchor_lang::prelude::*;

use crate::contexts::Register;

/// Create an AgentProfile and auto-link the creator's wallet.
pub fn register(ctx: Context<Register>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    let profile = &mut ctx.accounts.profile;
    profile.creator = ctx.accounts.creator.key();
    profile.authority = ctx.accounts.creator.key();
    profile.linked_wallet = ctx.accounts.creator.key();
    profile.personality_summary = String::new();
    profile.last_checkpoint = 0;
    profile.joins = 0;
    profile.defects = 0;
    profile.rallies = 0;
    profile.launches = 0;
    profile.messages = 0;
    profile.fuds = 0;
    profile.infiltrates = 0;
    profile.reinforces = 0;
    profile.war_loans = 0;
    profile.repay_loans = 0;
    profile.sieges = 0;
    profile.ascends = 0;
    profile.razes = 0;
    profile.tithes = 0;
    profile.created_at = now;
    profile.bump = ctx.bumps.profile;
    profile.total_sol_spent = 0;
    profile.total_sol_received = 0;

    let wallet_link = &mut ctx.accounts.wallet_link;
    wallet_link.profile = profile.key();
    wallet_link.wallet = ctx.accounts.creator.key();
    wallet_link.linked_at = now;
    wallet_link.bump = ctx.bumps.wallet_link;

    Ok(())
}
