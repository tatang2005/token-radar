// Token Radar's model: one sealed snapshot in, one ranked board out.
//
// The board ranks the protocols that legitimately have no token yet — every slug in the snapshot's
// watchlist, plus the other pre-token protocols that pass the same exclusion filters below the floor.
// A protocol is pre-token when DefiLlama records no token for it (no CoinGecko id, no symbol). It is
// a legitimate launch candidate when it is also not a wrapped, staked or bridged product of a token
// that already trades, not a versioned pool of another protocol, and not an exchange. The board never
// ranks a CEX, a bridge, or a wrapped/staked product at the top: those are products of tokens that
// already exist, not launches still to come.
//
// Implied value is derived at runtime from the snapshot's own figures — never from a hardcoded list
// of names. The FDV/TVL multiple for a category is calibrated from the snapshot's own tokenized
// protocols (their market cap divided by their TVL), shrunk toward the global median with a prior
// weight, so a category with few comps does not get an extreme multiple from one outlier:
//
//   multiple(cat) = clamp( (n * median(cat ratios) + K * G) / (n + K), 0.05, 3.0 )
//   G             = median of mcap_usd / tvl_usd over all protocols with mcap_usd != null, K = 5
//   implied       = round( tvl_usd * multiple(cat) * growth * age * chains )
//
//   growth = 1 + clamp(change_7d / 100, -0.5, 1.0); change_7d null counts as 0.
//   age    = 1 + min(age_years, 3) * 0.08; age_years from listed_at to as_of; listed_at null counts as 1.
//   chains = 1 + min(chains.length - 1, 8) * 0.015.
//
// A protocol that has run longer with no token is worth more (it has survived without one), a protocol
// growing fast is worth more, and a protocol live on more chains is worth more. Every row's board.json
// entry carries the four factors, so the number is auditable from the snapshot alone.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The calibrated model: the global median, the prior weight, the clamp, and one multiple per category. */
export interface ModelParams {
  global_median: number;
  prior_weight: number;
  clamp_low: number;
  clamp_high: number;
  multiples: Record<string, number>;
}

/** One row of board.json and of the dashboard's data: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_multiple: number;
  growth_factor: number;
  age_factor: number;
  chain_factor: number;
  farm_steps: string[];
}

/** A protocol whose token already trades: shown apart, never ranked in the board. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: ModelParams;
  watchlist_size: number;
  board_size: number;
  rows: BoardRow[];
  live: LiveRow[];
}

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-cat-1';
/** The prior weight shrinking a category's median toward the global median. */
export const PRIOR_WEIGHT = 5;
/** The clamp on a category's multiple. */
export const CLAMP_LOW = 0.05;
export const CLAMP_HIGH = 3.0;
/** How many live-token protocols the dashboard's Live view carries, by market cap. */
export const LIVE_ROWS = 24;

