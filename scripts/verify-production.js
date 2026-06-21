#!/usr/bin/env node

/**
 * Repeatable production verification for the contest program.
 *
 * Stages:
 * - pre-deploy:    local config, IDL, RPC cluster, and Squads Vault 0 checks.
 * - post-deploy:   also verifies the deployed program and tolerates authority handoff in progress.
 * - post-handoff:  strict production-ready state; admin and upgrade authority must be Squads Vault 0.
 */

const anchor = require("@coral-xyz/anchor");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

const BPF_UPGRADEABLE_LOADER_ID = new anchor.web3.PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);
const SQUADS_PROGRAM_ID = new anchor.web3.PublicKey(
  "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"
);
const MAINNET_GENESIS_HASH =
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

const scriptDir = __dirname;
const projectDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(projectDir, "..");
const rootEnvFile = path.join(repoRoot, ".env");
const defaultMainnetEnvFile = path.join(repoRoot, ".env.mainnet.local");

const args = process.argv.slice(2);

function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const network = argValue("--network", "mainnet");
const stage = argValue("--stage", "post-handoff");

if (!["mainnet", "devnet"].includes(network)) {
  console.error("ERROR: --network must be mainnet or devnet");
  process.exit(1);
}
if (!["pre-deploy", "post-deploy", "post-handoff"].includes(stage)) {
  console.error(
    "ERROR: --stage must be pre-deploy, post-deploy, or post-handoff"
  );
  process.exit(1);
}

const envFile =
  network === "mainnet"
    ? process.env.MAINNET_ENV_FILE || defaultMainnetEnvFile
    : process.env.DEVNET_ENV_FILE || rootEnvFile;
const resolvedEnvFile = path.resolve(envFile);

if (network === "mainnet" && resolvedEnvFile === path.resolve(rootEnvFile)) {
  console.error("ERROR: Refusing to load root .env for mainnet verification.");
  console.error("Use .env.mainnet.local or set MAINNET_ENV_FILE.");
  process.exit(1);
}
if (!fs.existsSync(resolvedEnvFile)) {
  console.error(`ERROR: Environment file not found: ${resolvedEnvFile}`);
  process.exit(1);
}

dotenv.config({ path: resolvedEnvFile, override: true });

const failures = [];
const warnings = [];

function pass(label, detail) {
  console.log(`OK: ${label}${detail ? ` - ${detail}` : ""}`);
}

function warn(label, detail) {
  warnings.push(`${label}${detail ? ` - ${detail}` : ""}`);
  console.warn(`WARN: ${label}${detail ? ` - ${detail}` : ""}`);
}

function fail(label, detail) {
  const safeDetail = detail ? redactSensitiveText(detail) : "";
  failures.push(`${label}${safeDetail ? ` - ${safeDetail}` : ""}`);
  console.error(`FAIL: ${label}${safeDetail ? ` - ${safeDetail}` : ""}`);
}

function isSensitivePathSegment(value) {
  try {
    return decodeURIComponent(value).length >= 6;
  } catch {
    return value.length >= 6;
  }
}

function redactUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.username) url.username = "***REDACTED***";
  if (url.password) url.password = "***REDACTED***";
  for (const key of [...url.searchParams.keys()]) {
    if (/key|token|secret|auth|password|signature|credential/i.test(key)) {
      url.searchParams.set(key, "***REDACTED***");
    }
  }
  url.pathname = url.pathname
    .split("/")
    .map((part) => (isSensitivePathSegment(part) ? "***REDACTED***" : part))
    .join("/");
  return url.toString();
}

function redactSensitiveText(value) {
  return String(value || "")
    .replace(/https?:\/\/[^\s"'<>]+/g, (match) => {
      const punctuationMatch = match.match(/[)\].,;:!?}]+$/);
      const trailingPunctuation = punctuationMatch ? punctuationMatch[0] : "";
      const urlText = trailingPunctuation
        ? match.slice(0, -trailingPunctuation.length)
        : match;
      try {
        return `${redactUrl(urlText)}${trailingPunctuation}`;
      } catch {
        return match;
      }
    })
    .replace(
      /(api[-_]?key|token|secret|auth|password|signature|credential)=([^&\s]+)/gi,
      "$1=***REDACTED***"
    );
}

