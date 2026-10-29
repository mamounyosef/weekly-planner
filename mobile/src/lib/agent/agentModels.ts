// ─── Planner agent: the models it can run on ────────────────────────────────
//
// Shared verbatim by the server, the PC/browser panel and the Android app
// (copied into mobile/src/lib/agent/). Pure, no imports.
//
// The same catalogue as the Notes app's assistant, strongest first (by total,
// then active, parameters). Two services run them:
//  - Ollama Cloud: facts from Ollama's /api/show and prices from
//    ollama.com/pricing (US dollars per million tokens), checked 19 October 2026.
//  - OpenRouter (free models): context and date added from openrouter.ai's
//    model list, architecture from each model's Hugging Face config.json or
//    model card, checked 20 October 2026. Free models allow 50 requests a day
//    on a key without credits.
// Thinking controls, checked 26 October 2026, differ by service even for the
// same model, so each entry keeps its own:
//  - Ollama: the `thinking` field of ollama.com/api/show ({ values, default }).
//    `think` takes exactly one of those values; numbers (budgets) are not
//    supported (docs.ollama.com/capabilities/thinking).
//  - OpenRouter: the `reasoning` field of openrouter.ai/api/v1/models
//    (mandatory, default_enabled, supported_efforts, default_effort,
//    supports_max_tokens). No supported_efforts means on/off only; mandatory
//    means it cannot be switched off (openrouter.ai/docs, reasoning tokens).

export type Provider = 'ollama' | 'openrouter';

export const PROVIDERS: Provider[] = ['ollama', 'openrouter'];
export const PROVIDER_LABEL: Record<Provider, string> = { ollama: 'Ollama', openrouter: 'OpenRouter' };

/** How hard a model reasons before it answers, lightest first. "on" is a plain switch with no levels. */
export type ThinkLevel = 'off' | 'minimal' | 'low' | 'on' | 'medium' | 'high' | 'xhigh' | 'max';

export const THINK_ORDER: ThinkLevel[] = ['off', 'minimal', 'low', 'on', 'medium', 'high', 'xhigh', 'max'];

export interface ThinkSpec {
  /** What this model takes on this service, lightest first. No "off" means it always thinks. */
  levels: ThinkLevel[];
  /** What the service uses when nothing is sent; absent when the service does not say. */
  default?: ThinkLevel;
  /** A reasoning token budget can be set instead of a level (OpenRouter reasoning.max_tokens). */
  budget?: boolean;
}

export interface Experts {
  /** Routed experts in each MoE layer. */
  total: number;
  /** Routed experts each token goes through. */
  active: number;
  /** Experts every token always goes through, on top of the routed ones. */
  shared?: number;
}

export interface ModelInfo {
  /** The name the service knows it by. */
  id: string;
  name: string;
  provider: Provider;
  /** Total parameters. */
  params: string;
  /** Active parameters per token for mixture-of-experts models; absent means dense. */
  active?: string;
  /** Context window in tokens. */
  context: number;
  /** When the model was published on the service. */
  released: string;
  /** Mixture-of-experts routing per MoE layer, from the model's config. */
  experts?: Experts;
  /** Architecture facts from the model's config or technical report. */
  arch: string[];
  /** Reads images itself. The others get images described by VISION_MODEL first. */
  vision: boolean;
  /** The thinking control this service offers for the model. */
  think: ThinkSpec;
  /** Per million tokens; null when the service does not list a price. Zero for free models. */
  price: { input: number; cached: number | null; output: number } | null;
  note?: string;
}

const FREE = { input: 0, cached: 0, output: 0 };

