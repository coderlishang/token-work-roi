/**
 * Official pricing calculator.
 *
 * This module intentionally avoids third-party pricing caches. Rates are copied
 * from provider-owned pricing pages and are expressed as USD per 1M tokens.
 * Unknown or research-preview models return 0 and are reported as unpriced.
 */

import { canonicalModelName } from './model-name.ts';

const MTOK = 1_000_000;
const VERIFIED_AT = '2026-09-23';
const DEFAULT_ANTHROPIC_CACHE_WRITE_TTL = '5m';
const PRICING_RATE_FIELDS = ['input', 'cachedInput', 'cacheWrite5m', 'cacheWrite1h', 'output'] as const;

type InputRecord = Record<string, unknown>;

interface PricingSource {
  provider: string;
  label: string;
  url: string;
  assetUrls?: string[];
  note: string;
}

interface PricingRates {
  input: number;
  cachedInput: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

interface OfficialCurrencyRates {
  currency: string;
  unit: string;
  ratesPerMTok: Partial<PricingRates>;
  exchangeRate?: number;
  sourceUnit?: string;
}

interface OfficialRateInput {
  provider: string;
  model: string;
  aliases: string[];
  input?: number;
  cachedInput?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  output?: number;
  source: string;
  note: string;
  unavailableReason?: string;
  officialRatesPerMTok?: OfficialCurrencyRates | null;
  rateSchedule?: OfficialRateScheduleInput[] | null;
}

// 价目时间表：同一模型不同时期的官方价，from 为生效日（null 表示更早不限），
// 供按用量日期取价，保证重采复现历史成本而不是用现价改写历史。
interface OfficialRateScheduleInput {
  from?: string | null;
  ratesPerMTok?: Partial<PricingRates> | null;
}

interface OfficialRate {
  provider: string;
  model: string;
  aliases: string[];
  priced: boolean;
  unavailableReason: string | null;
  ratesPerMTok: PricingRates | null;
  officialRatesPerMTok?: OfficialCurrencyRates | null;
  rateSchedule?: RateScheduleEntry[] | null;
  source: PricingSource | null;
  pricingFetchStatus?: string | null;
  note: string | null;
}

interface RateScheduleEntry {
  from: string | null;
  ratesPerMTok: PricingRates | null;
}

interface CachedRateInput {
  provider: string;
  model: string;
  aliases?: string[];
  priced?: boolean;
  unavailableReason?: string | null;
  ratesPerMTok?: Partial<PricingRates> | null;
  officialRatesPerMTok?: OfficialCurrencyRates | null;
  rateSchedule?: RateScheduleEntry[] | null;
  sourceProvider?: string | null;
  source?: PricingSource | string | null;
  pricingFetchStatus?: string | null;
  note?: string | null;
}

interface PricingData {
  mode?: string;
  verifiedAt?: string;
  fetchedAt?: string | null;
  sources?: PricingSource[];
  models?: CachedRateInput[];
}

interface PricingOptions {
  provider?: string | null;
  pricingData?: PricingData | null;
  anthropicCacheWriteTtl?: string | null;
  usageDate?: string | null;
}

interface TokenInput extends InputRecord {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cache_read?: unknown;
  cacheWrite?: unknown;
  cache_write?: unknown;
  reasoning?: unknown;
}

interface PricingRow extends InputRecord {
  model?: unknown;
  pricingModel?: unknown;
  pricingStatus?: unknown;
  pricingReason?: unknown;
  costUSD?: unknown;
  totalTokens?: unknown;
  total_tokens?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheCreationTokens?: unknown;
  reasoningOutputTokens?: unknown;
  cachedInputTokens?: unknown;
  cachedInput?: unknown;
  cacheRead?: unknown;
  input?: unknown;
  output?: unknown;
  cacheWrite?: unknown;
  reasoning?: unknown;
}

export const OFFICIAL_PRICING_SOURCES = [
  {
    provider: 'openai',
    label: 'OpenAI API pricing',
    url: 'https://openai.com/api/pricing/',
    note: 'Standard API rates; Batch, Flex, Priority, long-context and data residency modifiers are not applied by default.'
  },
  {
    provider: 'openai-codex',
    label: 'OpenAI Codex pricing',
    url: 'https://developers.openai.com/codex/pricing',
    note: 'Codex ChatGPT-plan credits are documented separately; API-key mode uses OpenAI API pricing.'
  },
  {
    provider: 'openai-gpt-5.6',
    label: 'OpenAI GPT-5.6 launch pricing',
    url: 'https://openai.com/index/gpt-5-6/',
    note: 'GPT-5.6 launch rates; cache write is 25% above input and cache read is 90% below input.'
  },
  {
    provider: 'openai-gpt-6-astra',
    label: 'OpenAI GPT-6 Astra pricing',
    url: 'https://developers.openai.com/api/docs/models/gpt-6-astra',
    note: 'Standard API rates; long-context, Batch, Flex and Fast mode modifiers are not applied by default.'
  },
  {
    provider: 'xai',
    label: 'xAI model pricing',
    url: 'https://docs.x.ai/developers/models',
    note: 'xAI public model page lists input and output rates; no separate cached-input rate is applied by default.'
  },
  {
    provider: 'anthropic',
    label: 'Claude API pricing',
    url: 'https://claude.com/pricing',
    note: 'First-party Claude API global standard pricing; cache write defaults to 5-minute prompt caching.'
  },
  {
    provider: 'anthropic-mythos',
    label: 'Claude Mythos 5.1 pricing',
    url: 'https://www.anthropic.com/claude/mythos',
    note: 'First-party Mythos 5.1 starting price; separate prompt-cache rates are not published.'
  },
  {
    provider: 'deepseek',
    label: 'DeepSeek Models & Pricing',
    url: 'https://api-docs.deepseek.com/quick_start/pricing',
    note: 'Overseas USD API prices per 1M tokens.'
  },
  {
    provider: 'xiaomi',
    label: 'Xiaomi MiMo API pricing',
    url: 'https://platform.xiaomimimo.com/docs/en-US/price/pay-as-you-go',
    note: 'Overseas USD API prices per 1M tokens.'
  },
  {
    provider: 'Zhipu GLM',
    label: 'Z.ai / BigModel pricing',
    url: 'https://open.bigmodel.cn/pricing',
    note: 'Official BigModel pricing page. RMB prices are converted to USD for internal cost math.'
  },
  {
    provider: 'DoubaoSeed',
    label: 'Volcengine Ark pricing',
    url: 'https://www.volcengine.com/pricing?product=ark_bd&tab=1',
    note: 'Official Ark pricing page. RMB prices are converted to USD for internal cost math.'
  },
  {
    provider: 'Gemini',
    label: 'Gemini API pricing',
    url: 'https://ai.google.dev/gemini-api/docs/pricing',
    note: 'Gemini API USD prices per 1M tokens; Pro has separate short-context and long-context rates.'
  },
  {
    provider: 'Kimi',
    label: 'Kimi API pricing',
    url: 'https://platform.kimi.com/docs/pricing/chat',
    assetUrls: [
      'https://platform.kimi.com/docs/pricing/chat.md'
    ],
    note: 'Official Kimi API RMB prices converted to USD for internal cost math.'
  },
  {
    provider: 'Qwen',
    label: 'Alibaba Cloud Model Studio pricing',
    url: 'https://help.aliyun.com/zh/model-studio/billing-for-model-studio',
    note: 'Official Alibaba Cloud Model Studio RMB prices converted to USD for internal cost math; short-context public rates are used by default.'
  },
  {
    provider: 'Tencent Hunyuan',
    label: 'Tencent TokenHub model pricing',
    url: 'https://cloud.tencent.com/document/product/1823/130055',
    note: 'Tencent TokenHub RMB prices are converted to USD for internal cost math.'
  }
];

export const OFFICIAL_PRICE_TABLE = [
  officialRate({
    provider: "openai",
    model: "gpt-6-astra",
    aliases: ["gpt-6-astra", "gpt_6_astra"],
    input: 10,
    cachedInput: 1,
    cacheWrite5m: 12.5,
    cacheWrite1h: 12.5,
    output: 50,
    source: "openai-gpt-6-astra",
    note: "OpenAI GPT-6 Astra standard API rate. Cache write is input x 1.25; cached input is input x 0.1."
  }),
  officialRate({
    provider: "openai",
    model: "gpt-5.6-sol",
    aliases: ["gpt-5-6-sol"],
    input: 5,
    cachedInput: 0.5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 6.25,
    output: 30,
    source: "openai-gpt-5.6",
    note: "OpenAI GPT-5.6 Sol flagship launch rate. Cache write is input × 1.25; cache read is input × 0.1."
  }),
  officialRate({
    provider: "openai",
    model: "gpt-5.6-terra",
    aliases: ["gpt-5-6-terra"],
    input: 2.5,
    cachedInput: 0.25,
    cacheWrite5m: 3.125,
    cacheWrite1h: 3.125,
    output: 15,
    source: "openai-gpt-5.6",
    note: "OpenAI GPT-5.6 Terra balanced launch rate. Cache write is input × 1.25; cache read is input × 0.1."
  }),
  officialRate({
    provider: "openai",
    model: "gpt-5.6-luna",
    aliases: ["gpt-5-6-luna"],
    input: 1,
    cachedInput: 0.1,
    cacheWrite5m: 1.25,
    cacheWrite1h: 1.25,
    output: 6,
    source: "openai-gpt-5.6",
    note: "OpenAI GPT-5.6 Luna lightweight launch rate. Cache write is input × 1.25; cache read is input × 0.1."
  }),
  officialRate({
    provider: "openai",
    model: "gpt-5.6-cyber",
    aliases: ["gpt-5-6-cyber"],
    input: 12.5,
    cachedInput: 1.25,
    cacheWrite5m: 15.625,
    cacheWrite1h: 15.625,
    output: 75,
    source: "openai-gpt-5.6",
    note: "OpenAI GPT-5.6 Cyber security-specialist rate with restricted API access. Cache write is input × 1.25; cache read is input × 0.1."
  }),
  officialRate({
    provider: "openai",
    model: "gpt-5.5",
    aliases: ["gpt-5-5"],
    input: 5,
    cachedInput: 0.5,
    cacheWrite5m: 5,
    cacheWrite1h: 5,
    output: 30,
    source: "openai",
    note: "OpenAI API standard short-context rate."
  }),
  officialRate({
    provider: "openai",
    model: "gpt-5.5-pro",
    aliases: ["gpt-5-5-pro"],
    input: 30,
    cachedInput: 30,
    cacheWrite5m: 30,
    cacheWrite1h: 30,
    output: 180,
    source: "openai",
    note: "OpenAI API standard short-context rate; the pricing page does not publish cache rates for Pro models, so cached input and cache write fall back to the input rate."
  }),
  officialRate({
    provider: "openai",
    model: "gpt-5.4",
    aliases: ["gpt-5-4"],
    input: 2.5,
    cachedInput: 0.25,
    cacheWrite5m: 2.5,
    cacheWrite1h: 2.5,
    output: 15,
    source: "openai",
    note: "OpenAI API standard short-context rate; long-context rates ($5.00 input / $0.50 cached input / $22.50 output) are not applied because the source event format does not carry the context tier."
  }),
  officialRate({
    provider: "openai",
    model: "gpt-5.4-pro",
    aliases: ["gpt-5-4-pro"],
    input: 30,
    cachedInput: 30,
    cacheWrite5m: 30,
    cacheWrite1h: 30,
    output: 180,
    source: "openai",
    note: "OpenAI API standard short-context rate; the pricing page does not publish cache rates for Pro models, so cached input and cache write fall back to the input rate."
  }),
  officialRate({
    provider: "openai",
    model: "gpt-5.4-nano",
    aliases: ["gpt-5-4-nano"],
    input: 0.2,
    cachedInput: 0.02,
    cacheWrite5m: 0.2,
    cacheWrite1h: 0.2,
    output: 1.25,
    source: "openai",
    note: "OpenAI API standard short-context rate."
  }),
  officialRate({
    provider: "openai",
    model: "gpt-image-2",
    aliases: ["gpt-image-2", "gpt_image_2"],
    input: 8,
    cachedInput: 2,
    cacheWrite5m: 8,
    cacheWrite1h: 8,
    output: 30,
    source: "openai",
    note: "OpenAI API image-token rate. The source event format does not identify text and image input separately, so input tokens use the published image rate; cache creation uses the input rate because the pricing table does not list a separate cache-write rate."
  }),
  officialRate({
    provider: "openai",
    model: "gpt-image-2.5-sunburst",
    aliases: ["gpt-image-2-5-sunburst", "gpt_image_2_5_sunburst"],
    input: 8,
    cachedInput: 2,
    cacheWrite5m: 8,
    cacheWrite1h: 8,
    output: 30,
    source: "openai",
    note: "OpenAI API image-token rate. The source event format does not identify text and image input separately, so input tokens use the published image rate; cache creation uses the input rate because the pricing table does not list a separate cache-write rate."
  }),
  officialRate({
    provider: "openai",
    model: "gpt-image-2.5-flare",
    aliases: ["gpt-image-2-5-flare", "gpt_image_2_5_flare"],
    input: 8,
    cachedInput: 2,
    cacheWrite5m: 8,
    cacheWrite1h: 8,
    output: 30,
    source: "openai",
    note: "OpenAI API image-token rate. The source event format does not identify text and image input separately, so input tokens use the published image rate; cache creation uses the input rate because the pricing table does not list a separate cache-write rate."
  }),
  officialRate({
    provider: "openai",
    model: "gpt-5.4-mini",
    aliases: ["gpt-5-4-mini"],
    rateSchedule: [{"from":null,"ratesPerMTok":null},{"from":"2026-09-18","ratesPerMTok":{"input":0.2,"cachedInput":0.02,"cacheWrite5m":0.2,"cacheWrite1h":0.2,"output":1.25}}],
    source: "openai",
    unavailableReason: "OpenAI API pricing page was not reachable during the last pricing refresh; do not infer this model price without a verified official rate.",
    note: "Standard API rates; Batch, Flex, Priority, long-context and data residency modifiers are not applied by default."
  }),
  officialRate({
    provider: "openai",
    model: "gpt-5.3-codex",
    aliases: ["gpt-5-3-codex"],
    input: 1.75,
    cachedInput: 0.175,
    cacheWrite5m: 1.75,
    cacheWrite1h: 1.75,
    output: 14,
    source: "openai",
    note: "OpenAI API standard Codex model rate."
  }),
  officialRate({
    provider: "openai",
    model: "gpt-5.3-codex-spark",
    aliases: ["gpt-5-3-codex-spark"],
    source: "openai-codex",
    unavailableReason: "OpenAI Codex docs list GPT-5.3-Codex-Spark as research preview and do not publish a USD API token rate.",
    note: "Codex ChatGPT-plan credits are documented separately; API-key mode uses OpenAI API pricing."
  }),
  officialRate({
    provider: "xai",
    model: "grok-4.5",
    aliases: ["grok-4-5"],
    input: 2,
    cachedInput: 0.3,
    cacheWrite5m: 2,
    cacheWrite1h: 2,
    output: 6,
    rateSchedule: [{"from":null,"ratesPerMTok":{"input":2,"cachedInput":2,"cacheWrite5m":2,"cacheWrite1h":2,"output":6}},{"from":"2026-09-18","ratesPerMTok":{"input":2,"cachedInput":0.3,"cacheWrite5m":2,"cacheWrite1h":2,"output":6}}],
    source: "xai",
    note: "xAI Grok 4.5 public model page lists input and output rates; cached-input rate verified against the official models page."
  }),
  officialRate({
    provider: "xai",
    model: "grok-4.6",
    aliases: ["grok-4-6"],
    rateSchedule: [{"from":null,"ratesPerMTok":null},{"from":"2026-09-18","ratesPerMTok":{"input":2,"cachedInput":0.5,"cacheWrite5m":2,"cacheWrite1h":2,"output":6}}],
    source: "xai",
    unavailableReason: "Grok 4.6 is recognized, but its official API rate has not been synchronized to the local price cache. This does not mean the model is free or has no price.",
    note: "Costs remain uncalculated until the official xAI API rate is refreshed."
  }),
  officialRate({
    provider: "xai",
    model: "grok-4.3",
    aliases: ["grok-4-3"],
    input: 1.25,
    cachedInput: 0.2,
    cacheWrite5m: 1.25,
    cacheWrite1h: 1.25,
    output: 2.5,
    source: "xai",
    note: "xAI public model page rate; cached input is input × 0.1."
  }),
  officialRate({
    provider: "xai",
    model: "grok-4.20-0309-reasoning",
    aliases: ["grok-4-20-0309-reasoning", "grok-4-20"],
    input: 1.25,
    cachedInput: 0.2,
    cacheWrite5m: 1.25,
    cacheWrite1h: 1.25,
    output: 2.5,
    source: "xai",
    note: "xAI public model page rate for the reasoning variant of Grok 4.20 (0309 release)."
  }),
  officialRate({
    provider: "xai",
    model: "grok-4.20-0309-non-reasoning",
    aliases: ["grok-4-20-0309-non-reasoning"],
    input: 1.25,
    cachedInput: 0.2,
    cacheWrite5m: 1.25,
    cacheWrite1h: 1.25,
    output: 2.5,
    source: "xai",
    note: "xAI public model page rate for the non-reasoning variant of Grok 4.20 (0309 release)."
  }),
  officialRate({
    provider: "xai",
    model: "grok-4.20-0309-multi-agent-0309",
    aliases: ["grok-4-20-0309-multi-agent-0309"],
    input: 1.25,
    cachedInput: 0.2,
    cacheWrite5m: 1.25,
    cacheWrite1h: 1.25,
    output: 2.5,
    source: "xai",
    note: "xAI public model page rate for the multi-agent variant of Grok 4.20 (0309 release)."
  }),
  officialRate({
    provider: "xai",
    model: "grok-build-0.1",
    aliases: ["grok-build-0-1"],
    input: 1,
    cachedInput: 0.2,
    cacheWrite5m: 1,
    cacheWrite1h: 1,
    output: 2,
    source: "xai",
    note: "xAI public model page rate for Grok Build."
  }),
  officialRate({
    provider: "anthropic",
    model: "claude-mythos-5",
    aliases: ["claude-mythos-5"],
    input: 10,
    cachedInput: 10,
    cacheWrite5m: 10,
    cacheWrite1h: 10,
    output: 50,
    rateSchedule: [{"from":null,"ratesPerMTok":{"input":10,"cachedInput":10,"cacheWrite5m":10,"cacheWrite1h":10,"output":50}},{"from":"2026-09-18","ratesPerMTok":{"input":10,"cachedInput":1,"cacheWrite5m":12.5,"cacheWrite1h":20,"output":50}}],
    source: "anthropic-mythos",
    note: "Claude Mythos 5 is limited to vetted trusted-access partners; separate prompt-cache rates are not published."
  }),
  officialRate({
    provider: "anthropic",
    model: "claude-mythos-5.1",
    aliases: ["claude-mythos-5-1"],
    input: 10,
    cachedInput: 10,
    cacheWrite5m: 10,
    cacheWrite1h: 10,
    output: 50,
    rateSchedule: [{"from":null,"ratesPerMTok":{"input":10,"cachedInput":10,"cacheWrite5m":10,"cacheWrite1h":10,"output":50}},{"from":"2026-09-18","ratesPerMTok":{"input":10,"cachedInput":0.25,"cacheWrite5m":12.5,"cacheWrite1h":20,"output":50}}],
    source: "anthropic-mythos",
    note: "Claude Mythos 5.1 is limited to vetted trusted-access partners; separate prompt-cache rates are not published."
  }),
  officialRate({
    provider: "anthropic",
    model: "claude-fable-5",
    aliases: ["claude-fable-5"],
    input: 10,
    cachedInput: 0.25,
    cacheWrite5m: 12.5,
    cacheWrite1h: 20,
    output: 50,
    source: "anthropic",
    note: "First-party Claude Fable 5 pricing; cache write defaults to 5-minute prompt caching."
  }),
  officialRate({
    provider: "anthropic",
    model: "claude-fable-5.1",
    aliases: ["claude-fable-5-1"],
    input: 10,
    cachedInput: 0.25,
    cacheWrite5m: 12.5,
    cacheWrite1h: 20,
    output: 50,
    source: "anthropic",
    note: "First-party Claude Fable 5.1 pricing; cache write defaults to 5-minute prompt caching."
  }),
  officialRate({
    provider: "anthropic",
    model: "claude-opus-5",
    aliases: ["claude-opus-5"],
    input: 5,
    cachedInput: 0.5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    output: 25,
    source: "anthropic",
    note: "First-party Claude API global standard pricing; cache write defaults to 5-minute prompt caching."
  }),
  officialRate({
    provider: "anthropic",
    model: "claude-opus-5-5",
    aliases: ["claude-opus-5-5"],
    input: 4,
    cachedInput: 0.2,
    cacheWrite5m: 5,
    cacheWrite1h: 8,
    output: 20,
    rateSchedule: [{"from":null,"ratesPerMTok":null},{"from":"2026-09-22","ratesPerMTok":{"input":4,"cachedInput":0.2,"cacheWrite5m":5,"cacheWrite1h":8,"output":20}}],
    source: "anthropic",
    note: "First-party Claude Opus 5.5 pricing; cache write defaults to 5-minute prompt caching, 1-hour cache write is input × 2."
  }),
  officialRate({
    provider: "anthropic",
    model: "claude-opus-4-8",
    aliases: ["claude-opus-4-8"],
    input: 5,
    cachedInput: 0.5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    output: 25,
    source: "anthropic",
    note: "First-party Claude API global standard pricing; cache write defaults to 5-minute prompt caching."
  }),
  officialRate({
    provider: "anthropic",
    model: "claude-opus-4-7",
    aliases: ["claude-opus-4-7"],
    input: 5,
    cachedInput: 0.5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    output: 25,
    source: "anthropic",
    note: "First-party Claude API global standard pricing; cache write defaults to 5-minute prompt caching."
  }),
  officialRate({
    provider: "anthropic",
    model: "claude-opus-4-6",
    aliases: ["claude-opus-4-6"],
    input: 5,
    cachedInput: 0.5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    output: 25,
    source: "anthropic",
    note: "First-party Claude API global standard pricing; cache write defaults to 5-minute prompt caching."
  }),
  officialRate({
    provider: "anthropic",
    model: "claude-sonnet-5",
    aliases: ["claude-sonnet-5"],
    input: 2,
    cachedInput: 0.2,
    cacheWrite5m: 2.5,
    cacheWrite1h: 4,
    output: 10,
    source: "anthropic",
    note: "First-party Claude API global standard pricing; cache write defaults to 5-minute prompt caching."
  }),
  officialRate({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    aliases: ["claude-sonnet-4-6"],
    input: 3,
    cachedInput: 0.3,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
    output: 15,
    source: "anthropic",
    note: "First-party Claude API global standard pricing; cache write defaults to 5-minute prompt caching."
  }),
  officialRate({
    provider: "anthropic",
    model: "claude-opus-4-5",
    aliases: ["claude-opus-4-5"],
    input: 5,
    cachedInput: 0.5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    output: 25,
    source: "anthropic",
    note: "First-party Claude API global standard pricing; cache write defaults to 5-minute prompt caching."
  }),
  officialRate({
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    aliases: ["claude-sonnet-4-5"],
    input: 3,
    cachedInput: 0.3,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
    output: 15,
    source: "anthropic",
    note: "First-party Claude API global standard pricing; cache write defaults to 5-minute prompt caching."
  }),
  officialRate({
    provider: "anthropic",
    model: "claude-haiku-4-5",
    aliases: ["claude-haiku-4-5"],
    input: 1,
    cachedInput: 0.1,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2,
    output: 5,
    source: "anthropic",
    note: "First-party Claude API global standard pricing; cache write defaults to 5-minute prompt caching."
  }),
  officialRate({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    aliases: ["deepseek-v4-pro"],
    input: 1.32,
    cachedInput: 0.044,
    cacheWrite5m: 1.32,
    cacheWrite1h: 1.32,
    output: 3.96,
    source: "deepseek",
    note: "Overseas USD API prices per 1M tokens."
  }),
  officialRate({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    aliases: ["deepseek-v4-flash", "deepseek-v4-flash-0731", "deepseek-v4-flash-vision-exp", "deepseek-chat", "deepseek-reasoner"],
    input: 0.14,
    cachedInput: 0.0028,
    cacheWrite5m: 0.14,
    cacheWrite1h: 0.14,
    output: 0.28,
    source: "deepseek",
    note: "Historical DeepSeek-V4-Flash-0731 rate retained for recorded legacy model identifiers."
  }),
  officialRate({
    provider: "deepseek",
    model: "deepseek-flash",
    aliases: ["deepseek-flash", "deepseek-v4-1-flash"],
    input: 0.3,
    cachedInput: 0.006,
    cacheWrite5m: 0.3,
    cacheWrite1h: 0.3,
    output: 1.2,
    source: "deepseek",
    note: "DeepSeek-V4.1-Flash uses the deepseek-flash API name. Peak rates are used because historical collection records do not contain the provider billing window; off-peak rates are half of these values."
  }),
  officialRate({
    provider: "MiniMax",
    model: "minimax-m3",
    aliases: ["minimax-m3", "minimax-m-3"],
    input: 0.6256079196004452,
    cachedInput: 0.6256079196004452,
    cacheWrite5m: 0.6256079196004452,
    cacheWrite1h: 0.6256079196004452,
    output: 2.5024316784017806,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":4.2,"output":16.8,"cachedInput":4.2,"cacheWrite5m":4.2,"cacheWrite1h":4.2},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Qwen",
    note: "Official Alibaba Cloud Model Studio rate for MiniMax-M3. This does not represent a direct MiniMax API price."
  }),
  officialRate({
    provider: "xiaomi",
    model: "mimo-v2.5-pro",
    aliases: ["mimo-v2-5-pro"],
    input: 0.435,
    cachedInput: 0.0036,
    cacheWrite5m: 0.435,
    cacheWrite1h: 0.435,
    output: 0.87,
    source: "xiaomi",
    note: "Overseas USD API prices per 1M tokens."
  }),
  officialRate({
    provider: "xiaomi",
    model: "mimo-v2.5",
    aliases: ["mimo-v2-5"],
    input: 0.14,
    cachedInput: 0.0028,
    cacheWrite5m: 0.14,
    cacheWrite1h: 0.14,
    output: 0.28,
    source: "xiaomi",
    note: "Overseas USD API prices per 1M tokens."
  }),
  officialRate({
    provider: "xiaomi",
    model: "mimo-v2-pro",
    aliases: ["mimo-v2-pro"],
    input: 0.435,
    cachedInput: 0.0036,
    cacheWrite5m: 0.435,
    cacheWrite1h: 0.435,
    output: 0.87,
    source: "xiaomi",
    note: "Xiaomi docs state mimo-v2-pro routes to V2.5 pricing."
  }),
  officialRate({
    provider: "Tencent Hunyuan",
    model: "hy3",
    aliases: ["hy3", "hy-3", "hunyuan-hy3", "hy3-x", "hy3_x", "hunyuan-hy3-x", "hunyuan_hy3_x"],
    input: 0.14895426657153454,
    cachedInput: 0.037238566642883636,
    cacheWrite5m: 0.14895426657153454,
    cacheWrite1h: 0.14895426657153454,
    output: 0.5958170662861382,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":1,"output":4,"cachedInput":0.25,"cacheWrite5m":1,"cacheWrite1h":1},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Tencent Hunyuan",
    note: "Official Tencent TokenHub hy3 RMB rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Tencent Hunyuan",
    model: "hy4-preview",
    aliases: ["hy4-preview", "hy-4-preview", "hunyuan-hy4-preview", "hunyuan-hy-4-preview"],
    input: 0.8937255994292073,
    cachedInput: 0.04468627997146036,
    cacheWrite5m: 0.8937255994292073,
    cacheWrite1h: 0.8937255994292073,
    output: 2.6811767982876216,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":6,"output":18,"cachedInput":0.3,"cacheWrite5m":6,"cacheWrite1h":6},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Tencent Hunyuan",
    note: "Official Tencent TokenHub hy4-preview RMB rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-5.3",
    aliases: ["glm-5-3"],
    input: 1.1916341325722764,
    cachedInput: 0.2979085331430691,
    cacheWrite5m: 1.1916341325722764,
    cacheWrite1h: 1.1916341325722764,
    output: 4.170719464002967,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":8,"output":28,"cachedInput":2,"cacheWrite5m":8,"cacheWrite1h":8},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel RMB rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-5.3-flash",
    aliases: ["glm-5-3-flash"],
    input: 0.11916341325722764,
    cachedInput: 0.03425948131145295,
    cacheWrite5m: 0.11916341325722764,
    cacheWrite1h: 0.11916341325722764,
    output: 0.4170719464002967,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":0.8,"output":2.8,"cachedInput":0.23,"cacheWrite5m":0.8,"cacheWrite1h":0.8},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    rateSchedule: [{"from":null,"ratesPerMTok":{"input":0.05946333743333045,"cachedInput":0.017095709512082505,"cacheWrite5m":0.05946333743333045,"cacheWrite1h":0.05946333743333045,"output":0.20812168101665654}},{"from":"2026-09-18","ratesPerMTok":{"input":0.1189266748666609,"cachedInput":0.03419141902416501,"cacheWrite5m":0.1189266748666609,"cacheWrite1h":0.1189266748666609,"output":0.4162433620333131}}],
    source: "Zhipu GLM",
    note: "Official BigModel RMB rate; the limited-time promo rate (0.4/1.4/0.115 CNY) applied through 2026-09-17."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-5.3-flashx",
    aliases: ["glm-5-3-flashx"],
    input: 0.2979085331430691,
    cachedInput: 0.08490393194577468,
    cacheWrite5m: 0.2979085331430691,
    cacheWrite1h: 0.2979085331430691,
    output: 1.0426798660007417,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":2,"output":7,"cachedInput":0.57,"cacheWrite5m":2,"cacheWrite1h":2},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel RMB rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-5.2",
    aliases: ["glm-5-2"],
    input: 1.1916341325722764,
    cachedInput: 0.2979085331430691,
    cacheWrite5m: 1.1916341325722764,
    cacheWrite1h: 1.1916341325722764,
    output: 4.170719464002967,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":8,"output":28,"cachedInput":2,"cacheWrite5m":8,"cacheWrite1h":8},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel RMB rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-5.1",
    aliases: ["glm-5-1"],
    input: 0.8937255994292073,
    cachedInput: 0.1936405465429949,
    cacheWrite5m: 0.8937255994292073,
    cacheWrite1h: 0.8937255994292073,
    output: 3.574902397716829,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":6,"output":24,"cachedInput":1.3,"cacheWrite5m":6,"cacheWrite1h":6},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel RMB short-context rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-4.5-air",
    aliases: ["glm-4-5-air"],
    input: 0.11916341325722764,
    cachedInput: 0.023832682651445527,
    cacheWrite5m: 0.11916341325722764,
    cacheWrite1h: 0.11916341325722764,
    output: 0.2979085331430691,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":0.8,"output":2,"cachedInput":0.16,"cacheWrite5m":0.8,"cacheWrite1h":0.8},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel pricing page. RMB prices are converted to USD for internal cost math."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-4.7",
    aliases: ["glm-4-7"],
    input: 0.2979085331430691,
    cachedInput: 0.05958170662861382,
    cacheWrite5m: 0.2979085331430691,
    cacheWrite1h: 0.2979085331430691,
    output: 1.1916341325722764,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":2,"output":8,"cachedInput":0.4,"cacheWrite5m":2,"cacheWrite1h":2},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel pricing page. RMB prices are converted to USD for internal cost math."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-5",
    aliases: ["glm-5"],
    input: 0.5958170662861382,
    cachedInput: 0.14895426657153454,
    cacheWrite5m: 0.5958170662861382,
    cacheWrite1h: 0.5958170662861382,
    output: 2.6811767982876216,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":4,"output":18,"cachedInput":1,"cacheWrite5m":4,"cacheWrite1h":4},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel pricing page. RMB prices are converted to USD for internal cost math."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-5-turbo",
    aliases: ["glm-5-turbo"],
    input: 0.7447713328576727,
    cachedInput: 0.17874511988584144,
    cacheWrite5m: 0.7447713328576727,
    cacheWrite1h: 0.7447713328576727,
    output: 3.2769938645737597,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":5,"output":22,"cachedInput":1.2,"cacheWrite5m":5,"cacheWrite1h":5},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel pricing page. RMB prices are converted to USD for internal cost math."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-5v-turbo",
    aliases: ["glm-5v-turbo", "glm-5-v-turbo"],
    input: 0.7447713328576727,
    cachedInput: 0.17874511988584144,
    cacheWrite5m: 0.7447713328576727,
    cacheWrite1h: 0.7447713328576727,
    output: 3.2769938645737597,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":5,"output":22,"cachedInput":1.2,"cacheWrite5m":5,"cacheWrite1h":5},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel pricing page. RMB prices are converted to USD for internal cost math."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-4.6v",
    aliases: ["glm-4-6v"],
    input: 0.14895426657153454,
    cachedInput: 0.02979085331430691,
    cacheWrite5m: 0.14895426657153454,
    cacheWrite1h: 0.14895426657153454,
    output: 0.44686279971460363,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":1,"output":3,"cachedInput":0.2,"cacheWrite5m":1,"cacheWrite1h":1},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel pricing page rate for input length [0, 32K]. RMB prices are converted to USD for internal cost math."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-4.6v-flashx",
    aliases: ["glm-4-6v-flashx"],
    input: 0.02234313998573018,
    cachedInput: 0.004468627997146036,
    cacheWrite5m: 0.02234313998573018,
    cacheWrite1h: 0.02234313998573018,
    output: 0.22343139985730182,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":0.15,"output":1.5,"cachedInput":0.03,"cacheWrite5m":0.15,"cacheWrite1h":0.15},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel pricing page rate for input length [0, 32K]. RMB prices are converted to USD for internal cost math."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-4.6v-flash",
    aliases: ["glm-4-6v-flash"],
    input: 0,
    cachedInput: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":0,"output":0,"cachedInput":0,"cacheWrite5m":0,"cacheWrite1h":0},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel pricing page lists this model as free. RMB prices are converted to USD for internal cost math."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-4.5v",
    aliases: ["glm-4-5v"],
    input: 0.2979085331430691,
    cachedInput: 0.05958170662861382,
    cacheWrite5m: 0.2979085331430691,
    cacheWrite1h: 0.2979085331430691,
    output: 0.8937255994292073,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":2,"output":6,"cachedInput":0.4,"cacheWrite5m":2,"cacheWrite1h":2},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel pricing page rate for input length [0, 32K]. RMB prices are converted to USD for internal cost math."
  }),
  officialRate({
    provider: "DoubaoSeed",
    model: "doubao-seed-evolving",
    aliases: ["doubao-seed-evolving", "doubao_seed_evolving"],
    input: 0.8937255994292073,
    cachedInput: 0.17874511988584144,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 4.4686279971460365,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":6,"output":30,"cachedInput":1.2,"cacheWrite5m":0,"cacheWrite1h":0},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "DoubaoSeed",
    note: "Official Volcengine Ark CNY online-inference rate converted to USD at the last verified refresh rate. Cache-storage charges are not included."
  }),
  officialRate({
    provider: "DoubaoSeed",
    model: "doubao-seed-2.1-pro",
    aliases: ["doubao-seed-2-1-pro", "doubao_seed_2_1_pro"],
    input: 0.8937255994292073,
    cachedInput: 0.17874511988584144,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 4.4686279971460365,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":6,"output":30,"cachedInput":1.2,"cacheWrite5m":0,"cacheWrite1h":0},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "DoubaoSeed",
    note: "Official Volcengine Ark CNY online-inference rate converted to USD at the last verified refresh rate. Cache-storage charges are not included."
  }),
  officialRate({
    provider: "DoubaoSeed",
    model: "doubao-seed-2.1-turbo",
    aliases: ["doubao-seed-2-1-turbo", "doubao_seed_2_1_turbo"],
    input: 0.44686279971460363,
    cachedInput: 0.08937255994292072,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 2.2343139985730183,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":3,"output":15,"cachedInput":0.6,"cacheWrite5m":0,"cacheWrite1h":0},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "DoubaoSeed",
    note: "Official Volcengine Ark CNY online-inference rate converted to USD at the last verified refresh rate. Cache-storage charges are not included."
  }),
  officialRate({
    provider: "DoubaoSeed",
    model: "ark-code-latest",
    aliases: ["ark-code-latest", "ark_code_latest", "ark-auto", "ark_auto", "volcengine-ark-auto", "volcengine_ark_auto"],
    input: 0.44686279971460363,
    cachedInput: 0.08937255994292072,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 2.2343139985730183,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":3,"output":15,"cachedInput":0.6,"cacheWrite5m":0,"cacheWrite1h":0},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "DoubaoSeed",
    note: "Volcengine Ark Coding Plan Auto scheduling does not expose the routed backend model in local logs; usage is attributed to the configured request model (ark-code-latest) and priced at the plan's doubao-seed-2.1-turbo reference rate. This is a reference conversion, not subscription billing."
  }),
  officialRate({
    provider: "DoubaoSeed",
    model: "doubao-seed-2.0-lite",
    aliases: ["doubao-seed-2-0-lite", "doubao_seed_2_0_lite"],
    input: 0.08937255994292072,
    cachedInput: 0.017874511988584144,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0.5362353596575243,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":0.6,"output":3.6,"cachedInput":0.12,"cacheWrite5m":0,"cacheWrite1h":0},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "DoubaoSeed",
    note: "Official Volcengine Ark regular online-inference rate for input length [0, 32K], converted to USD at the last verified refresh rate. Longer requests use higher tiered rates and are not distinguished by the local usage format."
  }),
  officialRate({
    provider: "DoubaoSeed",
    model: "doubao-pro-32k",
    aliases: ["doubao-pro-32k"],
    source: "DoubaoSeed",
    unavailableReason: "Run npm run pricing:update to fetch official RMB pricing and convert it to USD.",
    note: "Official Ark pricing page. RMB prices are converted to USD for internal cost math."
  }),
  officialRate({
    provider: "DoubaoSeed",
    model: "doubao-lite-32k",
    aliases: ["doubao-lite-32k"],
    source: "DoubaoSeed",
    unavailableReason: "Run npm run pricing:update to fetch official RMB pricing and convert it to USD.",
    note: "Official Ark pricing page. RMB prices are converted to USD for internal cost math."
  }),
  officialRate({
    provider: "DoubaoSeed",
    model: "doubao-pro-256k",
    aliases: ["doubao-pro-256k"],
    source: "DoubaoSeed",
    unavailableReason: "Run npm run pricing:update to fetch official RMB pricing and convert it to USD.",
    note: "Official Ark pricing page. RMB prices are converted to USD for internal cost math."
  }),
  officialRate({
    provider: "Gemini",
    model: "gemini-3.5-flash",
    aliases: ["gemini-3-5-flash"],
    input: 1.5,
    cachedInput: 0.15,
    cacheWrite5m: 1.5,
    cacheWrite1h: 1.5,
    output: 9,
    source: "Gemini",
    note: "Gemini API standard text-token rate. Context-cache storage charges are not included."
  }),
  officialRate({
    provider: "Gemini",
    model: "gemini-3.8-flash",
    aliases: ["gemini-3-8-flash"],
    rateSchedule: [{"from":null,"ratesPerMTok":null},{"from":"2026-09-18","ratesPerMTok":{"input":0.75,"cachedInput":0.075,"cacheWrite5m":0.75,"cacheWrite1h":0.75,"output":3.75}},{"from":"2027-01-01","ratesPerMTok":{"input":1.5,"cachedInput":0.15,"cacheWrite5m":1.5,"cacheWrite1h":1.5,"output":7.5}}],
    source: "Gemini",
    unavailableReason: "Gemini 3.8 Flash is recognized, but its official API rate has not been synchronized to the local price cache. This does not mean the model is free or has no price.",
    note: "Costs remain uncalculated until the official Gemini API rate is refreshed."
  }),
  officialRate({
    provider: "Gemini",
    model: "gemini-3.7-flash",
    aliases: ["gemini-3-7-flash"],
    rateSchedule: [{"from":null,"ratesPerMTok":null},{"from":"2026-09-18","ratesPerMTok":{"input":0.75,"cachedInput":0.075,"cacheWrite5m":0.75,"cacheWrite1h":0.75,"output":3.75}},{"from":"2027-01-01","ratesPerMTok":{"input":1.5,"cachedInput":0.15,"cacheWrite5m":1.5,"cacheWrite1h":1.5,"output":7.5}}],
    source: "Gemini",
    unavailableReason: "Gemini 3.7 Flash is recognized, but its official API rate has not been synchronized to the local price cache. This does not mean the model is free or has no price.",
    note: "Costs remain uncalculated until the official Gemini API rate is refreshed."
  }),
  officialRate({
    provider: "Gemini",
    model: "gemini-3.6-flash",
    aliases: ["gemini-3-6-flash"],
    input: 0.75,
    cachedInput: 0.075,
    cacheWrite5m: 0.75,
    cacheWrite1h: 0.75,
    output: 3.75,
    rateSchedule: [{"from":null,"ratesPerMTok":{"input":0.75,"cachedInput":0.075,"cacheWrite5m":0.75,"cacheWrite1h":0.75,"output":3.75}},{"from":"2027-01-01","ratesPerMTok":{"input":1.5,"cachedInput":0.15,"cacheWrite5m":1.5,"cacheWrite1h":1.5,"output":7.5}}],
    source: "Gemini",
    note: "Gemini API standard text-token rate at the launch promo price; standard rates apply from 2027-01-01. Context-cache storage charges are not included."
  }),
  officialRate({
    provider: "Gemini",
    model: "gemini-3.5-flash-lite",
    aliases: ["gemini-3-5-flash-lite"],
    input: 0.3,
    cachedInput: 0.03,
    cacheWrite5m: 0.3,
    cacheWrite1h: 0.3,
    output: 2.5,
    source: "Gemini",
    note: "Gemini API standard text-token rate. Context-cache storage charges are not included."
  }),
  officialRate({
    provider: "Gemini",
    model: "gemini-2.5-flash-lite",
    aliases: ["gemini-2-5-flash-lite"],
    input: 0.1,
    cachedInput: 0.01,
    cacheWrite5m: 0.1,
    cacheWrite1h: 0.1,
    output: 0.4,
    source: "Gemini",
    note: "Gemini API standard text-token rate. Context-cache storage charges are not included."
  }),
  officialRate({
    provider: "Gemini",
    model: "gemini-3.1-flash-image",
    aliases: ["gemini-3-1-flash-image", "gemini-3-1-flash-image-preview"],
    input: 0.5,
    cachedInput: 0.5,
    cacheWrite5m: 0.5,
    cacheWrite1h: 0.5,
    output: 60,
    source: "Gemini",
    note: "Gemini API image-output (Nano Banana 2) rate: output tokens use the published image rate and text output is billed at the same listed image-output price; cached-input rate is not published and falls back to the input rate. Context-cache storage charges are not included."
  }),
  officialRate({
    provider: "Gemini",
    model: "gemini-3.1-flash-lite-image",
    aliases: ["gemini-3-1-flash-lite-image", "gemini-3-1-flash-lite-image-preview"],
    input: 0.25,
    cachedInput: 0.25,
    cacheWrite5m: 0.25,
    cacheWrite1h: 0.25,
    output: 30,
    source: "Gemini",
    note: "Gemini API image-output rate: output tokens use the published image rate and text output is billed at the same listed image-output price; cached-input rate is not published and falls back to the input rate. Context-cache storage charges are not included."
  }),
  officialRate({
    provider: "Gemini",
    model: "gemini-3-pro-image",
    aliases: ["gemini-3-pro-image", "gemini-3-pro-image-preview"],
    input: 2,
    cachedInput: 2,
    cacheWrite5m: 2,
    cacheWrite1h: 2,
    output: 120,
    source: "Gemini",
    note: "Gemini API image-output (Nano Banana Pro) rate: output tokens use the published image rate and text output is billed at the same listed image-output price; cached-input rate is not published and falls back to the input rate. Context-cache storage charges are not included."
  }),
  officialRate({
    provider: "Gemini",
    model: "gemini-3.1-flash-lite",
    aliases: ["gemini-3-1-flash-lite"],
    input: 0.25,
    cachedInput: 0.025,
    cacheWrite5m: 0.25,
    cacheWrite1h: 0.25,
    output: 1.5,
    source: "Gemini",
    note: "Gemini API standard text-token rate. Context-cache storage charges are not included."
  }),
  officialRate({
    provider: "Gemini",
    model: "gemini-3.1-pro-preview",
    aliases: ["gemini-3-1-pro-preview", "gemini-3-1-pro-preview-customtools"],
    input: 2,
    cachedInput: 0.2,
    cacheWrite5m: 2,
    cacheWrite1h: 2,
    output: 12,
    source: "Gemini",
    note: "Gemini API preview rate for prompts up to 200k tokens. Context-cache storage charges are not included."
  }),
  officialRate({
    provider: "Gemini",
    model: "gemini-2.5-flash",
    aliases: ["gemini-2-5-flash", "gemini-flash-latest"],
    input: 0.3,
    cachedInput: 0.03,
    cacheWrite5m: 0.3,
    cacheWrite1h: 0.3,
    output: 2.5,
    source: "Gemini",
    note: "Gemini API standard rate for prompts up to 200k tokens."
  }),
  officialRate({
    provider: "Gemini",
    model: "gemini-2.5-pro",
    aliases: ["gemini-2-5-pro", "gemini-pro-latest"],
    input: 1.25,
    cachedInput: 0.125,
    cacheWrite5m: 1.25,
    cacheWrite1h: 1.25,
    output: 10,
    source: "Gemini",
    note: "Gemini API short-context rate for prompts up to 200k tokens."
  }),
  officialRate({
    provider: "Gemini",
    model: "gemini-2.5-pro-long-context",
    aliases: ["gemini-2-5-pro-long-context"],
    input: 2.5,
    cachedInput: 0.25,
    cacheWrite5m: 2.5,
    cacheWrite1h: 2.5,
    output: 15,
    source: "Gemini",
    note: "Gemini API long-context rate for prompts over 200k tokens."
  }),
  officialRate({
    provider: "Kimi",
    model: "kimi-k3",
    aliases: ["kimi-k3"],
    input: 5.958170662861382,
    cachedInput: 2.979085331430691,
    cacheWrite5m: 5.958170662861382,
    cacheWrite1h: 5.958170662861382,
    output: 0.2979085331430691,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":40,"cachedInput":20,"cacheWrite5m":40,"cacheWrite1h":40,"output":2},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Kimi",
    note: "Official Kimi API CNY rate parsed from the current model pricing pages."
  }),
  officialRate({
    provider: "Kimi",
    model: "kimi-k2.7-code",
    aliases: ["kimi-k2-7-code"],
    input: 0.9682027327149745,
    cachedInput: 0.1936405465429949,
    cacheWrite5m: 0.9682027327149745,
    cacheWrite1h: 0.9682027327149745,
    output: 4.021765197431432,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":6.5,"cachedInput":1.3,"cacheWrite5m":6.5,"cacheWrite1h":6.5,"output":27},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Kimi",
    note: "Official Kimi API CNY rate parsed from the current model pricing pages."
  }),
  officialRate({
    provider: "Kimi",
    model: "kimi-k2.7-code-highspeed",
    aliases: ["kimi-k2-7-code-highspeed"],
    input: 1.936405465429949,
    cachedInput: 0.3872810930859898,
    cacheWrite5m: 1.936405465429949,
    cacheWrite1h: 1.936405465429949,
    output: 8.043530394862865,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":13,"cachedInput":2.6,"cacheWrite5m":13,"cacheWrite1h":13,"output":54},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Kimi",
    note: "Official Kimi API CNY rate parsed from the current model pricing pages."
  }),
  officialRate({
    provider: "Kimi",
    model: "kimi-k2.6",
    aliases: ["kimi-k2-6"],
    input: 0.9682027327149745,
    cachedInput: 0.163849693228688,
    cacheWrite5m: 0.9682027327149745,
    cacheWrite1h: 0.9682027327149745,
    output: 4.021765197431432,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":6.5,"cachedInput":1.1,"cacheWrite5m":6.5,"cacheWrite1h":6.5,"output":27},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Kimi",
    note: "Official Kimi API CNY rate parsed from the current model pricing pages."
  }),
  officialRate({
    provider: "Kimi",
    model: "kimi-k2.5",
    aliases: ["kimi-k2-5"],
    input: 0.5958170662861382,
    cachedInput: 0.10426798660007418,
    cacheWrite5m: 0.5958170662861382,
    cacheWrite1h: 0.5958170662861382,
    output: 3.1280395980022253,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":4,"cachedInput":0.7,"cacheWrite5m":4,"cacheWrite1h":4,"output":21},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Kimi",
    note: "Official Kimi API CNY rate parsed from the current model pricing pages."
  }),
  officialRate({
    provider: "Qwen",
    model: "qwen3.8",
    aliases: ["qwen3-8", "qwen3-8-max"],
    input: 1.7874511988584145,
    cachedInput: 1.7874511988584145,
    cacheWrite5m: 1.7874511988584145,
    cacheWrite1h: 1.7874511988584145,
    output: 5.362353596575243,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":12,"output":36,"cachedInput":12,"cacheWrite5m":12,"cacheWrite1h":12},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Qwen",
    note: "Official Alibaba Cloud Model Studio RMB prices converted to USD for internal cost math; short-context public rates are used by default."
  }),
  officialRate({
    provider: "Qwen",
    model: "qwen3.7-plus",
    aliases: ["qwen3-7-plus"],
    input: 0.2979085331430691,
    cachedInput: 0.2979085331430691,
    cacheWrite5m: 0.2979085331430691,
    cacheWrite1h: 0.2979085331430691,
    output: 1.1916341325722764,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":2,"output":8,"cachedInput":2,"cacheWrite5m":2,"cacheWrite1h":2},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Qwen",
    note: "Official Alibaba Cloud Model Studio RMB short-context rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Qwen",
    model: "qwen3.7-max",
    aliases: ["qwen3-7-max"],
    input: 1.7874511988584145,
    cachedInput: 1.7874511988584145,
    cacheWrite5m: 1.7874511988584145,
    cacheWrite1h: 1.7874511988584145,
    output: 5.362353596575243,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":12,"output":36,"cachedInput":12,"cacheWrite5m":12,"cacheWrite1h":12},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Qwen",
    note: "Official Alibaba Cloud Model Studio RMB rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Qwen",
    model: "qwen3.6-flash",
    aliases: ["qwen3-6-flash"],
    input: 0.17874511988584144,
    cachedInput: 0.17874511988584144,
    cacheWrite5m: 0.17874511988584144,
    cacheWrite1h: 0.17874511988584144,
    output: 1.0724707193150487,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":1.2,"output":7.2,"cachedInput":1.2,"cacheWrite5m":1.2,"cacheWrite1h":1.2},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Qwen",
    note: "Official Alibaba Cloud Model Studio RMB rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Qwen",
    model: "qwen3-coder-plus",
    aliases: ["qwen3-coder-plus", "qwen3-coder"],
    input: 0.5958170662861382,
    cachedInput: 0.5958170662861382,
    cacheWrite5m: 0.5958170662861382,
    cacheWrite1h: 0.5958170662861382,
    output: 2.3832682651445527,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":4,"output":16,"cachedInput":4,"cacheWrite5m":4,"cacheWrite1h":4},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Qwen",
    note: "Official Alibaba Cloud Model Studio RMB short-context Coder rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Qwen",
    model: "qwen3-coder-flash",
    aliases: ["qwen3-coder-flash"],
    input: 0.14895426657153454,
    cachedInput: 0.14895426657153454,
    cacheWrite5m: 0.14895426657153454,
    cacheWrite1h: 0.14895426657153454,
    output: 0.5958170662861382,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":1,"output":4,"cachedInput":1,"cacheWrite5m":1,"cacheWrite1h":1},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Qwen",
    note: "Official Alibaba Cloud Model Studio RMB short-context Coder rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Qwen",
    model: "qwen-coder-plus",
    aliases: ["qwen-coder-plus"],
    input: 0.5213399330003708,
    cachedInput: 0.5213399330003708,
    cacheWrite5m: 0.5213399330003708,
    cacheWrite1h: 0.5213399330003708,
    output: 1.0426798660007417,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":3.5,"output":7,"cachedInput":3.5,"cacheWrite5m":3.5,"cacheWrite1h":3.5},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Qwen",
    note: "Official Alibaba Cloud Model Studio RMB Coder rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Qwen",
    model: "qwen-coder-turbo",
    aliases: ["qwen-coder-turbo"],
    input: 0.2979085331430691,
    cachedInput: 0.2979085331430691,
    cacheWrite5m: 0.2979085331430691,
    cacheWrite1h: 0.2979085331430691,
    output: 0.8937255994292073,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":2,"output":6,"cachedInput":2,"cacheWrite5m":2,"cacheWrite1h":2},"exchangeRate":6.71347,"sourceUnit":"元 / 1M tokens"},
    source: "Qwen",
    note: "Official Alibaba Cloud Model Studio RMB Coder rate converted to USD at the last verified refresh rate."
  })
];

/**
 * Kept for the collector API shape. No network or third-party cache is used.
 */
export async function loadPricing(cachePath: string | null = null): Promise<PricingData> {
  const cached = await readPricingCache(cachePath);
  if (cached) return cached;
  return {
    mode: 'official-docs',
    verifiedAt: VERIFIED_AT,
    sources: OFFICIAL_PRICING_SOURCES,
    models: OFFICIAL_PRICE_TABLE
  };
}

export function calculateCost(model, tokens, _pricingData = null, provider = null, usageDate = null) {
  return calculateOfficialCost(model, tokens, { provider, pricingData: _pricingData, usageDate }).totalUSD;
}

export function calculateOfficialCost(model, tokens: TokenInput = {}, options: PricingOptions = {}) {
  const pricing = resolveOfficialPricing(model, options.provider, options.pricingData, options.usageDate);
  const normalizedTokens = normalizeTokens(tokens);

  if (!pricing || !pricing.priced) {
    return {
      model: canonicalModelName(normalizeModelId(model)),
      resolvedModel: pricing?.model || null,
      provider: pricing?.provider || null,
      priced: false,
      status: pricing?.unavailableReason ? 'unpriced' : 'unknown-model',
      reason: pricing?.unavailableReason || 'No official USD token price is configured for this model.',
      tokens: normalizedTokens,
      ratesPerMTok: null,
      totalUSD: 0,
      source: pricing?.source || null
    };
  }

  const cacheWriteMode = normalizeAnthropicCacheWriteTtl(options.anthropicCacheWriteTtl);
  const rates = ratesForCalculation(pricing.ratesPerMTok, pricing.provider, cacheWriteMode);
  const outputTokens = normalizedTokens.output + normalizedTokens.reasoning;
  const inputUSD = costPart(normalizedTokens.input, rates.input);
  const cachedInputUSD = costPart(normalizedTokens.cacheRead, rates.cachedInput);
  const cacheWriteUSD = costPart(normalizedTokens.cacheWrite, rates.cacheWrite);
  const outputUSD = costPart(outputTokens, rates.output);

  return {
    model: canonicalModelName(normalizeModelId(model)),
    resolvedModel: pricing.model,
    provider: pricing.provider,
    priced: true,
    status: 'priced',
    reason: null,
    tokens: normalizedTokens,
    ratesPerMTok: rates,
    parts: {
      inputUSD,
      cachedInputUSD,
      cacheWriteUSD,
      outputUSD
    },
    totalUSD: inputUSD + cachedInputUSD + cacheWriteUSD + outputUSD,
    source: pricing.source,
    note: pricing.note || null
  };
}

// 解析结果记忆化:同一价格表下 (模型, 供应商, 用量日期) 的解析结果恒定,重复调用直接查缓存。
// 热路径是 /api/data 对数百行 daily/sessions 逐行定价,原先每行都对全价表 slice+sort,是主要耗时。
const officialPricingCache = new WeakMap<PricingData, Map<string, ReturnType<typeof resolveOfficialPricingFromTable>>>();
// pricingData 为空时走内置静态表,无对象键可用,用模块级 Map 承接(表内容进程内不变)。
const builtinPricingCache = new Map<string, ReturnType<typeof resolveOfficialPricingFromTable>>();

function resolveOfficialPricingFromTable(normalized: string, provider: string | null, pricingData: PricingData | null, usageDate: string | null) {
  const candidates = modelCandidates(normalized, provider);
  const sorted = pricingTableFrom(pricingData)
    .slice()
    .sort((a, b) => longestAliasLength(b) - longestAliasLength(a));

  for (const rate of sorted) {
    if (matchesRate(rate, candidates)) return applyRateSchedule(rate, usageDate);
  }

  return null;
}

export function resolveOfficialPricing(model, provider: string | null = null, pricingData: PricingData | null = null, usageDate: string | null = null) {
  const normalized = normalizeModelId(model);
  if (!normalized || normalized === '<synthetic>') return null;

  let cache = builtinPricingCache;
  if (pricingData) {
    cache = officialPricingCache.get(pricingData) ?? (() => {
      const created = new Map<string, ReturnType<typeof resolveOfficialPricingFromTable>>();
      officialPricingCache.set(pricingData, created);
      return created;
    })();
  }

  const cacheKey = `${normalized}\u0000${provider ?? ''}\u0000${usageDate ?? ''}`;
  let resolved = cache.get(cacheKey);
  if (resolved === undefined) {
    resolved = resolveOfficialPricingFromTable(normalized, provider, pricingData, usageDate);
    cache.set(cacheKey, resolved);
  }
  return resolved;
}

export function officialPricingMetadata(rows: PricingRow[] = [], pricingData: PricingData | null = null) {
  const byModel = new Map();
  let totalTokens = 0;
  let pricedTokens = 0;
  let pricedCostUSD = 0;
  const metadata = pricingData && pricingData.models?.length ? pricingData : null;

  for (const row of rows) {
    const tokens = tokenTotal(row);
    totalTokens += tokens;
    const cost = Number(row.costUSD || 0);
    const priced = row.pricingStatus === 'priced' || cost > 0;
    if (priced) {
      pricedTokens += tokens;
      pricedCostUSD += cost;
      continue;
    }
    const model = row.model || row.pricingModel || 'unknown';
    const current = byModel.get(model) || { model, totalTokens: 0, rows: 0, reason: row.pricingReason || 'No official USD price.' };
    current.totalTokens += tokens;
    current.rows += 1;
    byModel.set(model, current);
  }

  return {
    mode: 'official-price-conversion',
    currency: 'USD',
    verifiedAt: metadata?.verifiedAt || VERIFIED_AT,
    fetchedAt: metadata?.fetchedAt || null,
    totalTokens,
    pricedTokens,
    unpricedTokens: Math.max(0, totalTokens - pricedTokens),
    pricedShare: totalTokens ? pricedTokens / totalTokens : 1,
    pricedCostUSD,
    sources: metadata?.sources || OFFICIAL_PRICING_SOURCES,
    unpricedModels: Array.from(byModel.values())
      .sort((a, b) => b.totalTokens - a.totalTokens)
  };
}

export function attachOfficialPricing(row: PricingRow, model = row?.model, provider: string | null = null, pricingData: PricingData | null = null, usageDate: string | null = null) {
  const cacheRead = Number(row?.cacheReadTokens ?? row?.cacheRead ?? 0)
    + Number(row?.cachedInputTokens ?? row?.cachedInput ?? 0);
  const tokens = {
    input: row?.inputTokens ?? row?.input,
    output: row?.outputTokens ?? row?.output,
    cacheRead,
    cacheWrite: row?.cacheCreationTokens ?? row?.cacheWrite,
    reasoning: row?.reasoningOutputTokens ?? row?.reasoning
  };
  const cost = calculateOfficialCost(model, tokens, { provider, pricingData, usageDate });
  return {
    ...row,
    costUSD: cost.totalUSD,
    pricingStatus: cost.status,
    pricingModel: cost.resolvedModel || cost.model || model || null,
    pricingProvider: cost.provider || null,
    pricingReason: cost.reason || null,
    pricingSource: cost.source?.url || null,
    pricingSourceLabel: cost.source?.label || null,
    pricingRatesPerMTok: cost.ratesPerMTok || null
  };
}

function officialRate({
  provider,
  model,
  aliases,
  input,
  cachedInput,
  cacheWrite5m,
  cacheWrite1h,
  output,
  source,
  note,
  unavailableReason,
  officialRatesPerMTok,
  rateSchedule
}: OfficialRateInput): OfficialRate {
  const sourceMeta = findPricingSource(source);
  const priced = input != null && output != null && !unavailableReason;
  return {
    provider,
    model,
    aliases: aliases.map(normalizeModelId),
    priced,
    unavailableReason: unavailableReason || null,
    ratesPerMTok: priced ? {
      input: Number(input),
      cachedInput: Number(cachedInput ?? input),
      cacheWrite5m: Number(cacheWrite5m ?? input),
      cacheWrite1h: Number(cacheWrite1h ?? cacheWrite5m ?? input),
      output: Number(output)
    } : null,
    officialRatesPerMTok: officialRatesPerMTok || null,
    rateSchedule: normalizeRateSchedule(rateSchedule),
    source: sourceMeta,
    note: note || sourceMeta?.note || null
  };
}

function normalizeRateSchedule(schedule: OfficialRateScheduleInput[] | null | undefined): RateScheduleEntry[] | null {
  if (!Array.isArray(schedule) || !schedule.length) return null;
  const entries = schedule
    .map(entry => {
      const rates = entry?.ratesPerMTok;
      const from = typeof entry.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.from) ? entry.from : null;
      // ratesPerMTok: null 表示该时期官方未定价（补价前的空档），按日期命中时维持未计价
      if (!rates) return { from, ratesPerMTok: null };
      if (rates.input == null || rates.output == null) return null;
      return {
        from,
        ratesPerMTok: {
          input: Number(rates.input),
          cachedInput: Number(rates.cachedInput ?? rates.input),
          cacheWrite5m: Number(rates.cacheWrite5m ?? rates.input),
          cacheWrite1h: Number(rates.cacheWrite1h ?? rates.cacheWrite5m ?? rates.input),
          output: Number(rates.output)
        }
      };
    })
    .filter(Boolean) as RateScheduleEntry[];
  if (!entries.length) return null;
  // 升序排列，from: null 的历史档排在最前，便于按用量日期取「生效中的那一档」
  entries.sort((a, b) => {
    if (a.from === b.from) return 0;
    if (a.from == null) return -1;
    if (b.from == null) return 1;
    return a.from.localeCompare(b.from);
  });
  return entries;
}