function describeRpcError(error) {
  const message = redactSensitiveText(error?.message || String(error));
  if (
    message.includes("401") ||
    message.toLowerCase().includes("unauthorized")
  ) {
    return "RPC returned 401 Unauthorized. Check SOLANA_RPC_ENDPOINT and its API key in the selected env file.";
  }
  return message;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    fail(`Missing env var ${name}`, resolvedEnvFile);
    return "";
  }
  return value;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function publicKeyFromEnv(name) {
  const value = requireEnv(name);
  if (!value) return null;
  try {
    return new anchor.web3.PublicKey(value);
  } catch (error) {
    fail(`Invalid public key in ${name}`, error.message);
    return null;
  }
}

function toU8Bytes(value) {
  return Buffer.from([value]);
}

function deriveSquadsVault0(multisigPda) {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("multisig"),
      multisigPda.toBuffer(),
      Buffer.from("vault"),
      toU8Bytes(0),
    ],
    SQUADS_PROGRAM_ID
  )[0];
}

function decodeProgramDataAddress(programAccountData) {
  if (programAccountData.readUInt32LE(0) !== 2) {
    throw new Error(
      "Program account is not an upgradeable-loader Program state"
    );
  }
  return new anchor.web3.PublicKey(programAccountData.slice(4, 36));
}

function decodeProgramDataUpgradeAuthority(programDataAccountData) {
  if (programDataAccountData.readUInt32LE(0) !== 3) {
    throw new Error(
      "ProgramData account is not an upgradeable-loader ProgramData state"
    );
  }

  // Solana's loader metadata stores ProgramData as enum + slot + Option<Pubkey>.
  // In current loader serialization the Option tag is one byte; keep the u32
  // fallback so the script fails less mysteriously if tooling changes.
  if (programDataAccountData[12] === 0) {
    return null;
  }
  if (programDataAccountData[12] === 1 && programDataAccountData.length >= 45) {
    return new anchor.web3.PublicKey(programDataAccountData.slice(13, 45));
  }
  if (
    programDataAccountData.length >= 48 &&
    programDataAccountData.readUInt32LE(12) === 1
  ) {
    return new anchor.web3.PublicKey(programDataAccountData.slice(16, 48));
  }

  throw new Error("Could not decode ProgramData upgrade authority");
}

function verifyIdl(filePath, expectedProgramId, label) {
  if (!fs.existsSync(filePath)) {
    warn(`${label} not found`, filePath);
    return false;
  }
  const idl = readJson(filePath);
  if (idl.address !== expectedProgramId.toString()) {
    fail(
      `${label} address mismatch`,
      `IDL=${
        idl.address || "(missing)"
      } expected=${expectedProgramId.toString()}`
    );
    return false;
  }
  pass(`${label} address matches`, filePath);
  return true;
}

function verifySourceProgramId(expectedProgramId) {
  const sourcePath = path.join(
    projectDir,
    "programs",
    "contest",
    "src",
    "lib.rs"
  );
  if (!fs.existsSync(sourcePath)) {
    fail("Rust source not found", sourcePath);
    return;
  }
  const source = fs.readFileSync(sourcePath, "utf8");
  const match = source.match(/declare_id!\("([^"]+)"\)/);
  if (!match) {
    fail("Could not find declare_id! in Rust source", sourcePath);
    return;
  }
  if (match[1] !== expectedProgramId.toString()) {
    fail(
      "Rust declare_id! mismatch",
      `source=${match[1]} expected=${expectedProgramId.toString()}`
    );
    return;
  }
  pass("Rust declare_id! matches SOLANA_PROGRAM_ID");
}

async function fetchGlobalConfig(program, programId) {
  const [globalConfig] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("global-config")],
    programId
  );
  try {
    return {
      address: globalConfig,
      account: await program.account.globalConfig.fetch(globalConfig),
    };
  } catch (error) {
    return { address: globalConfig, account: null, error };
  }
}