const GEMMA_31B_ARCH = ['60 layers', 'dim 5376', 'GQA: 32 query heads, 16 KV heads', 'sliding window 1024, 10 full-attention layers'];
const ULTRA_ARCH = ['108 layers (48 Mamba-2, 48 MoE, 12 attention)', 'dim 8192', 'LatentMoE (latent 2048)', 'GQA: 64 query heads, 2 KV heads', 'multi-token prediction'];
const SUPER_ARCH = ['88 layers (40 Mamba-2, 40 MoE, 8 attention)', 'dim 4096', 'LatentMoE (latent 1024)', 'GQA: 32 query heads, 2 KV heads', 'multi-token prediction'];
const NANO_ARCH = ['52 layers (23 Mamba-2, 23 MoE, 6 attention)', 'dim 2688', 'GQA: 32 query heads, 2 KV heads'];
const ULTRA_EXPERTS: Experts = { total: 512, active: 22, shared: 1 };
const SUPER_EXPERTS: Experts = { total: 512, active: 22, shared: 1 };
const NANO_EXPERTS: Experts = { total: 128, active: 6, shared: 1 };

export const MODELS: ModelInfo[] = [
  {
    id: 'nemotron-3-ultra',
    name: 'Nemotron 3 Ultra',
    provider: 'ollama',
    params: '550B',
    active: '55B',
    context: 262_144,
    released: '2026-06-04',
    experts: ULTRA_EXPERTS,
    arch: ULTRA_ARCH,
    vision: false,
    think: { levels: ['off', 'on'], default: 'on' },
    price: { input: 0.1, cached: 0.1, output: 3.0 },
  },
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    name: 'Nemotron 3 Ultra',
    provider: 'openrouter',
    params: '550B',
    active: '55B',
    context: 1_000_000,
    released: '2026-06-04',
    experts: ULTRA_EXPERTS,
    arch: ULTRA_ARCH,
    vision: false,
    // Listed with a budget, but on 26 October 2026 its provider failed every budgeted request: the server then asks again with the level.
    think: { levels: ['off', 'medium', 'high'], default: 'high', budget: true },
    price: FREE,
    note: '1M context here, 256K on Ollama.',
  },
  {
    id: 'beam',
    name: 'Beam',
    provider: 'ollama',
    params: '501B',
    active: '23B',
    context: 1_048_576,
    released: '2026-10-16',
    experts: { total: 256, active: 8 },
    arch: ['52 layers (3 dense, 49 MoE)', 'dim 5120', 'GQA: 48 query heads, 8 KV heads', 'sliding window 512, 9 global layers'],
    vision: false,
    think: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'max' },
    price: null,
    note: 'Price not listed on Ollama yet.',
  },
  {
    id: 'minimax/minimax-m3.1-flash:free',
    name: 'MiniMax M3.1 Flash',
    provider: 'openrouter',
    params: '~428B',
    active: '~23B',
    context: 1_000_000,
    released: '2026-10-19',
    experts: { total: 128, active: 4, shared: 1 },
    arch: ['60 layers', 'dim 6144', 'sparse attention', 'built-in vision encoder', 'always reasons'],
    vision: true,
    think: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'max' },
    price: FREE,
    note: 'Newest. Size reported, not confirmed by MiniMax.',
  },
  {
    id: 'dots-studio/dots-3-note-preview:free',
    name: 'Dots3-Note Preview',
    provider: 'openrouter',
    params: '280B',
    active: '16B',
    context: 512_000,
    released: '2026-08-14',
    experts: { total: 256, active: 8, shared: 1 },
    arch: ['46 layers (1 dense, 45 MoE)', 'dim 5120', '13 sparse (DSA) + 33 sliding-window attention layers', 'multi-token prediction', 'MoE vision encoder (7B, 1.2B active)'],
    vision: true,
    think: { levels: ['off', 'on'] },
    price: FREE,
    note: 'Preview.',
  },
  {
    id: 'nvidia/nemotron-3.5-super-vl:free',
    name: 'Nemotron 3.5 Super VL',
    provider: 'openrouter',
    params: '120B',
    active: '12B',
    context: 1_000_000,
    released: '2026-10-15',
    experts: SUPER_EXPERTS,
    arch: ['Nemotron-H hybrid (Mamba-2, MoE, attention)', 'RADIO vision encoder', 'multi-token prediction'],
    vision: true,
    think: { levels: ['off', 'on'] },
    price: FREE,
    note: 'Reads documents and screenshots.',
  },
  {
    id: 'nemotron-3-super',
    name: 'Nemotron 3 Super',
    provider: 'ollama',
    params: '120B',
    active: '12B',
    context: 262_144,
    released: '2026-03-11',
    experts: SUPER_EXPERTS,
    arch: SUPER_ARCH,
    vision: false,
    think: { levels: ['off', 'on'], default: 'on' },
    price: { input: 0.015, cached: 0.015, output: 0.6 },
  },
  {
    id: 'nvidia/nemotron-3-super-120b-a12b:free',
    name: 'Nemotron 3 Super',
    provider: 'openrouter',
    params: '120B',
    active: '12B',
    context: 262_144,
    released: '2026-03-11',
    experts: SUPER_EXPERTS,
    arch: SUPER_ARCH,
    vision: false,
    think: { levels: ['off', 'low', 'medium'], default: 'medium', budget: true },
    price: FREE,
  },
  {
    id: 'poolside/laguna-s-2.1:free',
    name: 'Laguna S 2.1',
    provider: 'openrouter',
    params: '118B',
    active: '8B',
    context: 262_144,
    released: '2026-07-21',
    experts: { total: 256, active: 10 },
    arch: ['48 layers (36 sliding, 12 full)', 'dim 3072', 'GQA: 48 to 72 query heads, 8 KV heads', 'sliding window 512'],
    vision: false,
    think: { levels: ['off', 'on'], default: 'on' },
    price: FREE,
    note: 'Built for coding agents.',
  },
  {
    id: 'gpt-oss:120b',
    name: 'gpt-oss 120B',
    provider: 'ollama',
    params: '117B',
    active: '5.1B',
    context: 131_072,
    released: '2025-08-05',
    experts: { total: 128, active: 4 },
    arch: ['36 layers (18 sliding, 18 full)', 'dim 2880', 'GQA: 64 query heads, 8 KV heads', 'sliding window 128'],
    vision: false,
    think: { levels: ['low', 'medium', 'high'], default: 'medium' },
    price: { input: 0.15, cached: 0.014, output: 0.6 },
  },
  {
    id: 'gemma4:31b',
    name: 'Gemma 4 31B',
    provider: 'ollama',
    params: '32.7B',
    context: 262_144,
    released: '2026-04-02',
    arch: GEMMA_31B_ARCH,
    vision: true,
    think: { levels: ['off', 'on'], default: 'off' },
    price: { input: 0.14, cached: 0.05, output: 0.4 },
    note: 'Default. Reads images for the models that cannot see.',
  },
  {
    id: 'google/gemma-4-31b-it:free',
    name: 'Gemma 4 31B',
    provider: 'openrouter',
    params: '32.7B',
    context: 262_144,
    released: '2026-04-02',
    arch: GEMMA_31B_ARCH,
    vision: true,
    think: { levels: ['off', 'on'], default: 'off' },
    price: FREE,
  },
  {
    id: 'xingchen-agi/xing4.0-29b-a4b:free',
    name: 'Xing4.0 29B',
    provider: 'openrouter',
    params: '29B',
    active: '4B',
    context: 262_144,
    released: '2026-10-16',
    experts: { total: 64, active: 4, shared: 1 },
    arch: ['40 layers', 'dim 3584', 'latent attention (MLA style), 32 heads', 'multi-token prediction'],
    vision: false,
    think: { levels: ['off', 'on'], default: 'on' },
    price: FREE,
    note: 'From China Telecom (TeleAI).',
  },
  {
    id: 'google/gemma-4-26b-a4b-it:free',
    name: 'Gemma 4 26B',
    provider: 'openrouter',
    params: '25.2B',
    active: '3.8B',
    context: 262_144,
    released: '2026-04-03',
    experts: { total: 128, active: 8 },
    arch: ['30 layers (25 sliding, 5 full)', 'dim 2816', 'GQA: 16 query heads, 8 KV heads', 'sliding window 1024'],
    vision: true,
    think: { levels: ['off', 'on'], default: 'off' },
    price: FREE,
  },
  {
    id: 'nvidia/nemotron-3.5-lightning:free',
    name: 'Nemotron 3.5 Lightning',
    provider: 'openrouter',
    params: '30B',
    active: '3B',
    context: 1_000_000,
    released: '2026-08-11',
    experts: NANO_EXPERTS,
    arch: [...NANO_ARCH, 'multi-token prediction'],
    vision: false,
    think: { levels: ['off', 'on'] },
    price: FREE,
    note: 'Built for speed.',
  },
  {
    id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    name: 'Nemotron 3 Nano Omni',
    provider: 'openrouter',
    params: '30B',
    active: '3B',
    context: 256_000,
    released: '2026-04-28',
    experts: NANO_EXPERTS,
    arch: [...NANO_ARCH, 'vision and audio encoders'],
    vision: true,
    think: { levels: ['off', 'on'], default: 'on', budget: true },
    price: FREE,
  },
  {
    id: 'nemotron-3-nano:30b',
    name: 'Nemotron 3 Nano 30B',
    provider: 'ollama',
    params: '32B',
    active: '3.2B',
    context: 262_144,
    released: '2025-12-15',
    experts: NANO_EXPERTS,
    arch: NANO_ARCH,
    vision: false,
    think: { levels: ['off', 'on'], default: 'on' },
    price: { input: 0.06, cached: null, output: 0.24 },
  },
  {
    id: 'gpt-oss:20b',
    name: 'gpt-oss 20B',
    provider: 'ollama',
    params: '20.9B',
    active: '3.6B',
    context: 131_072,
    released: '2025-08-05',
    experts: { total: 32, active: 4 },
    arch: ['24 layers (12 sliding, 12 full)', 'dim 2880', 'GQA: 64 query heads, 8 KV heads', 'sliding window 128'],
    vision: false,
    think: { levels: ['low', 'medium', 'high'], default: 'medium' },
    price: { input: 0.07, cached: 0.035, output: 0.3 },
    note: 'Fastest.',
  },
];

