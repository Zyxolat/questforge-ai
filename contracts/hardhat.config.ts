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

function resolveCeloAccounts() {
  const raw = process.env.PRIVATE_KEY?.trim();
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
    const privateKey = new Wallet(raw).privateKey;
    if (/^0x0{64}$/i.test(privateKey)) {
      throw new Error("must not be the all-zero private key");
    }
    return [privateKey];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const wrappedError = new Error(`PRIVATE_KEY is invalid: ${message}`) as Error & { cause?: unknown };
    wrappedError.cause = error;
    throw wrappedError;
  }
}

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
