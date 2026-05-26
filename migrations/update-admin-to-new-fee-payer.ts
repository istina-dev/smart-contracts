/**
 * Update GlobalConfig Admin to New Fee Payer
 * 
 * This migration updates the admin from the old (shared) fee payer
 * to the new (secure) fee payer that was generated.
 * 
 * Run this ONCE after generating a new fee payer keypair.
 */

import * as anchor from '@coral-xyz/anchor';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables from parent directory
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function main() {
  console.log('\nUpdating GlobalConfig Admin to New Fee Payer');
  console.log('=================================');

  // Load program ID
  const programId = new PublicKey(process.env.SOLANA_PROGRAM_ID!);
  console.log(`Program ID: ${programId.toBase58()}`);

  // Load RPC endpoint
  const rpcUrl = process.env.SOLANA_RPC_ENDPOINT || 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  const network = process.env.SOLANA_NETWORK || 'devnet';
  console.log(`Network: ${network}`);
  if (network === 'mainnet' || network === 'mainnet-beta') {
    console.error('ERROR: This legacy migration is devnet-only. For mainnet, use update-admin-to-squads.ts with .env.mainnet.local.');
    process.exit(1);
  }

  // Load OLD admin keypair (must sign the update)
  // For devnet, this is the old fee payer that was used during init
  const oldKeypairPath = path.resolve(__dirname, '../../.secrets/old-fee-payer-keypair.json');
  
  if (!fs.existsSync(oldKeypairPath)) {
    console.error('\nERROR: Old fee payer keypair not found.');
    console.error(`   Expected at: ${oldKeypairPath}`);
    console.error('\nIf you still have access to the old fee payer:');
    console.error('   1. Create the old keypair from the array in your backup');
    console.error('   2. Save it to .secrets/old-fee-payer-keypair.json');
    console.error('\n   OR if you lost it:');
    console.error('   1. Redeploy the smart contract (creates new program)');
    console.error('   2. Run init-program.ts with the new fee payer');
    process.exit(1);
  }

  const oldKeypairData = JSON.parse(fs.readFileSync(oldKeypairPath, 'utf-8'));
  const oldAdminKeypair = Keypair.fromSecretKey(new Uint8Array(oldKeypairData));
  console.log(`\nOld Admin (signing): ${oldAdminKeypair.publicKey.toBase58()}`);

  // Load NEW fee payer public key
  const newFeePayerPubkey = new PublicKey(process.env.FEE_PAYER_PUBLIC_KEY!);
  console.log(`New Admin (target): ${newFeePayerPubkey.toBase58()}`);

  // Create provider with old admin (to sign the update)
  const wallet = new Wallet(oldAdminKeypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  });
  anchor.setProvider(provider);

  // Load program IDL
  const idlPath = path.resolve(__dirname, '../target/idl/contest.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));
  if (idl.address && idl.address !== programId.toBase58()) {
    console.error(`IDL address ${idl.address} does not match SOLANA_PROGRAM_ID ${programId.toBase58()}`);
    process.exit(1);
  }
  idl.address = programId.toBase58();
  // Anchor 0.30+ reads the program address from the IDL.
  const program = new anchor.Program(idl, provider);

  // Derive GlobalConfig PDA
  const [globalConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('global-config')],
    programId
  );
  console.log(`GlobalConfig PDA: ${globalConfig.toBase58()}`);

  // Fetch current GlobalConfig
  try {
    const configAccount = await (program.account as any).globalConfig.fetch(globalConfig);
    console.log(`\nCurrent Admin: ${configAccount.admin.toBase58()}`);
    
    if (configAccount.admin.toBase58() === newFeePayerPubkey.toBase58()) {
      console.log('\nAdmin is already set to the new fee payer. No update needed.');
      return;
    }
  } catch (error) {
    console.error('\nERROR: Failed to fetch GlobalConfig:', error);
    console.error('   Make sure the program is initialized with init-program.ts first.');
    process.exit(1);
  }

  // Update admin
  console.log('\nUpdating admin...');
  
  try {
    const tx = await (program.methods as any)
      .updateAdmin()
      .accounts({
        admin: oldAdminKeypair.publicKey,
        globalConfig: globalConfig,
        newAdmin: newFeePayerPubkey,
      })
      .signers([oldAdminKeypair])
      .rpc();

    console.log(`\nAdmin Updated Successfully.`);
    console.log(`   Transaction: ${tx}`);
    console.log(`   Explorer: https://solscan.io/tx/${tx}?cluster=${network}`);

    // Verify update
    const updatedConfig = await (program.account as any).globalConfig.fetch(globalConfig);
    console.log(`\nVerification:`);
    console.log(`   GlobalConfig PDA: ${globalConfig.toBase58()}`);
    console.log(`   New Admin: ${updatedConfig.admin.toBase58()}`);
    console.log(`   Bump: ${updatedConfig.bump}`);
    
    if (updatedConfig.admin.toBase58() === newFeePayerPubkey.toBase58()) {
      console.log('\nAdmin update verified.');
    } else {
      console.log('\nWARNING: Admin mismatch after update.');
    }

  } catch (error) {
    console.error('\nERROR: Failed to update admin:', error);
    process.exit(1);
  }

  console.log('\n=================================');
  console.log('Migration Complete!');
  console.log('=================================');
  console.log('\nNext steps:');
  console.log('1. Test contest creation on devnet');
  console.log('2. Test prize release on devnet');
  console.log('3. When ready for mainnet, run update-admin-to-squads.ts');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\nERROR: Migration failed:', error);
    process.exit(1);
  });

