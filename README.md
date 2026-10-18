# Octo Eyes

Octo's eyes: a small connector (MCP server) that lets Octo and Claude read live Solana token data.
No dependencies. Needs Node 22 or newer.

## What Octo can see

| Tool | What it does |
| --- | --- |
| `token_report` | Everything about a CA in one call: market data, pump.fun details and a safety check |
| `market_data` | DexScreener price, market cap, liquidity, volume, price changes, buys and sells |
| `pumpfun_info` | Creator, bonding curve progress, migrated or not, socials, replies |
| `safety_check` | Mint and freeze authority, top holders, top 10 %, dev holding %, red flags |
| `new_launches` | Newest pump.fun launches, live, with the dev's first buy |
| `watch_wallet` | Start following a wallet's pump.fun buys and sells |
| `watched_wallet_trades` | What the watched wallets just bought and sold |
| `wallet_status` | Octo's trading wallet: balance, open positions, P&L, today's spend, limits |
| `buy` | Buy a token with Octo's wallet, inside the hard limits |
| `sell` | Sell some or all of a holding |
| `set_trading` | The kill switch: pause or resume buys |

## Settings

| Setting | What it's for |
| --- | --- |
| `OCTO_SECRET` | Random text that becomes part of the connector link, so strangers can't use your server. |
| `SOLANA_RPC_URL` | Your Solana RPC link. Get a free one at helius.dev (looks like `https://mainnet.helius-rpc.com/?api-key=...`). The public default works but is slow and rate limited. |
| `WATCH_WALLETS` | Optional. Wallets to always watch, separated by commas (smart money from First In, devs you follow). |

## Trading (optional)

Octo can trade with its own wallet. Use a brand-new wallet that holds only what you're willing to lose, never your main one.

| Setting | Default | What it does |
| --- | --- | --- |
| `OCTO_WALLET_KEY` | none | The trading wallet's private key (base58, or the `[1,2,...]` array). Without it, trading is off. |
| `TRADING_ENABLED` | off | Set to `true` to allow buys. You can also pause and resume from chat. |
| `MAX_BUY_SOL` | 0.05 | Most SOL per buy. Larger requests are cut down to this. |
| `DAILY_BUDGET_SOL` | 0.25 | Most SOL spent on buys per day (UTC). |
| `MAX_OPEN_POSITIONS` | 3 | Most coins held at once. |
| `RESERVE_SOL` | 0.02 | Always left in the wallet for fees. |
| `TAKE_PROFIT_1_X` | 2 | Sells half at this multiple. |
| `TAKE_PROFIT_2_X` | 3.5 | Sells the rest at this multiple. |
| `STOP_LOSS_PCT` | 35 | Sells everything after this % drop. |
| `MAX_HOLD_HOURS` | 12 | Closes positions held this long. |
| `SLIPPAGE_PCT` | 15 | Slippage allowed per trade. |
| `PRIORITY_FEE_SOL` | 0.0005 | Priority fee per trade. |

Rules the server always applies: it never buys a coin with mint or freeze authority on, never signs a transaction paid by any other wallet, and runs exits every 20 seconds.
Trades go through PumpPortal's trade API, which charges a small fee per trade; check pumpportal.fun for the current rate.
Positions live in memory. After a restart, Octo rebuilds them from the coins in its wallet, with entry prices reset to the current price.
While a trading wallet is set, the server pings itself every 10 minutes so the free plan doesn't sleep through an exit.

## Deploy on Render (free)

1. Put these files in a GitHub repo.
2. On render.com: **New → Blueprint**, pick the repo. Render reads `render.yaml`.
3. Paste your Helius link into `SOLANA_RPC_URL` when asked. `OCTO_SECRET` is generated for you.
4. When it's live, open the service's **Environment** tab and copy `OCTO_SECRET`.
5. Your connector link is: `https://<your-service>.onrender.com/mcp/<OCTO_SECRET>`

The free plan sleeps after about 15 minutes without traffic. The first call after that takes about a minute,
and `new_launches` only shows coins seen since it woke up. For live launch watching around the clock,
use a paid instance (Render Starter, Railway or Fly.io).

## Add it to Claude

Claude → Settings → Connectors → **Add custom connector**. Name it **Octo Eyes** and paste the connector link.
Then Octo's page can use it, and you can also ask Claude about any CA in a normal chat.

## Run it on your own machine

```
OCTO_SECRET=pick-something SOLANA_RPC_URL="https://mainnet.helius-rpc.com/?api-key=..." node server.js
```

Health check: `http://localhost:3000/health`

## Notes

- pump.fun has no official public API. This uses the same endpoints its website uses, so it can break if pump.fun changes them. DexScreener and the Solana chain data keep working either way.
- Live launches and wallet trades come from PumpPortal's free data stream.
- Everything here only reads public data. It never holds keys or moves money.
