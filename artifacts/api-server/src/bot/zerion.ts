import axios from "axios";
import { CHAINS } from "./chains.js";

const ZERION_API_KEY = process.env.ZERION_API_KEY!;
const BASE_URL = "https://api.zerion.io";

function authHeader() {
  const encoded = Buffer.from(`${ZERION_API_KEY}:`).toString("base64");
  return { Authorization: `Basic ${encoded}` };
}

export interface TokenInfo {
  symbol: string;
  name: string;
  address: string;
  price: number;
  change24h: number;
}

export interface PortfolioBalance {
  symbol: string;
  name: string;
  amount: string;
  valueUsd: number;
  address: string;
}

// ─── Portfolio ────────────────────────────────────────────────────────────────

export async function getPortfolio(
  walletAddress: string,
  chain = "base"
): Promise<PortfolioBalance[]> {
  try {
    const res = await axios.get(
      `${BASE_URL}/v1/wallets/${walletAddress}/positions`,
      {
        headers: authHeader(),
        params: {
          "filter[chain_ids]": chain,
          "filter[position_types]": "wallet",
          currency: "usd",
        },
        timeout: 15000,
      }
    );

    const positions = res.data?.data ?? [];
    return positions
      .filter((p: any) => p.attributes?.quantity?.float > 0)
      .map((p: any) => ({
        symbol: p.attributes?.fungible_info?.symbol ?? "?",
        name: p.attributes?.fungible_info?.name ?? "Unknown",
        amount: p.attributes?.quantity?.float?.toFixed(6) ?? "0",
        valueUsd: p.attributes?.value ?? 0,
        address:
          p.attributes?.fungible_info?.implementations?.find(
            (impl: any) => impl.chain_id === chain
          )?.address ?? "",
      }));
  } catch (err: any) {
    throw new Error(`Portfolio fetch failed: ${err.message}`);
  }
}

export async function getUsdcBalance(
  walletAddress: string,
  chain = "base"
): Promise<number> {
  const positions = await getPortfolio(walletAddress, chain);
  const usdc = positions.find(
    (p) => p.symbol === "USDC" || p.symbol === "USDbC" || p.symbol === "USDC.e"
  );
  return usdc?.valueUsd ?? 0;
}

// ─── Token Price ──────────────────────────────────────────────────────────────

export async function getTokenPrice(
  address: string,
  chain = "base"
): Promise<number> {
  try {
    const res = await axios.get(`${BASE_URL}/v1/fungibles/${chain}:${address}`, {
      headers: authHeader(),
      params: { currency: "usd" },
      timeout: 8000,
    });
    return res.data?.data?.attributes?.market_data?.price ?? 0;
  } catch {
    return 0;
  }
}

// ─── Trending ─────────────────────────────────────────────────────────────────

export interface TrendingToken {
  symbol: string;
  name: string;
  price: number;
  change24h: number;
  marketCapUsd: number;
  address: string;
}

export async function getTrendingTokens(
  limit = 8,
  chain = "base"
): Promise<TrendingToken[]> {
  try {
    const res = await axios.get(`${BASE_URL}/v1/fungibles/`, {
      headers: authHeader(),
      params: {
        "filter[chain_ids]": chain,
        "sort": "-market_data.market_cap",
        "page[size]": limit,
        currency: "usd",
      },
      timeout: 12000,
    });
    const items: any[] = res.data?.data ?? [];
    return items
      .filter((item: any) => item.attributes?.market_data?.price > 0)
      .map((item: any) => {
        const impl = item.attributes?.implementations?.find(
          (i: any) => i.chain_id === chain
        );
        return {
          symbol: item.attributes?.symbol ?? "?",
          name: item.attributes?.name ?? "Unknown",
          price: item.attributes?.market_data?.price ?? 0,
          change24h: item.attributes?.market_data?.changes?.percent_1d ?? 0,
          marketCapUsd: item.attributes?.market_data?.market_cap ?? 0,
          address: impl?.address ?? "",
        };
      });
  } catch {
    return [];
  }
}

