/**
 * Initialize Program
 * 
 * This script initializes the GlobalConfig account if it doesn't exist.
 * 
 * Usage:
 *   npx ts-node migrations/init-program.ts --network devnet
 *   npx ts-node migrations/init-program.ts --network mainnet
 */

import * as anchor from '@coral-xyz/anchor';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

const repoEnvFile = path.join(__dirname, '..', '..', '.env');
const defaultMainnetEnvFile = path.join(__dirname, '..', '..', '.env.mainnet.local');

function loadEnvironment(network: string): string {
  const envFile = network === 'mainnet'
    ? (process.env.MAINNET_ENV_FILE || defaultMainnetEnvFile)
    : (process.env.DEVNET_ENV_FILE || repoEnvFile);
  const resolvedEnvFile = path.resolve(envFile);

  if (network === 'mainnet' && resolvedEnvFile === path.resolve(repoEnvFile)) {
    console.error('Refusing to load root .env for mainnet. Use .env.mainnet.local or MAINNET_ENV_FILE.');
    process.exit(1);
  }

  if (!fs.existsSync(resolvedEnvFile)) {
    console.error(`Environment file not found: ${resolvedEnvFile}`);
    process.exit(1);
  }

  dotenv.config({ path: resolvedEnvFile, override: true });
  return resolvedEnvFile;
}

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const networkIndex = args.indexOf('--network');
  const network = networkIndex !== -1 ? args[networkIndex + 1] : 'devnet';

  if (!['devnet', 'mainnet'].includes(network)) {
    console.error('Invalid network. Use --network devnet or --network mainnet');
    process.exit(1);
  }

  const envFile = loadEnvironment(network);

  console.log('\nInitializing Contest Program');
  console.log('=================================');
  console.log(`Network: ${network}`);
  console.log(`Env file: ${envFile}`);
  console.log('');

  // Set up provider
  const rpcUrl = network === 'mainnet' 
    ? process.env.SOLANA_RPC_ENDPOINT?.replace('devnet', 'mainnet-beta')
    : process.env.SOLANA_RPC_ENDPOINT;

  if (!rpcUrl) {
    console.error(`RPC URL not configured in ${envFile}`);
    process.exit(1);
  }

  // Load admin keypair (fee payer initially)
  // Preferred: file-based keypair path (matches deployment scripts)
  const feePayerKeypairPath = process.env.FEE_PAYER_KEYPAIR_PATH;
  const feePayerSecret = process.env.FEE_PAYER_SECRET_KEY; // legacy fallback

  let adminKeypair: anchor.web3.Keypair;
  if (feePayerKeypairPath && fs.existsSync(feePayerKeypairPath)) {
    const keypairData = JSON.parse(fs.readFileSync(feePayerKeypairPath, 'utf8'));
    adminKeypair = anchor.web3.Keypair.fromSecretKey(Uint8Array.from(keypairData));
  } else if (feePayerSecret) {
    const secretKey = JSON.parse(feePayerSecret);
    adminKeypair = anchor.web3.Keypair.fromSecretKey(Uint8Array.from(secretKey));
  } else {
    console.error('Fee payer keypair not configured.');
    console.error(`   Set FEE_PAYER_KEYPAIR_PATH (recommended) or FEE_PAYER_SECRET_KEY (legacy) in ${envFile}`);
    process.exit(1);
  }

  console.log(`Admin/Fee Payer: ${adminKeypair.publicKey.toString()}`);

  // Create connection and provider
  const connection = new anchor.web3.Connection(rpcUrl, 'confirmed');
  const wallet = new anchor.Wallet(adminKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  });

  // Load program
  const programIdStr = process.env.SOLANA_PROGRAM_ID;
  if (!programIdStr) {
    console.error(`SOLANA_PROGRAM_ID not configured in ${envFile}`);
    process.exit(1);
  }
  const programId = new anchor.web3.PublicKey(programIdStr);
  const idlPath = path.join(__dirname, '..', 'target', 'idl', 'contest.json');
  
  if (!fs.existsSync(idlPath)) {
    console.error('IDL file not found. Please run: anchor build');
    process.exit(1);
  }
  
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  if (idl.address && idl.address !== programId.toString()) {
    console.error(`IDL address ${idl.address} does not match SOLANA_PROGRAM_ID ${programId.toString()}`);
    process.exit(1);
  }
  idl.address = programId.toString();
  // Anchor 0.30+ reads the program address from the IDL.
  const program = new anchor.Program(idl, provider);

  console.log(`Program ID: ${programId.toString()}`);
  console.log('');

  // Derive GlobalConfig PDA
  const [globalConfig, bump] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from('global-config')],
    programId
  );

  console.log(`GlobalConfig PDA: ${globalConfig.toString()}`);

  // Derive ProgramData PDA (upgradeable loader)
  const BPF_UPGRADEABLE_LOADER_ID = new anchor.web3.PublicKey(
    'BPFLoaderUpgradeab1e11111111111111111111111'
  );
  const [programData] = anchor.web3.PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_UPGRADEABLE_LOADER_ID
  );

  // Check if already initialized
  try {
    const configAccount = await (program.account as any).globalConfig.fetch(globalConfig);
    console.log('');
    console.log('Program is already initialized!');
    console.log(`   Current admin: ${configAccount.admin.toString()}`);
    console.log('');
    console.log('No action needed. Use update-admin-to-squads.ts to change admin.');
    return;
  } catch (e) {
    // Account doesn't exist, proceed with initialization
    console.log('   Account not found - proceeding with initialization...');
  }

  // Initialize program
  console.log('');
  console.log('Initializing program...');
  
  try {
    const tx = await (program.methods as any)
      .programInit()
      .accounts({
        admin: adminKeypair.publicKey,
        globalConfig,
        program: programId,
        programData,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([adminKeypair])
      .rpc();

    console.log('');
    console.log('Program Initialized Successfully!');
    console.log(`   Transaction: ${tx}`);
    console.log(`   Explorer: https://solscan.io/tx/${tx}${network === 'devnet' ? '?cluster=devnet' : ''}`);
    console.log('');

    // Verify
    const configAccount = await (program.account as any).globalConfig.fetch(globalConfig);
    console.log('Verification:');
    console.log(`   GlobalConfig PDA: ${globalConfig.toString()}`);
    console.log(`   Admin: ${configAccount.admin.toString()}`);
    console.log(`   Bump: ${configAccount.bump}`);
    console.log('   Program ready for use!');

  } catch (e: any) {
    console.error('');
    console.error('Program initialization failed:', e.message);
    
    if (e.logs) {
      console.error('');
      console.error('Transaction logs:');
      e.logs.forEach((log: string) => console.error(`  ${log}`));
    }
    
    process.exit(1);
  }

  console.log('');
  console.log('=================================');
  console.log('Initialization Complete!');
  console.log('=================================');
  console.log('');
  console.log('Next steps:');
  console.log('1. Run update-admin-to-squads.ts to switch admin to Squads Vault 0');
  console.log('2. Test contest creation and prize release');
  console.log('3. Deploy to mainnet when ready');
  console.log('');
}

main().catch(console.error);

