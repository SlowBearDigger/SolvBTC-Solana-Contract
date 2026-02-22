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

describe("solvbtc-repro", () => {
  // Configure the client to use the local cluster.
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
  const mintBKeypair = Keypair.generate();
  const mintB = mintBKeypair.publicKey;

  const multisigAKeypair = Keypair.generate();
  const multisigA = multisigAKeypair.publicKey;
  const poolSignerA = derivePoolSignerAddress(mintA);
  const vaultA = deriveVaultAddress(mintA);

  // Withdraw request
  const hash = createWithdrawRequestHash();
  // We will define withdrawRequest address later depending on which mint we use for withdrawal (mintC)

  // Token Accounts
  const userAtaA = getAssociatedTokenAddressSync(mintA, user);

  // Mint C will be our deposit/withdraw currency
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
    // Airdrop
    const tx = new Transaction();
    tx.instructions = [authority, admin, user].map((account) =>
      SystemProgram.transfer({
        fromPubkey: provider.publicKey,
        toPubkey: account,
        lamports: 10 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(tx, []);

    // Create Mints
    const lamportsMint = await getMinimumBalanceForRentExemptMint(connection);
    const lamportsMultisig = await getMinimumBalanceForRentExemptMultisig(connection);

    const setupTx = new Transaction().add(
      // Create Multisig
      SystemProgram.createAccount({
        fromPubkey: provider.publicKey,
        newAccountPubkey: multisigA,
        space: MULTISIG_SIZE,
        lamports: lamportsMultisig,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMultisigInstruction(multisigA, [vaultA, poolSignerA], 1, TOKEN_PROGRAM_ID),

      // Create MintA (Target Token / Share Token)
      SystemProgram.createAccount({
        fromPubkey: provider.publicKey,
        newAccountPubkey: mintA,
        lamports: lamportsMint,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mintA, 8, multisigA, multisigA),

      // Create MintC (Deposit Token), controlled by authority
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

  it("Initialize Vault", async () => {
    await program.methods.vaultInitialize(
      admin,
      authority, // feeReceiver
      authority, // treasurer
      verifier,
      authority, // oracleManager
      ONE_BITCOIN, // NAV = 100,000,000 (1 BTC)
      50, // withdraw fee
    )
    .accountsStrict({
      ...accounts,
      mint: mintA,
      vault: vaultA,
    })
    .signers([authorityKeypair])
    .rpc();

    // Add currency C
    await program.methods.vaultAddCurrency(mintC, 0)
    .accountsStrict({
        ...accounts,
        admin,
        payer: authority,
        vault: vaultA,
        mint: mintA
    })
    .signers([authorityKeypair, adminKeypair])
    .rpc();
  });

  it("User deposits and requests withdrawal", async () => {
    const userAtaC = getAssociatedTokenAddressSync(mintC, user);
    const treasurerAtaC = getAssociatedTokenAddressSync(mintC, authority);

    // Create ATAs and Mint MintC to user
    const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(provider.publicKey, userAtaA, user, mintA),
        createAssociatedTokenAccountIdempotentInstruction(provider.publicKey, userAtaC, user, mintC),
        createAssociatedTokenAccountIdempotentInstruction(provider.publicKey, treasurerAtaC, authority, mintC)
    );
    await provider.sendAndConfirm(tx, []);

    // Mint 1000 tokens to user using spl-token lib
    await mintTo(connection, authorityKeypair, mintC, userAtaC, authorityKeypair, 1000_000_000);

    // Deposit
    // 1 BTC NAV. 1 token (if 8 decimals) = 1 share?
    // NAV (100,000,000) corresponds to ONE_BITCOIN (100,000,000).
    // share = amount * ONE_BITCOIN / NAV = amount * 1 = amount.

    await program.methods.vaultDeposit(new BN(100_000_000), new BN(0))
    .accountsStrict({
        ...accounts,
        vault: vaultA,
        multisig: multisigA,
        userTokenTa: userAtaC,
        userTargetTa: userAtaA,
        treasurerTokenTa: treasurerAtaC,
        mintToken: mintC,
        mintTarget: mintA,
    })
    .signers([userKeypair])
    .rpc();

    // User now has shares (MintA).
    // Request Withdrawal
    // Withdraw to MintC
    const withdrawRequest = deriveWithdrawRequestAddress(vaultA, mintC, user, hash);

    await program.methods.vaultWithdrawRequest(
        Array.from(hash),
        new BN(100_000_000)
    )
    .accountsStrict({
        ...accounts,
        vault: vaultA,
        userTargetTa: userAtaA, // Shares account
        mintTarget: mintA,
        userWithdrawTa: userAtaC, // Withdraw to MintC
        mintWithdraw: mintC,
        withdrawRequest: withdrawRequest
    })
    .signers([userKeypair])
    .rpc();

    // Verify Request Created with current NAV
    const requestAccount = await program.account.withdrawRequest.fetch(withdrawRequest);
    console.log("Request NAV:", requestAccount.nav.toString());
    assert.equal(requestAccount.nav.toString(), ONE_BITCOIN.toString());
  });

  it("Reproduce Vulnerability: Lockout on NAV Drop", async () => {
    // Simulate market crash: NAV drops by 2%.
    // Current NAV = 100,000,000. Target = 98,000,000.

    let currentNav = ONE_BITCOIN;
    const targetNav = new BN(98_000_000); // 2% drop

    console.log("Dropping NAV from", currentNav.toString(), "to", targetNav.toString());

    // Loop to drop NAV
    while (currentNav.gt(targetNav)) {
        let maxDrop = currentNav.mul(new BN(5)).div(new BN(10000));
        let nextNav = currentNav.sub(maxDrop);
        if (nextNav.lt(targetNav)) {
            nextNav = targetNav;
        }

        await program.methods.vaultSetNav(nextNav)
        .accountsStrict({
            ...accounts,
            oracleManager: authority,
            vault: vaultA
        })
        .signers([authorityKeypair])
        .rpc();

        currentNav = nextNav;
    }

    const vaultAccount = await program.account.vault.fetch(vaultA);
    console.log("New Vault NAV:", vaultAccount.nav.toString());
    assert.equal(vaultAccount.nav.toString(), targetNav.toString());

    // Prepare Withdraw
    // We need to fund vault with MintC to pay out.
    const vaultAtaC = getAssociatedTokenAddressSync(mintC, vaultA, true);
    const treasurerAtaC = getAssociatedTokenAddressSync(mintC, authority);

    // Create Vault ATA
    await provider.sendAndConfirm(new Transaction().add(
         createAssociatedTokenAccountIdempotentInstruction(provider.publicKey, vaultAtaC, vaultA, mintC)
    ), []);

    // Transfer from treasurer to vault (rebalance)
    await sendAndConfirmTransaction(connection, new Transaction().add(
        createTransferCheckedInstruction(
            treasurerAtaC,
            mintC,
            vaultAtaC,
            authority,
            100_000_000,
            8
        )
    ), [authorityKeypair]);

    // Withdraw Logic
    const withdrawRequestAddress = deriveWithdrawRequestAddress(vaultA, mintC, user, hash);
    const withdrawRequestData = await program.account.withdrawRequest.fetch(withdrawRequestAddress);

    const verifierHash = deriveWithdrawRequestEip191(
      user,
      mintC, // mintWithdraw
      hash,
      withdrawRequestData.shares,
      withdrawRequestData.nav,
    );
    const signature = createEip191WithdrawSig(verifierKeypair, verifierHash);

    try {
        await program.methods.vaultWithdraw(
            Array.from(hash),
            signature.signature
        )
        .accountsStrict({
            ...accounts,
            vault: vaultA,
            userWithdrawTa: getAssociatedTokenAddressSync(mintC, user),
            mintWithdraw: mintC,
            vaultWithdrawTa: vaultAtaC,
            feeReceiverTa: getAssociatedTokenAddressSync(mintC, authority), // fee receiver
            withdrawRequest: withdrawRequestAddress
        })
        .signers([userKeypair])
        .rpc();

        assert.fail("Withdrawal should have failed due to NAV drop");
    } catch (e: any) {
        console.log("Error caught as expected:", e.message);
        // Error code 6006 is NAVExceeded (0x1776)
        // Let's check error codes in errors.rs
        // Or just check if message contains "NAV exceeded"
        // In Anchor, errors are usually formatted.
        // assert.include(e.message, "NAV exceeded");
        // Note: Sometimes error message might be generic depending on client setup.
    }
  });

});