// ─── Token Info ───────────────────────────────────────────────────────────────

export async function getTokenInfo(
  symbol: string,
  chain = "base"
): Promise<TokenInfo | null> {
  try {
    const res = await axios.get(`${BASE_URL}/v1/fungibles/`, {
      headers: authHeader(),
      params: {
        "filter[search_query]": symbol,
        "filter[chain_ids]": chain,
        currency: "usd",
      },
      timeout: 10000,
    });

    const items = res.data?.data ?? [];
    const match = items.find(
      (item: any) =>
        item.attributes?.symbol?.toUpperCase() === symbol.toUpperCase()
    );

    if (!match) return null;

    const impl = match.attributes?.implementations?.find(
      (i: any) => i.chain_id === chain
    );

    return {
      symbol: match.attributes?.symbol ?? symbol,
      name: match.attributes?.name ?? symbol,
      address: impl?.address ?? "",
      price: match.attributes?.market_data?.price ?? 0,
      change24h: match.attributes?.market_data?.changes?.percent_1d ?? 0,
    };
  } catch (err: any) {
    throw new Error(`Token info fetch failed: ${err.message}`);
  }
}

export async function getTokenInfoByAddress(
  address: string,
  chain = "base"
): Promise<TokenInfo | null> {
  try {
    const res = await axios.get(`${BASE_URL}/v1/fungibles/${chain}:${address}`, {
      headers: authHeader(),
      params: { currency: "usd" },
      timeout: 10000,
    });
    const item = res.data?.data;
    if (!item) return null;
    const impl = item.attributes?.implementations?.find(
      (i: any) => i.chain_id === chain
    );
    return {
      symbol: item.attributes?.symbol ?? "?",
      name: item.attributes?.name ?? "Unknown",
      address: impl?.address ?? address,
      price: item.attributes?.market_data?.price ?? 0,
      change24h: item.attributes?.market_data?.changes?.percent_1d ?? 0,
    };
  } catch {
    return null;
  }
}

export async function searchTokenByName(
  query: string,
  chain = "base"
): Promise<TokenInfo | null> {
  try {
    const res = await axios.get(`${BASE_URL}/v1/fungibles/`, {
      headers: authHeader(),
      params: {
        "filter[search_query]": query,
        "filter[chain_ids]": chain,
        currency: "usd",
        "page[size]": 5,
      },
      timeout: 10000,
    });
    const items = res.data?.data ?? [];
    if (!items.length) return null;
    const match =
      items.find(
        (item: any) =>
          item.attributes?.symbol?.toUpperCase() === query.toUpperCase()
      ) ?? items[0];
    const impl = match.attributes?.implementations?.find(
      (i: any) => i.chain_id === chain
    );
    return {
      symbol: match.attributes?.symbol ?? query,
      name: match.attributes?.name ?? query,
      address: impl?.address ?? "",
      price: match.attributes?.market_data?.price ?? 0,
      change24h: match.attributes?.market_data?.changes?.percent_1d ?? 0,
    };
  } catch {
    return null;
  }
}

export interface ChainImpl {
  chainId: string;
  address: string;
}

export interface TokenDetail extends TokenInfo {
  marketCapUsd: number;
  fdvUsd: number;
  volume24hUsd: number;
  change1h: number;
  change24h: number;
  change7d: number;
  change30d: number;
  totalSupply: number;
  circulatingSupply: number;
  implementations: ChainImpl[];
  zerionId: string;
}

