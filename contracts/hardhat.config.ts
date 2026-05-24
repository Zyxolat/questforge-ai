import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-verify";
import "@typechain/hardhat";
import "hardhat-gas-reporter";
import "solidity-coverage";
import * as dotenv from "dotenv";
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
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
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
