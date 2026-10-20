// ─── Planner agent: the models it can run on ────────────────────────────────
//
// Shared verbatim by the server, the PC/browser panel and the Android app
// (copied into mobile/src/lib/agent/). Pure, no imports.
//
// Only Ollama Cloud, with the one key in `.env`. These are the models that
// key's free usage credits cover, strongest first (by total, then active,
// parameters). Facts from Ollama's /api/show and each model's config, prices
// from ollama.com/pricing (US dollars per million tokens), checked 19 October
// 2026. The same numbers as the Notes app's assistant.

export interface ModelInfo {
  /** The name Ollama knows it by. */
  id: string;
  name: string;
  /** Total parameters. */
  params: string;
  /** Active parameters per token for mixture-of-experts models; absent means dense. */
  active?: string;
  /** Context window in tokens. */
  context: number;
  /** When the model was published on Ollama. */
  released: string;
  /** Architecture facts from the model's config or technical report. */
  arch: string[];
  /** Reads images itself. The others get images described by VISION_MODEL first. */
  vision: boolean;
  /** gpt-oss takes a reasoning level instead of on/off. */
  thinkLevels?: boolean;
  /** Per million tokens; null when Ollama does not list a price yet. */
  price: { input: number; cached: number | null; output: number } | null;
  note?: string;
}

const ULTRA_ARCH = ['108 layers (48 Mamba-2, 48 MoE, 12 attention)', 'dim 8192', '512 experts + 1 shared, 22 per token', 'LatentMoE (latent 2048)', 'GQA: 64 query heads, 2 KV heads', 'multi-token prediction'];
const SUPER_ARCH = ['88 layers (40 Mamba-2, 40 MoE, 8 attention)', 'dim 4096', '512 experts + 1 shared, 22 per token', 'LatentMoE (latent 1024)', 'GQA: 32 query heads, 2 KV heads', 'multi-token prediction'];
const NANO_ARCH = ['52 layers (23 Mamba-2, 23 MoE, 6 attention)', 'dim 2688', '128 experts + 1 shared, 6 per token', 'GQA: 32 query heads, 2 KV heads'];

export const MODELS: ModelInfo[] = [
  {
    id: 'nemotron-3-ultra',
    name: 'Nemotron 3 Ultra',
    params: '550B',
    active: '55B',
    context: 262_144,
    released: '2026-06-04',
    arch: ULTRA_ARCH,
    vision: false,
    price: { input: 0.1, cached: 0.1, output: 3.0 },
  },
  {
    id: 'beam',
    name: 'Beam',
    params: '501B',
    active: '23B',
    context: 1_048_576,
    released: '2026-10-16',
    arch: ['52 layers (3 dense, 49 MoE)', 'dim 5120', '256 experts, 8 per token', 'GQA: 48 query heads, 8 KV heads', 'sliding window 512, 9 global layers'],
    vision: false,
    price: null,
    note: 'Newest. Price not listed on Ollama yet.',
  },
  {
    id: 'nemotron-3-super',
    name: 'Nemotron 3 Super',
    params: '120B',
    active: '12B',
    context: 262_144,
    released: '2026-03-11',
    arch: SUPER_ARCH,
    vision: false,
    price: { input: 0.015, cached: 0.015, output: 0.6 },
  },
  {
    id: 'gpt-oss:120b',
    name: 'gpt-oss 120B',
    params: '117B',
    active: '5.1B',
    context: 131_072,
    released: '2025-08-05',
    arch: ['36 layers (18 sliding, 18 full)', 'dim 2880', '128 experts, 4 per token', 'GQA: 64 query heads, 8 KV heads', 'sliding window 128'],
    vision: false,
    thinkLevels: true,
    price: { input: 0.15, cached: 0.014, output: 0.6 },
  },
  {
    id: 'gemma4:31b',
    name: 'Gemma 4 31B',
    params: '32.7B',
    context: 262_144,
    released: '2026-04-02',
    arch: ['60 layers', 'dim 5376', 'GQA: 32 query heads, 16 KV heads', 'sliding window 1024, 10 full-attention layers'],
    vision: true,
    price: { input: 0.14, cached: 0.05, output: 0.4 },
    note: 'Default. Reads images for the models that cannot see.',
  },
  {
    id: 'nemotron-3-nano:30b',
    name: 'Nemotron 3 Nano 30B',
    params: '32B',
    active: '3.2B',
    context: 262_144,
    released: '2025-12-15',
    arch: NANO_ARCH,
    vision: false,
    price: { input: 0.06, cached: null, output: 0.24 },
  },
  {
    id: 'gpt-oss:20b',
    name: 'gpt-oss 20B',
    params: '20.9B',
    active: '3.6B',
    context: 131_072,
    released: '2025-08-05',
    arch: ['24 layers (12 sliding, 12 full)', 'dim 2880', '32 experts, 4 per token', 'GQA: 64 query heads, 8 KV heads', 'sliding window 128'],
    vision: false,
    thinkLevels: true,
    price: { input: 0.07, cached: 0.035, output: 0.3 },
    note: 'Fastest.',
  },
];

export const DEFAULT_MODEL = 'gemma4:31b';

/** Reads images for models that cannot see. */
export const VISION_MODEL = 'gemma4:31b';

export function isKnownModel(id: unknown): id is string {
  return typeof id === 'string' && MODELS.some(m => m.id === id);
}

export function modelInfo(id: string | null | undefined): ModelInfo {
  return MODELS.find(m => m.id === id) ?? {
    id: String(id || ''),
    name: String(id || 'Unknown model'),
    params: '?',
    context: 131_072,
    released: '',
    arch: [],
    vision: false,
    price: null,
  };
}

/** The think switch, as each model expects it. The planner always reasons. */
export function thinkValue(id: string): boolean | 'high' {
  return modelInfo(id).thinkLevels ? 'high' : true;
}

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

/** "$0.10 in · $3.00 out / 1M", or "Price not listed". */
export function priceLabel(m: ModelInfo): string {
  if (!m.price) return 'Price not listed';
  return `${fmtPrice(m.price.input)} in · ${fmtPrice(m.price.output)} out / 1M`;
}
