[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/yinzzhou99-web/makefun-u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/yinzzhou99-web/makefun-u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Clean-Launch Scalper — Pump.fun Sharpe Sprint

A paper-trading bot for the [Pump.fun Sharpe Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) bounty on make.fun. It trades a 6-hour pump.fun replay, ranked by **hourly Sharpe ratio** — steady, controlled gains win, not one lucky moonshot.

## Strategy

A fresh curve's price jumps in its first two slots, so chasing the jump
with a 2-slot fill latency loses. But the **shape of the first few buys**
predicts what happens next: when the first buys are spread across many
wallets (no single buyer taking a quarter or more of the early buy flow),
the launch is organic and the price keeps grinding up; when one wallet
dominates, it dumps. This bot buys **one ticket per coin**, decided on its
6th or 10th trade from the top-share of the early buy flow, and exits on a
wide stop, a trailing stop once the ticket is up, or a short time limit.
Small uniform tickets keep every hourly return smooth — exactly what
hourly Sharpe rewards.

- **Entry:** on the 6th trade, or the 10th if undecided: main ticket
  (0.04 SOL) when the largest early buyer took under 25% of the early buy
  SOL; a small filler ticket (0.011 SOL) when the share is 25–30% (breadth
  for the 20-coin guardrail, at tiny size).
- **Size:** clipped to 80% of the 1%-of-real-reserve cap, never below
  0.0105 SOL (above the 0.01 SOL round-trip floor).
- **Exit:** stop at 92% of cost; trailing stop once value reaches 115% of
  cost (sell on a 5% pullback from the peak); or after 1200 slots held.
- **Limits:** one ticket per coin, at most 5 open positions, never more than
  free cash allows. Fully deterministic — no clock, no randomness.

## Layout

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts`
- `strategy.ts` — the strategy (this bot's own code)
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` wire shim,
  vendored byte for byte

## License

MIT — see [LICENSE](LICENSE).
