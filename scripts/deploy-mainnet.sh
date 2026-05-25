#!/bin/bash
# ============================================
# Deploy Smart Contract to Mainnet
# ============================================
# ⚠️ PRODUCTION DEPLOYMENT - BE CAREFUL!
# ============================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$PROJECT_DIR")"
MAINNET_ENV_FILE="${MAINNET_ENV_FILE:-$REPO_ROOT/.env.mainnet.local}"

redact_url() {
  echo "$1" | sed -E 's/(api-key=)[^&[:space:]]+/\1***REDACTED***/g'
}

echo ""
echo "⚠️  =================================================="
echo "⚠️  MAINNET DEPLOYMENT - PRODUCTION ENVIRONMENT"
echo "⚠️  =================================================="
echo ""

# Safety check: warn if local .env exists (should not!)
if [ -f "$PROJECT_DIR/.env" ]; then
    echo "⚠️  WARNING: Found local .env in smart-contracts/"
    echo "   This should NOT exist. mainnet deploy reads $MAINNET_ENV_FILE, not smart-contracts/.env."
    echo "   Please delete: $PROJECT_DIR/.env"
    echo ""
fi

# Load environment variables from the dedicated mainnet deploy env file.
# Do not use the root .env here; that file is for local/devnet workflows.
if [ "$(cd "$(dirname "$MAINNET_ENV_FILE")" && pwd)/$(basename "$MAINNET_ENV_FILE")" = "$REPO_ROOT/.env" ]; then
    echo "❌ Error: deploy-mainnet.sh refuses to load root .env."
    echo "   Use MAINNET_ENV_FILE or $REPO_ROOT/.env.mainnet.local instead."
    exit 1
fi

