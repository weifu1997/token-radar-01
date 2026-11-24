// Token Launch Radar — the valuation model and farm-plan generator.
//
// The idea, in one paragraph: a pre-token protocol's token, if it launched
// today at the valuation the market already gives comparable live protocols,
// would be worth roughly its TVL times the market-cap-to-TVL multiple of its
// own category. This model calibrates those multiples from the snapshot
// itself — every protocol in it whose token already trades is a comparable —
// then adjusts each pre-token protocol for its seven-day TVL momentum, for
// how long it has run without a token, and for how many chains it spans.
// Nothing is hardcoded per protocol: add a protocol to the snapshot and the
// model prices it from its own figures alone.
//
// The board ranks only genuine pre-token candidates. A protocol counts as a
// candidate when DefiLlama records no token for it and it is not a wrapped,
// staked or bridged product of a protocol whose token already trades, not an
// exchange's own balance sheet, and not a versioned re-release of a protocol
// that already has one — the same reading the snapshot's watchlist uses,
// without the watchlist's $50M floor.

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

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  multiple: number;
  growth_mult: number;
  maturity_mult: number;
  breadth_mult: number;
  capital: string;
  weeks: string;
  steps: string[];
}

export interface CalibrationRow {
  category: string;
  comparables: number;
  multiple: number;
}

export interface LiveRow {
  name: string;
  symbol: string | null;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  stats: {
    scanned: number;
    pre_token: number;
    candidates: number;
    board_rows: number;
    watchlist: number;
    total_implied_usd: number;
    global_multiple: number;
  };
  calibration: CalibrationRow[];
  live: LiveRow[];
  rows: RadarRow[];
}

export const MODEL_VERSION = 'calibrated-comps/1';

/** Prior weight, in phantom comparables, pulling a thin category toward the global median. */
const SHRINK = 6;
/** A category needs at least this many live comparables before its own median is trusted at all. */
const MIN_COMPS = 3;
/** How strongly a week of TVL momentum moves the price: +60% in a week is worth about ×1.5. */
const GROWTH_WEIGHT = 0.9;
const GROWTH_FLOOR = -30;
const GROWTH_CAP = 60;
/** The most the board will rank; the snapshot yields fewer candidates than this today. */
const MAX_ROWS = 280;

/** Categories that name a product of another protocol, or an exchange itself — never a launch candidate. */
const PRODUCT_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;

/** Read and lightly validate the sealed snapshot. Throws on anything malformed. */
export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (typeof raw.as_of !== 'string' || !Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: missing as_of, protocols or watchlist');
  }
  for (const p of raw.protocols) {
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number') {
      throw new Error(`snapshot: malformed protocol row (${String(p.slug)})`);
    }
  }
  return raw;
}

/** True when DefiLlama records no token for the protocol. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/**
 * True when the protocol is a genuine pre-token candidate: no token recorded,
 * and not a wrapped, staked or bridged product of one that trades, not an
 * exchange, and not a versioned re-release.
 */
export function isCandidate(p: SnapshotProtocol): boolean {
  if (!recordsNoToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (PRODUCT_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return false;
  return true;
}

/** Whole days between two YYYY-MM-DD dates, UTC. Null when either side is missing. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((a - b) / 86_400_000));
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Calibrate category multiples from the snapshot's own live protocols.
 * Each category's multiple is its median market-cap/TVL, shrunk toward the
 * global median in proportion to how few comparables it has, so a category
 * priced off two tokens cannot swing the board.
 */
export function calibrate(protocols: SnapshotProtocol[]): { global: number; byCategory: Map<string, CalibrationRow> } {
  const live = protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const global = median(live.map((p) => p.mcap_usd! / p.tvl_usd));
  const groups = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Uncategorised';
    const list = groups.get(key) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    groups.set(key, list);
  }
  const byCategory = new Map<string, CalibrationRow>();
  for (const [category, ratios] of groups) {
    if (ratios.length < MIN_COMPS) continue;
    const shrunk = (ratios.length * median(ratios) + SHRINK * global) / (ratios.length + SHRINK);
    byCategory.set(category, { category, comparables: ratios.length, multiple: shrunk });
  }
  return { global, byCategory };
}

/** The multiple applied to a protocol: its category's when calibrated, else the global median. */
function multipleFor(p: SnapshotProtocol, cal: { global: number; byCategory: Map<string, CalibrationRow> }): number {
  if (p.category !== null) {
    const row = cal.byCategory.get(p.category);
    if (row !== undefined) return row.multiple;
  }
  return cal.global;
}

/** Momentum: a protocol gaining TVL is worth more than the same TVL standing still. */
function growthMult(change7d: number | null): number {
  if (change7d === null) return 1;
  const clamped = Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, change7d));
  return 1 + (clamped / 100) * GROWTH_WEIGHT;
}

