// Broad-launch scalper for the pump.fun Sharpe sprint.
//
// What the dev window shows: a fresh curve's price jumps in its first two
// slots, so chasing the jump with a 2-slot fill latency loses. But the
// SHAPE of the first few buys predicts what happens next: when the first
// buys are spread across many wallets (no single buyer taking a quarter or
// more of the early buy flow), the launch is organic and the price keeps
// grinding up; when one wallet dominates, it dumps. So this bot buys one
// ticket per coin, decided on its 6th or 10th trade from the top-share of
// the early buy flow, and gets out on a wide stop, a trailing stop once the
// ticket is up, or a short time limit. Small uniform tickets keep every
// hourly return smooth, which is what hourly Sharpe rewards.
//
// - Entry: on the 6th trade, or the 10th if undecided, look at the first
//   6 / 10 trades. Main ticket when the largest single buyer took under
//   25% of the early buy SOL; a small filler ticket when the share is
//   25-30% (it only buys breadth for the 20-coin guardrail, at tiny size).
// - Size: 0.04 SOL main, 0.011 SOL filler, each clipped to 80% of the
//   1%-of-real-reserve cap and never below 0.0105 SOL (the 0.01 SOL
//   round-trip floor plus margin).
// - Exit: stop at 92% of cost, trailing stop once value reaches 115% of
//   cost (sell on a 5% pullback from the peak), or after 1200 slots held.
// - One ticket per coin, at most 5 open, never more than cash allows.
// - Fully deterministic: no clock, no randomness, no environment reads;
//   iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000;
const MAIN_TICKET_LAMPORTS = 40_000_000; // 0.04 SOL per main ticket
const FILLER_TICKET_LAMPORTS = 11_000_000; // 0.011 SOL per filler ticket
const MIN_TICKET_LAMPORTS = 10_500_000; // just above the 0.01 SOL round-trip floor
const MAX_OPEN = 5;

const EARLY_TRADES = 6; // first decision point: the 6th trade
const LATE_TRADES = 10; // second decision point: the 10th trade
const MAIN_TOP_SHARE = 0.25; // largest early buyer under 25% of early buy SOL
const FILLER_TOP_SHARE = 0.3; // filler band: 25-30%
const MAX_TAPE = 12; // only the first trades matter for the entry filter

const STOP_AT = 0.92; // sell when mark value falls to 92% of cost
const TRAIL_ARM_AT = 1.15; // trailing stop arms once value reaches 115% of cost
const TRAIL_BACK = 0.95; // sell on a 5% pullback from the peak value
const MAX_HOLD_SLOTS = 1200;
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 10000;

interface TapeTrade {
  buy: boolean;
  sol: number; // lamports
  user: string;
}

interface CurveNote {
  createdSlot: number | null;
  realQuote: bigint; // lamports of real SOL in the curve
  tape: TapeTrade[];
  trades: number; // TradeEvents seen on this curve
  decided: boolean; // the entry filter already ran its course here
  entered: boolean; // a ticket was already bought on this coin
  complete: boolean;
}

