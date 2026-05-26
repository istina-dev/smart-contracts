/**
 * Update Admin to Squads Vault 0
 *
 * This script updates the GlobalConfig.admin from the old hot wallet
 * to your Squads Vault 0 address.
 *
 * IMPORTANT:
 * - DO NOT use the Squads Multisig Account address as program authority.
 * - Use Squads Vault 0 for assets/authorities.
 * - Use the Multisig Account only for Squads SDK/CLI settings.
 *
 * ONE-TIME OPERATION - Run on devnet first, then mainnet.
 *
 * Usage:
 *   npx ts-node migrations/update-admin-to-squads.ts --network devnet
 *   npx ts-node migrations/update-admin-to-squads.ts --network mainnet
 */

import * as anchor from "@coral-xyz/anchor";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

const repoEnvFile = path.join(__dirname, "..", "..", ".env");
const defaultMainnetEnvFile = path.join(
  __dirname,
  "..",
  "..",
  ".env.mainnet.local"
);

function loadEnvironment(network: string): string {
  const envFile =
    network === "mainnet"
      ? process.env.MAINNET_ENV_FILE || defaultMainnetEnvFile
      : process.env.DEVNET_ENV_FILE || repoEnvFile;
  const resolvedEnvFile = path.resolve(envFile);

  if (network === "mainnet" && resolvedEnvFile === path.resolve(repoEnvFile)) {
    console.error(
      "Refusing to load root .env for mainnet. Use .env.mainnet.local or MAINNET_ENV_FILE."
    );
    process.exit(1);
  }

  if (!fs.existsSync(resolvedEnvFile)) {
    console.error(`Environment file not found: ${resolvedEnvFile}`);
    process.exit(1);
  }

  dotenv.config({ path: resolvedEnvFile, override: true });
  return resolvedEnvFile;
}

