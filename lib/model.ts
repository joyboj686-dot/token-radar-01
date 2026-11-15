// Token Radar value model: comps-based category multiples with shrinkage,
// runtime backtest, board builder, radar data, and farm plans.
// Node 22, standard library only.

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

export interface ModelConstants {
  shrinkage_prior: number;
  global_median: number;
  min_multiple: number;
  max_multiple: number;
  growth_floor: number;
  growth_cap: number;
  growth_weight: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  shrinkage_prior: 4,
  global_median: 0.214,
  min_multiple: 0.02,
  max_multiple: 1.5,
  growth_floor: -60,
  growth_cap: 120,
  growth_weight: 0.30,
  maturity_floor: 0.70,
  maturity_range: 0.30,
  maturity_days: 1095,
  unknown_age_days: 365,
};

export const MODEL_VERSION = 'radar-2-shrinkage';
export const EARLY_ROWS = 160;
export const LIVE_ROWS = 24;

const DAY_MS = 86_400_000;

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Comps = protocols whose token already trades. */
export function isComp(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.gecko_id !== null && p.symbol !== null;
}

/** Pre-token = no token recorded. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

function isExchangeName(name: string): boolean {
  const lower = name.toLowerCase();
  return EXCHANGE_NAMES.some((e) => lower.startsWith(e.toLowerCase()));
}

function hasWrappedOrStaked(name: string): boolean {
  const words = name.toLowerCase().split(/\s+/);
  return words.some((w) => w === 'wrapped' || w === 'staked' || w === 'staking');
}

export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category === 'CEX') return false;
  if (VERSIONED.test(p.name)) return false;
  if (isExchangeName(p.name)) return false;
  if (hasWrappedOrStaked(p.name)) return false;
  return true;
}

function finite(v: unknown, fb: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fb;
}

// --- Value model ---

interface CategoryMultiples {
  [cat: string]: number;
}

/** Fit category multiples from comps using shrinkage. */
export function fitCategoryMultiples(
  comps: SnapshotProtocol[],
  prior: number,
  globalMedian: number,
  minM: number,
  maxM: number,
): CategoryMultiples {
  const byCat = new Map<string, number[]>();
  for (const p of comps) {
    const cat = p.category || 'Other';
    const ratio = p.mcap_usd! / p.tvl_usd;
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(ratio);
  }
  const result: CategoryMultiples = {};
  for (const [cat, ratios] of byCat) {
    const sorted = ratios.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const n = sorted.length;
    const shrunk = (n * median + prior * globalMedian) / (n + prior);
    result[cat] = Math.max(minM, Math.min(maxM, shrunk));
  }
  // Categories with no comps get global median clamped
  for (const p of comps) {
    const cat = p.category || 'Other';
    if (!(cat in result)) {
      result[cat] = Math.max(minM, Math.min(maxM, globalMedian));
    }
  }
  return result;
}

/** Shrinkage multiples for ALL categories found in the snapshot. */
function allCategoryMultiples(snapshot: Snapshot, comps: SnapshotProtocol[]): CategoryMultiples {
  const cats = new Set<string>();
  for (const p of snapshot.protocols) {
    cats.add(p.category || 'Other');
  }
  const trained = fitCategoryMultiples(comps, MODEL.shrinkage_prior, MODEL.global_median, MODEL.min_multiple, MODEL.max_multiple);
  // Ensure every category in the snapshot has a value
  for (const cat of cats) {
    if (!(cat in trained)) {
      trained[cat] = Math.max(MODEL.min_multiple, Math.min(MODEL.max_multiple, MODEL.global_median));
    }
  }
  return trained;
}

