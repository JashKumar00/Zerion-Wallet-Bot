import { Telegraf, Markup } from "telegraf";
import type { Context } from "telegraf";
import prisma from "./db.js";
import { generateWallet, encryptPrivateKey, decryptPrivateKey, getWallet, generateSolanaWallet, encryptSolanaKey, decryptSolanaKey, getSolanaKeypair } from "./wallet.js";
import {
  getPortfolio, getTokenInfo, getTokenDetail, getTokenDetailByAddress, getTrendingTokens,
  getUsdcBalance, getSellQuote, getSwapQuote, executeSwapTx,
  getTokenInfoByAddress, searchTokenByName, getSolanaPortfolio,
} from "./zerion.js";
import { CHAINS, SOLANA_CHAIN, getChainLabel } from "./chains.js";
import {
  jupiterBuyToken, jupiterSellToken, getSolBalance, getSolanaUsdcBalance,
  getJupiterQuote, executeJupiterSwap,
} from "./jupiter.js";
import { startScheduler } from "./scheduler.js";
import { logger } from "../lib/logger.js";
import { ethers } from "ethers";

// ─── Constants ────────────────────────────────────────────────────────────────

const BOT_NAME = "@Zerion_DCA_bot";

const SUPPORTED_TOKENS: Record<string, { address: string; decimals: number }> = {
  ETH:   { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  WBTC:  { address: "0x1ceA84203673764244E05693e42E6Ace62bE9BA5", decimals: 8 },
  CBETH: { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18 },
  DAI:   { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
  USDC:  { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
};

const DCA_TOKENS = Object.keys(SUPPORTED_TOKENS).filter(t => t !== "USDC");

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const GAS_PRIORITY_LABELS: Record<string, string> = {
  slow: "🐢 Slow (0.5 gwei)",
  standard: "⚡ Standard (1.5 gwei)",
  fast: "🚀 Fast (3 gwei)",
  ultra: "🔥 Ultra (10 gwei)",
};

// ─── Rate Limiting ────────────────────────────────────────────────────────────

const RATE_LIMIT = new Map<string, { count: number; resetAt: number }>();
function rl(id: string): boolean {
  const now = Date.now();
  const e = RATE_LIMIT.get(id);
  if (!e || now > e.resetAt) { RATE_LIMIT.set(id, { count: 1, resetAt: now + 60_000 }); return true; }
  if (e.count >= 15) return false;
  e.count++; return true;
}

// ─── Conversation State ───────────────────────────────────────────────────────

type ConversationStep =
  | "IMPORT_KEY" | "IMPORT_SOL_KEY"
  | "SETUP_AMOUNT" | "SETUP_INTERVAL" | "SETUP_MAX_PRICE" | "SETUP_STOP_LOSS" | "SETUP_TP"
  | "WITHDRAW_AMOUNT" | "WITHDRAW_ADDRESS" | "WITHDRAW_CONFIRM"
  | "PRICE_TOKEN"
  | "SET_ALERT_PRICE"
  | "SET_LIMIT_AMOUNT" | "SET_LIMIT_PRICE"
  | "BUY_CUSTOM_AMOUNT"
  | "SELL_CUSTOM_AMOUNT"
  | "TOKEN_SEARCH";

interface ConvState { step: ConversationStep; data: Record<string, unknown> }
const convState = new Map<string, ConvState>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function short(addr: string) { return `${addr.slice(0, 6)}...${addr.slice(-4)}`; }
function fmt(n: number, d = 2) { return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: Math.max(d, 6) }); }

function genReferralCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function nextRun(interval: string): Date {
  const d = new Date();
  if (interval === "hourly") d.setHours(d.getHours() + 1);
  else if (interval === "weekly") d.setDate(d.getDate() + 7);
  else d.setDate(d.getDate() + 1);
  return d;
}

async function requireUser(ctx: Context) {
  const telegramId = String(ctx.from?.id ?? "");
  return prisma.user.findUnique({ where: { telegramId } });
}

// ─── Keyboards ───────────────────────────────────────────────────────────────

function homeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🟢 Buy", "buy_search"),          Markup.button.callback("🔴 Sell", "sell_search")],
    [Markup.button.callback("⚡ New DCA", "new_dca"),         Markup.button.callback("📊 My DCAs", "my_status")],
    [Markup.button.callback("🎯 Limit Order", "limit_order"), Markup.button.callback("🔔 Alerts", "alerts_menu")],
    [Markup.button.callback("🔥 Trending", "trending"),       Markup.button.callback("📈 Portfolio", "portfolio")],
    [Markup.button.callback("💵 Deposit", "deposit"),         Markup.button.callback("💼 Wallet", "wallet_menu")],
    [Markup.button.callback("📜 History", "history"),         Markup.button.callback("👥 Referrals", "referrals")],
    [Markup.button.callback("⚙️ Settings", "settings"),      Markup.button.callback("🔄 Refresh", "refresh")],
  ]);
}

function walletKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📥 Import EVM Key", "import_evm_wallet"), Markup.button.callback("📥 Import Solana Key", "import_sol_wallet")],
    [Markup.button.callback("📤 Export EVM Key", "export_key"),        Markup.button.callback("📤 Export SOL Key", "export_sol_key")],
    [Markup.button.callback("💵 Deposit EVM",   "deposit"),            Markup.button.callback("💵 Deposit Solana",  "deposit_solana")],
    [Markup.button.callback("💸 Withdraw EVM",  "withdraw")],
    [Markup.button.callback("🔙 Back to Home", "home")],
  ]);
}

function backKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("🔙 Back to Home", "home")]]);
}

function tokenKeyboard(prefix: string, includeUsdc = false, backAction = "home") {
  const tokens = includeUsdc ? Object.keys(SUPPORTED_TOKENS) : DCA_TOKENS;
  const rows = [];
  for (let i = 0; i < tokens.length; i += 2) {
    rows.push(tokens.slice(i, i + 2).map(t => Markup.button.callback(t, `${prefix}:${t}`)));
  }
  rows.push([Markup.button.callback("🔙 Back", backAction)]);
  return Markup.inlineKeyboard(rows);
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

async function getDashboardText(user: {
  id: string; walletAddress: string; referralCode: string | null;
  solanaPubkey?: string | null;
}) {
  // ── EVM wallet data (Base as default display chain) ──
  let evmUsdcBal = 0, evmTotal = 0, evmPosLines = "";
  try {
    const positions = await getPortfolio(user.walletAddress, "base");
    const usdc = positions.find(p => ["USDC","USDbC","USDC.e"].includes(p.symbol));
    evmUsdcBal = usdc?.valueUsd ?? 0;
    const others = positions.filter(p => !["USDC","USDbC","USDC.e"].includes(p.symbol) && p.valueUsd > 0.01);
    evmTotal = others.reduce((s, p) => s + p.valueUsd, 0) + evmUsdcBal;
    if (others.length) evmPosLines = "\n" + others.slice(0, 4).map(p => `    • ${p.symbol}: ${p.amount} ≈$${p.valueUsd.toFixed(2)}`).join("\n");
  } catch { /* offline */ }

  // ── Solana wallet data ──
  let solBal = 0, solUsdcBal = 0, solTotal = 0, solPosLines = "";
  if (user.solanaPubkey) {
    try {
      const [sb, ub, positions] = await Promise.all([
        getSolBalance(user.solanaPubkey),
        getSolanaUsdcBalance(user.solanaPubkey),
        getSolanaPortfolio(user.solanaPubkey),
      ]);
      solBal = sb; solUsdcBal = ub;
      const others = positions.filter(p => p.symbol !== "USDC" && p.valueUsd > 0.01);
      solTotal = others.reduce((s, p) => s + p.valueUsd, 0) + solUsdcBal;
      if (solBal > 0) solPosLines += `\n    • SOL: ${solBal.toFixed(4)}`;
      if (others.length) solPosLines += "\n" + others.slice(0, 4).map(p => `    • ${p.symbol}: ${p.amount} ≈$${p.valueUsd.toFixed(2)}`).join("\n");
    } catch { /* offline */ }
  }

  const [activeCount, pausedCount, spendAgg, activeAlerts, activeOrders] = await Promise.all([
    prisma.dcaConfig.count({ where: { userId: user.id, isActive: true, isPaused: false } }),
    prisma.dcaConfig.count({ where: { userId: user.id, isActive: true, isPaused: true } }),
    prisma.dcaConfig.aggregate({ where: { userId: user.id }, _sum: { totalSpentUsd: true } }),
    prisma.priceAlert.count({ where: { userId: user.id, isActive: true } }),
    prisma.limitOrder.count({ where: { userId: user.id, isActive: true, isFilled: false } }),
  ]);
  const totalSpent = spendAgg._sum.totalSpentUsd ?? 0;

  return (
    `🤖 <b>Zerion DCA Bot</b>\n` +
    `<i>Chain auto-detected per token · EVM + Solana</i>\n` +
    `${"━".repeat(28)}\n\n` +

    `🔵 <b>MultiChain Wallet</b>  <i>(Base · Arb · OP · Poly · BSC)</i>\n` +
    `<code>${user.walletAddress}</code>\n` +
    `💵 USDC: <b>$${fmt(evmUsdcBal)}</b>` +
    (evmTotal > evmUsdcBal ? `  |  Total: <b>$${fmt(evmTotal)}</b>` : "") +
    `${evmPosLines}\n\n` +

    `🟢 <b>Solana Wallet</b>\n` +
    (user.solanaPubkey
      ? `<code>${user.solanaPubkey}</code>\n` +
        `💵 USDC: <b>$${fmt(solUsdcBal)}</b>` +
        (solTotal > solUsdcBal ? `  |  Total: <b>$${fmt(solTotal)}</b>` : "") +
        `${solPosLines}`
      : `<i>No Solana wallet — send /start to generate one</i>`) +
    `\n\n` +
    `${"━".repeat(28)}\n` +
    `⚡ DCAs: <b>${activeCount} active</b>${pausedCount > 0 ? ` · ${pausedCount} paused` : ""}\n` +
    `🎯 Limit Orders: <b>${activeOrders}</b>  |  🔔 Alerts: <b>${activeAlerts}</b>\n` +
    `💰 DCA Spend: <b>$${fmt(totalSpent)}</b>\n` +
    `${"━".repeat(28)}\n` +
    `👥 Referral: <code>${user.referralCode ?? "—"}</code>  |  ` +
    `<a href="https://t.me/${BOT_NAME.replace("@", "")}?start=${user.referralCode ?? ""}">Invite Link</a>`
  );
}

async function showDashboard(ctx: Context, mode: "send" | "edit" = "send") {
  const telegramId = String(ctx.from?.id ?? "");
  try {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) { await ctx.reply("Please send /start to begin."); return; }
    const text = await getDashboardText(user);
    const kb = homeKeyboard();
    if (mode === "edit" && "callbackQuery" in ctx && ctx.callbackQuery) {
      try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb.reply_markup }); }
      catch { await ctx.reply(text, { parse_mode: "HTML", ...kb }); }
    } else {
      await ctx.reply(text, { parse_mode: "HTML", ...kb });
    }
  } catch (err: any) { logger.error({ err }, "showDashboard"); }
}

// ─── Bot factory ─────────────────────────────────────────────────────────────

