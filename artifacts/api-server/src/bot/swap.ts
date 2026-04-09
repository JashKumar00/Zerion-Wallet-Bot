import { getWallet } from "./wallet.js";
import { getSwapQuote, executeSwapTx } from "./zerion.js";
import { runAllPolicies } from "./policies.js";
import prisma from "./db.js";
import type { DcaConfig, User } from "@prisma/client";
import { CHAINS } from "./chains.js";

export type SwapResult =
  | { success: true; txHash: string; tokenAmount: string; tokenSymbol: string; usdAmount: number }
  | { success: false; reason: string };

export async function executeDcaSwap(
  config: DcaConfig,
  user: User,
  chain: string = "base"
): Promise<SwapResult> {
  const chainCfg = CHAINS[chain] ?? CHAINS.base;
  const usdcAddress = chainCfg.usdcAddress;

  let quote;
  try {
    quote = await getSwapQuote(
      user.walletAddress,
      usdcAddress,
      config.tokenAddress,
      config.amountUsd,
      config.slippageCap,
      chain
    );
  } catch (err: any) {
    return { success: false, reason: `Quote error: ${err.message}` };
  }

  const policyResult = await runAllPolicies({
    userId: user.id,
    configId: config.id,
    amountUsd: config.amountUsd,
    dailyCapUsd: config.dailyCapUsd,
    slippageCap: config.slippageCap,
    expiresAt: config.expiresAt,
    slippageFromQuote: quote.slippage,
    walletAddress: user.walletAddress,
  });

  if (!policyResult.passed) {
    return { success: false, reason: policyResult.reason! };
  }

  let txHash: string;
  try {
    const wallet = getWallet(user.encryptedPrivateKey, chain);
    txHash = await executeSwapTx(
      user.walletAddress,
      config.tokenAddress,
      quote.txData,
      wallet
    );
  } catch (err: any) {
    return { success: false, reason: `Transaction failed: ${err.message}` };
  }

  return {
    success: true,
    txHash,
    tokenAmount: quote.toAmount,
    tokenSymbol: config.tokenSymbol,
    usdAmount: config.amountUsd,
  };
}
