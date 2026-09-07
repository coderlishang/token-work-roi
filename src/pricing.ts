/**
 * Official pricing calculator.
 *
 * This module intentionally avoids third-party pricing caches. Rates are copied
 * from provider-owned pricing pages and are expressed as USD per 1M tokens.
 * Unknown or research-preview models return 0 and are reported as unpriced.
 */

import { canonicalModelName } from './collectors/utils.ts';

const MTOK = 1_000_000;
const VERIFIED_AT = '2026-09-07';
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
}

interface OfficialRate {
  provider: string;
  model: string;
  aliases: string[];
  priced: boolean;
  unavailableReason: string | null;
  ratesPerMTok: PricingRates | null;
  officialRatesPerMTok?: OfficialCurrencyRates | null;
  source: PricingSource | null;
  pricingFetchStatus?: string | null;
  note: string | null;
}

interface CachedRateInput {
  provider: string;
  model: string;
  aliases?: string[];
  priced?: boolean;
  unavailableReason?: string | null;
  ratesPerMTok?: Partial<PricingRates> | null;
  officialRatesPerMTok?: OfficialCurrencyRates | null;
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
      'https://platform.kimi.com/docs/pricing/chat-k3.md',
      'https://platform.kimi.com/docs/pricing/chat-k27-code.md',
      'https://platform.kimi.com/docs/pricing/chat-k26.md',
      'https://platform.kimi.com/docs/pricing/chat-k25.md'
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
    model: "gpt-5.4-mini",
    aliases: ["gpt-5-4-mini"],
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
    cachedInput: 2,
    cacheWrite5m: 2,
    cacheWrite1h: 2,
    output: 6,
    source: "xai",
    note: "xAI Grok 4.5 public model page lists input and output rates; no separate cached-input rate is applied by default."
  }),
  officialRate({
    provider: "xai",
    model: "grok-4.6",
    aliases: ["grok-4-6"],
    source: "xai",
    unavailableReason: "Grok 4.6 is recognized, but its official API rate has not been synchronized to the local price cache. This does not mean the model is free or has no price.",
    note: "Costs remain uncalculated until the official xAI API rate is refreshed."
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
    note: "Claude Sonnet 5 introductory pricing through August 31, 2026; standard pricing is USD 3/15 per MTok afterward."
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
    input: 0.435,
    cachedInput: 0.003625,
    cacheWrite5m: 0.435,
    cacheWrite1h: 0.435,
    output: 0.87,
    source: "deepseek",
    note: "Overseas USD API prices per 1M tokens."
  }),
  officialRate({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    aliases: ["deepseek-v4-flash", "deepseek-v4-flash-0731", "deepseek-chat", "deepseek-reasoner"],
    input: 0.14,
    cachedInput: 0.0028,
    cacheWrite5m: 0.14,
    cacheWrite1h: 0.14,
    output: 0.28,
    source: "deepseek",
    note: "DeepSeek docs identify DeepSeek-V4-Flash-0731 as the current version; deepseek-chat and deepseek-reasoner map to deepseek-v4-flash compatibility modes."
  }),
  officialRate({
    provider: "MiniMax",
    model: "minimax-m3",
    aliases: ["minimax-m3", "minimax-m-3"],
    input: 0.6250560876221483,
    cachedInput: 0.6250560876221483,
    cacheWrite5m: 0.6250560876221483,
    cacheWrite1h: 0.6250560876221483,
    output: 2.500224350488593,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":4.2,"output":16.8,"cachedInput":4.2,"cacheWrite5m":4.2,"cacheWrite1h":4.2},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
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
    input: 0.14882287800527338,
    cachedInput: 0.037205719501318346,
    cacheWrite5m: 0.14882287800527338,
    cacheWrite1h: 0.14882287800527338,
    output: 0.5952915120210935,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":1,"output":4,"cachedInput":0.25,"cacheWrite5m":1,"cacheWrite1h":1},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Tencent Hunyuan",
    note: "Official Tencent TokenHub hy3 RMB rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Tencent Hunyuan",
    model: "hy4-preview",
    aliases: ["hy4-preview", "hy-4-preview", "hunyuan-hy4-preview", "hunyuan-hy-4-preview"],
    input: 0.8929372680316403,
    cachedInput: 0.04464686340158202,
    cacheWrite5m: 0.8929372680316403,
    cacheWrite1h: 0.8929372680316403,
    output: 2.678811804094921,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":6,"output":18,"cachedInput":0.3,"cacheWrite5m":6,"cacheWrite1h":6},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Tencent Hunyuan",
    note: "Official Tencent TokenHub hy4-preview RMB rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-5.3",
    aliases: ["glm-5-3"],
    input: 1.190583024042187,
    cachedInput: 0.29764575601054677,
    cacheWrite5m: 1.190583024042187,
    cacheWrite1h: 1.190583024042187,
    output: 4.167040584147655,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":8,"output":28,"cachedInput":2,"cacheWrite5m":8,"cacheWrite1h":8},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel RMB rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-5.3-flash",
    aliases: ["glm-5-3-flash"],
    input: 0.05952915120210936,
    cachedInput: 0.01711463097060644,
    cacheWrite5m: 0.05952915120210936,
    cacheWrite1h: 0.05952915120210936,
    output: 0.20835202920738274,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":0.4,"output":1.4,"cachedInput":0.115,"cacheWrite5m":0.4,"cacheWrite1h":0.4},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel limited-time RMB rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-5.2",
    aliases: ["glm-5-2"],
    input: 1.190583024042187,
    cachedInput: 0.29764575601054677,
    cacheWrite5m: 1.190583024042187,
    cacheWrite1h: 1.190583024042187,
    output: 4.167040584147655,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":8,"output":28,"cachedInput":2,"cacheWrite5m":8,"cacheWrite1h":8},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel RMB rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-5.1",
    aliases: ["glm-5-1"],
    input: 0.8929372680316403,
    cachedInput: 0.1934697414068554,
    cacheWrite5m: 0.8929372680316403,
    cacheWrite1h: 0.8929372680316403,
    output: 3.5717490721265612,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":6,"output":24,"cachedInput":1.3,"cacheWrite5m":6,"cacheWrite1h":6},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel RMB short-context rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-4.5-air",
    aliases: ["glm-4-5-air"],
    input: 0.11905830240421872,
    cachedInput: 0.023811660480843745,
    cacheWrite5m: 0.11905830240421872,
    cacheWrite1h: 0.11905830240421872,
    output: 0.29764575601054677,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":0.8,"output":2,"cachedInput":0.16,"cacheWrite5m":0.8,"cacheWrite1h":0.8},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel pricing page. RMB prices are converted to USD for internal cost math."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-4.7",
    aliases: ["glm-4-7"],
    input: 0.29764575601054677,
    cachedInput: 0.05952915120210936,
    cacheWrite5m: 0.29764575601054677,
    cacheWrite1h: 0.29764575601054677,
    output: 1.190583024042187,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":2,"output":8,"cachedInput":0.4,"cacheWrite5m":2,"cacheWrite1h":2},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel pricing page. RMB prices are converted to USD for internal cost math."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-5",
    aliases: ["glm-5"],
    input: 0.5952915120210935,
    cachedInput: 0.14882287800527338,
    cacheWrite5m: 0.5952915120210935,
    cacheWrite1h: 0.5952915120210935,
    output: 2.678811804094921,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":4,"output":18,"cachedInput":1,"cacheWrite5m":4,"cacheWrite1h":4},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel pricing page. RMB prices are converted to USD for internal cost math."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-5-turbo",
    aliases: ["glm-5-turbo"],
    input: 0.7441143900263669,
    cachedInput: 0.17858745360632808,
    cacheWrite5m: 0.7441143900263669,
    cacheWrite1h: 0.7441143900263669,
    output: 3.2741033161160145,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":5,"output":22,"cachedInput":1.2,"cacheWrite5m":5,"cacheWrite1h":5},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel pricing page. RMB prices are converted to USD for internal cost math."
  }),
  officialRate({
    provider: "Zhipu GLM",
    model: "glm-5v-turbo",
    aliases: ["glm-5v-turbo", "glm-5-v-turbo"],
    input: 0.7441143900263669,
    cachedInput: 0.17858745360632808,
    cacheWrite5m: 0.7441143900263669,
    cacheWrite1h: 0.7441143900263669,
    output: 3.2741033161160145,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":5,"output":22,"cachedInput":1.2,"cacheWrite5m":5,"cacheWrite1h":5},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Zhipu GLM",
    note: "Official BigModel pricing page. RMB prices are converted to USD for internal cost math."
  }),
  officialRate({
    provider: "DoubaoSeed",
    model: "doubao-seed-evolving",
    aliases: ["doubao-seed-evolving", "doubao_seed_evolving"],
    input: 0.8929372680316403,
    cachedInput: 0.17858745360632808,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 4.4646863401582015,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":6,"output":30,"cachedInput":1.2,"cacheWrite5m":0,"cacheWrite1h":0},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "DoubaoSeed",
    note: "Official Volcengine Ark CNY online-inference rate converted to USD at the last verified refresh rate. Cache-storage charges are not included."
  }),
  officialRate({
    provider: "DoubaoSeed",
    model: "doubao-seed-2.1-pro",
    aliases: ["doubao-seed-2-1-pro", "doubao_seed_2_1_pro"],
    input: 0.8929372680316403,
    cachedInput: 0.17858745360632808,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 4.4646863401582015,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":6,"output":30,"cachedInput":1.2,"cacheWrite5m":0,"cacheWrite1h":0},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "DoubaoSeed",
    note: "Official Volcengine Ark CNY online-inference rate converted to USD at the last verified refresh rate. Cache-storage charges are not included."
  }),
  officialRate({
    provider: "DoubaoSeed",
    model: "doubao-seed-2.1-turbo",
    aliases: ["doubao-seed-2-1-turbo", "doubao_seed_2_1_turbo"],
    input: 0.44646863401582015,
    cachedInput: 0.08929372680316404,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 2.2323431700791008,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":3,"output":15,"cachedInput":0.6,"cacheWrite5m":0,"cacheWrite1h":0},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "DoubaoSeed",
    note: "Official Volcengine Ark CNY online-inference rate converted to USD at the last verified refresh rate. Cache-storage charges are not included."
  }),
  officialRate({
    provider: "DoubaoSeed",
    model: "doubao-seed-2.0-lite",
    aliases: ["doubao-seed-2-0-lite", "doubao_seed_2_0_lite"],
    input: 0.08929372680316404,
    cachedInput: 0.017858745360632807,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0.5357623608189842,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":0.6,"output":3.6,"cachedInput":0.12,"cacheWrite5m":0,"cacheWrite1h":0},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
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
    source: "Gemini",
    unavailableReason: "Gemini 3.8 Flash is recognized, but its official API rate has not been synchronized to the local price cache. This does not mean the model is free or has no price.",
    note: "Costs remain uncalculated until the official Gemini API rate is refreshed."
  }),
  officialRate({
    provider: "Gemini",
    model: "gemini-3.7-flash",
    aliases: ["gemini-3-7-flash"],
    source: "Gemini",
    unavailableReason: "Gemini 3.7 Flash is recognized, but its official API rate has not been synchronized to the local price cache. This does not mean the model is free or has no price.",
    note: "Costs remain uncalculated until the official Gemini API rate is refreshed."
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
    input: 2.9764575601054677,
    cachedInput: 0.29764575601054677,
    cacheWrite5m: 2.9764575601054677,
    cacheWrite1h: 2.9764575601054677,
    output: 14.882287800527338,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":20,"cachedInput":2,"cacheWrite5m":20,"cacheWrite1h":20,"output":100},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Kimi",
    note: "Official Kimi API CNY rate parsed from the current model pricing pages."
  }),
  officialRate({
    provider: "Kimi",
    model: "kimi-k2.7-code",
    aliases: ["kimi-k2-7-code"],
    input: 0.9673487070342771,
    cachedInput: 0.1934697414068554,
    cacheWrite5m: 0.9673487070342771,
    cacheWrite1h: 0.9673487070342771,
    output: 4.018217706142382,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":6.5,"cachedInput":1.3,"cacheWrite5m":6.5,"cacheWrite1h":6.5,"output":27},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Kimi",
    note: "Official Kimi API CNY rate parsed from the current model pricing pages."
  }),
  officialRate({
    provider: "Kimi",
    model: "kimi-k2.7-code-highspeed",
    aliases: ["kimi-k2-7-code-highspeed"],
    input: 1.9346974140685542,
    cachedInput: 0.3869394828137108,
    cacheWrite5m: 1.9346974140685542,
    cacheWrite1h: 1.9346974140685542,
    output: 8.036435412284764,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":13,"cachedInput":2.6,"cacheWrite5m":13,"cacheWrite1h":13,"output":54},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Kimi",
    note: "Official Kimi API CNY rate parsed from the current model pricing pages."
  }),
  officialRate({
    provider: "Kimi",
    model: "kimi-k2.6",
    aliases: ["kimi-k2-6"],
    input: 0.9673487070342771,
    cachedInput: 0.16370516580580075,
    cacheWrite5m: 0.9673487070342771,
    cacheWrite1h: 0.9673487070342771,
    output: 4.018217706142382,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":6.5,"cachedInput":1.1,"cacheWrite5m":6.5,"cacheWrite1h":6.5,"output":27},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Kimi",
    note: "Official Kimi API CNY rate parsed from the current model pricing pages."
  }),
  officialRate({
    provider: "Kimi",
    model: "kimi-k2.5",
    aliases: ["kimi-k2-5"],
    input: 0.5952915120210935,
    cachedInput: 0.10417601460369137,
    cacheWrite5m: 0.5952915120210935,
    cacheWrite1h: 0.5952915120210935,
    output: 3.125280438110741,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":4,"cachedInput":0.7,"cacheWrite5m":4,"cacheWrite1h":4,"output":21},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Kimi",
    note: "Official Kimi API CNY rate parsed from the current model pricing pages."
  }),
  officialRate({
    provider: "Qwen",
    model: "qwen3.8",
    aliases: ["qwen3-8", "qwen3-8-max"],
    input: 1.7858745360632806,
    cachedInput: 1.7858745360632806,
    cacheWrite5m: 1.7858745360632806,
    cacheWrite1h: 1.7858745360632806,
    output: 5.357623608189842,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":12,"output":36,"cachedInput":12,"cacheWrite5m":12,"cacheWrite1h":12},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Qwen",
    note: "Official Alibaba Cloud Model Studio RMB prices converted to USD for internal cost math; short-context public rates are used by default."
  }),
  officialRate({
    provider: "Qwen",
    model: "qwen3.7-plus",
    aliases: ["qwen3-7-plus"],
    input: 0.29764575601054677,
    cachedInput: 0.29764575601054677,
    cacheWrite5m: 0.29764575601054677,
    cacheWrite1h: 0.29764575601054677,
    output: 1.190583024042187,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":2,"output":8,"cachedInput":2,"cacheWrite5m":2,"cacheWrite1h":2},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Qwen",
    note: "Official Alibaba Cloud Model Studio RMB short-context rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Qwen",
    model: "qwen3.7-max",
    aliases: ["qwen3-7-max"],
    input: 1.7858745360632806,
    cachedInput: 1.7858745360632806,
    cacheWrite5m: 1.7858745360632806,
    cacheWrite1h: 1.7858745360632806,
    output: 5.357623608189842,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":12,"output":36,"cachedInput":12,"cacheWrite5m":12,"cacheWrite1h":12},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Qwen",
    note: "Official Alibaba Cloud Model Studio RMB rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Qwen",
    model: "qwen3.6-flash",
    aliases: ["qwen3-6-flash"],
    input: 0.17858745360632808,
    cachedInput: 0.17858745360632808,
    cacheWrite5m: 0.17858745360632808,
    cacheWrite1h: 0.17858745360632808,
    output: 1.0715247216379684,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":1.2,"output":7.2,"cachedInput":1.2,"cacheWrite5m":1.2,"cacheWrite1h":1.2},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Qwen",
    note: "Official Alibaba Cloud Model Studio RMB rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Qwen",
    model: "qwen3-coder-plus",
    aliases: ["qwen3-coder-plus", "qwen3-coder"],
    input: 0.5952915120210935,
    cachedInput: 0.5952915120210935,
    cacheWrite5m: 0.5952915120210935,
    cacheWrite1h: 0.5952915120210935,
    output: 2.381166048084374,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":4,"output":16,"cachedInput":4,"cacheWrite5m":4,"cacheWrite1h":4},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Qwen",
    note: "Official Alibaba Cloud Model Studio RMB short-context Coder rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Qwen",
    model: "qwen3-coder-flash",
    aliases: ["qwen3-coder-flash"],
    input: 0.14882287800527338,
    cachedInput: 0.14882287800527338,
    cacheWrite5m: 0.14882287800527338,
    cacheWrite1h: 0.14882287800527338,
    output: 0.5952915120210935,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":1,"output":4,"cachedInput":1,"cacheWrite5m":1,"cacheWrite1h":1},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Qwen",
    note: "Official Alibaba Cloud Model Studio RMB short-context Coder rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Qwen",
    model: "qwen-coder-plus",
    aliases: ["qwen-coder-plus"],
    input: 0.5208800730184568,
    cachedInput: 0.5208800730184568,
    cacheWrite5m: 0.5208800730184568,
    cacheWrite1h: 0.5208800730184568,
    output: 1.0417601460369137,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":3.5,"output":7,"cachedInput":3.5,"cacheWrite5m":3.5,"cacheWrite1h":3.5},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
    source: "Qwen",
    note: "Official Alibaba Cloud Model Studio RMB Coder rate converted to USD at the last verified refresh rate."
  }),
  officialRate({
    provider: "Qwen",
    model: "qwen-coder-turbo",
    aliases: ["qwen-coder-turbo"],
    input: 0.29764575601054677,
    cachedInput: 0.29764575601054677,
    cacheWrite5m: 0.29764575601054677,
    cacheWrite1h: 0.29764575601054677,
    output: 0.8929372680316403,
    officialRatesPerMTok: {"currency":"CNY","unit":"1M tokens","ratesPerMTok":{"input":2,"output":6,"cachedInput":2,"cacheWrite5m":2,"cacheWrite1h":2},"exchangeRate":6.719397,"sourceUnit":"元 / 1M tokens"},
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

export function calculateCost(model, tokens, _pricingData = null, provider = null) {
  return calculateOfficialCost(model, tokens, { provider, pricingData: _pricingData }).totalUSD;
}

export function calculateOfficialCost(model, tokens: TokenInput = {}, options: PricingOptions = {}) {
  const pricing = resolveOfficialPricing(model, options.provider, options.pricingData);
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

export function resolveOfficialPricing(model, provider: string | null = null, pricingData: PricingData | null = null) {
  const normalized = normalizeModelId(model);
  if (!normalized || normalized === '<synthetic>') return null;

  const candidates = modelCandidates(normalized, provider);
  const sorted = pricingTableFrom(pricingData)
    .slice()
    .sort((a, b) => longestAliasLength(b) - longestAliasLength(a));

  for (const rate of sorted) {
    if (matchesRate(rate, candidates)) return rate;
  }

  return null;
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

export function attachOfficialPricing(row: PricingRow, model = row?.model, provider: string | null = null, pricingData: PricingData | null = null) {
  const cacheRead = Number(row?.cacheReadTokens ?? row?.cacheRead ?? 0)
    + Number(row?.cachedInputTokens ?? row?.cachedInput ?? 0);
  const tokens = {
    input: row?.inputTokens ?? row?.input,
    output: row?.outputTokens ?? row?.output,
    cacheRead,
    cacheWrite: row?.cacheCreationTokens ?? row?.cacheWrite,
    reasoning: row?.reasoningOutputTokens ?? row?.reasoning
  };
  const cost = calculateOfficialCost(model, tokens, { provider, pricingData });
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
  officialRatesPerMTok
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
    source: sourceMeta,
    note: note || sourceMeta?.note || null
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
  const merged = new Map(OFFICIAL_PRICE_TABLE.map(model => [pricingKey(model), model]));
  const cached = pricingData.models
    .map(model => normalizeCachedRate(model))
    .filter(Boolean);
  for (const model of cached) {
    merged.set(pricingKey(model), model);
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