export const DEFAULT_MODEL = 'gemma4:31b';

/** Reads images for models that cannot see: Gemma on Ollama (paid, so no daily cap). */
export const VISION_MODEL = 'gemma4:31b';

export function isKnownModel(id: unknown): id is string {
  return typeof id === 'string' && MODELS.some(m => m.id === id);
}

export function modelInfo(id: string | null | undefined): ModelInfo {
  return MODELS.find(m => m.id === id) ?? {
    id: String(id || ''),
    name: String(id || 'Unknown model'),
    provider: String(id || '').includes('/') ? 'openrouter' : 'ollama',
    params: '?',
    context: 131_072,
    released: '',
    arch: [],
    vision: false,
    think: { levels: ['off', 'on'] },
    price: null,
  };
}

export const providerOf = (id: string | null | undefined): Provider => modelInfo(id).provider;

/** A free OpenRouter model: no price, a daily request allowance instead. */
export const isFreeModel = (m: ModelInfo) => m.provider === 'openrouter' && !!m.price && !m.price.input && !m.price.output;

// ─── Thinking ────────────────────────────────────────────────────────────────

/** A model's thinking pick: a level, and for models that take one, a reasoning token budget (0 or absent: none). */
export interface ThinkSetting {
  level: ThinkLevel;
  budget?: number;
}

