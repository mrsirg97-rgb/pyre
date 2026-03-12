use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::PyreWorldError;
use crate::state::*;

// ============================================================================
// Instruction Arguments
// ============================================================================

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CheckpointArgs {
    pub joins: u64,
    pub defects: u64,
    pub rallies: u64,
    pub launches: u64,
    pub messages: u64,
    pub fuds: u64,
    pub infiltrates: u64,
    pub reinforces: u64,
    pub war_loans: u64,
    pub repay_loans: u64,
    pub sieges: u64,
    pub ascends: u64,
    pub razes: u64,
    pub tithes: u64,
    pub personality_summary: String,
    pub total_sol_spent: u64,
    pub total_sol_received: u64,
}

// ============================================================================
// Register — create profile + auto-link creator wallet
// ============================================================================

#[derive(Accounts)]
pub struct Register<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        init,
        payer = creator,
        space = AgentProfile::LEN,
        seeds = [AGENT_SEED, creator.key().as_ref()],
        bump
    )]
    pub profile: Account<'info, AgentProfile>,

    /// Auto-created wallet link for the creator
    #[account(
        init,
        payer = creator,
        space = AgentWalletLink::LEN,
        seeds = [AGENT_WALLET_SEED, creator.key().as_ref()],
        bump
    )]
    pub wallet_link: Account<'info, AgentWalletLink>,

    pub system_program: Program<'info, System>,
}

// ============================================================================
// Checkpoint — update counters + personality (linked wallet only)
// ============================================================================

#[derive(Accounts)]
pub struct Checkpoint<'info> {
    /// Must be the profile's linked_wallet
    #[account(
        mut,
        constraint = signer.key() == profile.linked_wallet @ PyreWorldError::WalletLinkMismatch,
    )]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [AGENT_SEED, profile.creator.as_ref()],
        bump = profile.bump,
    )]
    pub profile: Account<'info, AgentProfile>,
}

// ============================================================================
// LinkWallet — authority only, link a new wallet
// ============================================================================

#[derive(Accounts)]
pub struct LinkWallet<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [AGENT_SEED, profile.creator.as_ref()],
        bump = profile.bump,
        has_one = authority @ PyreWorldError::WalletLinkMismatch,
    )]
    pub profile: Account<'info, AgentProfile>,

    /// CHECK: The wallet to link (doesn't need to sign — authority controls this)
    pub wallet_to_link: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = AgentWalletLink::LEN,
        seeds = [AGENT_WALLET_SEED, wallet_to_link.key().as_ref()],
        bump
    )]
    pub wallet_link: Account<'info, AgentWalletLink>,

    pub system_program: Program<'info, System>,
}

// ============================================================================
// UnlinkWallet — authority only, unlink the current wallet
// ============================================================================

#[derive(Accounts)]
pub struct UnlinkWallet<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [AGENT_SEED, profile.creator.as_ref()],
        bump = profile.bump,
        has_one = authority @ PyreWorldError::WalletLinkMismatch,
    )]
    pub profile: Account<'info, AgentProfile>,

    /// CHECK: The wallet being unlinked
    pub wallet_to_unlink: UncheckedAccount<'info>,

    #[account(
        mut,
        close = authority,
        seeds = [AGENT_WALLET_SEED, wallet_to_unlink.key().as_ref()],
        bump = wallet_link.bump,
        constraint = wallet_link.profile == profile.key() @ PyreWorldError::WalletLinkMismatch,
    )]
    pub wallet_link: Account<'info, AgentWalletLink>,

    pub system_program: Program<'info, System>,
}

// ============================================================================
// TransferAuthority — transfer profile admin to a new wallet
// ============================================================================

#[derive(Accounts)]
pub struct TransferAuthority<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [AGENT_SEED, profile.creator.as_ref()],
        bump = profile.bump,
        has_one = authority @ PyreWorldError::WalletLinkMismatch,
    )]
    pub profile: Account<'info, AgentProfile>,

    /// CHECK: New authority wallet — no signature required
    pub new_authority: UncheckedAccount<'info>,
}
