# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM (workspace DB) + Prisma (bot DB)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Telegram DCA Bot

A multi-user autonomous DCA (Dollar-Cost Averaging) Telegram bot deployed alongside the API server.

### Features
- Per-user isolated wallets (EVM, Base mainnet) — AES-256 encrypted private keys
- Recurring token purchases via Zerion API swap routing
- Policy enforcement: chain lock, daily cap, slippage cap, balance check, expiry
- Global cron scheduler (every minute) for all users' DCA configs
- Full command set: /start, /wallet, /setup, /mystatus, /pause, /resume, /cancel, /history, /policies, /price, /help

### Bot Name
`@Zerion_DCA_bot` on Telegram

### Environment Variables Required
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `ZERION_API_KEY` — from dashboard.zerion.io
- `MASTER_ENCRYPTION_KEY` — 32-byte hex for AES-256 wallet encryption
- `RPC_URL` — Alchemy/Infura Base mainnet RPC URL
- `BOT_DATABASE_URL` — PostgreSQL connection string (currently using local workspace DB as fallback)

### Bot Source Files
- `artifacts/api-server/src/bot/bot.ts` — All Telegram command handlers
- `artifacts/api-server/src/bot/scheduler.ts` — Global cron loop
- `artifacts/api-server/src/bot/swap.ts` — Swap orchestration
- `artifacts/api-server/src/bot/policies.ts` — All policy enforcement
- `artifacts/api-server/src/bot/wallet.ts` — Wallet generation + AES encryption
- `artifacts/api-server/src/bot/zerion.ts` — Zerion API wrapper
- `artifacts/api-server/src/bot/db.ts` — Prisma client setup
- `artifacts/api-server/prisma/schema.prisma` — Database schema

### Database
Uses local workspace PostgreSQL (helium:5432/heliumdb). Tables pushed via Prisma.
For production, update `db.ts` to use the external `BOT_DATABASE_URL` (Supabase) which is unreachable from Replit dev environment but works from deployed servers.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server + Telegram bot locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