/** Budget stops for the slider, in reasoning tokens. */
export const THINK_BUDGETS = [1024, 2048, 4096, 8192, 16384, 32768];

export const THINK_LABEL: Record<ThinkLevel, string> = { off: 'Off', minimal: 'Minimal', low: 'Low', on: 'On', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
export const THINK_SHORT: Record<ThinkLevel, string> = { off: 'Off', minimal: 'Min', low: 'Low', on: 'On', medium: 'Med', high: 'High', xhigh: 'XHigh', max: 'Max' };

/** What each level trades, for tooltips. */
export const THINK_HINT: Record<ThinkLevel, string> = {
  off: 'Answers at once: fastest, fine for quick questions and small edits.',
  minimal: 'A glance of reasoning: nearly as fast as off.',
  low: 'Brief reasoning: quick, a little more careful.',
  on: 'Thinks before answering, as deep as the model decides: slower, better at multi step plans.',
  medium: 'Balanced: the usual pick for multi step plans.',
  high: 'Thorough: slower, for tricky schedules and long plans.',
  xhigh: 'Very thorough: much slower, for hard problems.',
  max: 'Everything it has: slowest, for the hardest problems.',
};

const isLevel = (v: unknown): v is ThinkLevel => typeof v === 'string' && (THINK_ORDER as string[]).includes(v);

/** 0 to 4, how much a level thinks, for the bars. */
export const thinkDepth = (l: ThinkLevel): number => ({ off: 0, minimal: 1, low: 1, on: 2, medium: 2, high: 3, xhigh: 4, max: 4 })[l] ?? 0;

export const canStopThinking = (spec: ThinkSpec) => spec.levels.includes('off');

/** The supported level nearest to the one asked for; on a tie, the lighter (faster) one. */
export function nearestLevel(spec: ThinkSpec, want: ThinkLevel): ThinkLevel {
  if (spec.levels.includes(want)) return want;
  const rank = (l: ThinkLevel) => THINK_ORDER.indexOf(l);
  let best = spec.levels[0];
  for (const l of spec.levels) if (Math.abs(rank(l) - rank(want)) < Math.abs(rank(best) - rank(want))) best = l;
  return best;
}

/** The lightest level a model takes: off, or for models that always think, their lowest level. */
export const lightestLevel = (id: string) => modelInfo(id).think.levels[0];

/**
 * The level used before one is picked: the service's own default when it
 * thinks by default, otherwise thinking on (the planner has always thought by
 * default, as it is better at multi step plans).
 */
export function startLevel(id: string): ThinkLevel {
  const spec = modelInfo(id).think;
  if (spec.default && spec.default !== 'off') return spec.default;
  return nearestLevel(spec, 'on');
}

/** A saved pick checked against what the model takes now. Anything malformed falls back to the start level. */
export function resolveThink(id: string, s?: Partial<ThinkSetting> | null): ThinkSetting {
  const spec = modelInfo(id).think;
  const level = nearestLevel(spec, isLevel(s?.level) ? s!.level : startLevel(id));
  const want = Number(s?.budget);
  const budget = spec.budget && level !== 'off' && Number.isFinite(want) && want > 0 ? Math.min(THINK_BUDGETS[THINK_BUDGETS.length - 1], Math.round(want)) : 0;
  return budget ? { level, budget } : { level };
}

/** A thinking pick that came over the wire: kept only if it has a known level. */
export function coerceThinkSetting(raw: unknown): ThinkSetting | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (!isLevel(r.level)) return undefined;
  const b = Number(r.budget);
  return Number.isFinite(b) && b > 0 ? { level: r.level, budget: Math.round(b) } : { level: r.level };
}

