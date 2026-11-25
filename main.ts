// Clean-launch scalper: one small early ticket per fresh pump.fun coin,
// out on a tight stop, a trailing stop, or a short time limit.
// The grader runs `node /bot/main.ts` on Node 22; the strategy lives in
// strategy.ts and the wire shim is the kit's sdk/ts/makefun-bot.ts,
// vendored byte for byte as vendor/makefun-bot.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
