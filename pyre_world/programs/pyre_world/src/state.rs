use anchor_lang::prelude::*;

use crate::constants::MAX_PERSONALITY_LEN;

/// Per-agent identity and state. One per creator.
///
/// Stores action distribution counters (monotonically increasing)
/// and a compressed personality summary for stateless reconstruction.
///
/// Seeds: ["pyre_agent", creator.key()]
#[account]
pub struct AgentProfile {
    /// Immutable creator wallet — PDA seed (never changes)
    pub creator: Pubkey,
    /// Current authority — controls link/unlink/transfer (transferable)
    pub authority: Pubkey,
    /// Current active wallet that can write checkpoints
    pub linked_wallet: Pubkey,
    /// LLM-compressed personality paragraph (max 256 chars)
    pub personality_summary: String,
    /// Unix timestamp of last checkpoint
    pub last_checkpoint: i64,

    // ── Monotonically increasing action counters ──
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

    /// Registration timestamp
    pub created_at: i64,
    /// PDA bump
    pub bump: u8,

    // ── P&L tracking (lamports, monotonically increasing) ──
    /// Cumulative SOL spent on joins/buys/infiltrates (lamports)
    pub total_sol_spent: u64,
    /// Cumulative SOL received from defects/sells (lamports)
    pub total_sol_received: u64,
}

impl AgentProfile {
    pub const LEN: usize = 8   // discriminator
        + 32  // creator
        + 32  // authority
        + 32  // linked_wallet
        + (4 + MAX_PERSONALITY_LEN)  // personality_summary (borsh string: 4-byte len + data)
        + 8   // last_checkpoint
        + 8   // joins
        + 8   // defects
        + 8   // rallies
        + 8   // launches
        + 8   // messages
        + 8   // fuds
        + 8   // infiltrates
        + 8   // reinforces
        + 8   // war_loans
        + 8   // repay_loans
        + 8   // sieges
        + 8   // ascends
        + 8   // razes
        + 8   // tithes
        + 8   // created_at
        + 1   // bump
        + 8   // total_sol_spent
        + 8;  // total_sol_received
}

/// Reverse pointer: given a wallet, find its AgentProfile.
/// One link per wallet — prevents a wallet belonging to multiple profiles.
///
/// Seeds: ["pyre_agent_wallet", wallet.key()]
#[account]
pub struct AgentWalletLink {
    /// The AgentProfile this wallet belongs to
    pub profile: Pubkey,
    /// The linked wallet
    pub wallet: Pubkey,
    /// When this link was created
    pub linked_at: i64,
    /// PDA bump
    pub bump: u8,
}

impl AgentWalletLink {
    pub const LEN: usize = 8   // discriminator
        + 32  // profile
        + 32  // wallet
        + 8   // linked_at
        + 1;  // bump
}
