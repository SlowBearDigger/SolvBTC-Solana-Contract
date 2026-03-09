import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Solvbtc } from "../target/types/solvbtc";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { createWithdrawRequestHash, derivePoolSignerAddress, deriveVaultAddress, deriveWithdrawRequestAddress,
  ecdsaPubkeyFromPrivkey, ONE_BITCOIN,
deriveWithdrawRequestEip191, createEip191WithdrawSig } from "../sdk/solvbtc";
import { BN } from "bn.js";
import { createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction, createInitializeMultisigInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, getMinimumBalanceForRentExemptMint, getMinimumBalanceForRentExemptMultisig, MINT_SIZE, MULTISIG_SIZE, TOKEN_PROGRAM_ID, mintTo } from "@solana/spl-token";
import { ASSOCIATED_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/utils/token";
import { assert } from "chai";

describe("solvbtc-repro-stale", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider();
  const connection = provider.connection;
  const program = anchor.workspace.solvbtc as Program<Solvbtc>;

  const authorityKeypair = Keypair.generate();
  const authority = authorityKeypair.publicKey;
  const adminKeypair = Keypair.generate();
  const admin = adminKeypair.publicKey;
  const userKeypair = Keypair.generate();
  const user = userKeypair.publicKey;
  const mintAKeypair = Keypair.generate();
  const mintA = mintAKeypair.publicKey;

  const multisigAKeypair = Keypair.generate();
  const multisigA = multisigAKeypair.publicKey;
  const poolSignerA = derivePoolSignerAddress(mintA);
  const vaultA = deriveVaultAddress(mintA);

  const mintCKeypair = Keypair.generate();
  const mintC = mintCKeypair.publicKey;

  let verifierKeypair = Buffer.from("c2fffbf8e5cec943afb99e8194a5819c64c9df75b4ed03b2a111e8ccdcf55689", "hex");
  let verifier = Array.from(ecdsaPubkeyFromPrivkey(verifierKeypair).subarray(1));

  const accounts = {
    authority,
    admin,
    payer: authority,
    feeReceiver: authority,
    treasurer: authority,
    oracleManager: authority,
    mintA,
    multisigA,
    user,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
    systemProgram: SystemProgram.programId
  };

  it("Setup environment", async () => {
    const tx = new Transaction();
    tx.instructions = [authority, admin, user].map((account) =>
      SystemProgram.transfer({
        fromPubkey: provider.publicKey,
        toPubkey: account,
        lamports: 10 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(tx, []);

    const lamportsMint = await getMinimumBalanceForRentExemptMint(connection);
    const lamportsMultisig = await getMinimumBalanceForRentExemptMultisig(connection);

    const setupTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: provider.publicKey,
        newAccountPubkey: multisigA,
        space: MULTISIG_SIZE,
        lamports: lamportsMultisig,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMultisigInstruction(multisigA, [vaultA, poolSignerA], 1, TOKEN_PROGRAM_ID),
      SystemProgram.createAccount({
        fromPubkey: provider.publicKey,
        newAccountPubkey: mintA,
        lamports: lamportsMint,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mintA, 8, multisigA, multisigA),
      SystemProgram.createAccount({
        fromPubkey: provider.publicKey,
        newAccountPubkey: mintC,
        lamports: lamportsMint,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mintC, 8, authority, authority)
    );
    await provider.sendAndConfirm(setupTx, [multisigAKeypair, mintAKeypair, mintCKeypair]);
  });

  it("Initialize Vault and Deposit", async () => {
    await program.methods.vaultInitialize(
      admin, authority, authority, verifier, authority, ONE_BITCOIN, 50,
    ).accountsStrict({...accounts, mint: mintA, vault: vaultA}).signers([authorityKeypair]).rpc();

    await program.methods.vaultAddCurrency(mintC, 0)
    .accountsStrict({...accounts, admin, payer: authority, vault: vaultA, mint: mintA})
    .signers([authorityKeypair, adminKeypair]).rpc();

    // User gets 100 MintC
    const userAtaC = getAssociatedTokenAddressSync(mintC, user);
    const userAtaA = getAssociatedTokenAddressSync(mintA, user);
    const treasurerAtaC = getAssociatedTokenAddressSync(mintC, authority);

    const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(provider.publicKey, userAtaA, user, mintA),
        createAssociatedTokenAccountIdempotentInstruction(provider.publicKey, userAtaC, user, mintC),
        createAssociatedTokenAccountIdempotentInstruction(provider.publicKey, treasurerAtaC, authority, mintC)
    );
    await provider.sendAndConfirm(tx, []);
    await mintTo(connection, authorityKeypair, mintC, userAtaC, authorityKeypair, 100_000_000);

    // Deposit 100
    await program.methods.vaultDeposit(new BN(100_000_000), new BN(0))
    .accountsStrict({
        ...accounts, vault: vaultA, multisig: multisigA, userTokenTa: userAtaC, userTargetTa: userAtaA, treasurerTokenTa: treasurerAtaC, mintToken: mintC, mintTarget: mintA,
    }).signers([userKeypair]).rpc();
  });

  it("Simulate Stale NAV (Arbitrage)", async () => {
    // Current NAV is 100,000,000.
    // Simulate real market price drops to 50,000,000.
    // But Oracle is down, so NAV stays 100,000,000.
    // User requests withdraw at 100,000,000.
    // We assume time passes (e.g. 1 year) but no set_nav called.

    const hash = createWithdrawRequestHash();
    const withdrawRequest = deriveWithdrawRequestAddress(vaultA, mintC, user, hash);
    const userAtaC = getAssociatedTokenAddressSync(mintC, user);
    const userAtaA = getAssociatedTokenAddressSync(mintA, user);

    // Request withdraw
    await program.methods.vaultWithdrawRequest(Array.from(hash), new BN(100_000_000))
    .accountsStrict({
        ...accounts, vault: vaultA, userTargetTa: userAtaA, mintTarget: mintA, userWithdrawTa: userAtaC, mintWithdraw: mintC, withdrawRequest
    }).signers([userKeypair]).rpc();

    // Verify NAV is stale
    const requestAccount = await program.account.withdrawRequest.fetch(withdrawRequest);
    console.log("Request NAV:", requestAccount.nav.toString());
    assert.equal(requestAccount.nav.toString(), ONE_BITCOIN.toString());

    // User processes withdraw
    // Vault must have funds. Transfer from treasurer.
    const vaultAtaC = getAssociatedTokenAddressSync(mintC, vaultA, true);
    const treasurerAtaC = getAssociatedTokenAddressSync(mintC, authority);
    await provider.sendAndConfirm(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(provider.publicKey, vaultAtaC, vaultA, mintC)), []);
    await sendAndConfirmTransaction(connection, new Transaction().add(createTransferCheckedInstruction(treasurerAtaC, mintC, vaultAtaC, authority, 100_000_000, 8)), [authorityKeypair]);

    const withdrawRequestData = await program.account.withdrawRequest.fetch(withdrawRequest);
    const verifierHash = deriveWithdrawRequestEip191(user, mintC, hash, withdrawRequestData.shares, withdrawRequestData.nav);
    const signature = createEip191WithdrawSig(verifierKeypair, verifierHash);

    // Withdraw succeeds despite potential staleness
    // (There is NO check for staleness in the contract)
    await program.methods.vaultWithdraw(Array.from(hash), signature.signature)
    .accountsStrict({
        ...accounts, vault: vaultA, userWithdrawTa: userAtaC, mintWithdraw: mintC, vaultWithdrawTa: vaultAtaC, feeReceiverTa: getAssociatedTokenAddressSync(mintC, authority), withdrawRequest
    }).signers([userKeypair]).rpc();

    console.log("Withdrawal succeeded at stale price!");

    // If market price was truly 50M, user extracted 100M worth of value for 100M shares (which should be worth 50M).
    // Vault lost 50M.
  });
});
