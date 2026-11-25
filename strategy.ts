// Clean-launch scalper for the pump.fun Sharpe sprint.
//
// Idea, from the dev window: a fresh bonding curve usually pumps hard in its
// first minute (price climbs steadily as early buys land) and then gives most
// of it back. So this bot buys ONE small, fixed-size ticket per coin, early,
// while the climb is still young, and gets out on a tight stop, a trailing
// stop once the ticket is up, or a short time limit. Small uniform tickets
// keep every hourly return smooth, which is what hourly Sharpe rewards.
//
// - Entry: 2..900 slots after creation, price 1.04x..1.60x its create price,
//   real reserves 1.5..40 SOL, and the last 120 slots show real demand:
//   net buy flow >= 0.4 SOL, at least 4 buys, at least 3 distinct buyers.
// - Size: 0.02 SOL per ticket, clipped to 80% of the 1%-of-real-reserve cap
//   and never below 0.012 SOL (the 0.01 SOL round-trip floor plus margin).
// - Exit: stop at 95% of cost, trailing stop once value reaches 115% of
//   cost (sell on a 7% pullback from the peak), or after 2000 slots held.
// - One ticket per coin, at most 5 open, never more than cash allows.
// - Fully deterministic: no clock, no randomness, no environment reads;
//   iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000;
const STAKE_LAMPORTS = 20_000_000; // 0.02 SOL per ticket
const MIN_TICKET_LAMPORTS = 12_000_000; // 0.012 SOL, above the 0.01 SOL round-trip floor
const MAX_OPEN = 5;

const MIN_AGE_SLOTS = 2;
const MAX_AGE_SLOTS = 900;
const MIN_PRICE_UP = 1.04;
const MAX_PRICE_UP = 1.6;
const MIN_REAL_SOL = 1.5;
const MAX_REAL_SOL = 40;
const FLOW_WINDOW_SLOTS = 120;
const MIN_NET_FLOW_SOL = 0.4;
const MIN_BUYS = 4;
const MIN_BUYERS = 3;
const MAX_TAPE = 40;

const STOP_AT = 0.95; // sell when mark value falls to 95% of cost
const TRAIL_ARM_AT = 1.15; // trailing stop arms once value reaches 115% of cost
const TRAIL_BACK = 0.93; // sell on a 7% pullback from the peak value
const MAX_HOLD_SLOTS = 2000;
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 10000;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number; // lamports
  user: string;
}

interface CurveNote {
  createdSlot: number;
  createPrice: number; // SOL per token at creation
  lastPrice: number;
  realQuote: bigint; // lamports of real SOL in the curve
  tape: TapeTrade[];
  complete: boolean;
  entered: boolean; // a ticket was already bought on this coin
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

export function createStrategy(): Bot {
  const notes = new Map<Pubkey, CurveNote>();
  const tickets = new Map<Pubkey, OpenTicket>();

  function noteFor(mint: Pubkey): CurveNote | undefined {
    return notes.get(mint);
  }

  function refreshCurve(state: BotState, mint: Pubkey): CurveNote | undefined {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return undefined;
    let note = notes.get(mint);
    if (note === undefined) {
      if (curve.created_slot === null) return undefined;
      note = {
        createdSlot: curve.created_slot,
        createPrice: priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves),
        lastPrice: priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves),
        realQuote: curve.real_quote_reserves,
        tape: [],
        complete: false,
        entered: false,
      };
      notes.set(mint, note);
    }
    note.lastPrice = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
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
      if (event.event === 'CreateEvent') {
        note.createPrice = priceOf(BigInt(event.virtual_sol_reserves), BigInt(event.virtual_token_reserves));
        note.lastPrice = note.createPrice;
        note.realQuote = 0n;
      } else {
        const sol = Number(BigInt(event.sol_amount));
        note.tape.push({ slot: event.slot, buy: event.is_buy, sol, user: event.user });
        if (note.tape.length > MAX_TAPE) note.tape.splice(0, note.tape.length - MAX_TAPE);
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

  function flowStats(note: CurveNote, nowSlot: number): { netSol: number; buys: number; buyers: number } {
    let netLamports = 0;
    let buys = 0;
    const buyers = new Set<string>();
    for (const trade of note.tape) {
      if (trade.slot < nowSlot - FLOW_WINDOW_SLOTS) continue;
      if (trade.buy) {
        netLamports += trade.sol;
        buys += 1;
        buyers.add(trade.user);
      } else {
        netLamports -= trade.sol;
      }
    }
    return { netSol: netLamports / LAMPORTS_PER_SOL, buys, buyers: buyers.size };
  }

  function tryEnter(state: BotState, mint: Pubkey, orders: OrderInput[]): void {
    const note = noteFor(mint);
    if (note === undefined || note.complete || note.entered) return;
    const age = state.slot - note.createdSlot;
    if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) return;
    if (note.createPrice <= 0 || note.lastPrice <= 0) return;
    const rise = note.lastPrice / note.createPrice;
    if (rise < MIN_PRICE_UP || rise > MAX_PRICE_UP) return;
    const realSol = Number(note.realQuote) / LAMPORTS_PER_SOL;
    if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) return;
    const flow = flowStats(note, state.slot);
    if (flow.netSol < MIN_NET_FLOW_SOL || flow.buys < MIN_BUYS || flow.buyers < MIN_BUYERS) return;
    if (state.positions.has(mint)) return;
    for (const pending of state.pending.values()) {
      if (pending.order.mint === mint) return;
    }
    if (state.committedPositionCount() >= MAX_OPEN) return;
    const cap = state.maxBuyLamports(mint);
    const size = cap < BigInt(STAKE_LAMPORTS) ? (cap * 80n) / 100n : BigInt(STAKE_LAMPORTS);
    if (size < BigInt(MIN_TICKET_LAMPORTS)) return;
    const need = size + 2n * state.txFeeLamports();
    if (state.freeCashLamports() < need) return;
    orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
    note.entered = true;
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
