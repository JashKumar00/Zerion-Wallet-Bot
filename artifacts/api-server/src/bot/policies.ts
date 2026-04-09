import prisma from "./db.js";
import { getUsdcBalance } from "./zerion.js";

export interface PolicyResult {
  passed: boolean;
  reason?: string;
}

export interface PolicyContext {
  userId: string;
  configId: string;
  amountUsd: number;
  dailyCapUsd: number;
  slippageCap: number;
  expiresAt: Date;
  slippageFromQuote: number;
  walletAddress: string;
  currentPrice?: number;
  maxBuyPrice?: number | null;
  stopLossPrice?: number | null;
}

export async function runAllPolicies(ctx: PolicyContext): Promise<PolicyResult> {
  const now = new Date();

  if (now > ctx.expiresAt) {
    return { passed: false, reason: "DCA config has expired" };
  }

  if (ctx.maxBuyPrice != null && ctx.currentPrice != null && ctx.currentPrice > ctx.maxBuyPrice) {
    return {
      passed: false,
      reason: `Price $${ctx.currentPrice.toFixed(4)} above max buy price $${ctx.maxBuyPrice.toFixed(4)} — skipping`,
    };
  }

  if (ctx.stopLossPrice != null && ctx.currentPrice != null && ctx.currentPrice < ctx.stopLossPrice) {
    await prisma.dcaConfig.update({ where: { id: ctx.configId }, data: { isPaused: true } });
    return {
      passed: false,
      reason: `Price $${ctx.currentPrice.toFixed(4)} hit stop-loss $${ctx.stopLossPrice.toFixed(4)} — DCA paused`,
    };
  }

  const usdcBal = await getUsdcBalance(ctx.walletAddress);
  if (usdcBal < ctx.amountUsd * 0.995) {
    return {
      passed: false,
      reason: `Insufficient USDC: have $${usdcBal.toFixed(2)}, need $${ctx.amountUsd.toFixed(2)}`,
    };
  }

  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const recentSpend = await prisma.transaction.aggregate({
    where: { userId: ctx.userId, status: "success", executedAt: { gte: dayAgo } },
    _sum: { usdAmount: true },
  });
  const totalSpent24h = recentSpend._sum.usdAmount ?? 0;
  if (totalSpent24h + ctx.amountUsd > ctx.dailyCapUsd) {
    return {
      passed: false,
      reason: `Daily cap hit: spent $${totalSpent24h.toFixed(2)} in 24h (cap: $${ctx.dailyCapUsd.toFixed(2)})`,
    };
  }

  if (ctx.slippageFromQuote > ctx.slippageCap) {
    return {
      passed: false,
      reason: `Slippage ${ctx.slippageFromQuote.toFixed(2)}% exceeds cap ${ctx.slippageCap.toFixed(2)}%`,
    };
  }

  return { passed: true };
}
