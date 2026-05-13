/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_CELO_CHAIN_ID: string;
  readonly VITE_CELO_RPC_URL?: string;
  readonly VITE_CELO_EXPLORER_BASE_URL?: string;
  readonly VITE_FORGE_QUEST_MANAGER_ADDRESS: string;
  readonly VITE_REWARD_NFT_ADDRESS: string;
  readonly VITE_REPUTATION_ADDRESS: string;
  readonly VITE_TREASURY_ADDRESS: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
