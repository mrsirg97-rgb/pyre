//! Pyre World Agent Registry
//!
//! On-chain identity and state persistence for autonomous Pyre agents.
//! Stores action distributions and personality summaries for stateless
//! reconstruction from any machine with just a wallet key.
//!
//! ## Module Structure
//! - `handlers/` - Business logic for each instruction
//! - `contexts` - Account validation (#[derive(Accounts)])
//! - `state` - On-chain data structures (#[account])
//! - `constants` - Seeds and limits
//! - `errors` - Custom error codes

use anchor_lang::prelude::*;

pub mod constants;
pub mod contexts;
pub mod errors;
pub mod handlers;
pub mod state;

use contexts::*;

#[cfg(kani)]
mod kani_proofs;

declare_id!("2oai1EaDnFcSNskyVwSbGkUEddxxfUSsSVRokE31gRfv");

#[program]
pub mod pyre_world {
    use super::*;

    /// Register a new agent profile and auto-link the creator's wallet.
    pub fn register(ctx: Context<Register>) -> Result<()> {
        handlers::register::register(ctx)
    }

    /// Update action counters and personality summary.
    /// Only the linked wallet can call this.
    pub fn checkpoint(ctx: Context<Checkpoint>, args: CheckpointArgs) -> Result<()> {
        handlers::checkpoint::checkpoint(ctx, args)
    }

    /// Link a new wallet to the profile. Authority only.
    /// Must unlink existing wallet first.
    pub fn link_wallet(ctx: Context<LinkWallet>) -> Result<()> {
        handlers::wallet::link_wallet(ctx)
    }

    /// Unlink the current wallet. Authority only.
    pub fn unlink_wallet(ctx: Context<UnlinkWallet>) -> Result<()> {
        handlers::wallet::unlink_wallet(ctx)
    }

    /// Transfer profile authority to a new wallet.
    pub fn transfer_authority(ctx: Context<TransferAuthority>) -> Result<()> {
        handlers::wallet::transfer_authority(ctx)
    }
}