/** Per model picks, as a device keeps them. Unknown models and malformed entries are dropped. */
export function coerceThinkBook(raw: unknown): Record<string, ThinkSetting> {
  const out: Record<string, ThinkSetting> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const s = coerceThinkSetting(v);
    if (s && isKnownModel(id)) out[id] = s;
  }
  return out;
}

/**
 * The thinking fields of a request, as each service expects them: Ollama's
 * `think` (true, false or the level name) or OpenRouter's `reasoning` object
 * (a budget replaces the effort: OpenRouter takes one or the other).
 */
export function thinkFields(id: string, s?: Partial<ThinkSetting> | null): { think?: boolean | string; reasoning?: Record<string, unknown> } {
  const m = modelInfo(id);
  const { level, budget } = resolveThink(id, s);
  if (m.provider === 'ollama') return { think: level === 'off' ? false : level === 'on' ? true : level };
  const hasEfforts = m.think.levels.some(l => l !== 'off' && l !== 'on');
  if (level === 'off') return { reasoning: hasEfforts ? { effort: 'none' } : { enabled: false } };
  // `think` rides along as the level to fall back on if the provider fails on the budget.
  if (budget) return { reasoning: { max_tokens: budget }, think: level === 'on' ? true : level };
  return { reasoning: level === 'on' ? { enabled: true } : { effort: level } };
}