// 按用量日期取生效档；日期无效或不给日期时保持条目主价（最新档），与既有行为一致
function applyRateSchedule(rate: OfficialRate, usageDate: string | null | undefined): OfficialRate {
  const schedule = rate.rateSchedule;
  if (!schedule?.length || !usageDate) return rate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(usageDate)) return rate;
  let selected = schedule[0];
  for (const entry of schedule) {
    if (entry.from == null || entry.from <= usageDate) selected = entry;
  }
  if (selected.ratesPerMTok) {
    // 补价条目（主价未发布）命中有价档后按该档计价
    return { ...rate, ratesPerMTok: selected.ratesPerMTok, priced: true };
  }
  return {
    ...rate,
    ratesPerMTok: null,
    priced: false,
    unavailableReason: rate.unavailableReason || 'No official price was published for this usage date.'
  };
}

export function serializeOfficialPricingModels(models: OfficialRate[] = OFFICIAL_PRICE_TABLE) {
  return models.map(row => ({
    provider: row.provider,
    model: row.model,
    aliases: row.aliases,
    priced: row.priced,
    unavailableReason: row.unavailableReason,
    ratesPerMTok: row.ratesPerMTok,
    officialRatesPerMTok: row.officialRatesPerMTok || null,
    rateSchedule: row.rateSchedule || null,
    sourceProvider: row.source?.provider || row.source?.label || null,
    pricingFetchStatus: row.pricingFetchStatus || null,
    note: row.note || null
  }));
}