async function verifyOnChainProgram(
  connection,
  programId,
  expectedAdmin,
  feePayer
) {
  const programAccount = await connection.getAccountInfo(
    programId,
    "confirmed"
  );
  if (!programAccount) {
    if (stage === "pre-deploy") {
      warn(
        "Program account not found; allowed for pre-deploy",
        programId.toString()
      );
      return;
    }
    fail("Program account not found", programId.toString());
    return;
  }

  if (!programAccount.owner.equals(BPF_UPGRADEABLE_LOADER_ID)) {
    fail(
      "Program account owner is not the upgradeable loader",
      programAccount.owner.toString()
    );
    return;
  }
  pass("Program account exists and is upgradeable-loader owned");

  let programDataAddress;
  try {
    programDataAddress = decodeProgramDataAddress(programAccount.data);
    pass("ProgramData address decoded", programDataAddress.toString());
  } catch (error) {
    fail("Could not decode ProgramData address", error.message);
    return;
  }

  const programDataAccount = await connection.getAccountInfo(
    programDataAddress,
    "confirmed"
  );
  if (!programDataAccount) {
    fail("ProgramData account not found", programDataAddress.toString());
    return;
  }

  let upgradeAuthority;
  try {
    upgradeAuthority = decodeProgramDataUpgradeAuthority(
      programDataAccount.data
    );
  } catch (error) {
    fail("Could not decode upgrade authority", error.message);
    return;
  }

  if (!upgradeAuthority) {
    fail(
      "Program is immutable",
      "Expected Squads-controlled upgrade authority for production handoff"
    );
  } else if (stage === "post-handoff") {
    if (!upgradeAuthority.equals(expectedAdmin)) {
      fail(
        "Upgrade authority is not Squads Vault 0",
        `actual=${upgradeAuthority.toString()} expected=${expectedAdmin.toString()}`
      );
    } else {
      pass("Upgrade authority is Squads Vault 0", upgradeAuthority.toString());
    }
  } else if (
    upgradeAuthority.equals(expectedAdmin) ||
    (feePayer && upgradeAuthority.equals(feePayer))
  ) {
    pass(
      "Upgrade authority is acceptable for current stage",
      upgradeAuthority.toString()
    );
  } else {
    fail("Unexpected upgrade authority", upgradeAuthority.toString());
  }
}

