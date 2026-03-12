use anchor_lang::prelude::*;

#[error_code]
pub enum PyreWorldError {
    #[msg("Personality summary exceeds 256 characters")]
    PersonalityTooLong,

    #[msg("Counter value cannot decrease (must be monotonically increasing)")]
    CounterNotMonotonic,

    #[msg("A wallet is already linked to this profile — unlink first")]
    WalletAlreadyLinked,

    #[msg("Wallet link does not belong to this profile")]
    WalletLinkMismatch,

    #[msg("Cannot unlink — no wallet is currently linked")]
    NoWalletLinked,
}