export function createBot(): Telegraf {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const bot = new Telegraf(token);

  const tgSend = async (chatId: string, text: string) => {
    try { await bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML" }); }
    catch (err: any) { logger.error({ err }, "tgSend error"); }
  };

  // Rate-limit middleware
  bot.use(async (ctx, next) => {
    const id = String(ctx.from?.id ?? "");
    if (id && !rl(id)) { await ctx.reply("⚠️ Slow down! Too many requests."); return; }
    await next();
  });

  // ─── /start ─────────────────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    const telegramId = String(ctx.from.id);
    const telegramUsername = ctx.from.username ?? null;
    const payload = ctx.message.text.split(" ")[1] ?? null; // referral code

    let user = await prisma.user.findUnique({ where: { telegramId } });

    if (!user) {
      const { address, privateKey } = generateWallet();
      let referralCode = genReferralCode();
      let attempts = 0;
      while (await prisma.user.findUnique({ where: { referralCode } }) && attempts++ < 5) {
        referralCode = genReferralCode();
      }

      // Check referral code validity
      let referredBy: string | null = null;
      if (payload && payload.length === 6) {
        const referrer = await prisma.user.findUnique({ where: { referralCode: payload } });
        if (referrer && referrer.telegramId !== telegramId) referredBy = payload;
      }

      const sol = generateSolanaWallet();
      user = await prisma.user.create({
        data: {
          telegramId, telegramUsername, walletAddress: address,
          encryptedPrivateKey: encryptPrivateKey(privateKey),
          referralCode, referredBy,
          solanaPubkey: sol.pubkey,
          encryptedSolanaKey: encryptSolanaKey(sol.secretKeyBase58),
        },
      });

      const refMsg = referredBy ? `\n\n👥 Referred by a friend — thanks for joining!` : "";
      await ctx.reply(
        `👋 <b>Welcome to Zerion DCA Bot!</b>\n\n` +
        `🔵 <b>EVM Wallet (Base/Arbitrum/Optimism/Polygon/BSC):</b>\n<code>${address}</code>\n\n` +
        `🟢 <b>Solana Wallet:</b>\n<code>${sol.pubkey}</code>\n\n` +
        `⚠️ <b>Fund with USDC before running DCA.</b>\n` +
        `• Base bridge: https://bridge.base.org\n` +
        `• Switch chain with the ⛓ button in the main menu${refMsg}`,
        { parse_mode: "HTML" }
      );
    } else if (!user.referralCode) {
      let referralCode = genReferralCode();
      let attempts = 0;
      while (await prisma.user.findUnique({ where: { referralCode } }) && attempts++ < 5) referralCode = genReferralCode();
      user = await prisma.user.update({ where: { telegramId }, data: { referralCode } });
    }

    // Backfill Solana wallet for existing users who don't have one
    if (!user.solanaPubkey) {
      const sol = generateSolanaWallet();
      user = await prisma.user.update({
        where: { telegramId },
        data: { solanaPubkey: sol.pubkey, encryptedSolanaKey: encryptSolanaKey(sol.secretKeyBase58) },
      });
      await ctx.reply(
        `🟢 <b>Solana Wallet Generated!</b>\n\n<code>${sol.pubkey}</code>\n\nYou can now switch to Solana using the ⛓ Chain button.`,
        { parse_mode: "HTML" }
      );
    }

    await showDashboard(ctx, "send");
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `🤖 <b>Zerion DCA Bot — Help</b>\n\n` +
      `<b>⚡ New DCA</b> — Set up a recurring automated buy\n` +
      `<b>📊 My DCAs</b> — View and manage active DCA configs\n` +
      `<b>🎯 Limit Order</b> — One-time buy when price hits a target\n` +
      `<b>🔔 Alerts</b> — Price alerts (above/below)\n` +
      `<b>🔥 Trending</b> — Top tokens by market cap on Base\n` +
      `<b>📈 Portfolio</b> — P&amp;L vs DCA cost basis\n` +
      `<b>💵 Deposit</b> — Show your wallet address\n` +
      `<b>💼 Wallet</b> — Import/export/withdraw\n` +
      `<b>📜 History</b> — Last 20 transactions\n` +
      `<b>👥 Referrals</b> — Invite friends\n` +
      `<b>⚙️ Settings</b> — Gas priority and preferences\n\n` +
      `Type /cancel to abort any action.\nType /start to return home.`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  });

  bot.command("cancel", async (ctx) => {
    convState.delete(String(ctx.from.id));
    await ctx.reply("✅ Cancelled.", backKeyboard());
  });

  // ─── ADMIN CHECK ───────────────────────────────────────────────────────
  const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID ?? "";

  function isAdmin(ctx: Context): boolean {
    return ADMIN_ID !== "" && String(ctx.from?.id ?? "") === ADMIN_ID;
  }

  // ─── /admin COMMAND ────────────────────────────────────────────────────
  bot.command("admin", async (ctx) => {
    if (!isAdmin(ctx)) {
      if (!ADMIN_ID) {
        await ctx.reply(
          `⚙️ <b>Admin Setup</b>\n\nNo admin configured yet.\n\n` +
          `Set the <code>ADMIN_TELEGRAM_ID</code> secret to <code>${ctx.from.id}</code> to enable the admin panel.`,
          { parse_mode: "HTML" }
        );
      } else {
        await ctx.reply("❌ Not authorised.");
      }
      return;
    }
    await sendAdminDashboard(ctx, "send");
  });

  bot.action("admin_home", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) { await ctx.reply("❌ Not authorised."); return; }
    await sendAdminDashboard(ctx, "edit");
  });

  async function sendAdminDashboard(ctx: Context, mode: "send" | "edit") {
    const now = new Date();
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);

    const [
      totalUsers, newToday, newWeek,
      totalDca, activeDca, pausedDca,
      totalAlerts, activeAlerts,
      totalOrders, activeOrders,
      totalTx, successTx, skippedTx, failedTx,
      txToday, txWeek,
      volAll, volToday, volWeek,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: today } } }),
      prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.dcaConfig.count(),
      prisma.dcaConfig.count({ where: { isActive: true, isPaused: false } }),
      prisma.dcaConfig.count({ where: { isActive: true, isPaused: true } }),
      prisma.priceAlert.count(),
      prisma.priceAlert.count({ where: { isActive: true, isTriggered: false } }),
      prisma.limitOrder.count(),
      prisma.limitOrder.count({ where: { isActive: true, isFilled: false } }),
      prisma.transaction.count(),
      prisma.transaction.count({ where: { status: "success" } }),
      prisma.transaction.count({ where: { status: "skipped" } }),
      prisma.transaction.count({ where: { status: "failed" } }),
      prisma.transaction.count({ where: { executedAt: { gte: today } } }),
      prisma.transaction.count({ where: { executedAt: { gte: weekAgo } } }),
      prisma.transaction.aggregate({ where: { status: "success" }, _sum: { usdAmount: true } }),
      prisma.transaction.aggregate({ where: { status: "success", executedAt: { gte: today } }, _sum: { usdAmount: true } }),
      prisma.transaction.aggregate({ where: { status: "success", executedAt: { gte: weekAgo } }, _sum: { usdAmount: true } }),
    ]);

    const successRate = totalTx > 0 ? ((successTx / totalTx) * 100).toFixed(1) : "0";
    const text =
      `🛠 <b>Admin Dashboard</b>\n` +
      `<i>${now.toUTCString().slice(0, 25)}</i>\n` +
      `${"─".repeat(28)}\n` +
      `👥 <b>Users</b>\n` +
      `  Total: <b>${totalUsers}</b>  |  Today: <b>+${newToday}</b>  |  7d: <b>+${newWeek}</b>\n\n` +
      `⚡ <b>DCA Configs</b>\n` +
      `  Total: <b>${totalDca}</b>  |  Active: <b>${activeDca}</b>  |  Paused: <b>${pausedDca}</b>\n\n` +
      `🎯 <b>Limit Orders</b>: Total <b>${totalOrders}</b>  |  Active: <b>${activeOrders}</b>\n` +
      `🔔 <b>Price Alerts</b>: Total <b>${totalAlerts}</b>  |  Active: <b>${activeAlerts}</b>\n` +
      `${"─".repeat(28)}\n` +
      `📊 <b>Transactions</b>\n` +
      `  Total: <b>${totalTx}</b>  |  Today: <b>${txToday}</b>  |  7d: <b>${txWeek}</b>\n` +
      `  ✅ Success: <b>${successTx}</b>  ⏭ Skipped: <b>${skippedTx}</b>  ❌ Failed: <b>${failedTx}</b>\n` +
      `  Success rate: <b>${successRate}%</b>\n\n` +
      `💰 <b>Volume Swapped (DCA)</b>\n` +
      `  All-time: <b>$${fmt(volAll._sum.usdAmount ?? 0)}</b>\n` +
      `  Today: <b>$${fmt(volToday._sum.usdAmount ?? 0)}</b>\n` +
      `  7d: <b>$${fmt(volWeek._sum.usdAmount ?? 0)}</b>`;

    const importedCount = await prisma.user.count({ where: { walletImported: true } });
    const importedToday = await prisma.user.count({ where: { walletImported: true, walletImportedAt: { gte: today } } });

    const importLine = `📥 <b>Imported Wallets</b>: Total <b>${importedCount}</b>  |  Today: <b>+${importedToday}</b>`;

    const fullText = text + "\n" + importLine;

    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("👥 Users", "admin_users"),       Markup.button.callback("📊 Transactions", "admin_txs")],
      [Markup.button.callback("🔥 Top Tokens", "admin_tokens"), Markup.button.callback("⚡ Top DCAs", "admin_dcas")],
      [Markup.button.callback("📥 Imported Wallets", "admin_imports")],
      [Markup.button.callback("🔄 Refresh", "admin_home")],
    ]);

    try {
      if (mode === "edit") await ctx.editMessageText(fullText, { parse_mode: "HTML", reply_markup: kb.reply_markup });
      else await ctx.reply(fullText, { parse_mode: "HTML", ...kb });
    } catch { await ctx.reply(fullText, { parse_mode: "HTML", ...kb }); }
  }

  bot.action("admin_imports", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return;

    const imports = await prisma.user.findMany({
      where: { walletImported: true },
      orderBy: { walletImportedAt: "desc" },
      take: 25,
      select: {
        telegramId: true,
        telegramUsername: true,
        walletAddress: true,
        walletImportedAt: true,
        createdAt: true,
      },
    });

    if (imports.length === 0) {
      const kb = Markup.inlineKeyboard([[Markup.button.callback("🔙 Back", "admin_home")]]);
      try { await ctx.editMessageText("📥 <b>Imported Wallets</b>\n\nNo wallets imported yet.", { parse_mode: "HTML", reply_markup: kb.reply_markup }); }
      catch { await ctx.reply("📥 <b>Imported Wallets</b>\n\nNo wallets imported yet.", { parse_mode: "HTML", ...kb }); }
      return;
    }

    const lines = imports.map((u, i) => {
      const name = u.telegramUsername ? `@${u.telegramUsername}` : `id:${u.telegramId}`;
      const when = u.walletImportedAt
        ? u.walletImportedAt.toUTCString().slice(4, 22)
        : u.createdAt.toUTCString().slice(4, 22);
      return `${i + 1}. ${name}\n   📋 <code>${short(u.walletAddress)}</code>\n   🕐 ${when}`;
    });

    const text =
      `📥 <b>Imported Wallets (${imports.length})</b>\n` +
      `${"─".repeat(28)}\n` +
      lines.join("\n\n");

    const kb = Markup.inlineKeyboard([[Markup.button.callback("🔙 Back", "admin_home")]]);
    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb.reply_markup }); }
    catch { await ctx.reply(text, { parse_mode: "HTML", ...kb }); }
  });

  bot.action("admin_users", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return;

    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const recentUsers = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      take: 15,
      select: { telegramId: true, telegramUsername: true, walletAddress: true, createdAt: true, referralCode: true, referredBy: true, gasPriority: true },
    });

    // Users who had a tx in last 7 days
    const activeUserIds = await prisma.transaction.findMany({
      where: { executedAt: { gte: weekAgo }, status: "success" },
      select: { userId: true },
      distinct: ["userId"],
    });

    const lines = recentUsers.map(u => {
      const name = u.telegramUsername ? `@${u.telegramUsername}` : `id:${u.telegramId}`;
      const joined = u.createdAt.toDateString().slice(4, 10);
      const ref = u.referredBy ? ` | ref: ${u.referredBy}` : "";
      return `• ${name} — <code>${short(u.walletAddress)}</code> [${joined}]${ref}`;
    });

    const text =
      `👥 <b>Recent Users (last 15)</b>\n` +
      `Active this week: <b>${activeUserIds.length}</b>\n` +
      `${"─".repeat(28)}\n` +
      lines.join("\n");

    const kb = Markup.inlineKeyboard([[Markup.button.callback("🔙 Back", "admin_home")]]);
    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb.reply_markup }); }
    catch { await ctx.reply(text, { parse_mode: "HTML", ...kb }); }
  });

  bot.action("admin_txs", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return;

    const recentTxs = await prisma.transaction.findMany({
      orderBy: { executedAt: "desc" },
      take: 15,
      include: { user: { select: { telegramUsername: true, telegramId: true } } },
    });

    const lines = recentTxs.map(tx => {
      const icon = tx.status === "success" ? "✅" : tx.status === "skipped" ? "⏭" : "❌";
      const name = tx.user.telegramUsername ? `@${tx.user.telegramUsername}` : `id:${tx.user.telegramId}`;
      const time = tx.executedAt.toUTCString().slice(4, 16);
      let line = `${icon} ${time} | ${name} | ${tx.tokenSymbol} | $${fmt(tx.usdAmount)}`;
      if (tx.status === "success" && tx.txHash) line += `\n   <a href="https://basescan.org/tx/${tx.txHash}">tx ↗</a>`;
      else if (tx.skipReason) line += `\n   ⚠️ ${tx.skipReason.slice(0, 60)}`;
      return line;
    });

    const text = `📊 <b>Recent Transactions (last 15)</b>\n${"─".repeat(28)}\n${lines.join("\n\n")}`;
    const kb = Markup.inlineKeyboard([[Markup.button.callback("🔙 Back", "admin_home")]]);
    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb.reply_markup }); }
    catch { await ctx.reply(text, { parse_mode: "HTML", ...kb }); }
  });

  bot.action("admin_tokens", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return;

    const tokenStats = await prisma.transaction.groupBy({
      by: ["tokenSymbol"],
      where: { status: "success" },
      _sum: { usdAmount: true },
      _count: { id: true },
      orderBy: { _sum: { usdAmount: "desc" } },
    });

    const lines = tokenStats.map((t, i) => {
      const vol = fmt(t._sum.usdAmount ?? 0);
      return `${i + 1}. <b>${t.tokenSymbol}</b> — $${vol} vol | ${t._count.id} buys`;
    });

    const text = `🔥 <b>Top Tokens by DCA Volume</b>\n${"─".repeat(28)}\n${lines.join("\n") || "No data yet."}`;
    const kb = Markup.inlineKeyboard([[Markup.button.callback("🔙 Back", "admin_home")]]);
    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb.reply_markup }); }
    catch { await ctx.reply(text, { parse_mode: "HTML", ...kb }); }
  });

  bot.action("admin_dcas", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return;

    const topDcas = await prisma.dcaConfig.findMany({
      where: { isActive: true },
      orderBy: { totalSpentUsd: "desc" },
      take: 10,
      include: { user: { select: { telegramUsername: true, telegramId: true } } },
    });

    const lines = topDcas.map((c, i) => {
      const name = c.user.telegramUsername ? `@${c.user.telegramUsername}` : `id:${c.user.telegramId}`;
      const status = c.isPaused ? "⏸" : "▶️";
      return `${i + 1}. ${status} ${name} | <b>${c.tokenSymbol}</b> $${c.amountUsd}/${c.interval} | spent: $${fmt(c.totalSpentUsd)}`;
    });

    const text = `⚡ <b>Top Active DCAs (by spend)</b>\n${"─".repeat(28)}\n${lines.join("\n") || "No active configs."}`;
    const kb = Markup.inlineKeyboard([[Markup.button.callback("🔙 Back", "admin_home")]]);
    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb.reply_markup }); }
    catch { await ctx.reply(text, { parse_mode: "HTML", ...kb }); }
  });

  // ─── HOME / REFRESH ────────────────────────────────────────────────────
  bot.action("home", async (ctx) => { await ctx.answerCbQuery(); await showDashboard(ctx, "edit"); });
  bot.action("refresh", async (ctx) => { await ctx.answerCbQuery("🔄 Refreshing…"); await showDashboard(ctx, "edit"); });

  // Chain is now auto-detected per token — no manual selector needed.

  // ─── WALLET MENU ───────────────────────────────────────────────────────
  bot.action("wallet_menu", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireUser(ctx);
    if (!user) { await ctx.reply("Please /start first."); return; }

    let evmBal = 0, solUsdcBal = 0, solBal = 0;
    try { evmBal = await getUsdcBalance(user.walletAddress); } catch { /* offline */ }
    if (user.solanaPubkey) {
      try { [solUsdcBal, solBal] = await Promise.all([getSolanaUsdcBalance(user.solanaPubkey), getSolBalance(user.solanaPubkey)]); } catch { /* offline */ }
    }

    const text =
      `💼 <b>My Wallets</b>\n` +
      `${"━".repeat(28)}\n\n` +
      `🔵 <b>MultiChain Wallet</b>\n` +
      `<i>Base • Arbitrum • Optimism • Polygon • BSC</i>\n` +
      `<code>${user.walletAddress}</code>\n` +
      `💵 USDC: <b>$${fmt(evmBal)}</b>  |  ⛽ Gas: <b>${GAS_PRIORITY_LABELS[user.gasPriority ?? "standard"]}</b>\n\n` +
      `🟢 <b>Solana Wallet</b>\n` +
      (user.solanaPubkey
        ? `<code>${user.solanaPubkey}</code>\n` +
          `💵 USDC: <b>$${fmt(solUsdcBal)}</b>  |  SOL: <b>${solBal.toFixed(4)}</b>`
        : `<i>Not created yet — send /start</i>`) +
      `\n\n${"━".repeat(28)}\n` +
      `Import a key to replace a wallet.\nExport to back up your key.`;

    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: walletKeyboard().reply_markup }); }
    catch { await ctx.reply(text, { parse_mode: "HTML", ...walletKeyboard() }); }
  });

  // ─── DEPOSIT EVM ───────────────────────────────────────────────────────
  bot.action("deposit", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireUser(ctx);
    if (!user) return;
    const text =
      `📋 <b>Deposit — MultiChain (EVM)</b>\n\n` +
      `Send USDC or any token to your EVM wallet:\n\n<code>${user.walletAddress}</code>\n\n` +
      `✅ Works on: <b>Base · Arbitrum · Optimism · Polygon · BSC</b>\n\n` +
      `🌉 Bridge to Base: https://bridge.base.org\n` +
      `🏦 Buy on Coinbase: https://coinbase.com\n` +
      `🔄 Swap on Uniswap: https://app.uniswap.org`;
    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard([[Markup.button.callback("🔙 Back", "wallet_menu")]]).reply_markup }); }
    catch { await ctx.reply(text, { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Back", "wallet_menu")]])}); }
  });

  // ─── DEPOSIT SOLANA ────────────────────────────────────────────────────
  bot.action("deposit_solana", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireUser(ctx);
    if (!user) return;
    if (!user.solanaPubkey) {
      await ctx.reply("❌ No Solana wallet. Send /start to create one.");
      return;
    }
    const text =
      `📋 <b>Deposit — Solana Wallet</b>\n\n` +
      `Send USDC (SPL) or any Solana token to:\n\n<code>${user.solanaPubkey}</code>\n\n` +
      `✅ Works on: <b>Solana mainnet only</b>\n\n` +
      `🔄 Bridge from EVM: https://portal.allbridge.io\n` +
      `🔄 Wormhole bridge: https://wormhole.com\n` +
      `🏦 Buy SOL on FTX/Binance/Coinbase then transfer\n\n` +
      `⚠️ Only send Solana tokens to this address — EVM tokens will be lost.`;
    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard([[Markup.button.callback("🔙 Back", "wallet_menu")]]).reply_markup }); }
    catch { await ctx.reply(text, { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Back", "wallet_menu")]])}); }
  });

  // ─── IMPORT EVM WALLET ─────────────────────────────────────────────────
  bot.action("import_evm_wallet", async (ctx) => {
    await ctx.answerCbQuery();
    convState.set(String(ctx.from.id), { step: "IMPORT_KEY", data: {} });
    await ctx.reply(
      `📥 <b>Import EVM Wallet</b>\n\n` +
      `This will <b>replace</b> your MultiChain (EVM) wallet.\n\n` +
      `Paste your EVM <b>private key</b>:\n` +
      `• With prefix: <code>0x1234…abcd</code>\n` +
      `• Without prefix: <code>1234…abcd</code> (64 hex chars)\n\n` +
      `🔒 Your message is <b>deleted immediately</b> for security.\n` +
      `/cancel to abort.`,
      { parse_mode: "HTML" }
    );
  });

  // Keep old action alias working
  bot.action("import_wallet", async (ctx) => {
    await ctx.answerCbQuery();
    convState.set(String(ctx.from.id), { step: "IMPORT_KEY", data: {} });
    await ctx.reply(
      `📥 <b>Import EVM Wallet</b>\n\nPaste your EVM private key:\n\n🔒 Deleted immediately. /cancel to abort.`,
      { parse_mode: "HTML" }
    );
  });

  // ─── IMPORT SOLANA WALLET ──────────────────────────────────────────────
  bot.action("import_sol_wallet", async (ctx) => {
    await ctx.answerCbQuery();
    convState.set(String(ctx.from.id), { step: "IMPORT_SOL_KEY", data: {} });
    await ctx.reply(
      `📥 <b>Import Solana Wallet</b>\n\n` +
      `This will <b>replace</b> your Solana wallet.\n\n` +
      `Paste your Solana <b>secret key</b>:\n` +
      `• Base58 format (from Phantom/Solflare)\n` +
      `• Example: <code>3oV…xyz</code> (~88 chars)\n\n` +
      `🔒 Your message is <b>deleted immediately</b> for security.\n` +
      `/cancel to abort.`,
      { parse_mode: "HTML" }
    );
  });

  // ─── EXPORT KEY ────────────────────────────────────────────────────────
  bot.action("export_key", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `📤 <b>Export Private Key</b>\n\n` +
      `⚠️ <b>CRITICAL SECURITY WARNING:</b>\n\n` +
      `• Anyone with this key controls your wallet\n` +
      `• Never share it — not even with support\n` +
      `• Store offline in a secure location\n` +
      `• The message <b>auto-deletes in 60 seconds</b>\n\n` +
      `Are you sure?`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("✅ Yes, show key", "export_confirm")],
          [Markup.button.callback("❌ Cancel", "home")],
        ]),
      }
    );
  });

  bot.action("export_confirm", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireUser(ctx);
    if (!user) return;
    try {
      const pk = decryptPrivateKey(user.encryptedPrivateKey);
      const msg = await ctx.reply(
        `🔑 <b>EVM Private Key (deletes in 60s)</b>\n\n<code>${pk}</code>\n\n⚠️ Copy and store securely NOW.`,
        { parse_mode: "HTML" }
      );
      setTimeout(async () => {
        try {
          await bot.telegram.deleteMessage(user.telegramId, msg.message_id);
          await bot.telegram.sendMessage(user.telegramId, "🗑 Key message deleted for your security.");
        } catch { /* already deleted */ }
      }, 60_000);
    } catch (err: any) {
      logger.error({ err }, "export_confirm");
      await ctx.reply("❌ Failed to export key.");
    }
  });

  // ─── EXPORT SOLANA KEY ─────────────────────────────────────────────────
  bot.action("export_sol_key", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `📤 <b>Export Solana Key</b>\n\n` +
      `⚠️ <b>CRITICAL SECURITY WARNING:</b>\n\n` +
      `• Anyone with this key controls your Solana wallet\n` +
      `• Never share it\n` +
      `• The message <b>auto-deletes in 60 seconds</b>\n\n` +
      `Are you sure?`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("✅ Yes, show Solana key", "export_sol_confirm")],
          [Markup.button.callback("❌ Cancel", "wallet_menu")],
        ]),
      }
    );
  });

  bot.action("export_sol_confirm", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireUser(ctx);
    if (!user) return;
    if (!user.encryptedSolanaKey) {
      await ctx.reply("❌ No Solana wallet found. Send /start to create one.");
      return;
    }
    try {
      const secretB58 = decryptSolanaKey(user.encryptedSolanaKey);
      const msg = await ctx.reply(
        `🔑 <b>Solana Secret Key (deletes in 60s)</b>\n\n<code>${secretB58}</code>\n\n⚠️ Import into Phantom/Solflare to access this wallet.`,
        { parse_mode: "HTML" }
      );
      setTimeout(async () => {
        try {
          await bot.telegram.deleteMessage(user.telegramId, msg.message_id);
          await bot.telegram.sendMessage(user.telegramId, "🗑 Solana key deleted for your security.");
        } catch { /* already deleted */ }
      }, 60_000);
    } catch (err: any) {
      logger.error({ err }, "export_sol_confirm");
      await ctx.reply("❌ Failed to export Solana key.");
    }
  });

  // ─── WITHDRAW ──────────────────────────────────────────────────────────
  bot.action("withdraw", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `💸 <b>Withdraw</b>\n\nSelect token to send:`,
      { parse_mode: "HTML", ...tokenKeyboard("withdraw_token", true, "wallet_menu") }
    );
  });

  bot.action(/^withdraw_token:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const symbol = ctx.match[1];
    const telegramId = String(ctx.from.id);
    const user = await requireUser(ctx);
    if (!user) return;

    let balLine = "";
    try {
      const positions = await getPortfolio(user.walletAddress);
      const pos = positions.find(p => p.symbol === symbol);
      if (pos) balLine = `\nYour balance: <b>${pos.amount} ${symbol}</b> (~$${fmt(pos.valueUsd)})`;
    } catch { /* offline */ }

    convState.set(telegramId, { step: "WITHDRAW_AMOUNT", data: { symbol } });
    await ctx.reply(`💸 <b>Withdraw ${symbol}</b>${balLine}\n\nEnter amount to send:`, { parse_mode: "HTML" });
  });

  // ─── NEW DCA ───────────────────────────────────────────────────────────
  bot.action("new_dca", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(`⚡ <b>New DCA Config</b>\n\nSelect the token to buy automatically with USDC:`, {
      parse_mode: "HTML",
      ...tokenKeyboard("dca_token", false, "home"),
    });
  });

  bot.action(/^dca_token:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const symbol = ctx.match[1];
    convState.set(String(ctx.from.id), { step: "SETUP_AMOUNT", data: { symbol } });
    await ctx.reply(
      `⚡ <b>DCA: ${symbol}</b>\n\nHow much <b>USDC</b> to spend per purchase?\n\n` +
      `Enter amount (e.g. <code>5</code> or <code>25.50</code>):`,
      { parse_mode: "HTML" }
    );
  });

  // ─── MY STATUS / DCA CONFIGS ───────────────────────────────────────────
  bot.action("my_status", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireUser(ctx);
    if (!user) return;

    const configs = await prisma.dcaConfig.findMany({
      where: { userId: user.id, isActive: true },
      orderBy: { createdAt: "desc" },
    });

    if (!configs.length) {
      const text = `📊 <b>My DCA Configs</b>\n\nNo active configs. Tap ⚡ New DCA to get started.`;
      try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: backKeyboard().reply_markup }); }
      catch { await ctx.reply(text, { parse_mode: "HTML", ...backKeyboard() }); }
      return;
    }

    const lines = configs.map(c => {
      const s = c.isPaused ? "⏸" : "▶️";
      let guards = "";
      if (c.maxBuyPrice) guards += ` | Max: $${c.maxBuyPrice}`;
      if (c.stopLossPrice) guards += ` | SL: $${c.stopLossPrice}`;
      if (c.takeProfitPrice) guards += ` | TP: $${c.takeProfitPrice}`;
      return `${s} <b>${c.tokenSymbol}</b> — $${c.amountUsd}/${c.interval}${guards}\n  Spent: $${fmt(c.totalSpentUsd)} | Next: ${c.nextRunAt.toUTCString().slice(4, 16)}`;
    });

    const cfgButtons = configs.flatMap(c => [[
      Markup.button.callback(`${c.isPaused ? "▶️" : "⏸"} ${c.tokenSymbol}`, `toggle_dca:${c.id}`),
      Markup.button.callback(`🗑 ${c.tokenSymbol}`, `cancel_dca:${c.id}`),
    ]]);
    cfgButtons.push([Markup.button.callback("🔙 Back to Home", "home")]);

    const text = `📊 <b>My DCA Configs</b>\n\n${lines.join("\n\n")}`;
    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(cfgButtons).reply_markup }); }
    catch { await ctx.reply(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(cfgButtons) }); }
  });

  bot.action(/^toggle_dca:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const configId = ctx.match[1];
    const user = await requireUser(ctx);
    if (!user) return;
    const config = await prisma.dcaConfig.findFirst({ where: { id: configId, userId: user.id } });
    if (!config) return;
    await prisma.dcaConfig.update({ where: { id: configId }, data: { isPaused: !config.isPaused } });
    await ctx.reply(`${config.isPaused ? "▶️ Resumed" : "⏸ Paused"} DCA for <b>${config.tokenSymbol}</b>.`, { parse_mode: "HTML", ...backKeyboard() });
  });

  bot.action(/^cancel_dca:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const configId = ctx.match[1];
    const user = await requireUser(ctx);
    if (!user) return;
    const config = await prisma.dcaConfig.findFirst({ where: { id: configId, userId: user.id } });
    if (!config) return;
    await ctx.reply(
      `⚠️ Cancel DCA for <b>${config.tokenSymbol}</b>?\nTotal spent: $${fmt(config.totalSpentUsd)}`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("✅ Yes, cancel it", `confirm_cancel_dca:${configId}`)],
          [Markup.button.callback("❌ Keep it", "my_status")],
        ]),
      }
    );
  });

  bot.action(/^confirm_cancel_dca:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const configId = ctx.match[1];
    const user = await requireUser(ctx);
    if (!user) return;
    const config = await prisma.dcaConfig.findFirst({ where: { id: configId, userId: user.id } });
    if (!config) return;
    await prisma.dcaConfig.update({ where: { id: configId }, data: { isActive: false } });
    await ctx.reply(`🗑 DCA cancelled for <b>${config.tokenSymbol}</b>. Total spent: $${fmt(config.totalSpentUsd)}`, { parse_mode: "HTML", ...backKeyboard() });
  });

  // ─── LIMIT ORDERS ──────────────────────────────────────────────────────
  bot.action("limit_order", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireUser(ctx);
    if (!user) { await ctx.reply("Please /start first."); return; }

    const orders = await prisma.limitOrder.findMany({
      where: { userId: user.id, isActive: true, isFilled: false },
      orderBy: { createdAt: "desc" },
    });

    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("➕ New Limit Buy", "new_limit_order")],
      ...(orders.length > 0 ? orders.slice(0, 5).map(o => [
        Markup.button.callback(`🎯 ${o.tokenSymbol} ≤$${o.targetPrice} → $${o.amountUsd}`, `cancel_limit:${o.id}`),
      ]) : []),
      [Markup.button.callback("🔙 Back to Home", "home")],
    ]);

    const text = orders.length
      ? `🎯 <b>Limit Orders</b>\n\n` + orders.map(o =>
          `• <b>${o.tokenSymbol}</b>: buy $${o.amountUsd} when price ${o.direction} $${o.targetPrice}\n  Created: ${o.createdAt.toDateString()}`
        ).join("\n\n") + `\n\n(Tap an order to cancel it)`
      : `🎯 <b>Limit Orders</b>\n\nNo active limit orders.\n\nA limit order buys a token automatically when its price hits your target.`;

    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb.reply_markup }); }
    catch { await ctx.reply(text, { parse_mode: "HTML", ...kb }); }
  });

  bot.action("new_limit_order", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(`🎯 <b>New Limit Order</b>\n\nSelect the token to buy:`, {
      parse_mode: "HTML", ...tokenKeyboard("limit_token", false, "limit_order"),
    });
  });

  bot.action(/^limit_token:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const symbol = ctx.match[1];
    convState.set(String(ctx.from.id), { step: "SET_LIMIT_AMOUNT", data: { symbol } });
    await ctx.reply(
      `🎯 <b>Limit Order: ${symbol}</b>\n\nHow much <b>USDC</b> to spend when triggered?\n(e.g. <code>25</code>):`,
      { parse_mode: "HTML" }
    );
  });

  bot.action(/^cancel_limit:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const orderId = ctx.match[1];
    const user = await requireUser(ctx);
    if (!user) return;
    const order = await prisma.limitOrder.findFirst({ where: { id: orderId, userId: user.id } });
    if (!order) return;
    await prisma.limitOrder.update({ where: { id: orderId }, data: { isActive: false } });
    await ctx.reply(`🗑 Limit order for <b>${order.tokenSymbol}</b> cancelled.`, { parse_mode: "HTML", ...backKeyboard() });
  });

  // ─── PRICE ALERTS ──────────────────────────────────────────────────────
  bot.action("alerts_menu", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireUser(ctx);
    if (!user) return;

    const alerts = await prisma.priceAlert.findMany({
      where: { userId: user.id, isActive: true, isTriggered: false },
      orderBy: { createdAt: "desc" },
    });

    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("➕ Set New Alert", "new_alert_token")],
      ...(alerts.slice(0, 6).map(a => [
        Markup.button.callback(`${a.direction === "above" ? "📈" : "📉"} ${a.tokenSymbol} ${a.direction === "above" ? "≥" : "≤"}$${a.targetPrice}`, `del_alert:${a.id}`),
      ])),
      [Markup.button.callback("🔙 Back to Home", "home")],
    ]);

    const text = alerts.length
      ? `🔔 <b>Price Alerts</b>\n\n` + alerts.map(a =>
          `${a.direction === "above" ? "📈" : "📉"} <b>${a.tokenSymbol}</b> ${a.direction} <b>$${a.targetPrice}</b>`
        ).join("\n") + `\n\n(Tap an alert to delete it)`
      : `🔔 <b>Price Alerts</b>\n\nNo active alerts.\n\nGet notified when a token price crosses your target.`;

    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb.reply_markup }); }
    catch { await ctx.reply(text, { parse_mode: "HTML", ...kb }); }
  });

  bot.action("new_alert_token", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(`🔔 <b>New Price Alert</b>\n\nSelect the token:`, {
      parse_mode: "HTML", ...tokenKeyboard("alert_token", true, "alerts_menu"),
    });
  });

  bot.action(/^alert_token:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const symbol = ctx.match[1];
    await ctx.reply(
      `🔔 <b>Alert: ${symbol}</b>\n\nNotify me when price goes:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📈 Above a target price", `alert_dir:above:${symbol}`)],
          [Markup.button.callback("📉 Below a target price", `alert_dir:below:${symbol}`)],
          [Markup.button.callback("🔙 Cancel", "alerts_menu")],
        ]),
      }
    );
  });

  bot.action(/^alert_dir:(above|below):(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const direction = ctx.match[1];
    const symbol = ctx.match[2];
    const tokenInfo = SUPPORTED_TOKENS[symbol];
    convState.set(String(ctx.from.id), {
      step: "SET_ALERT_PRICE",
      data: { symbol, direction, tokenAddress: tokenInfo?.address ?? "" },
    });
    await ctx.reply(
      `🔔 Alert when <b>${symbol}</b> goes <b>${direction}</b> what price?\n\n` +
      `Enter target price in USD (e.g. <code>3500</code>):`,
      { parse_mode: "HTML" }
    );
  });

  bot.action(/^del_alert:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const alertId = ctx.match[1];
    const user = await requireUser(ctx);
    if (!user) return;
    const alert = await prisma.priceAlert.findFirst({ where: { id: alertId, userId: user.id } });
    if (!alert) return;
    await prisma.priceAlert.update({ where: { id: alertId }, data: { isActive: false } });
    await ctx.reply(`🗑 Alert for <b>${alert.tokenSymbol}</b> deleted.`, { parse_mode: "HTML", ...backKeyboard() });
  });

  // ─── TRENDING ──────────────────────────────────────────────────────────
  bot.action("trending", async (ctx) => {
    await ctx.answerCbQuery("🔥 Fetching trending tokens…");
    try {
      const tokens = await getTrendingTokens(8);
      if (!tokens.length) {
        await ctx.reply("❌ Could not fetch trending tokens.", backKeyboard());
        return;
      }
      const lines = tokens.map((t, i) => {
        const icon = t.change24h >= 0 ? "🟢" : "🔴";
        const cap = t.marketCapUsd > 1e9 ? `$${(t.marketCapUsd / 1e9).toFixed(2)}B` : `$${(t.marketCapUsd / 1e6).toFixed(0)}M`;
        return `${i + 1}. <b>${t.symbol}</b> — $${fmt(t.price, 4)}\n   ${icon} ${t.change24h >= 0 ? "+" : ""}${t.change24h.toFixed(2)}% 24h | Cap: ${cap}`;
      });
      const text = `🔥 <b>Trending on Base (by Market Cap)</b>\n\n${lines.join("\n\n")}`;
      try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: backKeyboard().reply_markup }); }
      catch { await ctx.reply(text, { parse_mode: "HTML", ...backKeyboard() }); }
    } catch (err: any) {
      await ctx.reply(`❌ Error: ${err.message}`, backKeyboard());
    }
  });

  // ─── PORTFOLIO P&L ─────────────────────────────────────────────────────
  bot.action("portfolio", async (ctx) => {
    await ctx.answerCbQuery("📈 Analyzing portfolio…");
    const user = await requireUser(ctx);
    if (!user) return;

    let positions: Awaited<ReturnType<typeof getPortfolio>> = [];
    try { positions = await getPortfolio(user.walletAddress); } catch { /* offline */ }

    const dcaConfigs = await prisma.dcaConfig.findMany({ where: { userId: user.id } });
    const totalDcaSpent = dcaConfigs.reduce((s, c) => s + c.totalSpentUsd, 0);
    const portfolioVal = positions.reduce((s, p) => s + p.valueUsd, 0);
    const pnl = portfolioVal - totalDcaSpent;
    const pnlPct = totalDcaSpent > 0 ? (pnl / totalDcaSpent) * 100 : 0;
    const pnlIcon = pnl >= 0 ? "🟢" : "🔴";

    const posLines = positions.length
      ? positions.map(p => `• <b>${p.symbol}</b>: ${p.amount} = <b>$${fmt(p.valueUsd)}</b>`).join("\n")
      : "No positions found.";

    const text =
      `📈 <b>Portfolio Analysis</b>\n\n` +
      `${posLines}\n\n` +
      `${"─".repeat(25)}\n` +
      `Total Portfolio Value: <b>$${fmt(portfolioVal)}</b>\n` +
      `Total DCA Invested: <b>$${fmt(totalDcaSpent)}</b>\n` +
      `Unrealized P&amp;L: ${pnlIcon} <b>${pnl >= 0 ? "+" : ""}$${fmt(pnl)}</b> (${pnl >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)\n\n` +
      `<i>P&amp;L based on DCA spend vs current market value.</i>`;

    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: backKeyboard().reply_markup }); }
    catch { await ctx.reply(text, { parse_mode: "HTML", ...backKeyboard() }); }
  });

  // ─── HISTORY ───────────────────────────────────────────────────────────
  bot.action("history", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireUser(ctx);
    if (!user) return;
    const txs = await prisma.transaction.findMany({
      where: { userId: user.id }, orderBy: { executedAt: "desc" }, take: 20,
    });
    if (!txs.length) {
      try { await ctx.editMessageText("📜 <b>History</b>\n\nNo transactions yet.", { parse_mode: "HTML", reply_markup: backKeyboard().reply_markup }); }
      catch { await ctx.reply("📜 No transactions yet.", backKeyboard()); }
      return;
    }
    const lines = txs.map(tx => {
      const icon = tx.status === "success" ? "✅" : tx.status === "skipped" ? "⏭" : "❌";
      const d = tx.executedAt.toUTCString().slice(4, 16);
      let line = `${icon} ${d} | ${tx.tokenSymbol} | $${fmt(tx.usdAmount)}`;
      if (tx.status === "success" && tx.txHash) line += `\n   <a href="https://basescan.org/tx/${tx.txHash}">BaseScan ↗</a>`;
      else if (tx.skipReason) line += `\n   ⚠️ ${tx.skipReason}`;
      return line;
    });
    const text = `📜 <b>Last ${txs.length} Transactions</b>\n\n${lines.join("\n\n")}`;
    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: backKeyboard().reply_markup }); }
    catch { await ctx.reply(text, { parse_mode: "HTML", ...backKeyboard() }); }
  });

  // ─── POLICIES ──────────────────────────────────────────────────────────
  bot.action("policies", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireUser(ctx);
    if (!user) return;
    const configs = await prisma.dcaConfig.findMany({ where: { userId: user.id, isActive: true } });
    const cfgLines = configs.length
      ? configs.map(c => {
          let line = `• <b>${c.tokenSymbol}</b>: $${c.amountUsd}/run | Daily cap: $${c.dailyCapUsd} | Slip: ${c.slippageCap}%`;
          if (c.maxBuyPrice) line += ` | Max buy: $${c.maxBuyPrice}`;
          if (c.stopLossPrice) line += ` | SL: $${c.stopLossPrice}`;
          if (c.takeProfitPrice) line += ` | TP: $${c.takeProfitPrice}`;
          return line;
        }).join("\n")
      : "No active configs";
    const text =
      `🛡 <b>Policy Rules</b>\n\n` +
      `<b>Global:</b>\n` +
      `• Chain: Base (chainId 8453) — locked\n` +
      `• USDC balance checked before every swap\n` +
      `• Slippage, daily cap enforced per config\n` +
      `• Price guards (max buy, stop loss) enforced\n` +
      `• Take profit: scheduler triggers auto-pause\n` +
      `• Expired configs auto-deactivated\n\n` +
      `<b>Your active config policies:</b>\n${cfgLines}`;
    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: backKeyboard().reply_markup }); }
    catch { await ctx.reply(text, { parse_mode: "HTML", ...backKeyboard() }); }
  });

  // ─── PRICE ─────────────────────────────────────────────────────────────
  bot.action("price", async (ctx) => {
    await ctx.answerCbQuery();
    convState.set(String(ctx.from.id), { step: "PRICE_TOKEN", data: {} });
    await ctx.reply(`💰 <b>Live Price</b>\n\nEnter a token symbol (e.g. <code>ETH</code>):`, { parse_mode: "HTML" });
  });

  // ─── REFERRALS ─────────────────────────────────────────────────────────
  bot.action("referrals", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireUser(ctx);
    if (!user) return;

    const referralCount = await prisma.user.count({ where: { referredBy: user.referralCode ?? "" } });
    const code = user.referralCode ?? "—";
    const inviteUrl = `https://t.me/${BOT_NAME.replace("@", "")}?start=${code}`;

    const text =
      `👥 <b>Referral Program</b>\n\n` +
      `Your referral code: <code>${code}</code>\n` +
      `Invite link: <code>${inviteUrl}</code>\n\n` +
      `Friends referred: <b>${referralCount}</b>\n\n` +
      `Share your invite link to bring friends onto the bot.\n` +
      `Every friend who joins is tracked under your code.`;

    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: backKeyboard().reply_markup }); }
    catch { await ctx.reply(text, { parse_mode: "HTML", ...backKeyboard() }); }
  });

  // ─── SETTINGS ──────────────────────────────────────────────────────────
  bot.action("settings", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireUser(ctx);
    if (!user) return;
    const gas = user.gasPriority ?? "standard";
    const text =
      `⚙️ <b>Settings</b>\n\n` +
      `<b>Chain:</b> Base mainnet (locked)\n` +
      `<b>Gas Priority:</b> ${GAS_PRIORITY_LABELS[gas]}\n` +
      `<b>Default Slippage:</b> 1%\n` +
      `<b>Default Daily Cap:</b> 3× per-run amount\n` +
      `<b>Default Expiry:</b> 30 days\n\n` +
      `Set gas priority:`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("🐢 Slow", "gas:slow"), Markup.button.callback("⚡ Standard", "gas:standard")],
      [Markup.button.callback("🚀 Fast", "gas:fast"), Markup.button.callback("🔥 Ultra", "gas:ultra")],
      [Markup.button.callback("🔙 Back", "home")],
    ]);
    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb.reply_markup }); }
    catch { await ctx.reply(text, { parse_mode: "HTML", ...kb }); }
  });

  bot.action(/^gas:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const priority = ctx.match[1];
    const user = await requireUser(ctx);
    if (!user) return;
    await prisma.user.update({ where: { telegramId: String(ctx.from.id) }, data: { gasPriority: priority } });
    await ctx.reply(`✅ Gas priority set to <b>${GAS_PRIORITY_LABELS[priority]}</b>.`, { parse_mode: "HTML", ...backKeyboard() });
  });

  // ─── DCA INTERVAL (from conversation) ─────────────────────────────────
  bot.action(/^dca_interval:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const interval = ctx.match[1];
    const telegramId = String(ctx.from.id);
    const state = convState.get(telegramId);
    if (!state || state.step !== "SETUP_INTERVAL") { await ctx.reply("Session expired. Try ⚡ New DCA again."); return; }

    const { symbol, amountUsd } = state.data as { symbol: string; amountUsd: number };
    convState.set(telegramId, { step: "SETUP_MAX_PRICE", data: state.data });

    await ctx.reply(
      `⚡ <b>DCA: ${symbol}</b> — $${amountUsd}/${interval}\n\n` +
      `<b>Advanced Settings (optional)</b>\n\n` +
      `Set a <b>max buy price</b>? (Skip buy if price is above this)\n` +
      `Enter a price in USD, or skip:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⏭ Skip (no max price)", `skip_max_price:${interval}`)],
          [Markup.button.callback("❌ Cancel", "home")],
        ]),
      }
    );
  });

  bot.action(/^skip_max_price:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const interval = ctx.match[1];
    const telegramId = String(ctx.from.id);
    const state = convState.get(telegramId);
    if (!state) return;
    convState.set(telegramId, { step: "SETUP_STOP_LOSS", data: { ...state.data, interval, maxBuyPrice: null } });
    await ctx.reply(
      `Set a <b>stop-loss price</b>? (Pause DCA if price drops below this)\nEnter USD price, or skip:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⏭ Skip (no stop-loss)", `skip_stop_loss:${interval}`)],
          [Markup.button.callback("❌ Cancel", "home")],
        ]),
      }
    );
  });

  bot.action(/^skip_stop_loss:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const interval = ctx.match[1];
    const telegramId = String(ctx.from.id);
    const state = convState.get(telegramId);
    if (!state) return;
    convState.set(telegramId, { step: "SETUP_TP", data: { ...state.data, interval, stopLossPrice: null } });
    await ctx.reply(
      `Set a <b>take-profit price</b>? (Auto-pause DCA if price reaches this)\nEnter USD price, or skip:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⏭ Skip (no take-profit)", `finalize_dca:${interval}`)],
          [Markup.button.callback("❌ Cancel", "home")],
        ]),
      }
    );
  });

  bot.action(/^finalize_dca:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const interval = ctx.match[1];
    const telegramId = String(ctx.from.id);
    const state = convState.get(telegramId);
    if (!state) { await ctx.reply("Session expired."); return; }
    await finalizeDcaConfig(ctx, telegramId, { ...state.data, interval, takeProfitPrice: null });
  });

  async function finalizeDcaConfig(ctx: Context, telegramId: string, data: Record<string, unknown>) {
    convState.delete(telegramId);
    const user = await requireUser(ctx);
    if (!user) return;

    const { symbol, amountUsd, interval, maxBuyPrice, stopLossPrice, takeProfitPrice } = data as {
      symbol: string; amountUsd: number; interval: string;
      maxBuyPrice: number | null; stopLossPrice: number | null; takeProfitPrice: number | null;
    };

    const tokenInfo = SUPPORTED_TOKENS[symbol];
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    const dailyCapUsd = amountUsd * 3;
    const nr = nextRun(interval);

    const config = await prisma.dcaConfig.create({
      data: {
        userId: user.id,
        tokenSymbol: symbol,
        tokenAddress: tokenInfo.address,
        amountUsd, interval, dailyCapUsd,
        slippageCap: 1.0,
        maxBuyPrice, stopLossPrice, takeProfitPrice,
        expiresAt, nextRunAt: nr,
      },
    });

    const msPerInterval = interval === "hourly" ? 3_600_000 : interval === "daily" ? 86_400_000 : 604_800_000;
    const runs = Math.floor((expiresAt.getTime() - Date.now()) / msPerInterval);

    let guards = "";
    if (maxBuyPrice) guards += `\nMax Buy Price: <b>$${maxBuyPrice}</b>`;
    if (stopLossPrice) guards += `\nStop Loss: <b>$${stopLossPrice}</b>`;
    if (takeProfitPrice) guards += `\nTake Profit: <b>$${takeProfitPrice}</b>`;

    await ctx.reply(
      `✅ <b>DCA Config Created!</b>\n\n` +
      `Token: <b>${symbol}</b>\n` +
      `Amount: <b>$${amountUsd} USDC</b> per ${interval} buy\n` +
      `Daily Cap: <b>$${dailyCapUsd.toFixed(2)}</b>\n` +
      `Slippage Cap: <b>1%</b>\n` +
      `First Run: <b>${nr.toUTCString().slice(4, 16)}</b>\n` +
      `Expires: <b>${expiresAt.toDateString()}</b>\n` +
      `Est. Budget: <b>$${(runs * amountUsd).toFixed(2)}</b> over ~${runs} buys` +
      guards + `\n\nID: <code>${config.id}</code>`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  }

  // ─── WITHDRAW EXECUTE ──────────────────────────────────────────────────
  bot.action("withdraw_execute", async (ctx) => {
    await ctx.answerCbQuery("⏳ Sending transaction…");
    const telegramId = String(ctx.from.id);
    const state = convState.get(telegramId);
    if (!state || state.step !== "WITHDRAW_CONFIRM") { await ctx.reply("Session expired. Try again."); return; }
    const { symbol, amount, toAddress } = state.data as { symbol: string; amount: number; toAddress: string };
    convState.delete(telegramId);
    const user = await requireUser(ctx);
    if (!user) return;
    await ctx.reply(`⏳ <b>Sending ${amount} ${symbol}…</b>`, { parse_mode: "HTML" });
    try {
      const wallet = getWallet(user.encryptedPrivateKey);
      const tokenInfo = SUPPORTED_TOKENS[symbol];
      let txHash: string;
      if (symbol === "ETH") {
        const tx = await wallet.sendTransaction({ to: toAddress, value: ethers.parseEther(String(amount)) });
        const receipt = await tx.wait();
        if (!receipt || receipt.status === 0) throw new Error("Transaction reverted");
        txHash = receipt.hash;
      } else {
        const contract = new ethers.Contract(tokenInfo.address, ERC20_ABI, wallet);
        const amountWei = ethers.parseUnits(String(amount), tokenInfo.decimals);
        const tx = await (contract.transfer as (to: string, amount: bigint) => Promise<any>)(toAddress, amountWei);
        const receipt = await tx.wait();
        if (!receipt || receipt.status === 0) throw new Error("Transaction reverted");
        txHash = receipt.hash;
      }
      await ctx.reply(
        `✅ <b>Sent!</b>\n\nSent: <b>${amount} ${symbol}</b>\nTo: <code>${toAddress}</code>\n🔗 <a href="https://basescan.org/tx/${txHash}">View on BaseScan</a>`,
        { parse_mode: "HTML", ...backKeyboard() }
      );
    } catch (err: any) {
      logger.error({ err }, "withdraw_execute");
      await ctx.reply(`❌ <b>Failed:</b> ${err.message}`, { parse_mode: "HTML", ...backKeyboard() });
    }
  });

  // ─── TEXT MESSAGE HANDLER ──────────────────────────────────────────────
  bot.on("text", async (ctx) => {
    const telegramId = String(ctx.from.id);
    const text = ctx.message.text.trim();
    const state = convState.get(telegramId);

    if (text.startsWith("/")) return;

    // ── No active conversation: try token lookup ──
    if (!state) {
      const isEvmAddress = /^0x[a-fA-F0-9]{40}$/.test(text);
      const isSolanaAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text) && !text.startsWith("0x");
      const isTicker = /^[A-Za-z$]{2,12}$/.test(text);

      if (isEvmAddress || isSolanaAddress || isTicker) {
        await ctx.reply(`🔍 Looking up <b>${text}</b>…`, { parse_mode: "HTML" });
        await showTokenCard(ctx, text, "send");
      }
      return;
    }

    const cancelOk = async () => {
      convState.delete(telegramId);
      await ctx.reply("✅ Cancelled.", backKeyboard());
    };

    // ── IMPORT KEY ──
    if (state.step === "IMPORT_KEY") {
      try { await ctx.deleteMessage(); } catch { /* can't delete */ }
      let wallet: ethers.Wallet;
      try { wallet = new ethers.Wallet(text); }
      catch {
        convState.delete(telegramId);
        await ctx.reply("❌ Invalid private key. Try again with /start.");
        return;
      }
      const address = wallet.address;
      const existing = await prisma.user.findUnique({ where: { walletAddress: address } });
      if (existing && existing.telegramId !== telegramId) {
        convState.delete(telegramId);
        await ctx.reply("❌ Wallet already registered to another user.");
        return;
      }
      await prisma.user.update({
        where: { telegramId },
        data: {
          walletAddress: address,
          encryptedPrivateKey: encryptPrivateKey(text),
          walletImported: true,
          walletImportedAt: new Date(),
        },
      });
      convState.delete(telegramId);
      await ctx.reply(`✅ <b>EVM Wallet Imported!</b>\n\nMultiChain wallet: <code>${address}</code>\n🔒 Key deleted from chat.`, { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("💼 My Wallets", "wallet_menu"), Markup.button.callback("🏠 Home", "home")]]) });
      return;
    }

    // ── IMPORT SOLANA KEY ──
    if (state.step === "IMPORT_SOL_KEY") {
      try { await ctx.deleteMessage(); } catch { /* can't delete */ }
      try {
        const bs58 = await import("bs58");
        const { Keypair } = await import("@solana/web3.js");
        // Try decoding the base58 key
        let secretKey: Uint8Array;
        try {
          secretKey = bs58.default.decode(text);
          if (secretKey.length !== 64) throw new Error("wrong length");
        } catch {
          convState.delete(telegramId);
          await ctx.reply("❌ Invalid Solana private key. Must be base58 (Phantom export format — 87-88 chars).");
          return;
        }
        const keypair = Keypair.fromSecretKey(secretKey);
        const pubkey = keypair.publicKey.toBase58();
        await prisma.user.update({
          where: { telegramId },
          data: {
            solanaPubkey: pubkey,
            encryptedSolanaKey: encryptSolanaKey(text),
          },
        });
        convState.delete(telegramId);
        await ctx.reply(
          `✅ <b>Solana Wallet Imported!</b>\n\nSolana address: <code>${pubkey}</code>\n🔒 Key deleted from chat.`,
          { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("💼 My Wallets", "wallet_menu"), Markup.button.callback("🏠 Home", "home")]]) }
        );
      } catch (err: any) {
        convState.delete(telegramId);
        logger.error({ err }, "import_sol_key");
        await ctx.reply("❌ Failed to import Solana key. Please check the format and try again.");
      }
      return;
    }

    // ── SETUP AMOUNT ──
    if (state.step === "SETUP_AMOUNT") {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) { await ctx.reply("❌ Enter a valid amount (e.g. <code>10</code>):", { parse_mode: "HTML" }); return; }
      convState.set(telegramId, { step: "SETUP_INTERVAL", data: { ...state.data, amountUsd: amount } });
      await ctx.reply(`⚡ <b>DCA: ${state.data.symbol}</b> — $${amount}/run\n\nHow often should it buy?`, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⏱ Hourly", "dca_interval:hourly")],
          [Markup.button.callback("📅 Daily", "dca_interval:daily")],
          [Markup.button.callback("📆 Weekly", "dca_interval:weekly")],
          [Markup.button.callback("❌ Cancel", "home")],
        ]),
      });
      return;
    }

    // ── SETUP MAX PRICE ──
    if (state.step === "SETUP_MAX_PRICE") {
      const price = parseFloat(text);
      if (isNaN(price) || price <= 0) { await ctx.reply("❌ Enter a valid price:", { parse_mode: "HTML" }); return; }
      const interval = (state.data as any).interval as string;
      convState.set(telegramId, { step: "SETUP_STOP_LOSS", data: { ...state.data, maxBuyPrice: price } });
      await ctx.reply(
        `✅ Max buy price: <b>$${price}</b>\n\nSet a <b>stop-loss price</b>? (Pause if price drops below)\nEnter USD price, or skip:`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("⏭ Skip", `skip_stop_loss:${interval}`)],
            [Markup.button.callback("❌ Cancel", "home")],
          ]),
        }
      );
      return;
    }

    // ── SETUP STOP LOSS ──
    if (state.step === "SETUP_STOP_LOSS") {
      const price = parseFloat(text);
      if (isNaN(price) || price <= 0) { await ctx.reply("❌ Enter a valid price:", { parse_mode: "HTML" }); return; }
      const interval = (state.data as any).interval as string;
      convState.set(telegramId, { step: "SETUP_TP", data: { ...state.data, stopLossPrice: price } });
      await ctx.reply(
        `✅ Stop-loss: <b>$${price}</b>\n\nSet a <b>take-profit price</b>? (Pause DCA when reached)\nEnter USD price, or skip:`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("⏭ Skip", `finalize_dca:${interval}`)],
            [Markup.button.callback("❌ Cancel", "home")],
          ]),
        }
      );
      return;
    }

    // ── SETUP TAKE PROFIT ──
    if (state.step === "SETUP_TP") {
      const price = parseFloat(text);
      if (isNaN(price) || price <= 0) { await ctx.reply("❌ Enter a valid price:", { parse_mode: "HTML" }); return; }
      const interval = (state.data as any).interval as string;
      await finalizeDcaConfig(ctx, telegramId, { ...state.data, takeProfitPrice: price });
      return;
    }

    // ── WITHDRAW AMOUNT ──
    if (state.step === "WITHDRAW_AMOUNT") {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) { await ctx.reply("❌ Enter a valid amount:"); return; }
      convState.set(telegramId, { step: "WITHDRAW_ADDRESS", data: { ...state.data, amount } });
      await ctx.reply(`💸 Sending <b>${amount} ${state.data.symbol}</b>\n\nEnter destination address on Base:`, { parse_mode: "HTML" });
      return;
    }

    // ── WITHDRAW ADDRESS ──
    if (state.step === "WITHDRAW_ADDRESS") {
      if (!ethers.isAddress(text)) { await ctx.reply("❌ Invalid address. Try again:"); return; }
      const { symbol, amount } = state.data as { symbol: string; amount: number };
      convState.set(telegramId, { step: "WITHDRAW_CONFIRM", data: { ...state.data, toAddress: text } });
      await ctx.reply(
        `💸 <b>Confirm Withdrawal</b>\n\nToken: <b>${symbol}</b>\nAmount: <b>${amount} ${symbol}</b>\nTo: <code>${text}</code>\n\n⚠️ Real onchain transaction — cannot be undone.`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("✅ Confirm & Send", "withdraw_execute")],
            [Markup.button.callback("❌ Cancel", "home")],
          ]),
        }
      );
      return;
    }

    // ── PRICE TOKEN / TOKEN SEARCH ──
    if (state.step === "PRICE_TOKEN" || state.step === "TOKEN_SEARCH") {
      convState.delete(telegramId);
      await ctx.reply(`🔍 Looking up <b>${text.toUpperCase()}</b>…`, { parse_mode: "HTML" });
      await showTokenCard(ctx, text, "send");
      return;
    }

    // ── BUY CUSTOM AMOUNT ──
    if (state.step === "BUY_CUSTOM_AMOUNT") {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) { await ctx.reply("❌ Enter a valid USDC amount (e.g. <code>15</code>):", { parse_mode: "HTML" }); return; }
      const { symbol, chain: stateChain } = state.data as { symbol: string; chain?: string };
      const chain = stateChain ?? "base";
      convState.delete(telegramId);
      const user = await requireUser(ctx);
      if (!user) return;
      await ctx.reply(`⏳ <b>Buying $${amount} of ${symbol}…</b>\n${getChainLabel(chain)} — fetching best route…`, { parse_mode: "HTML" });
      try {
        const result = await executeBuy(user as any, symbol, amount, chain);
        await ctx.reply(
          `✅ <b>Buy Executed!</b>\n\nChain: <b>${getChainLabel(result.chain)}</b>\nBought: <b>${result.outAmount}</b>\nSpent: <b>$${amount} USDC</b>\n🔗 <a href="${result.explorer}${result.txHash}">View Transaction</a>`,
          { parse_mode: "HTML", ...backKeyboard() }
        );
      } catch (err: any) {
        logger.error({ err }, "buy_custom error");
        await ctx.reply(`❌ <b>Buy Failed:</b> ${err.message}`, { parse_mode: "HTML", ...backKeyboard() });
      }
      return;
    }

    // ── SELL CUSTOM AMOUNT ──
    if (state.step === "SELL_CUSTOM_AMOUNT") {
      const { symbol, chain: stateChain } = state.data as { symbol: string; chain?: string };
      const chain = stateChain ?? "base";
      convState.delete(telegramId);
      const user = await requireUser(ctx);
      if (!user) return;

      let pct: number;
      if (text.endsWith("%")) {
        pct = parseFloat(text.replace("%", ""));
        if (isNaN(pct) || pct <= 0 || pct > 100) { await ctx.reply("❌ Enter a percentage between 1–100%:"); return; }
      } else {
        const positions = chain === "solana" && user.solanaPubkey
          ? await getSolanaPortfolio(user.solanaPubkey)
          : await getPortfolio(user.walletAddress, chain);
        const pos = positions.find(p => p.symbol === symbol);
        if (!pos) { await ctx.reply(`❌ No ${symbol} balance found on ${getChainLabel(chain)}.`); return; }
        const exactAmount = parseFloat(text);
        if (isNaN(exactAmount) || exactAmount <= 0) { await ctx.reply("❌ Enter a valid amount:"); return; }
        const total = parseFloat(pos.amount);
        if (exactAmount > total) { await ctx.reply(`❌ Amount exceeds balance (${total.toFixed(6)} ${symbol}).`); return; }
        pct = (exactAmount / total) * 100;
      }

      await ctx.reply(`⏳ <b>Selling ${pct.toFixed(1)}% of ${symbol}…</b> on ${getChainLabel(chain)}`, { parse_mode: "HTML" });
      try {
        const result = await executeSell(user as any, symbol, pct, chain);
        await ctx.reply(
          `✅ <b>Sell Executed!</b>\n\nChain: <b>${getChainLabel(result.chain)}</b>\nSold: <b>${result.soldAmount}</b>\nReceived: <b>${result.receivedUsdc} USDC</b>\n🔗 <a href="${result.explorer}${result.txHash}">View Transaction</a>`,
          { parse_mode: "HTML", ...backKeyboard() }
        );
      } catch (err: any) {
        logger.error({ err }, "sell_custom error");
        await ctx.reply(`❌ <b>Sell Failed:</b> ${err.message}`, { parse_mode: "HTML", ...backKeyboard() });
      }
      return;
    }

    // ── SET ALERT PRICE ──
    if (state.step === "SET_ALERT_PRICE") {
      const price = parseFloat(text);
      if (isNaN(price) || price <= 0) { await ctx.reply("❌ Enter a valid price:"); return; }
      const { symbol, direction, tokenAddress } = state.data as { symbol: string; direction: string; tokenAddress: string };
      convState.delete(telegramId);
      const user = await requireUser(ctx);
      if (!user) return;
      await prisma.priceAlert.create({ data: { userId: user.id, tokenSymbol: symbol, tokenAddress, targetPrice: price, direction } });
      const icon = direction === "above" ? "📈" : "📉";
      await ctx.reply(`${icon} Alert set: notify when <b>${symbol}</b> goes ${direction} <b>$${price}</b>.`, { parse_mode: "HTML", ...backKeyboard() });
      return;
    }

    // ── SET LIMIT AMOUNT ──
    if (state.step === "SET_LIMIT_AMOUNT") {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) { await ctx.reply("❌ Enter a valid USDC amount:"); return; }
      const { symbol } = state.data as { symbol: string };
      convState.set(telegramId, { step: "SET_LIMIT_PRICE", data: { ...state.data, amountUsd: amount } });
      await ctx.reply(
        `🎯 <b>Limit Order: ${symbol}</b> — $${amount} USDC\n\nAt what price should it trigger?\nEnter target price in USD:`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // ── SET LIMIT PRICE ──
    if (state.step === "SET_LIMIT_PRICE") {
      const price = parseFloat(text);
      if (isNaN(price) || price <= 0) { await ctx.reply("❌ Enter a valid price:"); return; }
      const { symbol, amountUsd } = state.data as { symbol: string; amountUsd: number };
      convState.delete(telegramId);
      const user = await requireUser(ctx);
      if (!user) return;

      // Ask direction (buy below or above)
      await ctx.reply(
        `🎯 <b>Limit Order: ${symbol}</b>\nAmount: $${amountUsd} USDC | Target: $${price}\n\nBuy when price is:`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback(`📉 At or below $${price}`, `confirm_limit:below:${symbol}:${amountUsd}:${price}`)],
            [Markup.button.callback(`📈 At or above $${price}`, `confirm_limit:above:${symbol}:${amountUsd}:${price}`)],
            [Markup.button.callback("❌ Cancel", "home")],
          ]),
        }
      );
      return;
    }
  });

  // ─── CONFIRM LIMIT ORDER ──────────────────────────────────────────────
  bot.action(/^confirm_limit:(above|below):(.+):(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const direction = ctx.match[1];
    const symbol = ctx.match[2];
    const amountUsd = parseFloat(ctx.match[3]);
    const targetPrice = parseFloat(ctx.match[4]);
    const user = await requireUser(ctx);
    if (!user) return;
    const tokenInfo = SUPPORTED_TOKENS[symbol];
    if (!tokenInfo) { await ctx.reply("❌ Unsupported token."); return; }
    await prisma.limitOrder.create({
      data: {
        userId: user.id, tokenSymbol: symbol, tokenAddress: tokenInfo.address,
        amountUsd, targetPrice, direction, slippageCap: 1.0,
      },
    });
    const icon = direction === "below" ? "📉" : "📈";
    await ctx.reply(
      `${icon} <b>Limit Order Created!</b>\n\nBuy <b>$${amountUsd} USDC</b> of <b>${symbol}</b>\nWhen price ${direction === "below" ? "drops to" : "reaches"} <b>$${targetPrice}</b>\nSlippage cap: <b>1%</b>\n\nThe scheduler checks every minute.`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  });

  // ─── TOKEN INFO CARD BUILDER ───────────────────────────────────────────
  function fmtPrice(p: number): string {
    if (p === 0) return "$0";
    if (p >= 1000) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    if (p >= 1) return `$${p.toFixed(4)}`;
    if (p >= 0.01) return `$${p.toFixed(6)}`;
    // Very small — find first significant digits
    const s = p.toFixed(12).replace(/0+$/, "");
    const match = s.match(/^0\.(0*)/);
    const zeros = match ? match[1].length : 0;
    const sig = (p * Math.pow(10, zeros + 4)).toFixed(0);
    return `$0.${"0".repeat(zeros)}${sig}`;
  }

  function fmtCompact(n: number): string {
    if (!n || n === 0) return "—";
    if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${n.toFixed(2)}`;
  }

  function changeStr(pct: number): string {
    const sign = pct >= 0 ? "+" : "";
    return `${sign}${pct.toFixed(2)}%`;
  }

  function chainExplorerUrl(chainId: string, address: string): string {
    const map: Record<string, string> = {
      base: `https://basescan.org/token/${address}`,
      ethereum: `https://etherscan.io/token/${address}`,
      arbitrum: `https://arbiscan.io/token/${address}`,
      optimism: `https://optimistic.etherscan.io/token/${address}`,
      polygon: `https://polygonscan.com/token/${address}`,
      "binance-smart-chain": `https://bscscan.com/token/${address}`,
      solana: `https://solscan.io/token/${address}`,
    };
    return map[chainId] ?? "";
  }

  async function showTokenCard(ctx: Context, input: string, mode: "send" | "edit" = "send") {
    const user = await requireUser(ctx);
    if (!user) return;
    // Detect input type
    const isEvmAddr = /^0x[a-fA-F0-9]{40}$/.test(input);
    const isSolAddr = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input) && !input.startsWith("0x");

    let detail: Awaited<ReturnType<typeof getTokenDetail>> = null;
    try {
      if (isEvmAddr) {
        detail = await getTokenDetailByAddress(input, "base");
        if (!detail) detail = await getTokenDetailByAddress(input, "arbitrum");
      } else if (isSolAddr) {
        detail = await getTokenDetailByAddress(input, "solana");
      } else {
        // Symbol search — try common chains in priority order
        detail = await getTokenDetail(input.toUpperCase(), "base");
        if (!detail) detail = await getTokenDetail(input.toUpperCase(), "solana");
      }
    } catch { /* offline */ }

    if (!detail) {
      const errText = `❌ <b>${input}</b> not found.\n\nTry a ticker like <code>ETH</code>, <code>SOL</code>, <code>BONK</code>, or paste a contract address.`;
      try {
        if (mode === "edit") await ctx.editMessageText(errText, { parse_mode: "HTML", reply_markup: backKeyboard().reply_markup });
        else await ctx.reply(errText, { parse_mode: "HTML", ...backKeyboard() });
      } catch { await ctx.reply(errText, { parse_mode: "HTML", ...backKeyboard() }); }
      return;
    }

    const sym = detail.symbol;
    const c1h = detail.change1h ?? 0, c24h = detail.change24h ?? 0, c7d = detail.change7d ?? 0, c30d = detail.change30d ?? 0;
    const trend1h = c1h >= 0 ? "🟢" : "🔴";
    const trend24h = c24h >= 0 ? "🟢" : "🔴";
    const trend7d = c7d >= 0 ? "🟢" : "🔴";

    // Auto-detect best chain for this token from its implementations
    const impls = detail.implementations ?? [];
    const bestChain = pickBestChain(impls);

    // Check user balance on best chain
    let balLine = "", hasBalance = false, balChain = bestChain;
    try {
      if (bestChain === "solana" && user.solanaPubkey) {
        const positions = await getSolanaPortfolio(user.solanaPubkey);
        const pos = positions.find(p => p.symbol === sym);
        if (pos && pos.valueUsd > 0.01) {
          hasBalance = true; balChain = "solana";
          balLine = `\n💼 Solana balance: <b>${pos.amount} ${sym}</b> ≈<b>$${fmt(pos.valueUsd)}</b>`;
        }
      }
      if (!hasBalance) {
        // Check EVM chains in priority order
        for (const c of CHAIN_PRIORITY.filter(c => c !== "solana")) {
          if (!impls.some(i => i.chainId === c)) continue;
          const positions = await getPortfolio(user.walletAddress, c);
          const pos = positions.find(p => p.symbol === sym);
          if (pos && pos.valueUsd > 0.01) {
            hasBalance = true; balChain = c;
            balLine = `\n💼 ${getChainLabel(c)} balance: <b>${pos.amount} ${sym}</b> ≈<b>$${fmt(pos.valueUsd)}</b>`;
            break;
          }
        }
      }
    } catch { /* offline */ }

    // Build chain availability line
    const chainNames: Record<string, string> = {
      base: "Base", ethereum: "ETH", arbitrum: "Arb", optimism: "OP",
      polygon: "Poly", "binance-smart-chain": "BSC", solana: "SOL",
    };
    const chainsAvail = impls.length > 0
      ? impls.map(i => chainNames[i.chainId] ?? i.chainId).slice(0, 6).join(" · ")
      : "";

    // Explorer links for best chain impl
    const bestImpl = impls.find(i => i.chainId === bestChain) ?? impls[0];
    const explorerUrl = bestImpl ? chainExplorerUrl(bestImpl.chainId, bestImpl.address) : "";
    const dexUrl = bestImpl?.address
      ? (bestImpl.chainId === "solana"
        ? `https://dexscreener.com/solana/${bestImpl.address}`
        : `https://dexscreener.com/${bestImpl.chainId}/${bestImpl.address}`)
      : "";
    const contractLine = bestImpl?.address
      ? `📋 <code>${bestImpl.address}</code>\n`
      : "";

    const text =
      `💎 <b>${sym} — ${detail.name}</b>\n` +
      (chainsAvail ? `<i>Available on: ${chainsAvail}</i>\n` : "") +
      `${"━".repeat(28)}\n` +
      `💰 Price: <b>${fmtPrice(detail.price)}</b>\n` +
      `${trend1h} 1h: <b>${changeStr(c1h)}</b>  ${trend24h} 24h: <b>${changeStr(c24h)}</b>  ${trend7d} 7d: <b>${changeStr(c7d)}</b>\n` +
      (c30d !== 0 ? `📆 30d: <b>${changeStr(c30d)}</b>\n` : "") +
      `${"─".repeat(28)}\n` +
      `📊 Market Cap: <b>${fmtCompact(detail.marketCapUsd)}</b>\n` +
      (detail.fdvUsd > 0 ? `🏦 FDV: <b>${fmtCompact(detail.fdvUsd)}</b>\n` : "") +
      `💧 Volume 24h: <b>${fmtCompact(detail.volume24hUsd)}</b>\n` +
      (detail.circulatingSupply > 0 ? `🔄 Circ. Supply: <b>${fmtCompact(detail.circulatingSupply).replace("$","")}</b>\n` : "") +
      `${"─".repeat(28)}\n` +
      contractLine +
      (explorerUrl ? `🔗 <a href="${explorerUrl}">Explorer</a>` : "") +
      (dexUrl ? `  •  <a href="${dexUrl}">DexScreener</a>` : "") +
      (explorerUrl || dexUrl ? "\n" : "") +
      balLine;

    const bc = bestChain; // buy chain (auto-detected)
    const sc = balChain; // sell chain (where balance was found)
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(`🟢 Buy $10 on ${chainNames[bc] ?? bc}`, `buy_amt:${sym}:10:${bc}`),
        Markup.button.callback(`🟢 Buy $50`, `buy_amt:${sym}:50:${bc}`),
        Markup.button.callback(`🟢 Buy $100`, `buy_amt:${sym}:100:${bc}`),
      ],
      [
        Markup.button.callback("🟢 Buy $250", `buy_amt:${sym}:250:${bc}`),
        Markup.button.callback("🟢 Custom Buy", `buy_custom:${sym}:${bc}`),
      ],
      ...(hasBalance ? [
        [
          Markup.button.callback("🔴 Sell 25%", `sell_pct:${sym}:25:${sc}`),
          Markup.button.callback("🔴 Sell 50%", `sell_pct:${sym}:50:${sc}`),
          Markup.button.callback("🔴 Sell 100%", `sell_pct:${sym}:100:${sc}`),
        ],
        [Markup.button.callback("🔴 Custom Sell", `sell_custom:${sym}:${sc}`)],
      ] : []),
      [
        Markup.button.callback("⚡ DCA", `dca_token:${sym}`),
        Markup.button.callback("🔔 Alert", `alert_token:${sym}`),
        Markup.button.callback("🎯 Limit", `limit_token:${sym}`),
      ],
      [Markup.button.callback("🔙 Back to Home", "home")],
    ]);

    try {
      if (mode === "edit") await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard.reply_markup, link_preview_options: { is_disabled: true } });
      else await ctx.reply(text, { parse_mode: "HTML", ...keyboard, link_preview_options: { is_disabled: true } });
    } catch { await ctx.reply(text, { parse_mode: "HTML", ...keyboard, link_preview_options: { is_disabled: true } }); }
  }

  // ─── BUY SEARCH ────────────────────────────────────────────────────────
  bot.action("buy_search", async (ctx) => {
    await ctx.answerCbQuery();
    convState.set(String(ctx.from.id), { step: "TOKEN_SEARCH", data: { mode: "buy" } });
    await ctx.reply(
      `🟢 <b>Buy Token</b>\n\nType a token name, symbol, or contract address:\n\n` +
      `Examples: <code>ETH</code>  <code>WBTC</code>  <code>cbETH</code>  <code>0x1234…</code>\n\n` +
      `Or just type any coin name in the chat — I'll look it up automatically!`,
      { parse_mode: "HTML" }
    );
  });

  // ─── SELL SEARCH ───────────────────────────────────────────────────────
  bot.action("sell_search", async (ctx) => {
    await ctx.answerCbQuery("📈 Loading positions…");
    const user = await requireUser(ctx);
    if (!user) return;

    type SellPos = { symbol: string; amount: string; valueUsd: number; chain: string };
    const sellable: SellPos[] = [];

    // Aggregate EVM positions (Base is the display chain)
    try {
      const evmPos = await getPortfolio(user.walletAddress, "base");
      evmPos
        .filter(p => !["USDC","USDbC","USDC.e"].includes(p.symbol) && p.valueUsd > 0.01)
        .forEach(p => sellable.push({ symbol: p.symbol, amount: p.amount, valueUsd: p.valueUsd, chain: "base" }));
    } catch { /* offline */ }

    // Aggregate Solana positions
    if (user.solanaPubkey) {
      try {
        const solPos = await getSolanaPortfolio(user.solanaPubkey);
        solPos
          .filter(p => p.symbol !== "USDC" && p.valueUsd > 0.01)
          .forEach(p => sellable.push({ symbol: p.symbol, amount: p.amount, valueUsd: p.valueUsd, chain: "solana" }));
      } catch { /* offline */ }
    }

    // Deduplicate by symbol (keep highest-value entry)
    const deduped = Object.values(
      sellable.reduce<Record<string, SellPos>>((acc, p) => {
        if (!acc[p.symbol] || p.valueUsd > acc[p.symbol].valueUsd) acc[p.symbol] = p;
        return acc;
      }, {})
    ).sort((a, b) => b.valueUsd - a.valueUsd);

    if (!deduped.length) {
      const errMsg = `🔴 <b>Sell Token</b>\n\nYou have no sellable positions.\n\nBuy some tokens first with 🟢 Buy.`;
      try { await ctx.editMessageText(errMsg, { parse_mode: "HTML", reply_markup: backKeyboard().reply_markup }); }
      catch { await ctx.reply(errMsg, { parse_mode: "HTML", ...backKeyboard() }); }
      return;
    }

    const chainEmoji: Record<string, string> = { solana: "🟢", base: "🔵", arbitrum: "🔷", optimism: "🔴", polygon: "🟣", "binance-smart-chain": "🟡" };
    const rows = deduped.map(pos => [
      Markup.button.callback(
        `${chainEmoji[pos.chain] ?? "🔴"} ${pos.symbol} — ${pos.amount} (~$${fmt(pos.valueUsd)})`,
        `token_info:${pos.symbol}`
      ),
    ]);
    rows.push([Markup.button.callback("🔙 Back", "home")]);

    const text = `🔴 <b>Sell Token</b>\n<i>Positions across EVM + Solana</i>\n\nSelect a position to sell:`;
    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(rows).reply_markup }); }
    catch { await ctx.reply(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) }); }
  });

  // ─── TOKEN INFO CARD ───────────────────────────────────────────────────
  bot.action(/^token_info:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery("🔍 Loading token info…");
    await showTokenCard(ctx, ctx.match[1], "edit");
  });

  // ─── AUTO-DETECT BEST CHAIN FOR TOKEN ─────────────────────────────────
  // Priority: solana > base > arbitrum > optimism > polygon > binance-smart-chain > first available
  const CHAIN_PRIORITY = ["solana", "base", "arbitrum", "optimism", "polygon", "binance-smart-chain"];

  function pickBestChain(implementations: { chainId: string }[]): string {
    for (const c of CHAIN_PRIORITY) {
      if (implementations.some(i => i.chainId === c)) return c;
    }
    return implementations[0]?.chainId ?? "base";
  }

  // ─── CHAIN-AWARE BUY HELPER ────────────────────────────────────────────
  async function executeBuy(
    user: Awaited<ReturnType<typeof requireUser>> & object,
    symbol: string,
    amountUsd: number,
    chain: string
  ): Promise<{ txHash: string; outAmount: string; chain: string; explorer: string }> {
    if (chain === "solana") {
      if (!user.solanaPubkey || !user.encryptedSolanaKey) throw new Error("No Solana wallet. Send /start.");
      const usdcBal = await getSolanaUsdcBalance(user.solanaPubkey);
      if (usdcBal < amountUsd * 0.99) throw new Error(`Insufficient USDC on Solana. Have $${fmt(usdcBal)}, need $${amountUsd}.`);
      const tokenMeta = await searchTokenByName(symbol, "solana");
      if (!tokenMeta?.address) throw new Error(`Token ${symbol} not found on Solana.`);
      const keypair = getSolanaKeypair(user.encryptedSolanaKey);
      const result = await jupiterBuyToken(keypair, tokenMeta.address, amountUsd);
      const outTokens = (parseInt(result.outAmount) / 1e9).toFixed(6);
      return { txHash: result.txid, outAmount: `${outTokens} ${symbol}`, chain, explorer: SOLANA_CHAIN.explorer };
    } else {
      const chainCfg = CHAINS[chain] ?? CHAINS.base;
      const usdcBal = await getUsdcBalance(user.walletAddress, chain);
      if (usdcBal < amountUsd * 0.99) throw new Error(`Insufficient USDC on ${chainCfg.name}. Have $${fmt(usdcBal)}, need $${amountUsd}.`);
      const found = await searchTokenByName(symbol, chain);
      const toAddress = found?.address ?? "";
      if (!toAddress) throw new Error(`Token ${symbol} not found on ${chainCfg.name}.`);
      const quote = await getSwapQuote(user.walletAddress, chainCfg.usdcAddress, toAddress, amountUsd, 1.0, chain);
      const wallet = getWallet(user.encryptedPrivateKey, chain);
      const txHash = await executeSwapTx(user.walletAddress, toAddress, quote.txData, wallet);
      return { txHash, outAmount: `${quote.toAmount} ${symbol}`, chain, explorer: chainCfg.explorer };
    }
  }

  async function executeSell(
    user: Awaited<ReturnType<typeof requireUser>> & object,
    symbol: string,
    pct: number,
    chain: string
  ): Promise<{ txHash: string; soldAmount: string; receivedUsdc: string; chain: string; explorer: string }> {
    if (chain === "solana") {
      if (!user.solanaPubkey || !user.encryptedSolanaKey) throw new Error("No Solana wallet. Send /start.");
      const positions = await getSolanaPortfolio(user.solanaPubkey);
      const pos = positions.find(p => p.symbol === symbol);
      if (!pos || pos.valueUsd < 0.01) throw new Error(`No ${symbol} balance on Solana.`);
      const totalAmount = parseFloat(pos.amount);
      const sellAmount = totalAmount * (pct / 100);
      const tokenMeta = await searchTokenByName(symbol, "solana");
      if (!tokenMeta?.address) throw new Error(`Token mint not found for ${symbol} on Solana.`);
      const keypair = getSolanaKeypair(user.encryptedSolanaKey);
      const result = await jupiterSellToken(keypair, tokenMeta.address, 9, sellAmount);
      return {
        txHash: result.txid,
        soldAmount: `${sellAmount.toFixed(6)} ${symbol}`,
        receivedUsdc: `$${fmt(result.outAmountUsdc)}`,
        chain,
        explorer: SOLANA_CHAIN.explorer,
      };
    } else {
      const chainCfg = CHAINS[chain] ?? CHAINS.base;
      const positions = await getPortfolio(user.walletAddress, chain);
      const pos = positions.find(p => p.symbol === symbol);
      if (!pos || pos.valueUsd < 0.01) throw new Error(`No ${symbol} balance on ${chainCfg.name}.`);
      const totalAmount = parseFloat(pos.amount);
      const sellAmount = totalAmount * (pct / 100);
      const tokenInfo = SUPPORTED_TOKENS[symbol];
      const decimals = tokenInfo?.decimals ?? 18;
      const fromAddress = tokenInfo?.address ?? pos.address;
      if (!fromAddress) throw new Error(`Cannot determine token address for ${symbol}.`);
      const quote = await getSellQuote(user.walletAddress, fromAddress, decimals, sellAmount, 1.0, chain);
      const wallet = getWallet(user.encryptedPrivateKey, chain);
      const txHash = await executeSwapTx(user.walletAddress, chainCfg.usdcAddress, quote.txData, wallet);
      return {
        txHash,
        soldAmount: `${sellAmount.toFixed(6)} ${symbol} (${pct.toFixed(0)}%)`,
        receivedUsdc: `~$${fmt(quote.toAmountUsd)}`,
        chain,
        explorer: chainCfg.explorer,
      };
    }
  }

  // ─── BUY AMOUNT ─── callback: buy_amt:SYM:AMT:CHAIN ──────────────────
  bot.action(/^buy_amt:([^:]+):(\d+(?:\.\d+)?):?([^:]*)$/, async (ctx) => {
    await ctx.answerCbQuery("⏳ Fetching quote…");
    const symbol = ctx.match[1];
    const amountUsd = parseFloat(ctx.match[2]);
    const chain = ctx.match[3] || "base";
    const user = await requireUser(ctx);
    if (!user) return;
    await ctx.reply(`⏳ <b>Buying $${amountUsd} of ${symbol}…</b>\n${getChainLabel(chain)} — finding best route…`, { parse_mode: "HTML" });
    try {
      const result = await executeBuy(user as any, symbol, amountUsd, chain);
      await ctx.reply(
        `✅ <b>Buy Executed!</b>\n\n` +
        `Chain: <b>${getChainLabel(result.chain)}</b>\n` +
        `Bought: <b>${result.outAmount}</b>\n` +
        `Spent: <b>$${amountUsd} USDC</b>\n` +
        `🔗 <a href="${result.explorer}${result.txHash}">View Transaction</a>`,
        { parse_mode: "HTML", ...backKeyboard() }
      );
    } catch (err: any) {
      logger.error({ err }, "buy_amt error");
      await ctx.reply(`❌ <b>Buy Failed:</b> ${err.message}`, { parse_mode: "HTML", ...backKeyboard() });
    }
  });

  // ─── CUSTOM BUY ─── callback: buy_custom:SYM:CHAIN ───────────────────
  bot.action(/^buy_custom:([^:]+):?([^:]*)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const symbol = ctx.match[1];
    const chain = ctx.match[2] || "base";
    convState.set(String(ctx.from.id), { step: "BUY_CUSTOM_AMOUNT", data: { symbol, chain } });
    await ctx.reply(`🟢 <b>Custom Buy: ${symbol}</b> on <b>${getChainLabel(chain)}</b>\n\nEnter USDC amount to spend:`, { parse_mode: "HTML" });
  });

  // ─── SELL PERCENTAGE ─── callback: sell_pct:SYM:PCT:CHAIN ────────────
  bot.action(/^sell_pct:([^:]+):(\d+):?([^:]*)$/, async (ctx) => {
    await ctx.answerCbQuery("⏳ Preparing sell…");
    const symbol = ctx.match[1];
    const pct = parseInt(ctx.match[2]);
    const chain = ctx.match[3] || "base";
    const user = await requireUser(ctx);
    if (!user) return;
    await ctx.reply(`⏳ <b>Selling ${pct}% of ${symbol}…</b>\n${getChainLabel(chain)}`, { parse_mode: "HTML" });
    try {
      const result = await executeSell(user as any, symbol, pct, chain);
      await ctx.reply(
        `✅ <b>Sell Executed!</b>\n\n` +
        `Chain: <b>${getChainLabel(result.chain)}</b>\n` +
        `Sold: <b>${result.soldAmount}</b>\n` +
        `Received: <b>${result.receivedUsdc} USDC</b>\n` +
        `🔗 <a href="${result.explorer}${result.txHash}">View Transaction</a>`,
        { parse_mode: "HTML", ...backKeyboard() }
      );
    } catch (err: any) {
      logger.error({ err }, "sell_pct error");
      await ctx.reply(`❌ <b>Sell Failed:</b> ${err.message}`, { parse_mode: "HTML", ...backKeyboard() });
    }
  });

  // ─── CUSTOM SELL ─── callback: sell_custom:SYM:CHAIN ─────────────────
  bot.action(/^sell_custom:([^:]+):?([^:]*)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const symbol = ctx.match[1];
    const chain = ctx.match[2] || "base";
    convState.set(String(ctx.from.id), { step: "SELL_CUSTOM_AMOUNT", data: { symbol, chain } });
    await ctx.reply(
      `🔴 <b>Custom Sell: ${symbol}</b> on <b>${getChainLabel(chain)}</b>\n\nEnter % of holdings to sell (e.g. <code>30</code> for 30%)\nor exact token amount (e.g. <code>0.05</code>):`,
      { parse_mode: "HTML" }
    );
  });

  // ─── /buy and /sell commands ───────────────────────────────────────────
  bot.command("buy", async (ctx) => {
    const parts = ctx.message.text.split(" ");
    const symbol = parts[1]?.toUpperCase();
    if (!symbol) {
      convState.set(String(ctx.from.id), { step: "TOKEN_SEARCH", data: { mode: "buy" } });
      await ctx.reply(`🟢 <b>Buy Token</b>\n\nType a token name or symbol:`, { parse_mode: "HTML" });
      return;
    }
    await ctx.reply(`🔍 Looking up <b>${symbol}</b>…`, { parse_mode: "HTML" });
    await showTokenCard(ctx, symbol, "send");
  });

  bot.command("sell", async (ctx) => {
    const parts = ctx.message.text.split(" ");
    const symbol = parts[1]?.toUpperCase();
    if (!symbol) {
      await ctx.reply(`🔴 Usage: /sell TOKEN\n\nExample: /sell ETH`);
      return;
    }
    await ctx.reply(`🔍 Looking up <b>${symbol}</b>…`, { parse_mode: "HTML" });
    await showTokenCard(ctx, symbol, "send");
  });

  // ─── ERROR HANDLER ─────────────────────────────────────────────────────
  bot.catch((err: unknown, ctx: Context) => {
    logger.error({ err, update: (ctx as any).update }, "Unhandled bot error");
  });

  startScheduler(tgSend);
  return bot;
}