function computeImplied(p: SnapshotProtocol, asOf: string, mults: CategoryMultiples): {
  implied: number;
  catMult: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, p.listed_at);
  const rawGrowth = finite(p.change_7d, 0);
  const growthPct = Math.max(MODEL.growth_floor, Math.min(MODEL.growth_cap, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * MODEL.growth_weight;
  const ageForModel = age ?? MODEL.unknown_age_days;
  const maturityMult = MODEL.maturity_floor + (Math.min(Math.max(ageForModel, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
  const cat = p.category || 'Other';
  const catMult = mults[cat] ?? Math.max(MODEL.min_multiple, Math.min(MODEL.max_multiple, MODEL.global_median));
  const implied = Math.max(1, Math.round(p.tvl_usd * catMult * growthMult * maturityMult));
  return { implied, catMult, growthPct, growthMult, maturityMult, age };
}

// --- Backtest ---

export interface BacktestResult {
  test_n: number;
  median_abs_pct_error: number;
  mean_abs_pct_error: number;
  within_2x_share: number;
}

export function runBacktest(snapshot: Snapshot, mults: CategoryMultiples): BacktestResult {
  const comps = snapshot.protocols.filter(isComp);
  // Sort by slug for deterministic split
  const sorted = comps.slice().sort((a, b) => a.slug.localeCompare(b.slug));
  const train: SnapshotProtocol[] = [];
  const test: SnapshotProtocol[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i % 5 === 0) test.push(sorted[i]!);
    else train.push(sorted[i]!);
  }

  // Fit on train only
  const trainMults = fitCategoryMultiples(train, MODEL.shrinkage_prior, MODEL.global_median, MODEL.min_multiple, MODEL.max_multiple);

  // Predict test
  const errors: number[] = [];
  let within2x = 0;
  for (const p of test) {
    const { implied, catMult, growthPct, growthMult, maturityMult } = computeImplied(p, snapshot.as_of, trainMults);
    const actual = p.mcap_usd!;
    if (actual <= 0) continue;
    const err = Math.abs(implied - actual) / actual;
    errors.push(err);
    if (implied <= actual * 2 && implied >= actual / 2) within2x++;
  }

  const n = errors.length;
  const sortedErr = errors.slice().sort((a, b) => a - b);
  const medianErr = n > 0 ? sortedErr[Math.floor(n / 2)]! : 0;
  const meanErr = n > 0 ? errors.reduce((s, v) => s + v, 0) / n : 0;
  const within2xShare = n > 0 ? within2x / n : 0;

  return {
    test_n: n,
    median_abs_pct_error: Math.round(medianErr * 10000) / 10000,
    mean_abs_pct_error: Math.round(meanErr * 10000) / 10000,
    within_2x_share: Math.round(within2xShare * 10000) / 10000,
  };
}

// --- Farm plans ---

interface FarmPlanInput {
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  age_days: number | null;
}

const CHAIN_GAS: Record<string, { gas: string; time: string; label: string }> = {
  Ethereum: { gas: '$2–8', time: '5–15 min', label: 'Ethereum mainnet' },
  'Arbitrum One': { gas: '$0.05–0.30', time: '1–2 min', label: 'Arbitrum' },
  Optimism: { gas: '$0.05–0.30', time: '1–2 min', label: 'Optimism' },
  Base: { gas: '$0.05–0.30', time: '1–2 min', label: 'Base' },
  Polygon: { gas: '$0.01–0.10', time: '1–2 min', label: 'Polygon' },
  Solana: { gas: '$0.01', time: 'seconds', label: 'Solana' },
  BSC: { gas: '$0.05–0.20', time: '1–3 min', label: 'BNB Chain' },
  Avalanche: { gas: '$0.05–0.30', time: '1–2 min', label: 'Avalanche' },
  Tron: { gas: '$0.01–0.50', time: '1–3 min', label: 'TRON' },
  Sui: { gas: '$0.01', time: 'seconds', label: 'Sui' },
  Aptos: { gas: '$0.01', time: 'seconds', label: 'Aptos' },
  Bitcoin: { gas: '$0.50–2 (sats)', time: '10–60 min', label: 'Bitcoin' },
  'Lightning Network': { gas: '$0.001–0.01', time: 'seconds', label: 'Lightning' },
};

function chainMeta(chain: string): { gas: string; time: string; label: string } {
  return CHAIN_GAS[chain] || { gas: '$0.10–1.00', time: '1–5 min', label: chain };
}

function capitalBand(tvl: number): { low: number; high: number; label: string } {
  if (tvl >= 10_000_000_000) return { low: 200, high: 500, label: '$200–500' };
  if (tvl >= 1_000_000_000) return { low: 100, high: 300, label: '$100–300' };
  if (tvl >= 100_000_000) return { low: 50, high: 150, label: '$50–150' };
  if (tvl >= 50_000_000) return { low: 20, high: 80, label: '$20–80' };
  return { low: 10, high: 50, label: '$10–50' };
}

function holdDays(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function catGroup(cat: string | null): string {
  const c = (cat || '').toLowerCase();
  if (/lend|cda|cdp|collateral|borrow/.test(c)) return 'lending';
  if (/dex|swap|aggregat/.test(c)) return 'dexs';
  if (/yield|vault|farm|farmer/.test(c)) return 'yield';
  if (/rwa|real.world|tokeniz/.test(c)) return 'rwa';
  if (/restak|liquid.stak|stake|curator|allocator/.test(c)) return 'restaking';
  if (/bridge|cross.chain/.test(c)) return 'bridge';
  if (/chain|layer|rollup|l2/.test(c)) return 'chain';
  if (/perpetual|derivative|future|option/.test(c)) return 'derivatives';
  if (/insurance|cover/.test(c)) return 'insurance';
  return 'default';
}

function escrowPeriod(age: number | null): string {
  const h = holdDays(age);
  return `at least ${h} days (protocol age ${age !== null ? Math.round(age / 30) + ' months' : 'unknown'})`;
}

export function buildFarmSteps(p: FarmPlanInput): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its primary chain';
  const { gas, time, label } = chainMeta(chain);
  const cap = capitalBand(p.tvl_usd);
  const hold = holdDays(p.age_days);
  const group = catGroup(p.category);
  const name = p.name;
  const cat = p.category || 'DeFi';

  // Build category-specific steps
  const templates: Record<string, string[]> = {
    lending: [
      `Bridge or fund a fresh wallet with ${cap.label} USDC on ${label}. Verify the wallet has no prior protocol interactions. Gas: ${gas}. Time: ${time}.`,
      `Supply ${cap.label} USDC as collateral on ${name} (${cat}, ${chain}). Confirm the supply transaction on the block explorer. Gas: ${gas}. Time: ${time}.`,
      `If ${name} offers a borrow market, borrow a small amount of a second asset (under 20% of supplied collateral) to create a second interaction point. Gas: ${gas}. Time: ${time}.`,
      `Repeat one qualifying supply or borrow action every 7–10 days for ${hold} to remain active across multiple snapshots. Gas: ~${gas} per action. Time: 10 min per week.`,
      `Monitor ${name}'s blog, governance forum and Twitter for token announcement signals. Track every tx hash and date in a farm log. Time: 5 min every few days.`,
      `Plan your exit: note the health factor threshold, set a reminder ${hold} days out, and decide your unwind order before you withdraw. Time: 10 min.`,
    ],
    dexs: [
      `Bridge or fund a fresh wallet with ${cap.label} USDC on ${label}. Check that the chain's RPC endpoint is responsive. Gas: ${gas}. Time: ${time}.`,
      `Swap ${cap.low} USDC into the protocol's most liquid pair on ${name} (${cat}, ${chain}). Save the LP token or position receipt. Gas: ${gas}. Time: ${time}.`,
      `Provide ${cap.high} USDC of additional liquidity to ${name}'s main pool to establish an LP position with measurable TVL contribution. Gas: ${gas}. Time: ${time}.`,
      `Make one swap or add-liquidity action every 7–14 days for ${hold} to register consistent user activity. Gas: ~${gas}. Time: 10 min per week.`,
      `Join ${name}'s Discord/Telegram, turn on notifications, and track liquidity mining or points announcements. Log all tx hashes and dates. Time: 5 min every few days.`,
      `Set a reminder for ${hold} days out. Review impermanent loss and decide whether to hold, rebalance, or exit the LP position. Time: 10 min.`,
    ],
    yield: [
      `Fund a fresh wallet with ${cap.label} USDC on ${label}. Use a new address for each farm to avoid cross-contamination. Gas: ${gas}. Time: ${time}.`,
      `Deposit ${cap.high} USDC into ${name}'s primary yield vault or strategy (${cat}, ${chain}). Confirm the vault share receipt. Gas: ${gas}. Time: ${time}.`,
      `If ${name} has multiple strategies, split your deposit: 70% in the highest-APY strategy, 30% in a lower-risk stable strategy. Gas: ${gas}. Time: ${time}.`,
      `Re-deposit or compound any yield rewards weekly for ${hold} to show sustained engagement. Gas: ~${gas} per compound. Time: 10 min per week.`,
      `Watch ${name}'s governance forum and Twitter for reward-token or retroactive airdrop signals. Keep a dated log of all deposits and compounds. Time: 5 min every few days.`,
      `Before ${hold} days elapse, assess vault performance and plan your withdrawal tx. Gas: ${gas}. Time: ${time}.`,
    ],
    rwa: [
      `Fund a fresh wallet with ${cap.label} USDC on ${label}. Ensure KYC if the protocol requires it before bonding funds. Gas: ${gas}. Time: ${time}.`,
      `Mint or purchase ${cap.high} USDC worth of ${name}'s yield-bearing token (${cat}, ${chain}). Confirm the on-chain receipt. Gas: ${gas}. Time: ${time}.`,
      `Hold the position without redeeming for ${hold} to establish a continuous holder record. Gas: none while holding. Time: 1 min per week to check.`,
      `Stake or lock any reward or governance tokens ${name} distributes, if available, to deepen your interaction. Gas: ${gas}. Time: ${time}.`,
      `Track ${name}'s issuer updates, RWA asset reports, and governance proposals. Log mint date, amount and tx hash. Time: 5 min every few days.`,
      `Plan redemption: note the lock-up window and set a reminder at day ${hold}. Gas: ${gas} to redeem. Time: ${time}.`,
    ],
    restaking: [
      `Fund a fresh wallet with ${cap.label} of the chain's native token (ETH, SOL, etc.) on ${label}. Gas: ${gas}. Time: ${time}.`,
      `Stake ${cap.high} of the native token via ${name} (${cat}, ${chain}). Keep the liquid staking receipt or LST token. Gas: ${gas}. Time: ${time}.`,
      `If ${name} offers restaking, delegate your LST back to ${name} for additional operator rewards. Gas: ${gas}. Time: ${time}.`,
      `Claim and re-stake any rewards weekly for ${hold} to maintain an active operator/delegator record. Gas: ~${gas}. Time: 10 min per week.`,
      `Monitor ${name}'s operator queue, slashing conditions and governance for token announcement signals. Log stake date and amounts. Time: 5 min every few days.`,
      `Set an unstake reminder at day ${hold} (note any unbonding period). Gas: ${gas} to initiate unstake. Time: ${time} + unbonding queue.`,
    ],
    bridge: [
      `Fund a fresh wallet with ${cap.label} USDC on the source chain ${chain}. Gas: ${gas}. Time: ${time}.`,
      `Bridge ${cap.high} USDC through ${name} (${cat}) to the destination chain. Save the bridge tx hash and proof. Gas: ${gas} + destination chain fee. Time: ${time}.`,
      `Use the bridged funds in ${name}'s app on the destination chain: swap, provide liquidity, or deposit to generate activity. Gas: ${gas}. Time: ${time}.`,
      `Repeat one bridge-and-use cycle every 14–21 days for ${hold} to demonstrate recurring cross-chain usage. Gas: ~${gas}. Time: 10 min per week.`,
      `Track ${name}'s bridge volume metrics, fee changes and governance for token signals. Log all bridge tx hashes and timestamps. Time: 5 min every few days.`,
      `Plan your return bridge or exit at day ${hold}. Gas: destination chain fee. Time: ${time}.`,
    ],
    chain: [
      `Fund a fresh wallet with ${cap.label} of the chain's native token on ${name} (${cat}). Gas: ${gas}. Time: ${time}.`,
      `Run or delegate to a ${name} node/validator if user-run: bond ${cap.high} native tokens as a validator or nominator. Gas: ${gas}. Time: ${time}.`,
      `Make at least one on-chain transaction (transfer, contract call, vote) every 14 days for ${hold}. Gas: ~${gas}. Time: 10 min per week.`,
      `Participate in ${name}'s governance: vote on at least one active proposal during the ${hold}-day window. Gas: ${gas}. Time: ${time}.`,
      `Monitor ${name}'s ecosystem fund, grant programs and blog for retroactive reward signals. Log tx hashes and dates. Time: 5 min every few days.`,
      `At day ${hold}, evaluate whether to continue staking/validating or unbond. Note any unbonding period. Gas: ${gas} to unbond. Time: ${time}.`,
    ],
    derivatives: [
      `Fund a fresh wallet with ${cap.label} USDC on ${label}. Gas: ${gas}. Time: ${time}.`,
      `Open one small hedge or limit order on ${name} (${cat}, ${chain}). Use under 10% of deposited capital as margin. Gas: ${gas}. Time: ${time}.`,
      `Make one additional small trade or order adjustment every 14 days for ${hold}. Gas: ~${gas}. Time: 10 min per week.`,
      `Deposit ${cap.high} USDC into ${name}'s liquidity or insurance pool if available, to add a second interaction type. Gas: ${gas}. Time: ${time}.`,
      `Follow ${name}'s Twitter and Discord for trading-competition or reward-program announcements. Log all trade dates and sizes. Time: 5 min every few days.`,
      `Close the open position at or before day ${hold}. Gas: ${gas}. Time: ${time}.`,
    ],
    insurance: [
      `Fund a fresh wallet with ${cap.label} USDC on ${label}. Gas: ${gas}. Time: ${time}.`,
      `Buy cover for ${cap.high} USDC worth of exposure through ${name} (${cat}, ${chain}). Save the policy NFT or receipt. Gas: ${gas}. Time: ${time}.`,
      `Renew or extend the cover policy before expiry, or purchase an additional cover product, to maintain continuous coverage for ${hold}. Gas: ${gas}. Time: ${time}. each renewal.`,
      `File no claim: simply holding active cover is the qualifying action. Log purchase date, coverage amount and expiry. Time: 1 min per week.`,
      `Monitor ${name}'s claims history, risk parameters and governance for cover-product updates or token signals. Time: 5 min every few days.`,
      `At day ${hold}, decide whether to renew, reduce or exit coverage. Gas: ${gas} to withdraw. Time: ${time}.`,
    ],
    default: [
      `Fund a fresh wallet with ${cap.label} USDC on ${label}. Gas: ${gas}. Time: ${time}.`,
      `Interact with ${name} (${cat}, ${chain}): deposit ${cap.high} USDC or complete the protocol's primary onboarding action. Save the tx hash. Gas: ${gas}. Time: ${time}.`,
      `Complete one follow-up action (stake, vote, provide liquidity, or swap) every 7–14 days for ${hold}. Gas: ~${gas}. Time: 10 min per week.`,
      `Hold the position without withdrawing for the full ${hold} days to establish a continuous user record. Gas: none while holding. Time: 1 min per week.`,
      `Watch ${name}'s announcements, blog and Discord for token or reward-program signals. Keep a dated farm log of all txs. Time: 5 min every few days.`,
      `Set a withdrawal reminder at day ${hold}. Gas: ${gas} to exit. Time: ${time}.`,
    ],
  };

  const steps = templates[group] || templates.default;
  // Ensure every step is 20–600 chars
  return steps.map((s) => {
    if (s.length < 20) return s + ' Confirm the transaction on the block explorer and record it.';
    if (s.length > 600) return s.slice(0, 596) + '...';
    return s;
  });
}

// --- Board ---

export interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
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
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_multiple: number;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
  backtest: BacktestResult;
  watchlist_slugs: string[];
}

export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new Error('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new Error('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new Error('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new Error('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new Error('snapshot.json has no watchlist');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new Error(`protocol ${i} lacks slug/name/tvl`);
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
    source: o.source as string,
    floor_usd: o.floor_usd as number,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  const m = new Map<string, SnapshotProtocol>();
  for (const p of protocols) m.set(p.slug, p);
  return m;
}

export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const comps = snapshot.protocols.filter(isComp);
  const mults = allCategoryMultiples(snapshot, comps);
  const backtest = runBacktest(snapshot, mults);

  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored: { p: SnapshotProtocol; data: ReturnType<typeof computeImplied> }[] = [];
  for (const p of chosen.values()) {
    const data = computeImplied(p, snapshot.as_of, mults);
    scored.push({ p, data });
  }
  scored.sort((a, b) => b.data.implied - a.data.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  return scored.map((s, i) => {
    const { implied, catMult, growthPct, growthMult, maturityMult, age } = s.data;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token' as const,
      age_days: age,
      implied_value_usd: implied,
      model: {
        category_multiple: Math.round(catMult * 10000) / 10000,
        growth_pct: growthPct,
        growth_multiplier: Math.round(growthMult * 10000) / 10000,
        maturity_multiplier: Math.round(maturityMult * 10000) / 10000,
        age_days: age,
      },
      farm_steps: buildFarmSteps({
        name: s.p.name,
        category: s.p.category,
        chains: s.p.chains,
        tvl_usd: s.p.tvl_usd,
        age_days: age,
      }),
    };
  });
}

export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
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

export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    growth_pct: row.model.growth_pct,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_steps: row.farm_steps,
  };
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData; backtest: BacktestResult } {
  const comps = snapshot.protocols.filter(isComp);
  const mults = allCategoryMultiples(snapshot, comps);
  const backtest = runBacktest(snapshot, mults);
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: MODEL,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
    backtest,
    watchlist_slugs: snapshot.watchlist.slice(),
    comps_count: comps.length,
  };
  return { board, radar, backtest };
}

export function dataScript(radar: RadarData): string {
  const wlSet = new Set(radar.watchlist_slugs);
  const taggedRows = radar.rows.map((r) => ({ ...r, _watchlist: wlSet.has(r.slug) }));
  const out: any = Object.assign({}, radar, { rows: taggedRows });
  return `window.RADAR=${JSON.stringify(out)};\n`;
}

export function boardIssue(board: BoardRow[]): string | null {
  if (board.length < 100) return `board has ${board.length} rows, needs at least 100`;
  if (board.length > 4000) return `board has ${board.length} rows, exceeds 4000`;
  const slugs = board.map((r) => r.slug);
  const seen = new Set<string>();
  for (const r of board) {
    if (seen.has(r.slug)) return `duplicate slug ${r.slug}`;
    seen.add(r.slug);
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i}`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all rows share the same implied value: not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const trimmed = s.trim();
      if (trimmed.length < 20 || trimmed.length > 600) return `${r.slug} step length ${trimmed.length}`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} bad implied ${r.implied_value_usd}`;
    if (r.implied_value_usd > 100_000_000_000_000) return `${r.slug} implied over cap`;
    if (r.token_status !== 'pre-token') return `${r.slug} bad token_status`;
  }
  return null;
}
