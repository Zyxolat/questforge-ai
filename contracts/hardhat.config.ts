import { HardhatUserConfig } from 'hardhat/config';
import '@nomiclabs/hardhat-waffle';
import '@nomiclabs/hardhat-ethers';
import '@typechain/hardhat';
import * as dotenv from 'dotenv';

dotenv.config();

const CELO_PRIVATE_KEY = process.env.PRIVATE_KEY || '';

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.20',
    settings: {
      optimizer: { enabled: true, runs: 200 }
    }
  },
  networks: {
    alfajores: {
      url: 'https://alfajores-forno.celo-testnet.org',
      accounts: CELO_PRIVATE_KEY ? [CELO_PRIVATE_KEY] : []
    },
    celo: {
      url: 'https://forno.celo.org',
      accounts: CELO_PRIVATE_KEY ? [CELO_PRIVATE_KEY] : []
    }
  },
  typechain: {
    outDir: 'typechain',
    target: 'ethers-v5'
  }
};

export default config;