export function validateOfficialPricingRefresh(models: CachedRateInput[], baselineModels: OfficialRate[] = OFFICIAL_PRICE_TABLE) {
  const baselineByKey = new Map<string, OfficialRate>();
  for (const model of baselineModels) {
    const key = pricingKey(model);
    if (baselineByKey.has(key)) throw new Error(`Duplicate baseline pricing model: ${key}`);
    baselineByKey.set(key, model);
  }

  if (models.length !== baselineByKey.size) {
    throw new Error(`Pricing refresh model count changed: expected ${baselineByKey.size}, received ${models.length}`);
  }

  const received = new Set<string>();
  for (const model of models) {
    const key = pricingKey(model);
    const baseline = baselineByKey.get(key);
    if (!baseline) throw new Error(`Pricing refresh contains an unknown model: ${key}`);
    if (received.has(key)) throw new Error(`Pricing refresh contains a duplicate model: ${key}`);
    received.add(key);

    if (typeof model.priced !== 'boolean' || (baseline.priced && !model.priced)) {
      throw new Error(`Pricing refresh removed official pricing for ${key}`);
    }

    const aliases = model.aliases || [];
    const normalizedAliases = aliases.map(normalizeModelId).filter(Boolean);
    if (!normalizedAliases.length || normalizedAliases.length !== new Set(normalizedAliases).size) {
      throw new Error(`Pricing refresh has invalid aliases for ${key}`);
    }

    if (!model.priced) continue;
    validateUsdRates(model.ratesPerMTok, key);
    validateOfficialCurrencyRates(model, key);
  }

  for (const key of baselineByKey.keys()) {
    if (!received.has(key)) throw new Error(`Pricing refresh is missing model: ${key}`);
  }
}