async function main() {
  console.log("");
  console.log("Contest Program Production Verification");
  console.log("=======================================");
  console.log(`Network: ${network}`);
  console.log(`Stage: ${stage}`);
  console.log(`Env file: ${resolvedEnvFile}`);
  console.log("");

  const rpcUrl = requireEnv("SOLANA_RPC_ENDPOINT");
  const solanaNetwork = requireEnv("SOLANA_NETWORK");
  const programId = publicKeyFromEnv("SOLANA_PROGRAM_ID");
  const adminSquadsPublicKey = publicKeyFromEnv("ADMIN_SQUADS_PUBLIC_KEY");
  const squadsMultisigPublicKey = publicKeyFromEnv(
    "SQUADS_MULTISIG_PUBLIC_KEY"
  );
  const feePayerPublicKey = process.env.FEE_PAYER_PUBLIC_KEY
    ? publicKeyFromEnv("FEE_PAYER_PUBLIC_KEY")
    : null;

  if (
    !rpcUrl ||
    !programId ||
    !adminSquadsPublicKey ||
    !squadsMultisigPublicKey
  ) {
    throw new Error("Missing required configuration");
  }

  if (network === "mainnet") {
    if (solanaNetwork !== "mainnet-beta") {
      fail("SOLANA_NETWORK must be mainnet-beta", solanaNetwork);
    } else {
      pass("SOLANA_NETWORK is mainnet-beta");
    }
    if (rpcUrl.includes("devnet")) {
      fail("SOLANA_RPC_ENDPOINT appears to target devnet");
    }
  }

  if (adminSquadsPublicKey.equals(squadsMultisigPublicKey)) {
    fail("ADMIN_SQUADS_PUBLIC_KEY equals SQUADS_MULTISIG_PUBLIC_KEY");
  } else {
    pass("Admin authority differs from Squads Multisig Account");
  }

  const derivedVault0 = deriveSquadsVault0(squadsMultisigPublicKey);
  if (!adminSquadsPublicKey.equals(derivedVault0)) {
    fail(
      "ADMIN_SQUADS_PUBLIC_KEY is not derived Squads Vault 0",
      `actual=${adminSquadsPublicKey.toString()} derived=${derivedVault0.toString()}`
    );
  } else {
    pass(
      "ADMIN_SQUADS_PUBLIC_KEY is derived Squads Vault 0",
      derivedVault0.toString()
    );
  }

  verifySourceProgramId(programId);
  const buildIdlPath = path.join(projectDir, "target", "idl", "contest.json");
  const appWalletIdlPath = path.join(
    repoRoot,
    "app-wallet",
    "assets",
    "idl",
    "contest.json"
  );
  const buildIdlOk = verifyIdl(buildIdlPath, programId, "Build IDL");
  const appWalletIdlOk = verifyIdl(
    appWalletIdlPath,
    programId,
    "App-wallet IDL"
  );

  const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
  let rpcUsable = true;
  try {
    const genesisHash = await connection.getGenesisHash();
    if (network === "mainnet" && genesisHash !== MAINNET_GENESIS_HASH) {
      fail("RPC genesis hash is not mainnet-beta", genesisHash);
    } else {
      pass("RPC genesis hash verified", genesisHash);
    }
  } catch (error) {
    rpcUsable = false;
    fail("RPC connectivity/authentication failed", describeRpcError(error));
  }

  const idlPath = buildIdlOk
    ? buildIdlPath
    : appWalletIdlOk
    ? appWalletIdlPath
    : null;
  let program = null;
  if (idlPath) {
    const idl = readJson(idlPath);
    idl.address = programId.toString();
    const wallet = new anchor.Wallet(anchor.web3.Keypair.generate());
    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    program = new anchor.Program(idl, provider);
  } else {
    fail(
      "A matching build or app-wallet IDL is required for GlobalConfig verification"
    );
  }

  if (rpcUsable) {
    await verifyOnChainProgram(
      connection,
      programId,
      adminSquadsPublicKey,
      feePayerPublicKey
    );
  }

  if (stage !== "pre-deploy" && program && rpcUsable) {
    const globalConfig = await fetchGlobalConfig(program, programId);
    console.log(`GlobalConfig PDA: ${globalConfig.address.toString()}`);

    if (!globalConfig.account) {
      if (stage === "post-deploy") {
        warn(
          "GlobalConfig is not initialized yet; allowed for post-deploy before init"
        );
      } else {
        fail("GlobalConfig is not initialized", globalConfig.error?.message);
      }
    } else if (stage === "post-handoff") {
      const admin = globalConfig.account.admin;
      if (!admin.equals(adminSquadsPublicKey)) {
        fail(
          "GlobalConfig.admin is not Squads Vault 0",
          `actual=${admin.toString()} expected=${adminSquadsPublicKey.toString()}`
        );
      } else {
        pass("GlobalConfig.admin is Squads Vault 0", admin.toString());
      }
    } else {
      const admin = globalConfig.account.admin;
      if (
        admin.equals(adminSquadsPublicKey) ||
        (feePayerPublicKey && admin.equals(feePayerPublicKey))
      ) {
        pass(
          "GlobalConfig.admin is acceptable for current stage",
          admin.toString()
        );
      } else {
        fail("Unexpected GlobalConfig.admin", admin.toString());
      }
    }
  }

  console.log("");
  console.log("Verification Summary");
  console.log("====================");
  console.log(`Warnings: ${warnings.length}`);
  console.log(`Failures: ${failures.length}`);

  if (failures.length > 0) {
    console.log("");
    failures.forEach((failure) => console.log(`- ${failure}`));
    process.exit(1);
  }

  console.log("Production verification passed.");
}

main().catch((error) => {
  console.error("");
  console.error("ERROR: Production verification failed unexpectedly.");
  console.error(redactSensitiveText(error?.stack || error?.message || error));
  process.exit(1);
});
