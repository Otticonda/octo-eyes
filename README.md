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
| `risk_dial` | Today's meme risk dial (0 to 1) and the market inputs behind it |
| `trade_journal` | Closed trades, win rate and P&L (split by Octo's calls vs the auto baseline), plus every refused buy and why |
| `scanner` | The fastest-filling pump.fun curves from the last 40 minutes |
| `candles` | Price candles for a coin's main pool (1m to 1d), for charts |

## Settings

| Setting | What it's for |
| --- | --- |
| `OCTO_SECRET` | Random text that becomes part of the connector link, so strangers can't use your server. |
| `SOLANA_RPC_URL` | Your Solana RPC link. Get a free one at helius.dev (looks like `https://mainnet.helius-rpc.com/?api-key=...`). The public default works but is slow and rate limited. |
| `WATCH_WALLETS` | Optional. Wallets to always watch, separated by commas (smart money from First In, devs you follow). |

## Trading: paper mode first

**Paper mode is on by default.** Octo trades a simulated bank (1 SOL) at real prices, with no wallet and no real SOL.
Every paper fill pays a cost on each side (3% by default, for pump.fun fees and slippage) plus the priority fee, so paper results aren't flattered.
Going live needs all three: `PAPER_MODE=false`, a wallet in `OCTO_WALLET_KEY`, and `TRADING_ENABLED=true`.

### The rules every buy goes through (paper and live)

1. **Risk dial.** Four market checks: BTC above its 200-day average, SOL above its 50-day, VIX under 22, and US net liquidity
   (Fed balance sheet minus the Treasury account minus reverse repo) rising over 4 weeks. The dial is the share that are green.
   Anything that can't be read or is stale counts as red. Under 0.5 is a **stand-down day**: no buys.
2. **Size.** Requested SOL (capped at `MAX_BUY_SOL`) × the dial, then capped at 2% of the coin's pool so Octo is never the exit.
   Tickets under `MIN_TICKET_SOL` are skipped.
3. **Daily loss stop.** Once the day's realized loss reaches `MAX_DAILY_LOSS_SOL`, no more buys until tomorrow (UTC).
4. **Exits**, checked every 20 seconds: stop loss, half at the first take profit, the rest at the second, **volume dried up**
   (last hour's volume under 20% of the coin's normal hourly pace, checked every 5 minutes), and max hold time.
5. **Every refused buy is logged** with the rule that refused it, in `trade_journal`.

### Auto paper (the baseline)

In paper mode, every 5 minutes Octo paper-buys the scanner's best fresh pick if its token report is clean (rug radar low,
top 10 ≤ 30%, dev ≤ 5%, bundles ≤ 10%). These trades are tagged `auto`. Octo's own calls from chat are tagged `chat`.
The journal splits the stats so you can see whether Octo's judgement beats the mechanical baseline. If it doesn't, it has no edge yet.

### The auto baseline's filter

Based on Otti's Axiom "Final Stretch" filter, translated to what Octo can see. The baseline looks every minute,
reports on up to 3 matching coins, and paper-buys the first that also passes the rug checks
(rug radar low, dev ≤ 5%, bundles ≤ 10%).

| Setting | Default | What it does |
| --- | --- | --- |
| `AUTO_MIN_AGE_MIN` / `AUTO_MAX_AGE_MIN` | 3 / 30 | Coin age window in minutes. |
| `AUTO_MIN_MCAP_USD` | 7000 | Minimum market cap. |
| `AUTO_MAX_TOP10_PCT` | 30 | Most the top 10 holders may own. |
| `AUTO_MIN_CURVE_PCT` | 50 | "Final stretch": how full the pump.fun curve must be. |
| `AUTO_ONLY_ON_CURVE` | on | Skip coins that already migrated. |
| `AUTO_EVERY_SEC` | 60 | How often the baseline looks. |
| `AUTO_REPORTS_PER_RUN` | 3 | Most coins it reports on per look. |

### Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `PAPER_MODE` | on | Set to `false` to trade real SOL. |
| `PAPER_START_SOL` | 1 | Simulated starting bank. |
| `PAPER_COST_PCT` | 3 | Cost charged on each side of a paper fill. |
| `AUTO_PAPER` | on | The 5-minute auto paper trader. `false` turns it off. |
| `OCTO_WALLET_KEY` | none | Live trading wallet's private key (base58, or the `[1,2,...]` array). Use a brand-new wallet. |
| `TRADING_ENABLED` | on in paper, off live | Allows buys. You can also pause and resume from chat. |
| `MAX_BUY_SOL` | 0.1 | Most SOL per buy, before the dial. |
| `DAILY_BUDGET_SOL` | 0.5 | Most SOL spent on buys per day (UTC). |
| `MAX_DAILY_LOSS_SOL` | 0.1 | Realized loss that stops buys for the day. |
| `MAX_POOL_SHARE_PCT` | 2 | Largest buy as a % of the coin's pool. |
| `MIN_TICKET_SOL` | 0.005 | Smaller tickets are skipped. |
| `VOLUME_DEAD_RATIO` | 0.2 | Exit when last hour's volume falls below this share of the normal hourly pace. |
| `MAX_OPEN_POSITIONS` | 3 | Most coins held at once. |
| `RESERVE_SOL` | 0.02 | Always left in the wallet for fees. |
| `TAKE_PROFIT_1_X` | 2 | Sells half at this multiple. |
| `TAKE_PROFIT_2_X` | 3.5 | Sells the rest at this multiple. |
| `STOP_LOSS_PCT` | 35 | Sells everything after this % drop. |
| `MAX_HOLD_HOURS` | 12 | Closes positions held this long. A paper coin that can't be priced by then is written off at zero. |
| `SLIPPAGE_PCT` | 15 | Slippage allowed per live trade. |
| `PRIORITY_FEE_SOL` | 0.0005 | Priority fee per trade. |

Rules the server always applies: it never buys a coin with mint or freeze authority on, never signs a transaction paid by any other wallet.
Live trades go through PumpPortal's trade API, which charges a small fee per trade; check pumpportal.fun for the current rate.
Positions and the journal live in memory. **A restart or redeploy clears the paper bank and journal.** The server pings itself
every 10 minutes so the free plan doesn't sleep, but a redeploy still resets it. Live positions are rebuilt from the wallet after a restart.

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
- In paper mode nothing touches real money. Live trading only happens with the three settings above.
