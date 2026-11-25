[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/yinzzhou99-web/makefun-u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/yinzzhou99-web/makefun-u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Clean-Launch Scalper — Pump.fun Sharpe Sprint

A paper-trading bot for the [Pump.fun Sharpe Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) bounty on make.fun. It trades a 6-hour pump.fun replay, ranked by **hourly Sharpe ratio** — steady, controlled gains win, not one lucky moonshot.

## Strategy

Fresh bonding curves usually pump hard in their first minute and then give
most of it back. This bot buys **one small fixed ticket (0.02 SOL) per coin,
early**, while the climb is still young, and exits on a tight stop, a
trailing stop once the ticket is up, or a short time limit. Small uniform
tickets keep every hourly return smooth — exactly what hourly Sharpe rewards.

- **Entry:** 2–900 slots after creation, price 1.04×–1.60× its create price,
  real reserves 1.5–40 SOL, and the last 120 slots show real demand: net buy
  flow ≥ 0.4 SOL, ≥ 4 buys, ≥ 3 distinct buyers.
- **Size:** 0.02 SOL per ticket, clipped to 80% of the 1%-of-real-reserve cap,
  never below 0.012 SOL (above the 0.01 SOL round-trip floor).
- **Exit:** stop at 95% of cost; trailing stop once value reaches 115% of
  cost (sell on a 7% pullback from the peak); or after 2000 slots held.
- **Limits:** one ticket per coin, at most 5 open positions, never more than
  free cash allows. Fully deterministic — no clock, no randomness.

## Layout

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts`
- `strategy.ts` — the strategy (this bot's own code)
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` wire shim,
  vendored byte for byte

## License

MIT — see [LICENSE](LICENSE).