interface OpenTicket {
  cost: number; // lamports actually spent (fees included)
  tokens: bigint;
  buySlot: number;
  peakValue: number; // lamports, best mark value seen since the buy
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

/** Largest single buyer's share of buy SOL over the tape's first `count` trades. */
function topShare(tape: TapeTrade[], count: number): number {
  const perBuyer = new Map<string, number>();
  let total = 0;
  const n = Math.min(count, tape.length);
  for (let i = 0; i < n; i++) {
    const trade = tape[i];
    if (!trade.buy) continue;
    total += trade.sol;
    perBuyer.set(trade.user, (perBuyer.get(trade.user) ?? 0) + trade.sol);
  }
  if (total <= 0) return 1;
  let biggest = 0;
  for (const sol of perBuyer.values()) if (sol > biggest) biggest = sol;
  return biggest / total;
}

export function createStrategy(): Bot {
  const notes = new Map<Pubkey, CurveNote>();
  const tickets = new Map<Pubkey, OpenTicket>();

  function refreshCurve(state: BotState, mint: Pubkey): CurveNote | undefined {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return undefined;
    let note = notes.get(mint);
    if (note === undefined) {
      note = {
        createdSlot: curve.created_slot,
        realQuote: curve.real_quote_reserves,
        tape: [],
        trades: 0,
        decided: false,
        entered: false,
        complete: false,
      };
      notes.set(mint, note);
    }
    note.realQuote = curve.real_quote_reserves;
    note.complete = curve.complete;
    return note;
  }

  function foldEvents(state: BotState, batch: Batch): Pubkey[] {
    const touched: Pubkey[] = [];
    const seen = new Set<Pubkey>();
    for (const event of batch.events) {
      if (event.event === 'CompleteEvent') {
        const note = notes.get(event.mint);
        if (note !== undefined) note.complete = true;
        continue;
      }
      const note = refreshCurve(state, event.mint);
      if (note === undefined) continue;
      if (event.event === 'TradeEvent') {
        note.trades += 1;
        if (note.tape.length < MAX_TAPE) {
          note.tape.push({ buy: event.is_buy, sol: Number(BigInt(event.sol_amount)), user: event.user });
        }
      }
      if (!seen.has(event.mint)) {
        seen.add(event.mint);
        touched.push(event.mint);
      }
    }
    return touched;
  }

  function foldFills(state: BotState, batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      if (fill.side === 'buy' && !fill.client_id.startsWith('_')) {
        tickets.set(fill.mint, {
          cost: Number(BigInt(fill.quote_lamports)),
          tokens: BigInt(fill.token_amount),
          buySlot: fill.slot,
          peakValue: 0,
        });
        const note = notes.get(fill.mint);
        if (note !== undefined) note.entered = true;
      } else if (fill.side === 'sell') {
        tickets.delete(fill.mint);
      }
    }
    // Positions the harness closed on its own (complete / flatten / writeoff)
    // arrive as sell fills too; anything left in tickets with no position is stale.
    for (const mint of [...tickets.keys()]) {
      if (!state.positions.has(mint)) tickets.delete(mint);
    }
  }

  function buyTicket(state: BotState, mint: Pubkey, ticket: bigint, orders: OrderInput[]): void {
    if (state.positions.has(mint)) return;
    for (const pending of state.pending.values()) {
      if (pending.order.mint === mint) return;
    }
    if (state.committedPositionCount() >= MAX_OPEN) return;
    const cap = state.maxBuyLamports(mint);
    const size = cap < ticket ? (cap * 80n) / 100n : ticket;
    if (size < BigInt(MIN_TICKET_LAMPORTS)) return;
    const need = size + 2n * state.txFeeLamports();
    if (state.freeCashLamports() < need) return;
    orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
    const note = notes.get(mint);
    if (note !== undefined) note.entered = true;
  }

  function tryEnter(state: BotState, mint: Pubkey, orders: OrderInput[]): void {
    const note = notes.get(mint);
    if (note === undefined || note.complete || note.entered || note.decided) return;
    if (note.createdSlot === null) return; // only coins seen from their creation
    if (note.trades >= EARLY_TRADES) {
      const share6 = topShare(note.tape, EARLY_TRADES);
      if (share6 < MAIN_TOP_SHARE) {
        buyTicket(state, mint, BigInt(MAIN_TICKET_LAMPORTS), orders);
        note.decided = true;
        return;
      }
    }
    if (note.trades >= LATE_TRADES) {
      const share10 = topShare(note.tape, LATE_TRADES);
      if (share10 < MAIN_TOP_SHARE) {
        buyTicket(state, mint, BigInt(MAIN_TICKET_LAMPORTS), orders);
      } else if (share10 < FILLER_TOP_SHARE) {
        buyTicket(state, mint, BigInt(FILLER_TICKET_LAMPORTS), orders);
      }
      note.decided = true;
    }
  }

  function tryExit(state: BotState, mint: Pubkey, orders: OrderInput[]): void {
    const ticket = tickets.get(mint);
    const holding = state.positions.get(mint);
    if (ticket === undefined || holding === undefined) return;
    for (const pending of state.pending.values()) {
      if (pending.order.mint === mint && pending.order.side === 'sell') return;
    }
    const curve = state.curves.get(mint);
    if (curve === undefined) return;
    const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (price <= 0) return;
    const value = Number(holding.token_amount) * price;
    if (value > ticket.peakValue) ticket.peakValue = value;
    const cost = ticket.cost;
    let sell = false;
    if (value <= STOP_AT * cost) sell = true;
    else if (ticket.peakValue >= TRAIL_ARM_AT * cost && value <= TRAIL_BACK * ticket.peakValue) sell = true;
    else if (state.slot - ticket.buySlot >= MAX_HOLD_SLOTS) sell = true;
    if (sell) {
      orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      foldFills(state, batch);
      const touched = foldEvents(state, batch);
      const orders: OrderInput[] = [];
      for (const mint of state.positions.keys()) tryExit(state, mint, orders);
      for (const mint of touched) tryEnter(state, mint, orders);
      return orders;
    },
  };
}