export async function getTokenDetail(
  symbol: string,
  chain = "base"
): Promise<TokenDetail | null> {
  try {
    const res = await axios.get(`${BASE_URL}/v1/fungibles/`, {
      headers: authHeader(),
      params: {
        "filter[search_query]": symbol,
        currency: "usd",
        "page[size]": 10,
      },
      timeout: 12000,
    });
    const items = res.data?.data ?? [];
    const match =
      items.find(
        (item: any) =>
          item.attributes?.symbol?.toUpperCase() === symbol.toUpperCase()
      ) ?? items[0];
    if (!match) return null;
    const impl = match.attributes?.implementations?.find(
      (i: any) => i.chain_id === chain
    ) ?? match.attributes?.implementations?.[0];
    const md = match.attributes?.market_data ?? {};
    return {
      zerionId: match.id ?? "",
      symbol: match.attributes?.symbol ?? symbol,
      name: match.attributes?.name ?? symbol,
      address: impl?.address ?? "",
      price: md.price ?? 0,
      change1h: md.changes?.percent_1h ?? 0,
      change24h: md.changes?.percent_1d ?? 0,
      change7d: md.changes?.percent_7d ?? 0,
      change30d: md.changes?.percent_30d ?? 0,
      marketCapUsd: md.market_cap ?? 0,
      fdvUsd: md.fully_diluted_valuation ?? 0,
      volume24hUsd: md.volume_24h ?? md.volume ?? 0,
      totalSupply: md.total_supply ?? 0,
      circulatingSupply: md.circulating_supply ?? 0,
      implementations: (match.attributes?.implementations ?? []).map((i: any) => ({
        chainId: i.chain_id,
        address: i.address ?? "",
      })),
    };
  } catch {
    return null;
  }
}

export async function getTokenDetailByAddress(
  address: string,
  chain = "base"
): Promise<TokenDetail | null> {
  try {
    const res = await axios.get(`${BASE_URL}/v1/fungibles/${chain}:${address}`, {
      headers: authHeader(),
      params: { currency: "usd" },
      timeout: 12000,
    });
    const match = res.data?.data;
    if (!match) return null;
    const impl = match.attributes?.implementations?.find(
      (i: any) => i.chain_id === chain
    ) ?? match.attributes?.implementations?.[0];
    const md = match.attributes?.market_data ?? {};
    return {
      zerionId: match.id ?? "",
      symbol: match.attributes?.symbol ?? "?",
      name: match.attributes?.name ?? "Unknown",
      address: impl?.address ?? address,
      price: md.price ?? 0,
      change1h: md.changes?.percent_1h ?? 0,
      change24h: md.changes?.percent_1d ?? 0,
      change7d: md.changes?.percent_7d ?? 0,
      change30d: md.changes?.percent_30d ?? 0,
      marketCapUsd: md.market_cap ?? 0,
      fdvUsd: md.fully_diluted_valuation ?? 0,
      volume24hUsd: md.volume_24h ?? md.volume ?? 0,
      totalSupply: md.total_supply ?? 0,
      circulatingSupply: md.circulating_supply ?? 0,
      implementations: (match.attributes?.implementations ?? []).map((i: any) => ({
        chainId: i.chain_id,
        address: i.address ?? "",
      })),
    };
  } catch {
    return null;
  }
}

// ─── Solana portfolio via Zerion ──────────────────────────────────────────────

export async function getSolanaPortfolio(
  solPubkey: string
): Promise<PortfolioBalance[]> {
  try {
    const res = await axios.get(
      `${BASE_URL}/v1/wallets/${solPubkey}/positions`,
      {
        headers: authHeader(),
        params: {
          "filter[chain_ids]": "solana",
          "filter[position_types]": "wallet",
          currency: "usd",
        },
        timeout: 15000,
      }
    );
    const positions = res.data?.data ?? [];
    return positions
      .filter((p: any) => p.attributes?.quantity?.float > 0)
      .map((p: any) => ({
        symbol: p.attributes?.fungible_info?.symbol ?? "?",
        name: p.attributes?.fungible_info?.name ?? "Unknown",
        amount: p.attributes?.quantity?.float?.toFixed(6) ?? "0",
        valueUsd: p.attributes?.value ?? 0,
        address:
          p.attributes?.fungible_info?.implementations?.find(
            (impl: any) => impl.chain_id === "solana"
          )?.address ?? "",
      }));
  } catch {
    return [];
  }
}

