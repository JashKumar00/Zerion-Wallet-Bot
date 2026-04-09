import axios from "axios";
import { Connection, VersionedTransaction, PublicKey } from "@solana/web3.js";
import type { Keypair } from "@solana/web3.js";
import { SOLANA_CHAIN } from "./chains.js";

const JUPITER_API_KEY = process.env.JUPITER_API_KEY ?? "";
const JUP_BASE = "https://api.jup.ag/swap/v1";
const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;

function jupHeaders() {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (JUPITER_API_KEY) h["x-api-key"] = JUPITER_API_KEY;
  return h;
}

export interface JupiterQuoteResult {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  quoteResponse: any;
}

export async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amountSmallestUnit: string,
  slippageBps = 100
): Promise<JupiterQuoteResult> {
  const res = await axios.get(`${JUP_BASE}/quote`, {
    headers: jupHeaders(),
    params: {
      inputMint,
      outputMint,
      amount: amountSmallestUnit,
      slippageBps,
      restrictIntermediateTokens: true,
    },
    timeout: 15000,
  });
  const q = res.data;
  if (!q || q.error) throw new Error(q?.error ?? "No quote from Jupiter");
  return {
    inputMint,
    outputMint,
    inAmount: q.inAmount,
    outAmount: q.outAmount,
    priceImpactPct: q.priceImpactPct ?? "0",
    quoteResponse: q,
  };
}

export async function executeJupiterSwap(
  keypair: Keypair,
  quoteResponse: any,
  priorityLevel: "low" | "medium" | "high" | "veryHigh" = "medium"
): Promise<string> {
  const swapRes = await axios.post(
    `${JUP_BASE}/swap`,
    {
      quoteResponse,
      userPublicKey: keypair.publicKey.toBase58(),
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel },
      },
    },
    { headers: jupHeaders(), timeout: 25000 }
  );

  const { swapTransaction } = swapRes.data;
  if (!swapTransaction) throw new Error("No swap transaction from Jupiter");

  const connection = new Connection(SOLANA_CHAIN.rpc, "confirmed");
  const txBuf = Buffer.from(swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: txid, ...latest }, "confirmed");
  return txid;
}

export async function getSolBalance(pubkey: string): Promise<number> {
  try {
    const connection = new Connection(SOLANA_CHAIN.rpc, "confirmed");
    const lamports = await connection.getBalance(new PublicKey(pubkey));
    return lamports / 1e9;
  } catch {
    return 0;
  }
}

export async function getSolanaTokenBalance(
  pubkey: string,
  mint: string
): Promise<number> {
  try {
    const connection = new Connection(SOLANA_CHAIN.rpc, "confirmed");
    const accounts = await connection.getParsedTokenAccountsByOwner(
      new PublicKey(pubkey),
      { mint: new PublicKey(mint) }
    );
    if (!accounts.value.length) return 0;
    return accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? 0;
  } catch {
    return 0;
  }
}

export async function getSolanaUsdcBalance(pubkey: string): Promise<number> {
  return getSolanaTokenBalance(pubkey, SOLANA_CHAIN.usdcMint);
}

export async function jupiterBuyToken(
  keypair: Keypair,
  outputMint: string,
  usdcAmountDecimal: number,
  slippageBps = 100
): Promise<{ txid: string; outAmount: string; priceImpact: string }> {
  const amountSmallest = Math.floor(usdcAmountDecimal * 10 ** USDC_DECIMALS).toString();
  const quote = await getJupiterQuote(SOLANA_CHAIN.usdcMint, outputMint, amountSmallest, slippageBps);
  const txid = await executeJupiterSwap(keypair, quote.quoteResponse);
  return { txid, outAmount: quote.outAmount, priceImpact: quote.priceImpactPct };
}

export async function jupiterSellToken(
  keypair: Keypair,
  inputMint: string,
  inputDecimals: number,
  sellAmountDecimal: number,
  slippageBps = 100
): Promise<{ txid: string; outAmountUsdc: number; priceImpact: string }> {
  const amountSmallest = Math.floor(sellAmountDecimal * 10 ** inputDecimals).toString();
  const quote = await getJupiterQuote(inputMint, SOLANA_CHAIN.usdcMint, amountSmallest, slippageBps);
  const txid = await executeJupiterSwap(keypair, quote.quoteResponse);
  const outAmountUsdc = parseInt(quote.outAmount) / 10 ** USDC_DECIMALS;
  return { txid, outAmountUsdc, priceImpact: quote.priceImpactPct };
}

export function solTokenId(mint: string) {
  return `solana:${mint}`;
}

export { SOL_DECIMALS, USDC_DECIMALS };
