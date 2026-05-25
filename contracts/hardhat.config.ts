import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-verify";
import "@typechain/hardhat";
import "hardhat-gas-reporter";
import "solidity-coverage";
import * as dotenv from "dotenv";
import { Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";

function loadEnvFile(envPath: string, override: boolean) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override });
  }
}

const baseEnvPaths = [
  path.join(__dirname, "..", ".env"),
  path.join(__dirname, ".env"),
];

const productionEnvPaths = [
  path.join(__dirname, "..", ".env.production"),
  path.join(__dirname, ".env.production"),
];

for (const envPath of baseEnvPaths) {
  loadEnvFile(envPath, false);
}

for (const envPath of productionEnvPaths) {
  loadEnvFile(envPath, true);
}

function selectedNetworkName() {
  const cliIndex = process.argv.indexOf("--network");
  const cliNetwork = cliIndex >= 0 ? process.argv[cliIndex + 1] : undefined;
  return (process.env.HARDHAT_NETWORK || cliNetwork || "").trim();
}

function parseLocalChainId() {
  const raw = process.env.LOCAL_CHAIN_ID?.trim() || "31337";
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`LOCAL_CHAIN_ID is invalid: ${raw}`);
  }
  return parsed;
}

function readOptionalEnv(name: string) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }

  // Ignore unresolved template placeholders from deployment platforms.
  if (/^\$\{\{.+\}\}$/.test(raw) || /^\$\{.+\}$/.test(raw)) {
    return undefined;
  }

  return raw;
}

function normalizePrivateKey(raw: string, name: string) {
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;

  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error(
      `${name} must be a 32-byte hex string${raw.startsWith("0x") ? "" : " (with or without a 0x prefix)"}.`
    );
  }

  if (/^0x0{64}$/i.test(normalized)) {
    throw new Error(`${name} must not be the all-zero private key`);
  }

  return normalized;
}

function resolveCeloAccounts() {
  const raw = readOptionalEnv("PRIVATE_KEY");
  const selectedNetwork = selectedNetworkName();

  if (!raw) {
    if (selectedNetwork === "celo") {
      throw new Error(
        "PRIVATE_KEY is required for the Hardhat celo network. Set it in contracts/.env.production, repo-root .env.production, or your shell before deploying."
      );
    }

    return [];
  }

  try {
    const privateKey = new Wallet(normalizePrivateKey(raw, "PRIVATE_KEY")).privateKey;
    return [privateKey];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const wrappedError = new Error(`PRIVATE_KEY is invalid: ${message}`) as Error & { cause?: unknown };
    wrappedError.cause = error;
    throw wrappedError;
  }
}

const localChainId = parseLocalChainId();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: localChainId,
    },
    localhost: {
      url: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545",
      chainId: localChainId,
    },
    celo: {
      url: process.env.CELO_RPC_URL || "https://forno.celo.org",
      accounts: resolveCeloAccounts(),
      chainId: 42220,
    },
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
  mocha: {
    timeout: 40000,
  },
};

export default config;