// ─── EVM Swaps ────────────────────────────────────────────────────────────────

export interface SwapQuote {
  toAmount: string;
  toAmountUsd: number;
  slippage: number;
  txData: any;
  priceImpact: number;
}

async function callSwapQuote(
  walletAddress: string,
  sellTokenId: string,
  buyTokenId: string,
  sellAmountWei: string,
  slippageCap: number,
  chain: string
): Promise<SwapQuote> {
  const res = await axios.post(
    `${BASE_URL}/v1/swaps/quotes`,
    {
      from_address: walletAddress,
      sell_token_id: sellTokenId,
      buy_token_id: buyTokenId,
      sell_amount: sellAmountWei,
      slippage_percent: slippageCap,
      chain_id: chain,
    },
    { headers: { ...authHeader(), "Content-Type": "application/json" }, timeout: 20000 }
  );
  const quote = res.data?.data?.attributes;
  if (!quote) throw new Error("No quote returned from Zerion API");
  return {
    toAmount: quote.buy_amount_normalized ?? "0",
    toAmountUsd: quote.buy_amount_usd ?? 0,
    slippage: quote.slippage_percent ?? 0,
    txData: quote.tx_data ?? null,
    priceImpact: quote.price_impact_percent ?? 0,
  };
}

export async function getSwapQuote(
  walletAddress: string,
  fromTokenAddress: string,
  toTokenAddress: string,
  amountUsd: number,
  slippageCap: number,
  chain = "base"
): Promise<SwapQuote> {
  const usdcDecimals = CHAINS[chain]?.usdcDecimals ?? 6;
  const amountWei = Math.floor(amountUsd * 10 ** usdcDecimals).toString();
  try {
    return await callSwapQuote(
      walletAddress,
      `${chain}:${fromTokenAddress}`,
      `${chain}:${toTokenAddress}`,
      amountWei,
      slippageCap,
      chain
    );
  } catch (err: any) {
    const msg = err.response?.data?.errors?.[0]?.detail ?? err.message;
    throw new Error(`Swap quote failed: ${msg}`);
  }
}

export async function getSellQuote(
  walletAddress: string,
  fromTokenAddress: string,
  fromTokenDecimals: number,
  fromAmountDecimal: number,
  slippageCap: number,
  chain = "base"
): Promise<SwapQuote> {
  const usdcAddress = CHAINS[chain]?.usdcAddress ?? CHAINS.base.usdcAddress;
  const sellAmountWei = BigInt(
    Math.floor(fromAmountDecimal * 10 ** fromTokenDecimals)
  ).toString();
  try {
    return await callSwapQuote(
      walletAddress,
      `${chain}:${fromTokenAddress}`,
      `${chain}:${usdcAddress}`,
      sellAmountWei,
      slippageCap,
      chain
    );
  } catch (err: any) {
    const msg = err.response?.data?.errors?.[0]?.detail ?? err.message;
    throw new Error(`Sell quote failed: ${msg}`);
  }
}

export async function executeSwapTx(
  walletAddress: string,
  toTokenAddress: string,
  txData: any,
  wallet: import("ethers").Wallet
): Promise<string> {
  const tx = await wallet.sendTransaction({
    to: txData.to,
    data: txData.data,
    value: BigInt(txData.value ?? "0"),
    gasLimit: txData.gas ? BigInt(Math.floor(txData.gas * 1.2)) : undefined,
  });

  const receipt = await tx.wait(1, 3 * 60 * 1000);
  if (!receipt || receipt.status === 0) {
    throw new Error("Transaction reverted on chain");
  }
  return receipt.hash;
}
