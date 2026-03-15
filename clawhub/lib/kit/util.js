"use strict";
/**
 * Pyre Kit Actions
 *
 * Thin wrappers that call torchsdk functions and map params/results
 * into game-semantic Pyre types. No new on-chain logic.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.startVaultPnlTracker = exports.createEphemeralAgent = void 0;
exports.blacklistMints = blacklistMints;
exports.isBlacklistedMint = isBlacklistedMint;
exports.getBlacklistedMints = getBlacklistedMints;
exports.getDexPool = getDexPool;
exports.getDexVaults = getDexVaults;
const web3_js_1 = require("@solana/web3.js");
const torchsdk_1 = require("torchsdk");
// ─── Blacklist ──────────────────────────────────────────────────────
// Mints from previous swarm runs. Agents should skip these and only
// interact with freshly launched factions.
const DEFAULT_BLACKLIST = [
    'E1SgYPW6JXhw5BabrvJkr6L2PyvfFenYaoCTePazyNpy',
    '6jWsyDC87RmfrZZRjuxSAxvUxE665HGZwZ2Z8j5z9epy',
    '6J8PLgFxHb98cNURP2Yt2SKwgnUeEXpN6Us2kxaMz1py',
    '5A297UyPQstxWpJyydDnFvn2zN8whCEYdqvnfB5bF9py',
    '8XdWfSKLJusAcRrYzK3bWJ7dy46AkbU8qxF3B55uSfpy',
    '7ZYrKcJbFFbG36keCYRvfc1j1HScQmJW1zRV3wVVD4py',
    'ERQPyG2oqx5bdyuY2Nnm5ZbZY2zcB46TfUxqpzYWH5py',
    'JCvpK3kTnh2EdQG71mqE8ZXcvzLU5EJNG5vgGZme4wpy',
    '9RDFkGSjKpjHtXZ25uuug2MN5P7oSjzkLg16HcrKy3py',
    '2kWcX1ZetV4jUtBPbKKk265q4gS4nuut2kc1MbaZDfpy',
    '3r9FnQim6GToR7NkY5om8igUNu7gfpq5fk2qtv3bV5py',
    '2498F79s1Ghyj3J4VhV1qy5hhznnM53ZwzTXM9iscopy',
    '5VpotyDyc8QKKqLuzu8pfhtEa9gsRG1ww58DbqJUgTpy',
    'GXi1opahTkavPfAqfUhkoUJRBjPoAmAMVW87kdbDwNpy',
    'GKFAokGiyhXGXxUPgwQEo8fE5nBjRdJcVX6LVj7SgPpy',
    'EKFVwfNk1xzqhpyFJSMNw8KDcLRemvqxiGoSyfRtBspy',
    'GsZLHVt3mTwus5krUcifBWS52xMQSuXSy3RpPhEFtvpy',
    '9azKjXnt2w4RB5ykVcyaicWSssmxoapZ9SSQLMZc4Epy',
    'BaLwryyMrqhtsMrELkrTSdWF9UYuNdjW4413hrQqbtpy',
    '5p9ibszMVe79mm95M8uubS6WttXem2xZfh3mWmBdvUpy',
    'CTvoAmTggJcBTnbxcfy91Y1c6t6fU5xq3SRtYh3TgEpy',
    '2kqVCdQS9KSv2kxLiytGZfcLsx5xwKQT6rHTg4V18hpy',
    'zV7XZcvY8DVk4scKUiw7GGN4L3eBPSXuD7Q1NPxfspy',
    '3UhzKfdU1wgnEN2VCykRURw88qVVqeu3ejRkUnjmhRpy',
    'FRaS3dAdr1zo6u811XBVGUp9K2mSdQ2yG8qW4qP5hapy',
    '4NHzWVP7hzZhd9LhTrbyxzsSnT8EmNSYVP1DpAKXHYpy',
    'Yt2rdfp6uzS7L52df3LPmetLoy3GvKChYJ4Lmvk6gpy',
    '9Ejju29KHPWMpda4WpFsJ6ZDHVUqNWyMZHteEisgw9py',
    '2zPC4A7WR2cMNDfBzERp49fEbTBCyqXPKhcrgz3hWcpy',
    '7jBAriydb1qRy7Wg4WAz8woHP4pVxZJSnF7vw95tVQpy',
    'HvPWKuMFpG3zAdkPMbaadyo78VoJbAMtpXaBYMK1Aqpy',
    'GyNw9bkqz2rhR66Xx7P4p11PFBrjPi2r6XoCg5gPAdpy',
    '6HveNEes9xtkkchb76JgjWWQ61sbXjESy2vr3A7Maipy',
    '8E3GETvTkTTaCLpzkyHJTnuNMfmGvzUEgAYnurZuLZpy',
    'AeApaJqppwjW9S2KeZGPZpmg1kAdxZHkFRnXPZc8Kjpy',
    '8FfteyAMQm96upu4w6cJvE5T8RcMKRf5keJMdXbukXpy',
    'BrEj2Q9XE13WesRU1u8USiprv2DkpBcJfaqQeqQ6grpy',
    'Dtki37mAB3DiTW1bp8LnZQyv54UuC68Yo5pGZkPdVSpy',
    '77UzTntZ7ThyXhN4hVvSx7m6tjit8uCw6U2LVQHPSqpy',
    'ASV9kiC6vEpZy3X7xVExuyG257KHKd3Hutbji8AVRUpy',
    'Fc1V6KcxSriJkUNeDLqz8w5Sm4mp1s8gxornZVLcHEpy',
    'FEizyHEUoYenqfpF87kqiGnq3w1R2TReodEfsnTrrfpy',
    'DmwgcVHoJxKeRiij5LtedY9LWDpqoqa3hGfUyVgBkgpy',
    'GUGz1Em5KZ57aKFqEBSd4Y4Vb6WxBd3H2b16fPCC6upy',
    '6ZWY3Bau5zw1j7vMQQ1czSw4rjBJrExHQ8Renor2vLpy',
    // wave 3
    '4LyPhwUCZNLEp45RsGWdwtkX5tb3wmwydBKEu1V7fxpy',
    'FYw8FZKzG6vVweUMQgSXBrY9ViHgquWyN4x5QthaK3py',
    'DhFhRRpRMkPi2Vz3kErZWHNmWqxgQm5YwXT5pFpgVKpy',
    '6GLqPmACtuDi4LcMtVpFK43sYkG8yVouYiDfdfBSSVpy',
    '8YYYewvvCTGPZ2UddgrD6oWUZD7CYXe3DBbA9GBkapy',
    'FpQT2uDi3oxEpnayKHAUCcWXVhtDaZCb85e7nZzoCUpy',
    '5EWX6grTtA46FQUHGC1kogCW3CsnVfXNvVgrYVtwvRpy',
    '8HSvBFkr6gu9qtbMKcTAZSjzkj4Ag1d1wkdiaMDHHapy',
    '2hgo2kdtNNQGNuvfEPSfydWDqfhSwfbFTzgeVb758wpy',
    'DKvaEayFig3RHQ9rXHnCKBjvMnJCstzuBmSe77Ybf6py',
    'Cws3YSPxWYxzrEEfguLi3p13ea2vPNi42mjJwwSMTTpy',
    'GodcBg2dLzrypiYH5Aqo2bTJ7KiZa5G5XSDwNQ74iYpy',
    '46tUp7tMEhpLeenPXQwvzP8H8V5M4F63vi4M9k4bbbpy',
    'a5iH2Soh5c8X81vTVbKZq7A7yPckhFdN1amv1Q2tapy',
    '2zTGWtQeJ5GtdHu888QikPzKkyHJPWVFYtoQjNeJJ7py',
    'HNnpL7z1GKsXuxaEHs2a52zW7tTUjU4dZnrSEf8ZsMpy',
    'EASit9Yrj1SBg6xchFxDSwVV9Rz11RKdDpB4tcNsekpy',
    'F7VcdtqsXV6nkDL3yk6esUBu9qGvka4EY9XNTQ7PmZpy',
    '3huHC9Co5dy5Z5U6H8Vf7aVTcuukpKeUr8rDQx8s5Zpy',
    '97ymhwybP8Jh45VcYBJY1pwQ5xkPLX15u7Tg3P7TG7py',
    '92fMEzcYdcoEXX8A5T8i8vfz2S96P39abzoXXuBghfpy',
    '2ZeQsU13WjgX2152qV3wyzxURjLg7GwfXznAiA99Jjpy',
    'FuUHck8jqaXxGiTuLym4gYXJQrueyEsgd8AMUQx2fMpy',
    'trTuaGATQZwUeYkYTeyJfQnGGnKRvAriAZRgBWg7Epy',
    'HEhemzeszztaFzFYR9DjpNwdhghVDD1y7cHxP93EPZpy',
    'obuf6MkL1ev6WuUDDjH3bq2q6Ryr6MBNMRsA6dEW4py',
    '76ruUbqBpqSKsysoPesDrpaLsDSahWWphQmXrswiLbpy',
    '4ci4scCevt5tXCxkGr5xHoWyaeQY1dahp5nFsTnfYApy',
    'shzuPKgqedBxJmxdrRyWAtajG3hSNyLr72SufvmEvpy',
    // wave 4 (devnet cleanup)
    'ZkprRY78cmfSmjMvDmgb4rWRxnxNrQYpF8chejRt3py',
    '4BFfCqG4L6bsS2tEZTpgQPJjsSqqLPQaxuaWMJcaRjpy',
    '5xRA2q9oHjoxN1XgqMTZW3aRBgGppcLCCbLBURepXApy',
    // wave 5 (devnet cleanup — v3.0 refactor)
    '3HmSa1VjnHgybLwp54ekaroCCbJcHywoJHfHS6BDLBpy',
    '4HKqRw3Gm6FCnPeWM5tTwMfm4kpuZ5KZD2mpAWRMmNpy',
    'EGt84WUBAVCbczNrggGiQNSFC1PRTc4BvYHCqALxNtpy',
    'DkxahcwFnpSTSDpTSzaP8e8fhURXw8wYHes1GqEh9qpy',
    '7P6yWvgX1BdXnMvutt4FJbfhA8gtzwEFaYjfw1fV2zpy',
    '2iSsxTATxv1gu6P85fzMcnqidpiVhCokgUea4vkARFpy',
    // wave 6 (devnet cleanup — torchsdk v4.0.1)
    'N7L7myyBVT4Sw7PsKQNqEf2mcwJygbTELqJcD9TkRpy',
    'BK9HTWwHvz4VSvr16pH2hTzszQmrEs58WEJMR3cucNpy',
];
const BLACKLISTED_MINTS = new Set(DEFAULT_BLACKLIST);
/** Add mints to the blacklist (call at startup with old mints) */
function blacklistMints(mints) {
    for (const m of mints)
        BLACKLISTED_MINTS.add(m);
}
/** Check if a mint is blacklisted */
function isBlacklistedMint(mint) {
    return BLACKLISTED_MINTS.has(mint);
}
/** Get all blacklisted mints */
function getBlacklistedMints() {
    return Array.from(BLACKLISTED_MINTS);
}
/** Create an ephemeral agent keypair (memory-only, zero key management) */
var torchsdk_2 = require("torchsdk");
Object.defineProperty(exports, "createEphemeralAgent", { enumerable: true, get: function () { return torchsdk_2.createEphemeralAgent; } });
/** Get the Raydium pool state PDA for an ascended faction's DEX pool */
function getDexPool(mint) {
    const { poolState } = (0, torchsdk_1.getRaydiumMigrationAccounts)(new web3_js_1.PublicKey(mint));
    return poolState;
}
/** Get Raydium pool vault addresses for an ascended faction */
function getDexVaults(mint) {
    const accts = (0, torchsdk_1.getRaydiumMigrationAccounts)(new web3_js_1.PublicKey(mint));
    return {
        solVault: (accts.isWsolToken0 ? accts.token0Vault : accts.token1Vault).toString(),
        tokenVault: (accts.isWsolToken0 ? accts.token1Vault : accts.token0Vault).toString(),
    };
}
const startVaultPnlTracker = async (intel, wallet) => {
    const before = await intel.getAgentSolLamports(wallet);
    return {
        async finish() {
            const after = await intel.getAgentSolLamports(wallet);
            const diff = after - before;
            return {
                spent: diff < 0 ? Math.abs(diff) : 0,
                received: diff > 0 ? diff : 0,
            };
        },
    };
};
exports.startVaultPnlTracker = startVaultPnlTracker;