/**
 * Maturity: the longer a protocol has run at size without a token, the more
 * proven the launch it is holding back. The curve rises from 0.85 for a
 * brand-new listing toward 1.15 for a veteran, and never dominates the price.
 */
function maturityMult(age: number | null): number {
  if (age === null) return 0.97;
  const years = age / 365;
  return 0.85 + 0.3 * (1 - Math.exp(-years / 2.2));
}

/** Breadth: every extra chain is distribution a launch can drop into, worth a little each. */
function breadthMult(chainCount: number): number {
  return 1 + 0.02 * Math.min(Math.max(chainCount - 1, 0), 5);
}

export interface Priced {
  protocol: SnapshotProtocol;
  age: number | null;
  multiple: number;
  growth: number;
  maturity: number;
  breadth: number;
  implied: number;
}

/** Price one candidate protocol from its own figures. */
export function price(p: SnapshotProtocol, asOf: string, cal: { global: number; byCategory: Map<string, CalibrationRow> }): Priced {
  const age = ageDays(asOf, p.listed_at);
  const multiple = multipleFor(p, cal);
  const growth = growthMult(p.change_7d);
  const maturity = maturityMult(age);
  const breadth = breadthMult(p.chains.length);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growth * maturity * breadth));
  return { protocol: p, age, multiple, growth, maturity, breadth, implied };
}

/** Working capital a serious farmer parks in a protocol of this size. */
export function capitalFor(tvl: number): string {
  if (tvl >= 1_000_000_000) return '$2,000–$10,000';
  if (tvl >= 250_000_000) return '$1,000–$5,000';
  if (tvl >= 50_000_000) return '$500–$2,500';
  if (tvl >= 10_000_000) return '$250–$1,000';
  return '$100–$500';
}

/** How long a position should season before a snapshot is likely to count it. */
export function weeksFor(age: number | null): string {
  if (age === null) return '8–12 weeks';
  const years = age / 365;
  if (years >= 3) return '6–10 weeks';
  if (years >= 1) return '8–12 weeks';
  return '10–16 weeks';
}

/** The per-transaction fee reality of the protocol's home chain, so plans can budget gas. */
function gasNote(chain: string): string {
  if (chain === 'Ethereum') return 'Ethereum mainnet gas runs $5–$40 a transaction, so batch actions into low-fee weekend windows';
  if (chain === 'Solana') return 'Solana fees are under a cent a transaction, so activity there is nearly free to keep up';
  if (chain === 'Bitcoin') return 'Bitcoin fees swing with the mempool, so time non-urgent transactions for quiet blocks';
  if (['Base', 'Arbitrum', 'Optimism', 'zkSync Era', 'Linea', 'Scroll', 'Mantle', 'Polygon', 'Avalanche', 'BSC', 'Binance', 'Gnosis', 'Fantom', 'Sonic'].includes(chain)) {
    return `fees on ${chain} run a few cents to about a dollar a transaction`;
  }
  return `fees on ${chain} are modest, but check the live rate before a large session`;
}

interface Playbook {
  core: string;
  depth: string;
}

