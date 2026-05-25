# Istina Contest Program

On-chain escrow program for contest prize pools on Solana.

## Scope

This repository contains:
- Solana program source code
- deployment and migration scripts
- program metadata (`security.txt`, IDL artifacts)

Application/business logic and user-facing services are implemented in separate repositories.

## Program

- Program ID (devnet/mainnet): `BUzLPyNSfEGnKY3RozDtny4us72bYPbiCq2njQLjtaff`
- Crate name: `contest`
- Toolchain: Anchor `0.32.1`

## Core Instructions

- `program_init`
- `create_and_fund_contest`
- `release_prize`
- `refund`
- `close_contest`

## Environment Configuration

Do not place secret values in this repository.

Deployment scripts load environment variables from files in the repository root:
- Devnet: `DEVNET_ENV_FILE` (default `../.env`)
- Mainnet: `MAINNET_ENV_FILE` (default `../.env.mainnet.local`)

Required variables include:
- `SOLANA_RPC_ENDPOINT`
- `SOLANA_NETWORK`
- `SOLANA_PROGRAM_ID`
- `FEE_PAYER_KEYPAIR_PATH`
- `FEE_PAYER_PUBLIC_KEY`
- `ADMIN_SQUADS_PUBLIC_KEY` (Squads Vault 0)
- `SQUADS_MULTISIG_PUBLIC_KEY` (governance account; not program authority)

See `.env.example` for the template.

## Deployment

Devnet:

```bash
./scripts/deploy-devnet.sh
DEVNET_ENV_FILE=../.env npx ts-node scripts/init-program.ts --network devnet
```

Mainnet:

```bash
MAINNET_ENV_FILE=../.env.mainnet.local ./scripts/deploy-mainnet.sh
MAINNET_ENV_FILE=../.env.mainnet.local npx ts-node scripts/init-program.ts --network mainnet
MAINNET_ENV_FILE=../.env.mainnet.local npx ts-node migrations/update-admin-to-squads.ts --network mainnet
```

After initialization and admin migration, transfer upgrade authority to Squads Vault 0.

## IDL Management

For a new on-chain IDL account:

```bash
anchor idl init <PROGRAM_ID> --filepath target/idl/contest.json --provider.cluster <RPC_URL> --provider.wallet <KEYPAIR_PATH>
```

For updates:

```bash
anchor idl upgrade <PROGRAM_ID> --filepath target/idl/contest.json --provider.cluster <RPC_URL> --provider.wallet <KEYPAIR_PATH>
```

Set IDL authority to Squads Vault 0:

```bash
anchor idl set-authority --program-id <PROGRAM_ID> --new-authority <SQUADS_VAULT_0_PUBKEY> --provider.cluster <RPC_URL> --provider.wallet <KEYPAIR_PATH>
```

## Source Verification

Status endpoint:

```bash
curl https://verify.osec.io/status/BUzLPyNSfEGnKY3RozDtny4us72bYPbiCq2njQLjtaff | jq
```

Submit verification from the public source repository with `solana-verify`.

## Security Contact

- Email: `security@istina.co`
- Policy: `https://istina.co/contact`