function validateUsdRates(rates: Partial<PricingRates> | null | undefined, key: string) {
  if (!rates) throw new Error(`Pricing refresh has no rates for ${key}`);
  for (const field of PRICING_RATE_FIELDS) {
    const rate = Number(rates[field]);
    if (!Number.isFinite(rate) || rate < 0) {
      throw new Error(`Pricing refresh has an invalid ${field} rate for ${key}`);
    }
  }
}

function validateOfficialCurrencyRates(model: CachedRateInput, key: string) {
  const official = model.officialRatesPerMTok;
  if (!official || String(official.currency).toUpperCase() !== 'CNY') return;

  const exchangeRate = Number(official.exchangeRate);
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    throw new Error(`Pricing refresh has an invalid CNY exchange rate for ${key}`);
  }

  const usdRates = model.ratesPerMTok || {};
  for (const field of PRICING_RATE_FIELDS) {
    const cnyRate = Number(official.ratesPerMTok[field]);
    const usdRate = Number(usdRates[field]);
    const expected = cnyRate / exchangeRate;
    const tolerance = Math.max(1e-12, Math.abs(expected) * 1e-12);
    if (!Number.isFinite(cnyRate) || cnyRate < 0 || !Number.isFinite(usdRate) || Math.abs(usdRate - expected) > tolerance) {
      throw new Error(`Pricing refresh has inconsistent CNY conversion for ${key} (${field})`);
    }
  }
}

