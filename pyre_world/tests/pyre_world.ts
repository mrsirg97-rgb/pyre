import pkg from "@coral-xyz/anchor";
const { AnchorProvider, setProvider, workspace, BN } = pkg;
type Program<T> = pkg.Program<T>;
import { PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import type { PyreWorld } from "../target/types/pyre_world";

const AGENT_SEED = "pyre_agent";
const AGENT_WALLET_SEED = "pyre_agent_wallet";

describe("pyre_world", () => {
  const provider = AnchorProvider.env();
  setProvider(provider);
  const program = workspace.PyreWorld as Program<PyreWorld>;

  // Test wallets
  const creator = Keypair.generate();
  const walletA = Keypair.generate();
  const walletB = Keypair.generate();
  const newAuthority = Keypair.generate();
  const otherUser = Keypair.generate();

  // PDAs (set in before())
  let profilePda: PublicKey;
  let profileBump: number;
  let creatorWalletLinkPda: PublicKey;

  function getProfilePda(key: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(AGENT_SEED), key.toBuffer()],
      program.programId,
    );
  }

  function getWalletLinkPda(wallet: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(AGENT_WALLET_SEED), wallet.toBuffer()],
      program.programId,
    );
  }

  /** Build a checkpoint args object with BN wrappers */
  function checkpointArgs(
    overrides: Partial<Record<string, number | string>> = {},
  ) {
    const defaults: Record<string, number> = {
      joins: 0, defects: 0, rallies: 0, launches: 0, messages: 0,
      fuds: 0, infiltrates: 0, reinforces: 0, warLoans: 0, repayLoans: 0,
      sieges: 0, ascends: 0, razes: 0, tithes: 0,
    };
    const merged = { ...defaults, ...overrides };
    return {
      joins: new BN(merged.joins),
      defects: new BN(merged.defects),
      rallies: new BN(merged.rallies),
      launches: new BN(merged.launches),
      messages: new BN(merged.messages),
      fuds: new BN(merged.fuds),
      infiltrates: new BN(merged.infiltrates),
      reinforces: new BN(merged.reinforces),
      warLoans: new BN(merged.warLoans),
      repayLoans: new BN(merged.repayLoans),
      sieges: new BN(merged.sieges),
      ascends: new BN(merged.ascends),
      razes: new BN(merged.razes),
      tithes: new BN(merged.tithes),
      personalitySummary: (merged.personalitySummary as string) ?? "",
    };
  }

  before(async () => {
    // Airdrop SOL to all test wallets
    const airdropAmount = 10 * LAMPORTS_PER_SOL;
    const sigs = await Promise.all([
      provider.connection.requestAirdrop(creator.publicKey, airdropAmount),
      provider.connection.requestAirdrop(walletA.publicKey, airdropAmount),
      provider.connection.requestAirdrop(walletB.publicKey, airdropAmount),
      provider.connection.requestAirdrop(newAuthority.publicKey, airdropAmount),
      provider.connection.requestAirdrop(otherUser.publicKey, airdropAmount),
    ]);
    await Promise.all(sigs.map((s) => provider.connection.confirmTransaction(s)));

    [profilePda, profileBump] = getProfilePda(creator.publicKey);
    [creatorWalletLinkPda] = getWalletLinkPda(creator.publicKey);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Register
  // ═══════════════════════════════════════════════════════════════════

  describe("register", () => {
    it("registers a new agent profile and auto-links creator", async () => {
      await program.methods
        .register()
        .accounts({
          creator: creator.publicKey,
          profile: profilePda,
          walletLink: creatorWalletLinkPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const profile = await program.account.agentProfile.fetch(profilePda);
      expect(profile.creator.toBase58()).to.equal(creator.publicKey.toBase58());
      expect(profile.authority.toBase58()).to.equal(creator.publicKey.toBase58());
      expect(profile.linkedWallet.toBase58()).to.equal(creator.publicKey.toBase58());
      expect(profile.personalitySummary).to.equal("");
      expect(profile.lastCheckpoint.toNumber()).to.equal(0);
      expect(profile.joins.toNumber()).to.equal(0);
      expect(profile.defects.toNumber()).to.equal(0);
      expect(profile.rallies.toNumber()).to.equal(0);
      expect(profile.launches.toNumber()).to.equal(0);
      expect(profile.messages.toNumber()).to.equal(0);
      expect(profile.fuds.toNumber()).to.equal(0);
      expect(profile.infiltrates.toNumber()).to.equal(0);
      expect(profile.reinforces.toNumber()).to.equal(0);
      expect(profile.warLoans.toNumber()).to.equal(0);
      expect(profile.repayLoans.toNumber()).to.equal(0);
      expect(profile.sieges.toNumber()).to.equal(0);
      expect(profile.ascends.toNumber()).to.equal(0);
      expect(profile.razes.toNumber()).to.equal(0);
      expect(profile.tithes.toNumber()).to.equal(0);
      expect(profile.createdAt.toNumber()).to.be.greaterThan(0);
      expect(profile.bump).to.equal(profileBump);

      // Wallet link created for creator
      const link = await program.account.agentWalletLink.fetch(creatorWalletLinkPda);
      expect(link.profile.toBase58()).to.equal(profilePda.toBase58());
      expect(link.wallet.toBase58()).to.equal(creator.publicKey.toBase58());
      expect(link.linkedAt.toNumber()).to.be.greaterThan(0);
    });

    it("rejects double registration", async () => {
      try {
        await program.methods
          .register()
          .accounts({
            creator: creator.publicKey,
            profile: profilePda,
            walletLink: creatorWalletLinkPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Anchor rejects re-init of existing account
        expect(err.toString()).to.not.be.empty;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Checkpoint (creator is the linked wallet initially)
  // ═══════════════════════════════════════════════════════════════════

  describe("checkpoint", () => {
    it("updates all counters and personality", async () => {
      await program.methods
        .checkpoint(checkpointArgs({
          joins: 5, defects: 2, rallies: 10, launches: 1, messages: 42,
          fuds: 3, reinforces: 7, warLoans: 1, repayLoans: 1,
          personalitySummary: "Aggressive provocateur who thrives on chaos",
        }))
        .accounts({ signer: creator.publicKey, profile: profilePda })
        .signers([creator])
        .rpc();

      const profile = await program.account.agentProfile.fetch(profilePda);
      expect(profile.joins.toNumber()).to.equal(5);
      expect(profile.defects.toNumber()).to.equal(2);
      expect(profile.rallies.toNumber()).to.equal(10);
      expect(profile.launches.toNumber()).to.equal(1);
      expect(profile.messages.toNumber()).to.equal(42);
      expect(profile.fuds.toNumber()).to.equal(3);
      expect(profile.reinforces.toNumber()).to.equal(7);
      expect(profile.warLoans.toNumber()).to.equal(1);
      expect(profile.repayLoans.toNumber()).to.equal(1);
      expect(profile.personalitySummary).to.equal(
        "Aggressive provocateur who thrives on chaos",
      );
      expect(profile.lastCheckpoint.toNumber()).to.be.greaterThan(0);
    });

    it("allows monotonic increase on second checkpoint", async () => {
      await program.methods
        .checkpoint(checkpointArgs({
          joins: 10, defects: 2, rallies: 15, launches: 1, messages: 100,
          fuds: 5, infiltrates: 3, reinforces: 7, warLoans: 2, repayLoans: 2,
          sieges: 1, tithes: 1,
          personalitySummary: "Evolved into strategic leader",
        }))
        .accounts({ signer: creator.publicKey, profile: profilePda })
        .signers([creator])
        .rpc();

      const profile = await program.account.agentProfile.fetch(profilePda);
      expect(profile.joins.toNumber()).to.equal(10);
      expect(profile.messages.toNumber()).to.equal(100);
      expect(profile.personalitySummary).to.equal("Evolved into strategic leader");
    });

    it("rejects counter rollback (non-monotonic)", async () => {
      try {
        await program.methods
          .checkpoint(checkpointArgs({
            joins: 5, // was 10 — rollback!
            defects: 2, rallies: 15, launches: 1, messages: 100,
            fuds: 5, infiltrates: 3, reinforces: 7, warLoans: 2, repayLoans: 2,
            sieges: 1, tithes: 1,
            personalitySummary: "Same",
          }))
          .accounts({ signer: creator.publicKey, profile: profilePda })
          .signers([creator])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("CounterNotMonotonic");
      }
    });

    it("rejects personality > 256 chars", async () => {
      try {
        await program.methods
          .checkpoint(checkpointArgs({
            joins: 10, defects: 2, rallies: 15, launches: 1, messages: 100,
            fuds: 5, infiltrates: 3, reinforces: 7, warLoans: 2, repayLoans: 2,
            sieges: 1, tithes: 1,
            personalitySummary: "x".repeat(257),
          }))
          .accounts({ signer: creator.publicKey, profile: profilePda })
          .signers([creator])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("PersonalityTooLong");
      }
    });

    it("accepts personality at exactly 256 chars", async () => {
      const maxSummary = "a".repeat(256);
      await program.methods
        .checkpoint(checkpointArgs({
          joins: 10, defects: 2, rallies: 15, launches: 1, messages: 100,
          fuds: 5, infiltrates: 3, reinforces: 7, warLoans: 2, repayLoans: 2,
          sieges: 1, tithes: 1,
          personalitySummary: maxSummary,
        }))
        .accounts({ signer: creator.publicKey, profile: profilePda })
        .signers([creator])
        .rpc();

      const profile = await program.account.agentProfile.fetch(profilePda);
      expect(profile.personalitySummary.length).to.equal(256);
    });

    it("rejects checkpoint from non-linked wallet", async () => {
      try {
        await program.methods
          .checkpoint(checkpointArgs({
            joins: 10, defects: 2, rallies: 15, launches: 1, messages: 100,
            fuds: 5, infiltrates: 3, reinforces: 7, warLoans: 2, repayLoans: 2,
            sieges: 1, tithes: 1,
            personalitySummary: "Hijacked",
          }))
          .accounts({ signer: otherUser.publicKey, profile: profilePda })
          .signers([otherUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("WalletLinkMismatch");
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Wallet Management
  //
  // After register: linked_wallet = creator (sentinel = "default state").
  // The link_wallet handler treats linked_wallet == creator as "no active
  // external link", so linking a new wallet succeeds immediately.
  // ═══════════════════════════════════════════════════════════════════

  describe("wallet management", () => {
    // State: linked_wallet = creator (from register)

    it("link_wallet succeeds when linked_wallet is creator (sentinel)", async () => {
      // After register, linked_wallet == creator is the "can link" state
      const [walletALinkPda] = getWalletLinkPda(walletA.publicKey);

      await program.methods
        .linkWallet()
        .accounts({
          authority: creator.publicKey,
          profile: profilePda,
          walletToLink: walletA.publicKey,
          walletLink: walletALinkPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const profile = await program.account.agentProfile.fetch(profilePda);
      expect(profile.linkedWallet.toBase58()).to.equal(walletA.publicKey.toBase58());

      const link = await program.account.agentWalletLink.fetch(walletALinkPda);
      expect(link.wallet.toBase58()).to.equal(walletA.publicKey.toBase58());
      expect(link.profile.toBase58()).to.equal(profilePda.toBase58());
    });

    // State: linked_wallet = walletA

    it("rejects link_wallet when a non-creator wallet is linked", async () => {
      const [walletBLinkPda] = getWalletLinkPda(walletB.publicKey);
      try {
        await program.methods
          .linkWallet()
          .accounts({
            authority: creator.publicKey,
            profile: profilePda,
            walletToLink: walletB.publicKey,
            walletLink: walletBLinkPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("WalletAlreadyLinked");
      }
    });

    it("walletA can checkpoint", async () => {
      await program.methods
        .checkpoint(checkpointArgs({
          joins: 15, defects: 3, rallies: 20, launches: 2, messages: 150,
          fuds: 8, infiltrates: 5, reinforces: 10, warLoans: 3, repayLoans: 3,
          sieges: 2, ascends: 1, tithes: 2,
          personalitySummary: "Checkpoint from walletA",
        }))
        .accounts({ signer: walletA.publicKey, profile: profilePda })
        .signers([walletA])
        .rpc();

      const profile = await program.account.agentProfile.fetch(profilePda);
      expect(profile.joins.toNumber()).to.equal(15);
      expect(profile.personalitySummary).to.equal("Checkpoint from walletA");
    });

    it("creator can no longer checkpoint (not linked wallet)", async () => {
      try {
        await program.methods
          .checkpoint(checkpointArgs({
            joins: 15, defects: 3, rallies: 20, launches: 2, messages: 150,
            fuds: 8, infiltrates: 5, reinforces: 10, warLoans: 3, repayLoans: 3,
            sieges: 2, ascends: 1, tithes: 2,
            personalitySummary: "Should fail",
          }))
          .accounts({ signer: creator.publicKey, profile: profilePda })
          .signers([creator])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("WalletLinkMismatch");
      }
    });

    it("rejects unlink from non-authority", async () => {
      const [walletALinkPda] = getWalletLinkPda(walletA.publicKey);
      try {
        await program.methods
          .unlinkWallet()
          .accounts({
            authority: otherUser.publicKey,
            profile: profilePda,
            walletToUnlink: walletA.publicKey,
            walletLink: walletALinkPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([otherUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("WalletLinkMismatch");
      }
    });

    it("unlinks walletA", async () => {
      const [walletALinkPda] = getWalletLinkPda(walletA.publicKey);

      await program.methods
        .unlinkWallet()
        .accounts({
          authority: creator.publicKey,
          profile: profilePda,
          walletToUnlink: walletA.publicKey,
          walletLink: walletALinkPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const profile = await program.account.agentProfile.fetch(profilePda);
      // Resets to creator sentinel
      expect(profile.linkedWallet.toBase58()).to.equal(creator.publicKey.toBase58());

      // walletA link PDA closed
      const linkAccount = await provider.connection.getAccountInfo(walletALinkPda);
      expect(linkAccount).to.be.null;
    });

    // State: linked_wallet = creator (sentinel again)

    it("links walletB after unlink", async () => {
      const [walletBLinkPda] = getWalletLinkPda(walletB.publicKey);

      await program.methods
        .linkWallet()
        .accounts({
          authority: creator.publicKey,
          profile: profilePda,
          walletToLink: walletB.publicKey,
          walletLink: walletBLinkPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const profile = await program.account.agentProfile.fetch(profilePda);
      expect(profile.linkedWallet.toBase58()).to.equal(walletB.publicKey.toBase58());
    });

    it("walletB can checkpoint", async () => {
      await program.methods
        .checkpoint(checkpointArgs({
          joins: 20, defects: 5, rallies: 25, launches: 3, messages: 200,
          fuds: 10, infiltrates: 8, reinforces: 15, warLoans: 4, repayLoans: 4,
          sieges: 3, ascends: 1, tithes: 3,
          personalitySummary: "Checkpoint from walletB",
        }))
        .accounts({ signer: walletB.publicKey, profile: profilePda })
        .signers([walletB])
        .rpc();

      const profile = await program.account.agentProfile.fetch(profilePda);
      expect(profile.joins.toNumber()).to.equal(20);
      expect(profile.personalitySummary).to.equal("Checkpoint from walletB");
    });

    it("walletA can no longer checkpoint after being unlinked", async () => {
      try {
        await program.methods
          .checkpoint(checkpointArgs({
            joins: 20, defects: 5, rallies: 25, launches: 3, messages: 200,
            fuds: 10, infiltrates: 8, reinforces: 15, warLoans: 4, repayLoans: 4,
            sieges: 3, ascends: 1, tithes: 3,
            personalitySummary: "Should fail",
          }))
          .accounts({ signer: walletA.publicKey, profile: profilePda })
          .signers([walletA])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("WalletLinkMismatch");
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Transfer Authority
  // State: authority = creator, linked_wallet = walletB
  // ═══════════════════════════════════════════════════════════════════

  describe("transfer_authority", () => {
    it("rejects transfer from non-authority", async () => {
      try {
        await program.methods
          .transferAuthority()
          .accounts({
            authority: otherUser.publicKey,
            profile: profilePda,
            newAuthority: newAuthority.publicKey,
          })
          .signers([otherUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("WalletLinkMismatch");
      }
    });

    it("transfers authority", async () => {
      await program.methods
        .transferAuthority()
        .accounts({
          authority: creator.publicKey,
          profile: profilePda,
          newAuthority: newAuthority.publicKey,
        })
        .signers([creator])
        .rpc();

      const profile = await program.account.agentProfile.fetch(profilePda);
      expect(profile.authority.toBase58()).to.equal(newAuthority.publicKey.toBase58());
      expect(profile.creator.toBase58()).to.equal(creator.publicKey.toBase58());
      expect(profile.linkedWallet.toBase58()).to.equal(walletB.publicKey.toBase58());
    });

    it("old authority can no longer unlink", async () => {
      const [walletBLinkPda] = getWalletLinkPda(walletB.publicKey);
      try {
        await program.methods
          .unlinkWallet()
          .accounts({
            authority: creator.publicKey,
            profile: profilePda,
            walletToUnlink: walletB.publicKey,
            walletLink: walletBLinkPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("WalletLinkMismatch");
      }
    });

    it("new authority can unlink", async () => {
      const [walletBLinkPda] = getWalletLinkPda(walletB.publicKey);

      await program.methods
        .unlinkWallet()
        .accounts({
          authority: newAuthority.publicKey,
          profile: profilePda,
          walletToUnlink: walletB.publicKey,
          walletLink: walletBLinkPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([newAuthority])
        .rpc();

      const profile = await program.account.agentProfile.fetch(profilePda);
      expect(profile.linkedWallet.toBase58()).to.equal(creator.publicKey.toBase58());
    });

    it("new authority can link a fresh wallet", async () => {
      // Use walletA (whose link PDA was closed earlier)
      const [walletALinkPda] = getWalletLinkPda(walletA.publicKey);

      await program.methods
        .linkWallet()
        .accounts({
          authority: newAuthority.publicKey,
          profile: profilePda,
          walletToLink: walletA.publicKey,
          walletLink: walletALinkPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([newAuthority])
        .rpc();

      const profile = await program.account.agentProfile.fetch(profilePda);
      expect(profile.linkedWallet.toBase58()).to.equal(walletA.publicKey.toBase58());
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Multiple independent agents
  // ═══════════════════════════════════════════════════════════════════

  describe("multiple agents", () => {
    it("another user registers independently", async () => {
      const [otherProfilePda] = getProfilePda(otherUser.publicKey);
      const [otherWalletLinkPda] = getWalletLinkPda(otherUser.publicKey);

      await program.methods
        .register()
        .accounts({
          creator: otherUser.publicKey,
          profile: otherProfilePda,
          walletLink: otherWalletLinkPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([otherUser])
        .rpc();

      const profile = await program.account.agentProfile.fetch(otherProfilePda);
      expect(profile.creator.toBase58()).to.equal(otherUser.publicKey.toBase58());
      expect(profile.linkedWallet.toBase58()).to.equal(otherUser.publicKey.toBase58());
    });

    it("agents cannot cross-checkpoint each other", async () => {
      // walletA is linked to creator's profile — try to checkpoint otherUser's profile
      const [otherProfilePda] = getProfilePda(otherUser.publicKey);
      try {
        await program.methods
          .checkpoint(checkpointArgs({
            joins: 1, personalitySummary: "Hijack attempt",
          }))
          .accounts({ signer: walletA.publicKey, profile: otherProfilePda })
          .signers([walletA])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("WalletLinkMismatch");
      }
    });

    it("other user's authority cannot manage creator's profile", async () => {
      const [walletALinkPda] = getWalletLinkPda(walletA.publicKey);
      try {
        await program.methods
          .unlinkWallet()
          .accounts({
            authority: otherUser.publicKey,
            profile: profilePda,
            walletToUnlink: walletA.publicKey,
            walletLink: walletALinkPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([otherUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("WalletLinkMismatch");
      }
    });
  });
});