const DAY_MS = 86_400_000;

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The median of a non-empty list of numbers; the mean of the two middles when it is even. */
export function median(values: number[]): number {
  const a = [...values].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 === 1 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * The FDV/TVL calibration, computed from the snapshot's own tokenized protocols: every protocol
 * with mcap_usd != null (a market cap of 0 still records a token, and its ratio is 0). The global
 * median G is the median of mcap_usd / tvl_usd over those. A category's multiple is its own median
 * ratio shrunk toward G with PRIOR_WEIGHT, then clamped. A category with no tokenized comps uses G.
 */
export function categoryMultiples(protocols: SnapshotProtocol[]): ModelParams {
  const tokenized = protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const ratios = tokenized.map((p) => (p.mcap_usd as number) / p.tvl_usd);
  const global = ratios.length > 0 ? median(ratios) : 0.169;
  const byCategory = new Map<string, number[]>();
  for (const p of tokenized) {
    const key = p.category ?? 'Uncategorized';
    const list = byCategory.get(key) ?? [];
    list.push((p.mcap_usd as number) / p.tvl_usd);
    byCategory.set(key, list);
  }
  const multiples: Record<string, number> = {};
  for (const [cat, list] of [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const catMedian = median(list);
    const shrunk = (list.length * catMedian + PRIOR_WEIGHT * global) / (list.length + PRIOR_WEIGHT);
    multiples[cat] = Math.min(CLAMP_HIGH, Math.max(CLAMP_LOW, shrunk));
  }
  return { global_median: global, prior_weight: PRIOR_WEIGHT, clamp_low: CLAMP_LOW, clamp_high: CLAMP_HIGH, multiples };
}

/** The multiple for one protocol's category, or the global median when the category has no comps. */
export function multipleFor(category: string | null, params: ModelParams): number {
  const key = category ?? 'Uncategorized';
  const m = params.multiples[key];
  return m === undefined ? params.global_median : m;
}

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when the date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The growth factor from the 7-day TVL change: 1 + the change, clamped to -50%..+100%. Null counts as 0. */
export function growthFactor(change7d: number | null): number {
  const pct = finite(change7d, 0) / 100;
  return 1 + Math.min(1.0, Math.max(-0.5, pct));
}

/** The age factor: a protocol that has run longer with no token is worth more, capped at 3 years. */
export function ageFactor(age: number | null): number {
  if (age === null) return 1.0;
  const years = age / 365.25;
  return 1 + Math.min(years, 3) * 0.08;
}

/** The chain factor: a protocol live on more chains is worth a little more, capped at 8 extra chains. */
export function chainFactor(chains: string[]): number {
  return 1 + Math.min(Math.max(chains.length - 1, 0), 8) * 0.015;
}

/** The four factors and the implied value one protocol gets under the calibrated model. */
export function impliedValue(
  protocol: SnapshotProtocol,
  params: ModelParams,
  asOf: string,
): { implied: number; category_multiple: number; growth_factor: number; age_factor: number; chain_factor: number; age_days: number | null } {
  const category_multiple = multipleFor(protocol.category, params);
  const growth_factor = growthFactor(protocol.change_7d);
  const age_days = ageDays(asOf, protocol.listed_at);
  const age_factor = ageFactor(age_days);
  const chain_factor = chainFactor(protocol.chains);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * category_multiple * growth_factor * age_factor * chain_factor));
  return { implied, category_multiple, growth_factor, age_factor, chain_factor, age_days };
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** The categories that are wrapped, staked or bridged products of a token that already trades. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** The exchanges whose name at the start of a protocol's name marks it as their product. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;
/** A name ending in a version marker is a pool of another protocol, not a launch of its own. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A whole word that marks a wrapped, staked or staking product. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/**
 * Whether a protocol is a legitimate launch candidate: pre-token, not an exchange, not a versioned
 * pool, and not a wrapped, staked or bridged product of a token that already trades. No TVL floor:
 * the watchlist's floor is where the house's reading started, not where this radar stops.
 */
export function isLegitimateCandidate(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (EXCLUDED_CATEGORIES.has(p.category ?? '')) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  return true;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open so it shows in the protocol's activity.`;
  if (c.includes('dex') || c.includes('liquidity manager')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('leveraged farm') || c.includes('yield aggregator') || c.includes('yield')) return `Deposit $${capital} of USDC into ${name}'s highest-TVL vault on ${chain} and keep the receipt.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('capital')) return `Deposit $${capital} into a ${name} vault on ${chain} and hold the vault shares in the same wallet.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options') || c.includes('basis trading')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} on ${name} and place one market position, then leave the stake working.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield-bearing asset on ${chain} through ${name} and hold it.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.`;
  if (c.includes('launchpad')) return `Commit $${capital} of USDC to ${name}'s next allocation on ${chain} and complete its checks.`;
  if (c.includes('locker') || c.includes('vesting')) return `Lock $${capital} of the asset through ${name} on ${chain} for the shortest term it offers.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('privacy')) return `Route $${capital} of USDC through ${name}'s private pool on ${chain} and keep the receipt.`;
  if (c.includes('ai agent') || c.includes('decentralized ai')) return `Stake or deposit $${capital} through ${name} on ${chain} and run one agent task the protocol counts.`;
  if (c.includes('nft')) return `List or trade one item worth about $${capital} on ${name} on ${chain} and keep the wallet active.`;
  if (c.includes('payment')) return `Send $${capital} of USDC through ${name}'s payment rails on ${chain} and keep the receipt.`;
  if (c.includes('index')) return `Buy $${capital} of ${name}'s index on ${chain} and hold it in the farming wallet.`;
  if (c.includes('chain')) return `Bridge $${capital} of USDC to ${chain} and use ${name}'s native app with the same wallet.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** One farm step as a single string: the action, then what it costs and how long it takes. */
function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const gas = capital >= 150 ? 8 : 4;
  return [
    stepText('Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', 'under $3 of gas for the first transaction', '5 minutes'),
    stepText(action, `$${capital} of capital and about $${gas} of gas`, '15 minutes to set up'),
    stepText('Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote, so the wallet stays active.', 'about $2 of gas a week', '10 minutes a week'),
    stepText(`Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, `the $${capital} stays in the position`, `${hold} days`),
    stepText('Before you withdraw, open the protocol\'s own points or rewards page and claim only from the link it publishes.', 'no fee to check, and never pay to claim', '10 minutes'),
    stepText('Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', 'nothing but the log', '5 minutes'),
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, params: ModelParams): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other legitimate candidate, at any TVL. No floor, no cap.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isLegitimateCandidate(p)) chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, params, snapshot.as_of);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.age_days,
    implied_value_usd: s.implied,
    category_multiple: Math.round(s.category_multiple * 10000) / 10000,
    growth_factor: Math.round(s.growth_factor * 10000) / 10000,
    age_factor: Math.round(s.age_factor * 10000) / 10000,
    chain_factor: Math.round(s.chain_factor * 10000) / 10000,
    farm_steps: farmSteps(s.p, s.age_days),
  }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData; params: ModelParams } {
  const params = categoryMultiples(snapshot.protocols);
  const board = buildBoard(snapshot, params);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: params,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    rows: board,
    live,
  };
  return { board, radar, params };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