/** The two protocol-specific actions of a plan, by category. {name}, {chain} and {capital} are filled in. */
const PLAYBOOKS: Record<string, Playbook> = {
  Dexs: {
    core: 'Route real swaps through {name} on {chain}: {capital} of volume spread over the plan, in the flagship pairs, at sizes a normal trader would use rather than one showcase trade.',
    depth: 'Add {capital} of two-sided liquidity to the deepest pool on {name} and leave it working; liquidity that stays through volatile weeks is the behaviour points programs reward most.',
  },
  Lending: {
    core: 'Deposit {capital} of blue-chip collateral into {name} on {chain} and keep it supplied; a lending market reads its depositors first when it looks for token holders.',
    depth: 'Run a conservative borrow-and-repay cycle against the deposit — borrow at most 40% of the collateral value, repay within days, and keep the health factor comfortably above liquidation.',
  },
  CDP: {
    core: 'Open a vault on {name} with {capital} of collateral and mint its stablecoin at a conservative ratio, then put the minted stablecoin to work inside the same ecosystem.',
    depth: 'Keep the vault active for the whole plan: top up collateral when markets fall, repay and re-mint in small cycles, and hold some of the stablecoin rather than selling it all at once.',
  },
  Yield: {
    core: 'Deposit {capital} into the flagship vault on {name} on {chain} and leave the position compounding; yield vaults snapshot depositors, and size plus duration is the usual formula.',
    depth: 'Split a second tranche across one or two other vaults on {name} so the activity reads as real allocation, and rebalance monthly instead of chasing every new vault launch.',
  },
  'Yield Aggregator': {
    core: 'Deposit {capital} into the main auto-compounding vault on {name} and let it season; aggregators reward the depositors whose capital their strategies actually route.',
    depth: 'Rotate a smaller tranche between strategies every few weeks so the wallet shows continuing use of the aggregator, not a single parked deposit.',
  },
  'Cross Chain Bridge': {
    core: 'Bridge {capital} through {name} in both directions over the plan, in transfers of a few hundred dollars each, and use the destination chain for a day before bridging back.',
    depth: 'Spread crossings across at least three routes {name} serves and keep a small balance working on the far side; one giant crossing reads as farming, a pattern of real use does not.',
  },
  RWA: {
    core: 'Complete onboarding with {name} and hold {capital} of its tokenised real-world assets on {chain}; for RWA protocols the holder register is the distribution list that matters.',
    depth: 'Add to the position monthly rather than in one lump, and hold through at least one full yield or coupon cycle so the wallet reads as an investor, not a passer-by.',
  },
  'Prediction Market': {
    core: 'Trade the liquid markets on {name} with {capital} of working balance: take positions you have a view on, in normal sizes, several times a week.',
    depth: 'Post limit orders on both sides of two or three markets to add depth, and let some positions settle rather than closing everything early; settled flow is the record that counts.',
  },
  'Risk Curators': {
    core: 'Deposit {capital} into a vault curated by {name} on {chain} and keep it there; when a curator launches, its vault depositors are the community it already has.',
    depth: 'Spread deposits across two vaults under the same curator and stay through a full reallocation cycle, withdrawing nothing in the first month unless the vault itself is wound down.',
  },
  'Onchain Capital Allocator': {
    core: 'Allocate {capital} through {name} into its flagship vault on {chain} and hold the position; allocators distribute to the wallets whose capital they have been routing.',
    depth: 'Follow the allocator into one new vault it opens during the plan with a smaller tranche, so the wallet shows continuing allocation rather than one early deposit.',
  },
  Derivatives: {
    core: 'Trade perpetuals on {name} with {capital} of margin: modest size, real positions held for hours to days, and a stop you actually respect — volume with risk reads as a trader, churn does not.',
    depth: 'Keep a steady weekly rhythm of trades through quiet and volatile weeks alike, and try each market {name} lists on {chain} at least once.',
  },
  Options: {
    core: 'Buy and write small options on {name} with {capital} of premium over the plan, letting some contracts expire rather than closing every position early.',
    depth: 'Provide liquidity to the options vault on {name} with a second tranche, so the wallet is on both sides of the market the protocol is building.',
  },
  Indexes: {
    core: 'Buy and hold {capital} of the flagship index on {name}; index protocols reward the holders who keep the product in circulation.',
    depth: 'Add to the index position monthly and use the protocol’s rebalancing or mint route at least once, so the wallet shows product use beyond a single purchase.',
  },
  Privacy: {
    core: 'Use {name} for real private transfers on {chain} with {capital} cycled through over the plan, in amounts and intervals that look like ordinary use.',
    depth: 'Keep a standing balance in the shielded pool between transfers; privacy protocols read long-lived shielded balances as their committed user base.',
  },
  Launchpad: {
    core: 'Take part in launches on {name} with {capital} across the plan: register early, commit at a size you can hold, and keep some of each allocation rather than flipping all of it.',
    depth: 'Use the platform’s staking or tier system if it has one, and vote or comment on launch selection where the platform allows it — launchpads reward their regulars.',
  },
};

const GENERIC_PLAY: Playbook = {
  core: 'Use {name}’s flagship product on {chain} with {capital} of working capital, the way a real user would: real transactions, normal sizes, no automation patterns.',
  depth: 'Keep the position or activity running for the whole plan and add a second, smaller use of {name} — a different feature, market or chain it serves — so the wallet shows depth of use.',
};

function fill(template: string, p: SnapshotProtocol, capital: string): string {
  const chain = p.chains[0] ?? 'its main chain';
  return template.replaceAll('{name}', p.name).replaceAll('{chain}', chain).replaceAll('{capital}', capital);
}