function pricingTableFrom(pricingData: PricingData | null = null) {
  if (!pricingData?.models?.length) return OFFICIAL_PRICE_TABLE;
  const baselineByKey = new Map(OFFICIAL_PRICE_TABLE.map(model => [pricingKey(model), model]));
  const merged = new Map(baselineByKey);
  const cached = pricingData.models
    .map(model => normalizeCachedRate(model))
    .filter(Boolean);
  for (const model of cached) {
    // 缓存行没有价目时间表时继承 baseline 的，防止 pricing:update 刷缓存后丢历史档
    const baseline = baselineByKey.get(pricingKey(model));
    if (baseline?.rateSchedule?.length && !model.rateSchedule?.length) {
      merged.set(pricingKey(model), { ...model, rateSchedule: baseline.rateSchedule });
    } else {
      merged.set(pricingKey(model), model);
    }
  }
  return Array.from(merged.values());
}

function normalizeCachedRate(row: CachedRateInput): OfficialRate {
  const sourceKey = row.sourceProvider
    || (row.source && typeof row.source === 'object' ? row.source.provider : row.source)
    || row.provider;
  const provider = canonicalProvider(row.provider);
  const sourceMeta = findPricingSource(sourceKey);
  const rates = row.ratesPerMTok || {};
  const hasRates = rates.input != null && rates.output != null;
  const priced = row.priced !== false && hasRates && !row.unavailableReason;
  return {
    provider,
    model: row.model,
    aliases: (row.aliases || [row.model]).map(normalizeModelId),
    priced,
    unavailableReason: row.unavailableReason || null,
    ratesPerMTok: priced ? {
      input: Number(rates.input),
      cachedInput: Number(rates.cachedInput ?? rates.input),
      cacheWrite5m: Number(rates.cacheWrite5m ?? rates.input),
      cacheWrite1h: Number(rates.cacheWrite1h ?? rates.cacheWrite5m ?? rates.input),
      output: Number(rates.output)
    } : null,
    officialRatesPerMTok: row.officialRatesPerMTok || null,
    rateSchedule: Array.isArray(row.rateSchedule) && row.rateSchedule.length ? row.rateSchedule : null,
    source: sourceMeta,
    pricingFetchStatus: row.pricingFetchStatus || null,
    note: row.note || sourceMeta?.note || null
  };
}