/** Thinking as a plain switch (voice mode and its speed test): off is the lightest level, on the usual one. */
export function thinkValue(id: string, on: boolean) {
  return thinkFields(id, { level: on ? startLevel(id) : lightestLevel(id) });
}

/** "Off or on", "Low to Max", for the model cards. */
export function thinkSummary(spec: ThinkSpec): string {
  const lv = spec.levels.filter(l => l !== 'off');
  const range = lv.length === 1 ? THINK_LABEL[lv[0]] : `${THINK_LABEL[lv[0]]} to ${THINK_LABEL[lv[lv.length - 1]]}`;
  return canStopThinking(spec) ? (lv.length === 1 ? 'Off or on' : `Off, ${range}`) : range;
}

export const fmtBudget = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n));

// ─── Cost and formatting ─────────────────────────────────────────────────────

/** Dollar cost of a request from the reported token counts; null without a price. */
export function costOf(id: string, u: { prompt: number; output: number; cached?: number }): number | null {
  const p = modelInfo(id).price;
  if (!p) return null;
  const cached = Math.min(Math.max(0, u.cached || 0), Math.max(0, u.prompt));
  const fresh = Math.max(0, u.prompt) - cached;
  return (fresh * p.input + cached * (p.cached ?? p.input) + Math.max(0, u.output) * p.output) / 1e6;
}

/** 262144 -> "256K", 1048576 -> "1M". */
export function fmtCtx(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '?';
  if (n >= 1_000_000) return `${Math.round(n / 104857.6) / 10}M`;
  return `${Math.round(n / 1024)}K`;
}

/** Token counts for people: 950, 12.3K, 1.2M. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-06-04" -> "Jun 4, 2026". Locale-free so the phone and PC agree. */
export function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return '';
  return `${MONTHS[Number(m[2]) - 1] ?? ''} ${Number(m[3])}, ${m[1]}`;
}

/** A per-million price: $0.10, $0.015, $3.00. */
export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  return `$${n < 0.1 && n > 0 ? n.toFixed(3) : n.toFixed(2)}`;
}

/** What one reply cost: $0, <$0.0001, $0.0042, $0.031, $1.20. */
export function fmtMoney(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n < 0.0001) return '<$0.0001';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

/** "Dense, 32.7B" or "MoE, 501B total, 23B active". */
export function paramsLabel(m: Pick<ModelInfo, 'params' | 'active'>): string {
  return m.active ? `MoE, ${m.params} total, ${m.active} active` : `Dense, ${m.params}`;
}

/** "22 of 512 experts active + 1 shared": what each token goes through in a MoE layer. */
export function expertsLabel(e: Experts): string {
  return `${e.active} of ${e.total} experts active${e.shared ? ` + ${e.shared} shared` : ''}`;
}

export function expertsTitle(e: Experts): string {
  return `Each MoE layer has ${e.total} experts; every token goes through ${e.active} of them${e.shared ? `, plus ${e.shared} shared expert${e.shared > 1 ? 's' : ''} every token always uses` : ''}.`;
}

/** "$0.10 in · $3.00 out / 1M", "Free · 50 requests a day", or "Price not listed". */
export function priceLabel(m: ModelInfo): string {
  if (!m.price) return 'Price not listed';
  if (isFreeModel(m)) return 'Free · 50 requests a day';
  return `${fmtPrice(m.price.input)} in · ${fmtPrice(m.price.output)} out / 1M`;
}
