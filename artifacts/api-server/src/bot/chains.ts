export interface ChainConfig {
  id: string;
  name: string;
  emoji: string;
  chainId: number;
  nativeCoin: string;
  usdcAddress: string;
  usdcDecimals: number;
  rpc: string;
  explorer: string;
}

export const CHAINS: Record<string, ChainConfig> = {
  base: {
    id: "base",
    name: "Base",
    emoji: "🔵",
    chainId: 8453,
    nativeCoin: "ETH",
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdcDecimals: 6,
    rpc: process.env.RPC_URL ?? "https://mainnet.base.org",
    explorer: "https://basescan.org/tx/",
  },
  arbitrum: {
    id: "arbitrum",
    name: "Arbitrum",
    emoji: "🔵",
    chainId: 42161,
    nativeCoin: "ETH",
    usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    usdcDecimals: 6,
    rpc: "https://arb1.arbitrum.io/rpc",
    explorer: "https://arbiscan.io/tx/",
  },
  optimism: {
    id: "optimism",
    name: "Optimism",
    emoji: "🔴",
    chainId: 10,
    nativeCoin: "ETH",
    usdcAddress: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    usdcDecimals: 6,
    rpc: "https://mainnet.optimism.io",
    explorer: "https://optimistic.etherscan.io/tx/",
  },
  polygon: {
    id: "polygon",
    name: "Polygon",
    emoji: "🟣",
    chainId: 137,
    nativeCoin: "POL",
    usdcAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    usdcDecimals: 6,
    rpc: "https://polygon-rpc.com",
    explorer: "https://polygonscan.com/tx/",
  },
  bsc: {
    id: "bsc",
    name: "BNB Chain",
    emoji: "🟡",
    chainId: 56,
    nativeCoin: "BNB",
    usdcAddress: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    usdcDecimals: 18,
    rpc: "https://bsc-dataseed.binance.org",
    explorer: "https://bscscan.com/tx/",
  },
};

export const SOLANA_CHAIN = {
  id: "solana",
  name: "Solana",
  emoji: "🟢",
  nativeCoin: "SOL",
  usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  wsolMint: "So11111111111111111111111111111111111111112",
  rpc: "https://api.mainnet-beta.solana.com",
  explorer: "https://solscan.io/tx/",
};

export const ALL_CHAIN_IDS = [...Object.keys(CHAINS), "solana"] as const;
export type ChainId = (typeof ALL_CHAIN_IDS)[number];

export function getChainLabel(chainId: string): string {
  if (chainId === "solana") return `${SOLANA_CHAIN.emoji} Solana`;
  const c = CHAINS[chainId];
  return c ? `${c.emoji} ${c.name}` : chainId;
}