function pricingKey(row: Pick<OfficialRate, 'provider' | 'model'>) {
  return `${normalizeProvider(row.provider)}::${normalizeModelId(row.model)}`;
}

function findPricingSource(provider) {
  const key = normalizeProvider(provider);
  return OFFICIAL_PRICING_SOURCES.find(item => normalizeProvider(item.provider) === key) || null;
}

async function readPricingCache(cachePath) {
  if (!cachePath) return null;
  try {
    const { readFile } = await Function('specifier', 'return import(specifier)')('node:fs/promises');
    const text = await readFile(cachePath, 'utf8');
    const parsed = JSON.parse(text);
    const models = pricingTableFrom(parsed);
    if (!models.length) return null;
    return {
      mode: parsed.mode || 'official-cache',
      verifiedAt: parsed.verifiedAt || parsed.fetchedAt || VERIFIED_AT,
      fetchedAt: parsed.fetchedAt || null,
      sources: parsed.sources || OFFICIAL_PRICING_SOURCES,
      models
    };
  } catch {
    return null;
  }
}

function ratesForCalculation(rates, provider, cacheWriteMode) {
  return {
    input: validRate(rates.input),
    cachedInput: validRate(rates.cachedInput),
    cacheWrite: validRate(
      provider === 'anthropic' && cacheWriteMode === '1h'
        ? rates.cacheWrite1h
        : rates.cacheWrite5m
    ),
    output: validRate(rates.output)
  };
}

