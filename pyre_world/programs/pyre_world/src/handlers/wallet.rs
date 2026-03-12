use anchor_lang::prelude::*;

use crate::contexts::*;
use crate::errors::PyreWorldError;

/// Link a new wallet to the profile. Authority only.
/// The profile must not have an active linked wallet other than the creator fallback.
pub fn link_wallet(ctx: Context<LinkWallet>) -> Result<()> {
    let profile = &mut ctx.accounts.profile;

    // Ensure no wallet is currently linked (must unlink first)
    // After unlink, linked_wallet is reset to creator as a sentinel
    require!(
        profile.linked_wallet == profile.creator,
        PyreWorldError::WalletAlreadyLinked
    );

    let wallet_link = &mut ctx.accounts.wallet_link;
    wallet_link.profile = profile.key();
    wallet_link.wallet = ctx.accounts.wallet_to_link.key();
    wallet_link.linked_at = Clock::get()?.unix_timestamp;
    wallet_link.bump = ctx.bumps.wallet_link;

    profile.linked_wallet = ctx.accounts.wallet_to_link.key();

    Ok(())
}

/// Unlink the current wallet. Authority only.
/// Resets linked_wallet to creator as a sentinel value.
pub fn unlink_wallet(ctx: Context<UnlinkWallet>) -> Result<()> {
    let profile = &mut ctx.accounts.profile;

    // Cannot unlink if no wallet is linked (already at creator fallback)
    require!(
        profile.linked_wallet != profile.creator,
        PyreWorldError::NoWalletLinked
    );

    // Validate the wallet being unlinked is the currently linked one
    require!(
        ctx.accounts.wallet_to_unlink.key() == profile.linked_wallet,
        PyreWorldError::WalletLinkMismatch
    );

    // Reset to creator sentinel — wallet_link PDA is closed by Anchor's `close = authority`
    profile.linked_wallet = profile.creator;

    Ok(())
}

/// Transfer profile authority to a new wallet. Does NOT affect the linked wallet.
pub fn transfer_authority(ctx: Context<TransferAuthority>) -> Result<()> {
    let profile = &mut ctx.accounts.profile;
    profile.authority = ctx.accounts.new_authority.key();
    Ok(())
}