/**
 * A concrete farm plan for one protocol: set up, the category's two real
 * actions with capital attached, a weekly cadence with a time budget, the
 * community work, and the wallet hygiene that keeps the activity eligible.
 * Every step states what it costs or how long it takes.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const capital = capitalFor(p.tvl_usd);
  const weeks = weeksFor(age);
  const chain = p.chains[0] ?? 'its main chain';
  const play = (p.category !== null ? PLAYBOOKS[p.category] : undefined) ?? GENERIC_PLAY;
  const steps = [
    `Set up one wallet dedicated to ${p.name} and fund it on ${chain} (${gasNote(chain)}). Turn on the protocol's own points or activity page if it has one, and note the start date — the plan runs ${weeks}.`,
    fill(play.core, p, capital),
    fill(play.depth, p, capital),
    `Keep a weekly rhythm for ${weeks}: two or three sessions a week of about 20 minutes, sized like a normal user's, and never silent for more than ten days — snapshots reward consistency, not one big week.`,
    `Do the free work around ${p.name}: join its Discord and forum, vote in governance or snapshot polls when they open, and finish any official quest or testnet it runs — about 30 minutes a week, no capital required.`,
    `Stay eligible: use one wallet only, never move funds in circles between your own wallets, and keep records of every position so a sybil screen reads this as one honest user farming one protocol.`,
  ];
  return steps;
}

/** Rank the candidates and build both the board the gate reads and the data the page renders. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const cal = calibrate(snapshot.protocols);
  const watch = new Set(snapshot.watchlist);
  const priced = snapshot.protocols
    .filter(isCandidate)
    .map((p) => price(p, snapshot.as_of, cal))
    .sort((a, b) => b.implied - a.implied || b.protocol.tvl_usd - a.protocol.tvl_usd || (a.protocol.slug < b.protocol.slug ? -1 : 1))
    .slice(0, MAX_ROWS);

  const board: BoardRow[] = [];
  const rows: RadarRow[] = [];
  priced.forEach((entry, i) => {
    const p = entry.protocol;
    const steps = farmSteps(p, entry.age);
    board.push({ slug: p.slug, name: p.name, rank: i + 1, implied_value_usd: entry.implied, farm_steps: steps });
    rows.push({
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_days: entry.age,
      on_watchlist: watch.has(p.slug),
      implied_usd: entry.implied,
      implied_low_usd: Math.max(1, Math.round(entry.implied / 2)),
      implied_high_usd: entry.implied * 2,
      multiple: Math.round(entry.multiple * 1000) / 1000,
      growth_mult: Math.round(entry.growth * 1000) / 1000,
      maturity_mult: Math.round(entry.maturity * 1000) / 1000,
      breadth_mult: Math.round(entry.breadth * 1000) / 1000,
      capital: capitalFor(p.tvl_usd),
      weeks: weeksFor(entry.age),
      steps,
    });
  });

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd!)
    .slice(0, 10)
    .map((p) => ({
      name: p.name,
      symbol: p.symbol,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      multiple: Math.round((p.mcap_usd! / p.tvl_usd) * 1000) / 1000,
    }));

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    stats: {
      scanned: snapshot.protocols.length,
      pre_token: snapshot.protocols.filter(recordsNoToken).length,
      candidates: snapshot.protocols.filter(isCandidate).length,
      board_rows: board.length,
      watchlist: snapshot.watchlist.length,
      total_implied_usd: board.reduce((sum, r) => sum + r.implied_value_usd, 0),
      global_multiple: Math.round(cal.global * 1000) / 1000,
    },
    calibration: [...cal.byCategory.values()].sort((a, b) => b.comparables - a.comparables || (a.category < b.category ? -1 : 1)),
    live,
    rows,
  };
  return { board, radar };
}

/** The board's own pre-flight check, mirroring the gate's board rules. Returns the first problem, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100–4000`;
  const known = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const seen = new Set<string>();
  let previous = Number.POSITIVE_INFINITY;
  let allSame = true;
  for (let i = 0; i < board.length; i++) {
    const row = board[i]!;
    if (!known.has(row.slug)) return `row ${i + 1}: slug ${row.slug} is not in the snapshot`;
    if (seen.has(row.slug)) return `row ${i + 1}: slug ${row.slug} appears twice`;
    seen.add(row.slug);
    if (row.rank !== i + 1) return `row ${i + 1}: rank is ${row.rank}, expected ${i + 1}`;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0 || row.implied_value_usd > 100_000_000_000_000) {
      return `row ${i + 1}: implied_value_usd ${row.implied_value_usd} is not a positive whole number within the cap`;
    }
    if (row.implied_value_usd > previous) return `row ${i + 1}: implied value rises as rank ascends`;
    if (i > 0 && row.implied_value_usd !== board[0]!.implied_value_usd) allSame = false;
    previous = row.implied_value_usd;
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `row ${i + 1}: farm_steps holds ${row.farm_steps.length} steps`;
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `row ${i + 1}: a farm step is ${len} characters, outside 20–600`;
    }
  }
  if (allSame) return 'every implied value is the same: the board ranks nothing';
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist protocol ${slug} is missing from the board`;
  }
  return null;
}

/** The dashboard's data file: one assignment the page's script reads. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}