function normalizeAnthropicCacheWriteTtl(value = globalThis.process?.env?.ANTHROPIC_CACHE_WRITE_TTL) {
  const normalized = String(value || DEFAULT_ANTHROPIC_CACHE_WRITE_TTL).trim().toLowerCase();
  return normalized === '1h' || normalized === 'hour' || normalized === '3600' ? '1h' : '5m';
}

function modelCandidates(model, provider) {
  const normalized = normalizeModelId(model);
  const bare = normalized.split('/').at(-1);
  const providerPrefix = normalized.includes('/') ? normalized.split('/').at(0) : '';
  const separated = normalizeModelSeparators(normalized);
  const separatedBare = normalizeModelSeparators(bare);
  const values = [
    normalized,
    bare,
    separated,
    separatedBare,
    normalizeVersionSeparator(normalized),
    normalizeVersionSeparator(bare)
  ].filter(Boolean);
  const providerHint = normalizeProvider(provider);
  if (providerHint) {
    values.push(`${providerHint}/${bare}`);
  } else if (providerPrefix) {
    values.push(`${providerPrefix}/${bare}`);
  }
  return Array.from(new Set(values));
}

function matchesRate(rate, candidates) {
  const providerKey = normalizeProvider(rate.provider);
  return candidates.some(candidate => {
    const text = String(candidate || '');
    const slash = text.indexOf('/');
    const candidateProvider = slash > 0 ? normalizeProvider(text.slice(0, slash)) : '';
    const candidateModel = slash > 0 ? text.slice(slash + 1) : text;
    if (candidateProvider && candidateProvider !== providerKey) return false;
    return rate.aliases.some(alias =>
      candidateModel === alias || isDatedModelVariant(candidateModel, alias)
    );
  });
}

