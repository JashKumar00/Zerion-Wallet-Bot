import cron from "node-cron";
import prisma from "./db.js";
import { executeDcaSwap } from "./swap.js";
import { getTokenInfo, getSwapQuote, executeSwapTx } from "./zerion.js";
import { getWallet } from "./wallet.js";
import { CHAINS } from "./chains.js";
import { logger } from "../lib/logger.js";

const CHAIN_EXPLORERS: Record<string, string> = {
  base: "https://basescan.org/tx/",
  arbitrum: "https://arbiscan.io/tx/",
  optimism: "https://optimistic.etherscan.io/tx/",
  polygon: "https://polygonscan.com/tx/",
  "binance-smart-chain": "https://bscscan.com/tx/",
  solana: "https://solscan.io/tx/",
};

function getNextRunAt(interval: string, from: Date = new Date()): Date {
  const next = new Date(from);
  switch (interval) {
    case "hourly": next.setHours(next.getHours() + 1); break;
    case "weekly": next.setDate(next.getDate() + 7); break;
    default: next.setDate(next.getDate() + 1);
  }
  return next;
}


export function startScheduler(
  sendTelegramMessage: (chatId: string, text: string) => Promise<void>
) {
  cron.schedule("* * * * *", async () => {
    const now = new Date();

    // ── DCA LOOP ──────────────────────────────────────────────────────────
    let configs;
    try {
      configs = await prisma.dcaConfig.findMany({
        where: { isActive: true, isPaused: false, nextRunAt: { lte: now } },
        include: { user: true },
      });
    } catch (err: any) {
      logger.error({ err }, "Scheduler: failed to fetch DCA configs");
      return;
    }

    for (const config of configs) {
      const user = config.user;

      if (now > config.expiresAt) {
        try {
          await prisma.dcaConfig.update({ where: { id: config.id }, data: { isActive: false } });
          await sendTelegramMessage(user.telegramId, `⏰ DCA for <b>${config.tokenSymbol}</b> has expired and been deactivated.`);
        } catch (err: any) { logger.error({ err }, "Scheduler: deactivate expired"); }
        continue;
      }

      const chain: string = (config as any).chain ?? "base";
      const result = await executeDcaSwap(config, user, chain);
      const nextRun = getNextRunAt(config.interval);

      const chainExplorers: Record<string, string> = {
        base: "https://basescan.org/tx/",
        arbitrum: "https://arbiscan.io/tx/",
        optimism: "https://optimistic.etherscan.io/tx/",
        polygon: "https://polygonscan.com/tx/",
        "binance-smart-chain": "https://bscscan.com/tx/",
        solana: "https://solscan.io/tx/",
      };
      const explorerBase = chainExplorers[chain] ?? "https://basescan.org/tx/";

      if (result.success) {
        try {
          await prisma.$transaction([
            prisma.transaction.create({
              data: {
                userId: user.id, dcaConfigId: config.id,
                tokenSymbol: result.tokenSymbol, tokenAmount: result.tokenAmount,
                usdAmount: result.usdAmount, txHash: result.txHash, status: "success",
              },
            }),
            prisma.dcaConfig.update({
              where: { id: config.id },
              data: { totalSpentUsd: { increment: result.usdAmount }, nextRunAt: nextRun },
            }),
          ]);
          await sendTelegramMessage(
            user.telegramId,
            `✅ <b>DCA Executed</b>\n\nBought <b>${result.tokenAmount} ${result.tokenSymbol}</b> for <b>$${result.usdAmount.toFixed(2)}</b>\n🔗 <a href="${explorerBase}${result.txHash}">View Transaction</a>`
          );
        } catch (err: any) { logger.error({ err }, "Scheduler: record success"); }
      } else {
        try {
          const status = result.reason?.match(/cap|balance|slippage|expire|stop-loss|price/i) ? "skipped" : "failed";
          await prisma.$transaction([
            prisma.transaction.create({
              data: {
                userId: user.id, dcaConfigId: config.id,
                tokenSymbol: config.tokenSymbol, tokenAmount: "0",
                usdAmount: 0, txHash: "", status, skipReason: result.reason,
              },
            }),
            prisma.dcaConfig.update({ where: { id: config.id }, data: { nextRunAt: nextRun } }),
          ]);
          await sendTelegramMessage(user.telegramId, `⚠️ DCA skipped for <b>${config.tokenSymbol}</b>: ${result.reason}`);
        } catch (err: any) { logger.error({ err }, "Scheduler: record skip"); }
      }
    }

    // ── PRICE ALERTS ──────────────────────────────────────────────────────
    let alerts;
    try {
      alerts = await prisma.priceAlert.findMany({
        where: { isActive: true, isTriggered: false },
        include: { user: true },
      });
    } catch (err: any) { logger.error({ err }, "Scheduler: fetch alerts"); return; }

    for (const alert of alerts) {
      try {
        const info = await getTokenInfo(alert.tokenSymbol);
        if (!info) continue;
        const price = info.price;
        const triggered =
          (alert.direction === "above" && price >= alert.targetPrice) ||
          (alert.direction === "below" && price <= alert.targetPrice);
        if (!triggered) continue;

        await prisma.priceAlert.update({ where: { id: alert.id }, data: { isTriggered: true, isActive: false } });
        const icon = alert.direction === "above" ? "📈" : "📉";
        await sendTelegramMessage(
          alert.user.telegramId,
          `${icon} <b>Price Alert Triggered!</b>\n\n<b>${alert.tokenSymbol}</b> is now <b>$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}</b>\n(Target: ${alert.direction} $${alert.targetPrice})`
        );
      } catch (err: any) { logger.error({ err, alertId: alert.id }, "Scheduler: alert check"); }
    }

    // ── LIMIT ORDERS ──────────────────────────────────────────────────────
    let orders;
    try {
      orders = await prisma.limitOrder.findMany({
        where: { isActive: true, isFilled: false },
        include: { user: true },
      });
    } catch (err: any) { logger.error({ err }, "Scheduler: fetch limit orders"); return; }

    for (const order of orders) {
      try {
        const info = await getTokenInfo(order.tokenSymbol);
        if (!info) continue;
        const price = info.price;
        const shouldFill =
          (order.direction === "below" && price <= order.targetPrice) ||
          (order.direction === "above" && price >= order.targetPrice);
        if (!shouldFill) continue;

        const orderChain: string = (order as any).chain ?? "base";
        const chainCfg = CHAINS[orderChain] ?? CHAINS.base;
        const explorerBase = CHAIN_EXPLORERS[orderChain] ?? "https://basescan.org/tx/";

        const quote = await getSwapQuote(
          order.user.walletAddress, chainCfg.usdcAddress, order.tokenAddress,
          order.amountUsd, order.slippageCap, orderChain
        );
        const wallet = getWallet(order.user.encryptedPrivateKey, orderChain);
        const txHash = await executeSwapTx(order.user.walletAddress, order.tokenAddress, quote.txData, wallet);

        await prisma.limitOrder.update({
          where: { id: order.id },
          data: { isFilled: true, isActive: false, txHash, filledAt: new Date() },
        });

        await sendTelegramMessage(
          order.user.telegramId,
          `🎯 <b>Limit Order Filled!</b>\n\nBought <b>${quote.toAmount} ${order.tokenSymbol}</b> at <b>$${price.toFixed(4)}</b> for <b>$${order.amountUsd}</b>\n🔗 <a href="${explorerBase}${txHash}">View Transaction</a>`
        );
      } catch (err: any) {
        logger.error({ err, orderId: order.id }, "Scheduler: limit order fill");
        try {
          await prisma.limitOrder.update({ where: { id: order.id }, data: { isActive: false } });
          await sendTelegramMessage(order.user.telegramId, `❌ Limit order for <b>${order.tokenSymbol}</b> failed: ${err.message}`);
        } catch { /* ignore */ }
      }
    }
  });

  logger.info("DCA scheduler started");
}
