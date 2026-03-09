// ─── Program Error Codes ────────────────────────────────────────────
export const PROGRAM_ERRORS: Record<number, string> = {
  6000: 'MathOverflow',
  6001: 'SlippageExceeded',
  6002: 'MaxWalletExceeded (2% cap)',
  6003: 'InsufficientTokens',
  6004: 'InsufficientSol',
  6005: 'InsufficientUserBalance',
  6006: 'BondingComplete',
  6007: 'BondingNotComplete',
  6008: 'AlreadyVoted',
  6009: 'NoTokensToVote',
  6010: 'AlreadyMigrated',
  6011: 'InvalidAuthority',
  6012: 'AmountTooSmall',
  6013: 'ProtocolPaused',
  6014: 'ZeroAmount',
  6022: 'VoteRequired',
  6030: 'NotMigrated',
  6044: 'LendingNotEnabled',
  6045: 'LendingRequiresMigration',
  6046: 'LtvExceeded',
  6047: 'LendingCapExceeded',
  6048: 'UserBorrowCapExceeded',
  6049: 'BorrowTooSmall (min 0.1 SOL)',
  6050: 'NoActiveLoan',
  6051: 'NotLiquidatable',
  6052: 'EmptyBorrowRequest',
  6053: 'RepayExceedsDebt',
  6054: 'InvalidPoolAccount',
  6055: 'InsufficientVaultBalance',
  6056: 'VaultUnauthorized',
  6057: 'WalletNotLinked',
  // Token-2022 / SPL errors
  2505: 'InsufficientFunds (token balance too low)',
}

// Errors that mean "don't retry this action on this faction right now"
export const SKIP_ERRORS = new Set([
  6002, // MaxWalletExceeded — already at 2% cap
  6006, // BondingComplete — use DEX instead
  6007, // BondingNotComplete — can't migrate yet
  6010, // AlreadyMigrated
  6044, // LendingNotEnabled
  6045, // LendingRequiresMigration
  6047, // LendingCapExceeded
  6051, // NotLiquidatable
])

export const parseCustomError = (err: any): { code: number; name: string } | null => {
  const msg = err?.message || String(err)
  // Match "custom program error: 0x1772" or "Custom: 6002"
  const hexMatch = msg.match(/custom program error:\s*0x([0-9a-fA-F]+)/i)
  if (hexMatch) {
    const code = parseInt(hexMatch[1], 16)
    return { code, name: PROGRAM_ERRORS[code] || `Unknown(${code})` }
  }
  const decMatch = msg.match(/Custom:\s*(\d+)/)
  if (decMatch) {
    const code = parseInt(decMatch[1], 10)
    return { code, name: PROGRAM_ERRORS[code] || `Unknown(${code})` }
  }
  return null
}