function isDatedModelVariant(model, alias) {
  if (!model.startsWith(alias)) return false;
  const suffix = model.slice(alias.length);
  return /^[-:](?:\d{4}|\d{6}|\d{8}|\d{4}-\d{2}-\d{2})$/.test(suffix);
}

function longestAliasLength(rate) {
  return Math.max(...rate.aliases.map(alias => alias.length));
}

function normalizeTokens(tokens: TokenInput = {}) {
  return {
    input: positive(tokens.input),
    output: positive(tokens.output),
    cacheRead: positive(tokens.cacheRead ?? tokens.cache_read),
    cacheWrite: positive(tokens.cacheWrite ?? tokens.cache_write),
    reasoning: positive(tokens.reasoning)
  };
}

function tokenTotal(row: PricingRow = {}) {
  return positive(row.totalTokens ?? row.total_tokens)
    || positive(row.inputTokens) + positive(row.outputTokens)
      + positive(row.cacheReadTokens) + positive(row.cacheCreationTokens)
      + positive(row.reasoningOutputTokens);
}

function costPart(tokens, ratePerMTok) {
  return positive(tokens) * validRate(ratePerMTok) / MTOK;
}

function validRate(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function positive(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeProvider(value) {
  return String(canonicalProvider(value) || '').trim().toLowerCase().replace(/_/g, '-');
}

function canonicalProvider(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (['zai', 'z ai', 'zhipu', 'zhipu ai', 'zhipu glm', 'bigmodel'].includes(normalized)) return 'Zhipu GLM';
  if (['volcengine', 'volc engine', 'ark', 'doubao', 'doubao seed', 'doubaoseed', 'bytedance'].includes(normalized)) return 'DoubaoSeed';
  if (['google', 'gemini'].includes(normalized)) return 'Gemini';
  if (['moonshot', 'moonshot ai', 'moonshotai', 'kimi'].includes(normalized)) return 'Kimi';
  if (['qwen', 'tongyi', 'tongyi qianwen', 'aliyun', 'alibaba', 'alibaba cloud', 'dashscope', 'model studio'].includes(normalized)) return 'Qwen';
  return String(value || '').trim();
}

function normalizeModelId(value) {
  return String(value || '').trim().toLowerCase().replace(/(?<=\d)\.(?=\d)/g, '-');
}

function normalizeVersionSeparator(id) {
  const text = String(id || '');
  const normalized = text.replace(/(?<=\d)\.(?=\d)/g, '-');
  return normalized === text ? null : normalized;
}

function normalizeModelSeparators(id) {
  return String(id || '').replace(/[\s_]+/g, '-');
}
