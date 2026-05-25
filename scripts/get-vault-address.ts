/**
 * Get Contest Vault Address
 * 
 * Given a contest ID and creator, derive the vault address where USDC should be sent.
 * 
 * Usage:
 *   npx ts-node scripts/get-vault-address.ts <contest_id> <creator_pubkey> [--network devnet|mainnet] [--mint <mint_pubkey>]
 *   npx ts-node scripts/get-vault-address.ts 0 <creator_pubkey>
 */

import * as anchor from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
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

// USDC Devnet Mint
const USDC_DEVNET_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const USDC_MAINNET_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

async function main() {
  // Get contest ID from command line
  const contestIdArg = process.argv[2];
  const creatorArg = process.argv[3];
  if (!contestIdArg || !creatorArg) {
    console.error('❌ Usage: npx ts-node scripts/get-vault-address.ts <contest_id> <creator_pubkey> [--network devnet|mainnet] [--mint <mint_pubkey>]');
    console.error('   Example: npx ts-node scripts/get-vault-address.ts 0 11111111111111111111111111111111');
    process.exit(1);
  }
  
  const contestId = parseInt(contestIdArg, 10);
  if (isNaN(contestId)) {
    console.error('❌ Invalid contest ID. Must be a number.');
    process.exit(1);
  }
  
  // Parse optional args
  const args = process.argv.slice(4);
  const networkIdx = args.indexOf('--network');
  const network = networkIdx !== -1 ? args[networkIdx + 1] : 'devnet';

  const mintIdx = args.indexOf('--mint');
  const mintOverride = mintIdx !== -1 ? args[mintIdx + 1] : undefined;

  if (!['devnet', 'mainnet'].includes(network)) {
    console.error('❌ Invalid network. Use --network devnet or --network mainnet');
    process.exit(1);
  }

  const envFile = loadEnvironment(network);

  // Load program ID
  const programIdStr = process.env.SOLANA_PROGRAM_ID;
  if (!programIdStr) {
    console.error(`❌ SOLANA_PROGRAM_ID not found in ${envFile}`);
    process.exit(1);
  }
  const programId = new PublicKey(programIdStr);

  const creator = new PublicKey(creatorArg);

  const tokenMint = mintOverride
    ? new PublicKey(mintOverride)
    : (network === 'mainnet' ? USDC_MAINNET_MINT : USDC_DEVNET_MINT);
  
  console.log('\n🔍 Contest Vault Address Lookup');
  console.log('================================\n');
  console.log(`Contest ID: ${contestId}`);
  console.log(`Creator: ${creator.toString()}`);
  console.log(`Program: ${programId.toString()}`);
  console.log(`Network: ${network}`);
  console.log(`Env file: ${envFile}`);
  console.log(`Token mint: ${tokenMint.toString()}`);
  
  // Derive Contest PDA
  const contestIdBuffer = Buffer.alloc(8);
  contestIdBuffer.writeBigUInt64LE(BigInt(contestId), 0);
  const [contestPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('contest'), creator.toBuffer(), contestIdBuffer],
    programId
  );
  
  console.log(`\nContest PDA: ${contestPda.toString()}`);
  console.log(`   Explorer: https://explorer.solana.com/address/${contestPda.toString()}${network === 'devnet' ? '?cluster=devnet' : ''}`);
  
  // Derive Vault Authority PDA
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault-authority'), contestPda.toBuffer()],
    programId
  );
  
  console.log(`\nVault Authority PDA: ${vaultAuthority.toString()}`);
  
  // Derive Vault Token Account (ATA)
  const vaultTokenAccount = await getAssociatedTokenAddress(
    tokenMint,
    vaultAuthority,
    true // allowOwnerOffCurve (PDA can own token accounts)
  );
  
  console.log(`\n💰 VAULT ADDRESS (Send USDC here):`);
  console.log(`   ${vaultTokenAccount.toString()}`);
  console.log(`\n   Explorer: https://explorer.solana.com/address/${vaultTokenAccount.toString()}${network === 'devnet' ? '?cluster=devnet' : ''}`);
  
  console.log(`\n📋 How to Fund This Vault:`);
  console.log(`   1. Get devnet USDC: https://faucet.circle.com/`);
  console.log(`   2. Send USDC to: ${vaultTokenAccount.toString()}`);
  console.log(`   3. Or use the funding script: npx ts-node scripts/fund-contest.ts ${contestId}\n`);
}

main().catch((error) => {
  console.error('\n❌ Error:', error.message);
  process.exit(1);
});



