/**
 * Initialize the Contest Program
 * 
 * This script initializes the GlobalConfig PDA with the admin wallet.
 * Run after deploying the program.
 * 
 * Usage:
 *   npx ts-node scripts/init-program.ts --network devnet
 *   npx ts-node scripts/init-program.ts --network mainnet
 */

import * as anchor from '@coral-xyz/anchor'
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'

const repoEnvFile = path.join(__dirname, '..', '..', '.env')
const defaultMainnetEnvFile = path.join(__dirname, '..', '..', '.env.mainnet.local')

function loadEnvironment(network: string): string {
  const envFile = network === 'mainnet'
    ? (process.env.MAINNET_ENV_FILE || defaultMainnetEnvFile)
    : (process.env.DEVNET_ENV_FILE || repoEnvFile)
  const resolvedEnvFile = path.resolve(envFile)

  if (network === 'mainnet' && resolvedEnvFile === path.resolve(repoEnvFile)) {
    console.error('Refusing to load root .env for mainnet. Use .env.mainnet.local or MAINNET_ENV_FILE.')
    process.exit(1)
  }

  if (!fs.existsSync(resolvedEnvFile)) {
    console.error(`Environment file not found: ${resolvedEnvFile}`)
    process.exit(1)
  }

  dotenv.config({ path: resolvedEnvFile, override: true })
  return resolvedEnvFile
}

async function fetchGlobalConfigWithRetry(program: anchor.Program, globalConfig: anchor.web3.PublicKey) {
  let lastError: unknown
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      return await (program.account as any).globalConfig.fetch(globalConfig)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  throw lastError
}

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2)
  const networkIndex = args.indexOf('--network')
  const network = networkIndex !== -1 ? args[networkIndex + 1] : 'devnet'

  if (!['devnet', 'mainnet'].includes(network)) {
    console.error('Invalid network. Use --network devnet or --network mainnet')
    process.exit(1)
  }

  const envFile = loadEnvironment(network)

  console.log('\n Initializing Contest Program')
  console.log('================================')
  console.log(`Network: ${network}`)
  console.log(`Env file: ${envFile}`)

  // Set up provider
  const rpcUrl = network === 'mainnet'
    ? process.env.SOLANA_RPC_ENDPOINT?.replace('devnet', 'mainnet-beta')
    : process.env.SOLANA_RPC_ENDPOINT

  if (!rpcUrl) {
    console.error(`RPC URL not configured in ${envFile}`)
    process.exit(1)
  }

  // Load admin/fee-payer keypair
  // Preferred: file-based keypair path (matches deployment scripts)
  const keypairPath = process.env.FEE_PAYER_KEYPAIR_PATH
  const secretKeyStr = process.env.FEE_PAYER_SECRET_KEY // legacy fallback

  let keypair: anchor.web3.Keypair
  if (keypairPath && fs.existsSync(keypairPath)) {
    const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf8'))
    keypair = anchor.web3.Keypair.fromSecretKey(Uint8Array.from(keypairData))
  } else if (secretKeyStr) {
    const secretKey = JSON.parse(secretKeyStr)
    keypair = anchor.web3.Keypair.fromSecretKey(Uint8Array.from(secretKey))
  } else {
    console.error(`Fee payer keypair not configured in ${envFile}`)
    console.error('Set FEE_PAYER_KEYPAIR_PATH (recommended) or FEE_PAYER_SECRET_KEY (legacy)')
    process.exit(1)
  }

  console.log(`Admin/Fee Payer Wallet: ${keypair.publicKey.toString()}`)

  // Create connection and provider
  const connection = new anchor.web3.Connection(rpcUrl, 'confirmed')
  const wallet = new anchor.Wallet(keypair)
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  })

  // Load program from IDL file
  const programIdStr = process.env.SOLANA_PROGRAM_ID
  if (!programIdStr) {
    console.error(`SOLANA_PROGRAM_ID not configured in ${envFile}`)
    process.exit(1)
  }
  const programId = new anchor.web3.PublicKey(programIdStr)
  const idlPath = path.join(__dirname, '..', 'target', 'idl', 'contest.json')
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'))
  if (idl.address && idl.address !== programId.toString()) {
    console.error(`IDL address ${idl.address} does not match SOLANA_PROGRAM_ID ${programId.toString()}`)
    process.exit(1)
  }
  idl.address = programId.toString()
  
  // Anchor 0.30+ reads the program address from the IDL.
  const program = new anchor.Program(idl, provider)

  console.log(`Program ID: ${programId.toString()}`)

  // Derive GlobalConfig PDA
  const [globalConfig, bump] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from('global-config')],
    programId
  )

  console.log(`GlobalConfig PDA: ${globalConfig.toString()}`)

  // Derive ProgramData PDA (upgradeable loader) - required by on-chain init guard
  const BPF_UPGRADEABLE_LOADER_ID = new anchor.web3.PublicKey(
    'BPFLoaderUpgradeab1e11111111111111111111111'
  )
  const [programData] = anchor.web3.PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_UPGRADEABLE_LOADER_ID
  )

  // Check if already initialized
  try {
    const existingConfig = await (program.account as any).globalConfig.fetch(globalConfig)
    console.log('\n GlobalConfig already initialized!')
    console.log(`   Admin: ${existingConfig.admin.toString()}`)
    return
  } catch (e) {
    console.log('\n GlobalConfig not initialized, proceeding...')
  }

  // Initialize GlobalConfig
  console.log('\n Initializing GlobalConfig...')
  
  try {
    const tx = await (program.methods as any)
      .programInit()
      .accountsStrict({
        admin: keypair.publicKey,
        globalConfig,
        program: programId,
        programData,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc()

    console.log('\n GlobalConfig Initialized!')
    console.log(`   Transaction: ${tx}`)
    console.log(`   Explorer: https://explorer.solana.com/tx/${tx}?cluster=${network}`)

    // Verify
    const latestBlockhash = await provider.connection.getLatestBlockhash('confirmed')
    await provider.connection.confirmTransaction({ signature: tx, ...latestBlockhash }, 'confirmed')
    const config = await fetchGlobalConfigWithRetry(program, globalConfig)
    console.log(`\n   Admin: ${config.admin.toString()}`)
    console.log(`   Bump: ${config.bump}`)

  } catch (e) {
    console.error('\n Initialization failed:', e)
    process.exit(1)
  }

  console.log('\n================================')
  console.log('Program initialization complete!')
  console.log('================================\n')
}

main().catch(console.error)
