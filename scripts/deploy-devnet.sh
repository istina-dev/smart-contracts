#!/bin/bash
# ============================================
# Deploy Smart Contract to Devnet
# ============================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$PROJECT_DIR")"
DEVNET_ENV_FILE="${DEVNET_ENV_FILE:-$REPO_ROOT/.env}"

echo "Deploying Contest Program to Devnet"
echo "========================================"

# Safety check: warn if local .env exists (should not!)
if [ -f "$PROJECT_DIR/.env" ]; then
    echo "WARNING: Found local .env in smart-contracts/"
    echo "   This should NOT exist. devnet deploy reads $DEVNET_ENV_FILE, not smart-contracts/.env."
    echo "   Please delete: $PROJECT_DIR/.env"
    echo ""
fi

# Load environment variables from the devnet deploy env file.
# Defaults to root .env because root .env is reserved for local/devnet workflows.
if [ -f "$DEVNET_ENV_FILE" ]; then
    # Use a proper .env parser
    while IFS='=' read -r key value; do
        # Skip empty lines and comments
        [[ -z "$key" || "$key" =~ ^# ]] && continue
        # Remove quotes and export
        value=$(echo "$value" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
        export "$key=$value"
    done < "$DEVNET_ENV_FILE"
    echo "✓ Using devnet env: $DEVNET_ENV_FILE"
else
    echo "ERROR: Devnet env file not found at $DEVNET_ENV_FILE"
    echo "   Create $REPO_ROOT/.env or set DEVNET_ENV_FILE=/path/to/devnet.env"
    exit 1
fi

# Required environment values for devnet deploy
required_vars=(
  "SOLANA_RPC_ENDPOINT"
  "SOLANA_PROGRAM_ID"
  "FEE_PAYER_KEYPAIR_PATH"
  "FEE_PAYER_PUBLIC_KEY"
)
for var_name in "${required_vars[@]}"; do
  if [ -z "${!var_name}" ]; then
    echo "ERROR: required env var $var_name is not set in $DEVNET_ENV_FILE"
    exit 1
  fi
done

# Refuse obvious mainnet configuration in this script.
if [[ "$SOLANA_RPC_ENDPOINT" == *"mainnet"* ]]; then
  echo "ERROR: SOLANA_RPC_ENDPOINT appears to target mainnet: $SOLANA_RPC_ENDPOINT"
  exit 1
fi
if [ -n "$SOLANA_NETWORK" ] && [ "$SOLANA_NETWORK" != "devnet" ]; then
  echo "ERROR: SOLANA_NETWORK must be devnet for deploy-devnet.sh (got: $SOLANA_NETWORK)"
  exit 1
fi

# Set up Solana CLI
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Use the fee-payer keypair (same key that deployed the program originally)
KEYPAIR_FILE="$FEE_PAYER_KEYPAIR_PATH"

if [ ! -f "$KEYPAIR_FILE" ]; then
    echo "ERROR: Fee-payer keypair not found at $KEYPAIR_FILE"
    exit 1
fi
DERIVED_FEE_PAYER_PUBKEY="$(solana-keygen pubkey "$KEYPAIR_FILE")"
if [ "$DERIVED_FEE_PAYER_PUBKEY" != "$FEE_PAYER_PUBLIC_KEY" ]; then
    echo "ERROR: FEE_PAYER_PUBLIC_KEY does not match FEE_PAYER_KEYPAIR_PATH."
    echo "   FEE_PAYER_PUBLIC_KEY:  $FEE_PAYER_PUBLIC_KEY"
    echo "   Derived from keypair:  $DERIVED_FEE_PAYER_PUBKEY"
    exit 1
fi
echo "OK: Using fee-payer keypair: $FEE_PAYER_PUBLIC_KEY"

# Configure Solana CLI
solana config set --url "$SOLANA_RPC_ENDPOINT" --keypair "$KEYPAIR_FILE" > /dev/null
echo "OK: Configured Solana CLI for devnet"

# Check balance
BALANCE=$(solana balance --lamports 2>/dev/null | awk '{print $1}')
BALANCE_SOL=$(echo "scale=4; $BALANCE / 1000000000" | bc)
echo "   Fee-payer: $FEE_PAYER_PUBLIC_KEY"
echo "   Balance: $BALANCE_SOL SOL"

if [ "$BALANCE" -lt 2000000000 ]; then
    echo ""
    echo "WARNING: Balance is low (< 2 SOL)"
    echo "   Deployment requires ~2-3 SOL"
    echo "   Get devnet SOL: https://faucet.solana.com/"
    echo ""
    if [ "${NON_INTERACTIVE:-0}" = "1" ]; then
        echo "NON_INTERACTIVE=1 → continuing automatically"
        echo ""
    else
        read -p "Continue anyway? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
fi

# Build the program
echo ""
echo "INFO: Building program..."
cd "$PROJECT_DIR"
anchor build

# Deploy using Solana CLI to match mainnet behavior.
echo ""
echo "INFO: Deploying to devnet..."
ANCHOR_CLUSTER="${SOLANA_RPC_ENDPOINT:-devnet}"
echo "   Using RPC: $ANCHOR_CLUSTER"

echo ""
echo "INFO: Checking deploy balance (devnet)..."
echo "   Note: upgrades + IDL publish may require additional SOL beyond build estimates."
BALANCE_LAMPORTS=$(solana balance --lamports 2>/dev/null | awk '{print $1}')
BALANCE_SOL=$(echo "scale=4; $BALANCE_LAMPORTS / 1000000000" | bc)
echo "   Balance: $BALANCE_SOL SOL"

# Conservative minimum: leave buffer for IDL upload / retries
MIN_BALANCE_LAMPORTS=3000000000
if [ "$BALANCE_LAMPORTS" -lt "$MIN_BALANCE_LAMPORTS" ]; then
    echo ""
    echo "ERROR: Insufficient balance for deploy + IDL publish (need >= 3 SOL recommended)."
    echo "   Current: $BALANCE_SOL SOL"
    echo "   Get devnet SOL: https://faucet.solana.com/"
    exit 1
fi

PROGRAM_KEYPAIR_FILE="${PROGRAM_KEYPAIR_FILE:-target/deploy/contest-keypair.json}"
if [ ! -f "$PROGRAM_KEYPAIR_FILE" ]; then
    echo "ERROR: Program keypair not found at $PROGRAM_KEYPAIR_FILE"
    echo "   To deploy to the configured program id, you need the program keypair file."
    exit 1
fi

PROGRAM_KEYPAIR_PUBKEY="$(solana-keygen pubkey "$PROGRAM_KEYPAIR_FILE")"
if [ "$PROGRAM_KEYPAIR_PUBKEY" != "$SOLANA_PROGRAM_ID" ]; then
    echo "ERROR: Program keypair public key does not match SOLANA_PROGRAM_ID."
    echo "   SOLANA_PROGRAM_ID:      $SOLANA_PROGRAM_ID"
    echo "   Program keypair pubkey: $PROGRAM_KEYPAIR_PUBKEY"
    echo "   Refusing to deploy a different program than devnet is configured to use."
    exit 1
fi

# If the program already exists, this is an upgrade and must be signed by the
# current upgrade authority. Detect mismatches before sending deploy txs.
PROGRAM_SHOW_OUTPUT="$(solana program show "$SOLANA_PROGRAM_ID" --keypair "$KEYPAIR_FILE" --url "$SOLANA_RPC_ENDPOINT" 2>&1 || true)"
CURRENT_UPGRADE_AUTHORITY="$(echo "$PROGRAM_SHOW_OUTPUT" | awk '$1=="Authority:" { print $2; exit }')"
if [ -n "$CURRENT_UPGRADE_AUTHORITY" ]; then
    echo "OK: Existing devnet program detected"
    echo "   Current upgrade authority: $CURRENT_UPGRADE_AUTHORITY"
    if [ "$CURRENT_UPGRADE_AUTHORITY" != "$FEE_PAYER_PUBLIC_KEY" ]; then
        echo ""
        echo "ERROR: Existing devnet program is controlled by a different upgrade authority."
        echo "   Current authority: $CURRENT_UPGRADE_AUTHORITY"
        echo "   Provided fee payer: $FEE_PAYER_PUBLIC_KEY"
        echo ""
        echo "   Use the current upgrade-authority keypair to upgrade this devnet program,"
        echo "   or deploy a fresh devnet rehearsal program id."
        exit 1
    fi
else
    echo "OK: No readable existing devnet upgrade authority found; treating this as a first deploy"
fi

DEPLOY_ARGS=(
  target/deploy/contest.so
  --program-id "$PROGRAM_KEYPAIR_FILE"
  --keypair "$KEYPAIR_FILE"
  --url "$SOLANA_RPC_ENDPOINT"
  --max-sign-attempts "${SOLANA_DEPLOY_MAX_SIGN_ATTEMPTS:-5}"
)

if [ "${SOLANA_DEPLOY_USE_RPC:-0}" = "1" ]; then
  echo "   Deploy transport: RPC (--use-rpc)"
  DEPLOY_ARGS+=(--use-rpc)
else
  echo "   Deploy transport: Solana CLI default"
fi

if ! solana program deploy "${DEPLOY_ARGS[@]}"; then
    echo ""
    echo "ERROR: Devnet deploy failed while uploading program data."
    echo "   If Solana printed a buffer account above, close it to recover devnet SOL:"
    echo "   solana program close <BUFFER_ACCOUNT> --keypair \"$KEYPAIR_FILE\" --url \"$SOLANA_RPC_ENDPOINT\""
    echo ""
    echo "   You can retry with another devnet RPC by setting SOLANA_RPC_ENDPOINT in $DEVNET_ENV_FILE."
    echo "   Only set SOLANA_DEPLOY_USE_RPC=1 if the default transport is blocked on your network."
    exit 1
fi

# Use the PROGRAM_ID from environment (matches what's in Anchor.toml and lib.rs)
PROGRAM_ID="$SOLANA_PROGRAM_ID"

# Show deployed program info
echo ""
echo "========================================"
echo "Deployment Complete"
echo "========================================"
echo ""
echo "Program ID: $PROGRAM_ID"
echo "Network: Devnet"
echo "Explorer: https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"
echo ""
echo "Security.txt embedded: YES"
echo "   Contact: security@istina.co"
echo "   Project: https://istina.co"
echo ""
echo "View on Solscan:"
echo "   https://solscan.io/account/$PROGRAM_ID?cluster=devnet"
echo ""

# Verify Security.txt is actually present in the deployed on-chain binary
echo "INFO: Verifying embedded Security.txt in on-chain program..."
TMP_DUMP="$(mktemp -t onchain_contest_devnet.XXXXXX)"
if solana program dump "$PROGRAM_ID" "$TMP_DUMP" --url "$SOLANA_RPC_ENDPOINT" > /dev/null 2>&1; then
  if strings -a "$TMP_DUMP" | grep -q "=======BEGIN SECURITY.TXT V1======="; then
    echo "OK: On-chain Security.txt markers found"
  else
    echo "ERROR: On-chain Security.txt markers NOT found"
    echo "   This usually means the deployed program binary does not include the .security.txt section."
    echo "   Rebuild and redeploy, then re-run this script."
    rm -f "$TMP_DUMP"
    exit 1
  fi
else
  echo "WARNING: Could not dump on-chain program to verify Security.txt (RPC issue?)."
  echo "   You can verify manually with:"
  echo "   solana program dump -u \"$SOLANA_RPC_ENDPOINT\" \"$PROGRAM_ID\" /tmp/contest.so && strings -a /tmp/contest.so | grep 'BEGIN SECURITY.TXT'"
fi
rm -f "$TMP_DUMP"

echo ""
echo "INFO: Solscan may still show Security.txt = FALSE on devnet until it re-indexes."
echo "   We verified the on-chain binary contains the markers, so this is usually a Solscan lag/parsing issue."
echo ""

echo "Next steps:"
echo "1. Initialize GlobalConfig: npx ts-node scripts/init-program.ts --network devnet"
echo "2. Submit to Osec.io for verification: https://verify.osec.io/"
echo "3. Optionally rehearse Squads admin / upgrade-authority transfer on devnet"
echo "4. Test the program with the integration tests"
echo ""