async function fetchGlobalConfigWithRetry(
  program: anchor.Program,
  globalConfig: anchor.web3.PublicKey
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      return await (program.account as any).globalConfig.fetch(globalConfig);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const networkIndex = args.indexOf("--network");
  const network = networkIndex !== -1 ? args[networkIndex + 1] : "devnet";

  if (!["devnet", "mainnet"].includes(network)) {
    console.error("Invalid network. Use --network devnet or --network mainnet");
    process.exit(1);
  }

  const envFile = loadEnvironment(network);

  console.log("\nUpdating Admin to Squads Vault 0");
  console.log("=====================================");
  console.log(`Network: ${network}`);
  console.log(`Env file: ${envFile}`);
  console.log("");

  // Set up provider
  const rpcUrl =
    network === "mainnet"
      ? process.env.SOLANA_RPC_ENDPOINT?.replace("devnet", "mainnet-beta")
      : process.env.SOLANA_RPC_ENDPOINT;

  if (!rpcUrl) {
    console.error(`ERROR: RPC URL not configured in ${envFile}`);
    process.exit(1);
  }

  // Load current admin keypair (fee payer, path-based only)
  const feePayerKeypairPath = process.env.FEE_PAYER_KEYPAIR_PATH;
  if (!feePayerKeypairPath) {
    console.error("ERROR: Fee payer keypair not configured.");
    console.error(`   Set FEE_PAYER_KEYPAIR_PATH in ${envFile}`);
    process.exit(1);
  }
  const resolvedFeePayerKeypairPath = path.resolve(feePayerKeypairPath);
  if (!fs.existsSync(resolvedFeePayerKeypairPath)) {
    console.error(
      `ERROR: Fee payer keypair file not found: ${resolvedFeePayerKeypairPath}`
    );
    process.exit(1);
  }

  const keypairData = JSON.parse(
    fs.readFileSync(resolvedFeePayerKeypairPath, "utf8")
  );
  const currentAdminKeypair = anchor.web3.Keypair.fromSecretKey(
    Uint8Array.from(keypairData)
  );

  console.log(`Current Admin: ${currentAdminKeypair.publicKey.toString()}`);

  // Get new admin (Squads Vault 0)
  const newAdminPubkey = process.env.ADMIN_SQUADS_PUBLIC_KEY;
  if (!newAdminPubkey) {
    console.error(
      `ERROR: ADMIN_SQUADS_PUBLIC_KEY not configured in ${envFile}`
    );
    console.error(`   Please set your Squads Vault 0 address in ${envFile}`);
    process.exit(1);
  }

  const newAdmin = new anchor.web3.PublicKey(newAdminPubkey);
  console.log(`New Admin (Squads Vault 0): ${newAdmin.toString()}`);
  if (
    process.env.SQUADS_MULTISIG_PUBLIC_KEY &&
    process.env.SQUADS_MULTISIG_PUBLIC_KEY === newAdminPubkey
  ) {
    console.error(
      "ERROR: ADMIN_SQUADS_PUBLIC_KEY equals SQUADS_MULTISIG_PUBLIC_KEY."
    );
    console.error(
      "   This is unsafe. ADMIN_SQUADS_PUBLIC_KEY must be Squads Vault 0, not the Multisig Account."
    );
    process.exit(1);
  }
  console.log("");

  // Confirm with user
  console.log("WARNING: This is a one-time operation.");
  console.log(
    "   After this, only Squads Vault 0 can perform admin actions via approved Squads proposals."
  );
  console.log("   Make sure this is Vault 0, not the Multisig Account.");
  console.log("");
  console.log(`Press Ctrl+C to cancel, or wait 5 seconds to continue...`);

  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Create connection and provider
  const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(currentAdminKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  // Load program
  const programId = new anchor.web3.PublicKey(process.env.SOLANA_PROGRAM_ID!);
  const idlPath = path.join(__dirname, "..", "target", "idl", "contest.json");

  if (!fs.existsSync(idlPath)) {
    console.error("ERROR: IDL file not found. Please run: anchor build");
    process.exit(1);
  }

  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  if (idl.address && idl.address !== programId.toString()) {
    console.error(
      `IDL address ${
        idl.address
      } does not match SOLANA_PROGRAM_ID ${programId.toString()}`
    );
    process.exit(1);
  }
  idl.address = programId.toString();
  // Anchor 0.30+ reads the program address from the IDL.
  const program = new anchor.Program(idl, provider);

  console.log(`Program ID: ${programId.toString()}`);
  console.log("");

  // Derive GlobalConfig PDA
  const [globalConfig, bump] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("global-config")],
    programId
  );

  console.log(`GlobalConfig PDA: ${globalConfig.toString()}`);

  // Check current state
  try {
    const configAccount = await (program.account as any).globalConfig.fetch(
      globalConfig
    );
    console.log(`   Current admin: ${configAccount.admin.toString()}`);

    if (configAccount.admin.toString() === newAdmin.toString()) {
      console.log("");
      console.log("Admin is already set to Squads Vault 0!");
      console.log("   No update needed.");
      return;
    }

    if (
      configAccount.admin.toString() !==
      currentAdminKeypair.publicKey.toString()
    ) {
      console.error("");
      console.error("ERROR: Current admin does not match fee payer signer.");
      console.error(`   On-chain admin: ${configAccount.admin.toString()}`);
      console.error(
        `   Your keypair: ${currentAdminKeypair.publicKey.toString()}`
      );
      console.error("");
      console.error("   You do not have permission to update the admin.");
      process.exit(1);
    }
  } catch (e) {
    console.error("ERROR: Failed to fetch GlobalConfig:", e);
    console.error("   Make sure the program is initialized with program_init");
    process.exit(1);
  }

  // Update admin
  console.log("");
  console.log("Updating admin...");

  try {
    const tx = await (program.methods as any)
      .updateAdmin()
      .accounts({
        admin: currentAdminKeypair.publicKey,
        globalConfig,
        newAdmin,
      })
      .signers([currentAdminKeypair])
      .rpc();

    console.log("");
    console.log("Admin Updated Successfully.");
    console.log(`   Transaction: ${tx}`);
    console.log(
      `   Explorer: https://solscan.io/tx/${tx}${
        network === "devnet" ? "?cluster=devnet" : ""
      }`
    );
    console.log("");

    // Verify
    const latestBlockhash = await provider.connection.getLatestBlockhash(
      "confirmed"
    );
    await provider.connection.confirmTransaction(
      { signature: tx, ...latestBlockhash },
      "confirmed"
    );
    const updatedConfig = await fetchGlobalConfigWithRetry(
      program,
      globalConfig
    );
    console.log("Verification:");
    console.log(`   Old admin: ${currentAdminKeypair.publicKey.toString()}`);
    console.log(`   New admin: ${updatedConfig.admin.toString()}`);

    if (updatedConfig.admin.toString() === newAdmin.toString()) {
      console.log("Admin successfully updated to Squads Vault 0!");
    } else {
      console.error("Admin update verification failed!");
      process.exit(1);
    }
  } catch (e: any) {
    console.error("");
    console.error("Admin update failed:", e.message);

    if (e.logs) {
      console.error("");
      console.error("Transaction logs:");
      e.logs.forEach((log: string) => console.error(`  ${log}`));
    }

    process.exit(1);
  }

  console.log("");
  console.log("=====================================");
  console.log("Migration Complete!");
  console.log("=====================================");
  console.log("");
  console.log("Next steps:");
  console.log("1. Update backend to use Squads SDK");
  console.log("2. Test prize release on devnet");
  console.log("3. Deploy to mainnet when ready");
  console.log("");
}

main().catch(console.error);