if [ -f "$MAINNET_ENV_FILE" ]; then
    # Use a proper .env parser
    while IFS='=' read -r key value; do
        # Skip empty lines and comments
        [[ -z "$key" || "$key" =~ ^# ]] && continue
        # Remove quotes and export
        value=$(echo "$value" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
        export "$key=$value"
    done < "$MAINNET_ENV_FILE"
    echo "✓ Using mainnet env: $MAINNET_ENV_FILE"
else
    echo "❌ Error: Mainnet env file not found at $MAINNET_ENV_FILE"
    echo "   Create $REPO_ROOT/.env.mainnet.local or set MAINNET_ENV_FILE=/path/to/mainnet.env"
    exit 1
fi

# Required environment values for mainnet deploy
required_vars=(
  "SOLANA_RPC_ENDPOINT"
  "SOLANA_NETWORK"
  "SOLANA_PROGRAM_ID"
  "FEE_PAYER_KEYPAIR_PATH"
  "FEE_PAYER_PUBLIC_KEY"
  "ADMIN_SQUADS_PUBLIC_KEY"
)
for var_name in "${required_vars[@]}"; do
  if [ -z "${!var_name}" ]; then
    echo "❌ Error: required env var $var_name is not set in $MAINNET_ENV_FILE"
    exit 1
  fi
done

# Refuse obvious non-mainnet configuration in this script.
if [ "$SOLANA_NETWORK" != "mainnet-beta" ]; then
  echo "❌ Error: SOLANA_NETWORK must be mainnet-beta for deploy-mainnet.sh (got: $SOLANA_NETWORK)"
  exit 1
fi
if [[ "$SOLANA_RPC_ENDPOINT" == *"devnet"* ]]; then
  echo "❌ Error: SOLANA_RPC_ENDPOINT appears to target devnet: $(redact_url "$SOLANA_RPC_ENDPOINT")"
  exit 1
fi

# Safety checks
echo ""
echo "🔒 Pre-deployment Safety Checks"
echo "================================"

# Check 1: Confirm mainnet deployment
echo ""
echo "You are about to deploy to MAINNET (real money!)."
echo "Program ID: $SOLANA_PROGRAM_ID"
echo "Fee-payer: $FEE_PAYER_PUBLIC_KEY"
echo ""
read -p "Type 'DEPLOY TO MAINNET' to confirm: " CONFIRM
if [ "$CONFIRM" != "DEPLOY TO MAINNET" ]; then
    echo "❌ Deployment cancelled"
    exit 1
fi

# Check 2: Verify admin is a Squads Vault 0 address (recommended)
echo ""
echo "Admin wallet: $ADMIN_SQUADS_PUBLIC_KEY"
echo ""
echo "⚠️  For mainnet, the admin MUST be Squads Vault 0."
echo "    Do NOT use the Squads Multisig Account address as program authority."
echo "    Squads warning: only Squad Vault should own assets/authorities."
echo ""
if [ "$ADMIN_SQUADS_PUBLIC_KEY" = "$FEE_PAYER_PUBLIC_KEY" ]; then
    echo "❌ ERROR: Admin is the same as fee-payer (single key)!"
    echo "   This is NOT safe for mainnet!"
    echo ""
    read -p "Continue anyway? (type 'I ACCEPT THE RISK') " RISK_CONFIRM
    if [ "$RISK_CONFIRM" != "I ACCEPT THE RISK" ]; then
        exit 1
    fi
else
    echo "✓ Admin is not the fee-payer. Confirm manually it is Squads Vault 0."
fi

# If provided, enforce that Vault 0 and Multisig Account are different.
if [ -n "$SQUADS_MULTISIG_PUBLIC_KEY" ] && [ "$ADMIN_SQUADS_PUBLIC_KEY" = "$SQUADS_MULTISIG_PUBLIC_KEY" ]; then
    echo "❌ ERROR: ADMIN_SQUADS_PUBLIC_KEY equals SQUADS_MULTISIG_PUBLIC_KEY."
    echo "   ADMIN_SQUADS_PUBLIC_KEY must be Squads Vault 0, not the Multisig Account."
    exit 1
fi

# Check 3: Verify audit status
echo ""
read -p "Has the smart contract been audited? (yes/no) " AUDITED
if [ "$AUDITED" != "yes" ]; then
    echo ""
    echo "⚠️  WARNING: Deploying unaudited code to mainnet!"
    echo "   Consider getting an audit from:"
    echo "   - Halborn"
    echo "   - OtterSec"
    echo "   - Neodyme"
    echo ""
    read -p "Deploy unaudited code? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Set up Solana CLI
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Use the fee-payer keypair (upgrade authority)
KEYPAIR_FILE="$FEE_PAYER_KEYPAIR_PATH"

if [ ! -f "$KEYPAIR_FILE" ]; then
    echo "❌ Error: Fee-payer keypair not found at $KEYPAIR_FILE"
    exit 1
fi
DERIVED_FEE_PAYER_PUBKEY="$(solana-keygen pubkey "$KEYPAIR_FILE")"
if [ "$DERIVED_FEE_PAYER_PUBKEY" != "$FEE_PAYER_PUBLIC_KEY" ]; then
  echo "❌ Error: FEE_PAYER_PUBLIC_KEY does not match FEE_PAYER_KEYPAIR_PATH."
  echo "   FEE_PAYER_PUBLIC_KEY:  $FEE_PAYER_PUBLIC_KEY"
  echo "   Derived from keypair:  $DERIVED_FEE_PAYER_PUBKEY"
  exit 1
fi
echo "✓ Using fee-payer keypair: $FEE_PAYER_PUBLIC_KEY"

# Configure for mainnet
solana config set --url "$SOLANA_RPC_ENDPOINT" --keypair "$KEYPAIR_FILE" > /dev/null
echo "✓ Configured Solana CLI for mainnet"

# Check balance
BALANCE=$(solana balance --lamports 2>/dev/null | awk '{print $1}')
BALANCE_SOL=$(echo "scale=4; $BALANCE / 1000000000" | bc)
echo ""
echo "Deployer Balance: $BALANCE_SOL SOL"

if [ "$BALANCE" -lt 3000000000 ]; then
    echo ""
    echo "❌ Error: Insufficient balance (need ~3 SOL for deployment)"
    exit 1
fi

# Final confirmation
echo ""
echo "========================================"
echo "FINAL CONFIRMATION"
echo "========================================"
echo "Network:    MAINNET"
echo "Program ID: $SOLANA_PROGRAM_ID"
echo "Fee-payer:  $FEE_PAYER_PUBLIC_KEY"
echo "Balance:    $BALANCE_SOL SOL"
echo "Admin:      $ADMIN_SQUADS_PUBLIC_KEY"
echo "========================================"
echo ""
read -p "Proceed with mainnet deployment? (yes/no) " FINAL_CONFIRM
if [ "$FINAL_CONFIRM" != "yes" ]; then
    echo "❌ Deployment cancelled"
    exit 1
fi

# Build
echo ""
echo "📦 Building program..."
cd "$PROJECT_DIR"
anchor build

# Deploy/Upgrade using solana CLI (more reliable than anchor deploy)
echo ""
echo "🚀 Deploying to mainnet..."
echo "   Using RPC: $(redact_url "$SOLANA_RPC_ENDPOINT")"

PROGRAM_KEYPAIR_FILE="${PROGRAM_KEYPAIR_FILE:-target/deploy/contest-keypair.json}"
if [ ! -f "$PROGRAM_KEYPAIR_FILE" ]; then
    echo "❌ Error: Program keypair not found at $PROGRAM_KEYPAIR_FILE"
    echo "   To deploy to the configured program id, you need the program keypair file."
    echo "   If it is lost, generate/deploy a new program id and update SOLANA_PROGRAM_ID."
    exit 1
fi

PROGRAM_KEYPAIR_PUBKEY="$(solana-keygen pubkey "$PROGRAM_KEYPAIR_FILE")"
if [ "$PROGRAM_KEYPAIR_PUBKEY" != "$SOLANA_PROGRAM_ID" ]; then
    echo "❌ Error: Program keypair public key does not match SOLANA_PROGRAM_ID."
    echo "   SOLANA_PROGRAM_ID:      $SOLANA_PROGRAM_ID"
    echo "   Program keypair pubkey: $PROGRAM_KEYPAIR_PUBKEY"
    echo "   Refusing to deploy a different program than production is configured to use."
    exit 1
fi

# If the program already exists, this is an upgrade and must be signed by the
# current upgrade authority. Detect mismatches before sending deploy txs.
PROGRAM_SHOW_OUTPUT="$(solana program show "$SOLANA_PROGRAM_ID" --keypair "$KEYPAIR_FILE" --url "$SOLANA_RPC_ENDPOINT" 2>&1 || true)"
CURRENT_UPGRADE_AUTHORITY="$(echo "$PROGRAM_SHOW_OUTPUT" | awk '$1=="Authority:" { print $2; exit }')"
if [ -n "$CURRENT_UPGRADE_AUTHORITY" ]; then
    echo "✓ Existing mainnet program detected"
    echo "   Current upgrade authority: $CURRENT_UPGRADE_AUTHORITY"
    if [ "$CURRENT_UPGRADE_AUTHORITY" != "$FEE_PAYER_PUBLIC_KEY" ]; then
        echo ""
        echo "❌ Error: Existing mainnet program is controlled by a different upgrade authority."
        echo "   Current authority: $CURRENT_UPGRADE_AUTHORITY"
        echo "   Provided fee payer: $FEE_PAYER_PUBLIC_KEY"
        echo ""
        echo "   Use the current upgrade-authority keypair to upgrade this program."
        exit 1
    fi
else
    echo "✓ No readable existing mainnet upgrade authority found; treating this as a first deploy"
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
    echo "❌ Mainnet deploy failed while uploading program data."
    echo "   If Solana printed a buffer account above, recover or close it before retrying."
    echo "   Close command template:"
    echo "   solana program close <BUFFER_ACCOUNT> --keypair \"$KEYPAIR_FILE\" --url \"$(redact_url "$SOLANA_RPC_ENDPOINT")\""
    echo ""
    echo "   Prefer retrying with a paid mainnet RPC endpoint before changing deployment keys or program ids."
    echo "   Only set SOLANA_DEPLOY_USE_RPC=1 if the default transport is blocked or your RPC provider recommends it."
    exit 1
fi

# Optional: Publish IDL (best effort). This can fail; deployment still succeeds.
echo ""
echo "📎 Publishing IDL (best effort)..."
ANCHOR_CLUSTER="${SOLANA_RPC_ENDPOINT:-mainnet-beta}"
if anchor idl fetch "$SOLANA_PROGRAM_ID" \
  --provider.cluster "$ANCHOR_CLUSTER" \
  --provider.wallet "$KEYPAIR_FILE" > /dev/null 2>&1; then
  IDL_COMMAND="upgrade"
else
  IDL_COMMAND="init"
fi

if anchor idl "$IDL_COMMAND" "$SOLANA_PROGRAM_ID" \
  --filepath target/idl/contest.json \
  --provider.cluster "$ANCHOR_CLUSTER" \
  --provider.wallet "$KEYPAIR_FILE"; then
    echo "✅ IDL $IDL_COMMAND complete"

    CURRENT_IDL_AUTHORITY="$(anchor idl authority "$SOLANA_PROGRAM_ID" \
      --provider.cluster "$ANCHOR_CLUSTER" \
      --provider.wallet "$KEYPAIR_FILE" 2>/dev/null || true)"
    if [ "$CURRENT_IDL_AUTHORITY" = "$ADMIN_SQUADS_PUBLIC_KEY" ]; then
      echo "✅ IDL authority already set to Squads Vault 0"
    elif [ "$CURRENT_IDL_AUTHORITY" = "$FEE_PAYER_PUBLIC_KEY" ]; then
      echo "🔐 Transferring IDL authority to Squads Vault 0..."
      if anchor idl set-authority \
        --program-id "$SOLANA_PROGRAM_ID" \
        --new-authority "$ADMIN_SQUADS_PUBLIC_KEY" \
        --provider.cluster "$ANCHOR_CLUSTER" \
        --provider.wallet "$KEYPAIR_FILE"; then
          echo "✅ IDL authority transferred to Squads Vault 0"
      else
          echo "⚠️  IDL authority transfer failed (non-fatal)."
      fi
    elif [ -n "$CURRENT_IDL_AUTHORITY" ]; then
      echo "⚠️  IDL authority is neither fee payer nor Squads Vault 0: $CURRENT_IDL_AUTHORITY"
      echo "   Review manually before future IDL upgrades."
    else
      echo "⚠️  Could not read IDL authority (non-fatal)."
    fi
else
    echo ""
    echo "⚠️  IDL publish failed (non-fatal)."
    echo "   You can retry later with:"
    echo "   anchor idl init \"$SOLANA_PROGRAM_ID\" --filepath target/idl/contest.json --provider.cluster \"$(redact_url "$ANCHOR_CLUSTER")\" --provider.wallet \"$KEYPAIR_FILE\""
fi

# Success
echo ""
echo "========================================"
echo "✅ MAINNET DEPLOYMENT COMPLETE!"
echo "========================================"
echo ""
echo "Program ID: $SOLANA_PROGRAM_ID"
echo "Explorer: https://explorer.solana.com/address/$SOLANA_PROGRAM_ID"
echo "Solscan: https://solscan.io/account/$SOLANA_PROGRAM_ID"
echo ""
echo "🔍 Security.txt embedded: ✅"
echo "   Contact: security@istina.co"
echo "   Project: https://istina.co"
echo ""

# Verify Security.txt is actually present in the deployed on-chain binary
echo "🔎 Verifying embedded Security.txt in on-chain program..."
TMP_DUMP="$(mktemp -t onchain_contest_mainnet.XXXXXX)"
if solana program dump "$SOLANA_PROGRAM_ID" "$TMP_DUMP" --url "$SOLANA_RPC_ENDPOINT" > /dev/null 2>&1; then
  if strings -a "$TMP_DUMP" | grep -q "=======BEGIN SECURITY.TXT V1======="; then
    echo "✅ On-chain Security.txt markers found"
  else
    echo "❌ On-chain Security.txt markers NOT found"
    echo "   This usually means the deployed program binary does not include the .security.txt section."
    echo "   Rebuild and redeploy, then re-run this script."
    rm -f "$TMP_DUMP"
    exit 1
  fi
else
  echo "⚠️  Could not dump on-chain program to verify Security.txt (RPC issue?)."
  echo "   You can verify manually with:"
  echo "   solana program dump -u \"$(redact_url "$SOLANA_RPC_ENDPOINT")\" \"$SOLANA_PROGRAM_ID\" /tmp/contest.so && strings -a /tmp/contest.so | grep 'BEGIN SECURITY.TXT'"
fi
rm -f "$TMP_DUMP"

echo ""
echo "ℹ️  Skipping automatic upgrade-authority transfer in this step (safe default)."
echo "   Why: program_init requires the current upgrade authority signer on first init."
echo "   Transfer upgrade authority ONLY AFTER init-program and update-admin-to-squads succeed."

echo "IMPORTANT NEXT STEPS:"
echo "1. Initialize GlobalConfig: npx ts-node scripts/init-program.ts --network mainnet"
echo "2. Set GlobalConfig.admin to Squads Vault 0, never the Multisig Account"
echo "3. Transfer program upgrade authority to Squads Vault 0:"
echo "   solana program set-upgrade-authority \"$SOLANA_PROGRAM_ID\" --upgrade-authority \"$KEYPAIR_FILE\" --new-upgrade-authority \"$ADMIN_SQUADS_PUBLIC_KEY\" --skip-new-upgrade-authority-signer-check --keypair \"$KEYPAIR_FILE\" --url \"$(redact_url "$SOLANA_RPC_ENDPOINT")\""
echo "4. Verify upgrade authority:"
echo "   solana program show \"$SOLANA_PROGRAM_ID\" --url \"$(redact_url "$SOLANA_RPC_ENDPOINT")\""
echo "5. Update production backend .env with PROGRAM_ID"
echo "6. Test with small amounts first!"
echo ""
echo "🔐 Security Reminders:"
echo "   - Keep deployer keypair secure"
echo "   - Use Squads Vault 0 for program authority/assets"
echo "   - Use Squads Multisig Account only for Squads SDK/CLI settings"
echo "   - Monitor program for unusual activity"
echo ""

