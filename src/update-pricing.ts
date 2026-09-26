import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  OFFICIAL_PRICING_SOURCES,
  OFFICIAL_PRICE_TABLE,
  serializeOfficialPricingModels,
  validateOfficialPricingRefresh
} from './pricing.ts';
import { getUsdCnyExchangeRate } from './exchange-rate.ts';

process.env.PRICING_REFRESH = '1';

const pricingCachePath = resolve(process.cwd(), 'data', 'official-pricing.json');
const pricingSourcePath = resolve(process.cwd(), 'src', 'pricing.ts');
const MAX_PRICING_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_PRICING_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_PRICING_ASSETS = 4;

interface ParsedRates {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

interface PricingAsset {
  url: string;
  fetchStatus: string;
  fetchError?: string;
  httpStatus?: number;
  contentLength?: number;
  body?: string;
}
const STABLE_ALIASES = new Map([
  ['openai::gpt-6-astra', ['gpt-6-astra', 'gpt_6_astra']],
  ['openai::gpt-5-6-sol', ['gpt-5.6-sol', 'gpt-5-6-sol']],
  ['openai::gpt-5-6-terra', ['gpt-5.6-terra', 'gpt-5-6-terra']],
  ['openai::gpt-5-6-luna', ['gpt-5.6-luna', 'gpt-5-6-luna']],
  ['openai::gpt-5-6-cyber', ['gpt-5.6-cyber', 'gpt-5-6-cyber']],
  ['openai::gpt-5-5-pro', ['gpt-5.5-pro', 'gpt-5-5-pro']],
  ['openai::gpt-5-4', ['gpt-5.4', 'gpt-5-4']],
  ['openai::gpt-5-4-pro', ['gpt-5.4-pro', 'gpt-5-4-pro']],
  ['openai::gpt-5-4-nano', ['gpt-5.4-nano', 'gpt-5-4-nano']],
  ['openai::gpt-image-2-5-sunburst', ['gpt-image-2.5-sunburst', 'gpt-image-2-5-sunburst']],
  ['openai::gpt-image-2-5-flare', ['gpt-image-2.5-flare', 'gpt-image-2-5-flare']],
  ['deepseek::deepseek-v4-flash', ['deepseek-v4-flash', 'deepseek-v4-flash-0731', 'deepseek-v4-flash-vision-exp', 'deepseek-chat', 'deepseek-reasoner']],
  ['deepseek::deepseek-flash', ['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-v4-1-flash']],
  ['minimax::minimax-m3', ['minimax-m3', 'minimax-m-3']],
  ['xai::grok-4-6', ['grok-4.6', 'grok-4-6']],
  ['xai::grok-4-5', ['grok-4.5', 'grok-4-5']],
  ['xai::grok-4-3', ['grok-4.3', 'grok-4-3']],
  ['xai::grok-4-20-0309-reasoning', ['grok-4.20-0309-reasoning', 'grok-4-20-0309-reasoning', 'grok-4.20']],
  ['xai::grok-4-20-0309-non-reasoning', ['grok-4.20-0309-non-reasoning', 'grok-4-20-0309-non-reasoning']],
  ['xai::grok-4-20-0309-multi-agent-0309', ['grok-4.20-0309-multi-agent-0309', 'grok-4-20-0309-multi-agent-0309']],
  ['xai::grok-build-0-1', ['grok-build-0.1', 'grok-build-0-1']],
  ['anthropic::claude-opus-4-5', ['claude-opus-4-5', 'claude-opus-4.5']],
  ['anthropic::claude-opus-5-5', ['claude-opus-5-5', 'claude-opus-5.5']],
  ['anthropic::claude-sonnet-4-5', ['claude-sonnet-4-5', 'claude-sonnet-4.5']],
  ['gemini::gemini-3-8-flash', ['gemini-3.8-flash', 'gemini-3-8-flash']],
  ['gemini::gemini-3-7-flash', ['gemini-3.7-flash', 'gemini-3-7-flash']],
  ['gemini::gemini-3-6-flash', ['gemini-3.6-flash', 'gemini-3-6-flash']],
  ['gemini::gemini-3-5-flash-lite', ['gemini-3.5-flash-lite', 'gemini-3-5-flash-lite']],
  ['gemini::gemini-2-5-flash-lite', ['gemini-2.5-flash-lite', 'gemini-2-5-flash-lite']],
  ['gemini::gemini-3-1-flash-image', ['gemini-3.1-flash-image', 'gemini-3-1-flash-image', 'gemini-3.1-flash-image-preview']],
  ['gemini::gemini-3-1-flash-lite-image', ['gemini-3.1-flash-lite-image', 'gemini-3-1-flash-lite-image', 'gemini-3.1-flash-lite-image-preview']],
  ['gemini::gemini-3-pro-image', ['gemini-3-pro-image', 'gemini-3-pro-image-preview']],
  ['xiaomi::mimo-v2.5-pro', ['mimo-v2.5-pro', 'mimo-v2-pro']],
  ['zhipu glm::glm-5-3', ['glm-5.3', 'glm-5-3']],
  ['zhipu glm::glm-5-3-flash', ['glm-5.3-flash', 'glm-5-3-flash']],
  ['zhipu glm::glm-5-3-flashx', ['glm-5.3-flashx', 'glm-5-3-flashx']],
  ['zhipu glm::glm-5.2', ['glm-5.2', 'glm-5-2']],
  ['zhipu glm::glm-5.1', ['glm-5.1', 'glm-5-1']],
  ['zhipu glm::glm-4.5-air', ['glm-4.5-air', 'glm-4-5-air']],
  ['zhipu glm::glm-4.7', ['glm-4.7', 'glm-4-7']],
  ['zhipu glm::glm-4.6v', ['glm-4.6v', 'glm-4-6v']],
  ['zhipu glm::glm-4.6v-flashx', ['glm-4.6v-flashx', 'glm-4-6v-flashx']],
  ['zhipu glm::glm-4.6v-flash', ['glm-4.6v-flash', 'glm-4-6v-flash']],
  ['zhipu glm::glm-4.5v', ['glm-4.5v', 'glm-4-5v']],
  ['qwen::qwen3.7-plus', ['qwen3.7-plus', 'qwen3-7-plus']],
  ['qwen::qwen3-8', ['qwen3.8', 'qwen3-8', 'qwen3.8-max', 'qwen3-8-max']],
  ['qwen::qwen3.7-max', ['qwen3.7-max', 'qwen3-7-max']],
  ['qwen::qwen3.6-flash', ['qwen3.6-flash', 'qwen3-6-flash']],
  ['qwen::qwen3-coder-plus', ['qwen3-coder-plus', 'qwen3-coder']],
  ['qwen::qwen3-coder-flash', ['qwen3-coder-flash']],
  ['qwen::qwen-coder-plus', ['qwen-coder-plus']],
  ['qwen::qwen-coder-turbo', ['qwen-coder-turbo']],
  ['tencent hunyuan::hy3', ['hy3', 'hy-3', 'hunyuan-hy3', 'hy3-x', 'hy3_x', 'hunyuan-hy3-x', 'hunyuan_hy3_x']],
  ['tencent hunyuan::hy4-preview', ['hy4-preview', 'hy-4-preview', 'hunyuan-hy4-preview', 'hunyuan-hy-4-preview']]
]);
const fetchedAt = new Date().toISOString();
const previousModels = await readPreviousPricingModels(pricingCachePath);
const exchangeRate = await getUsdCnyExchangeRate();
const sources = await Promise.all(OFFICIAL_PRICING_SOURCES.map(source => fetchSourceStatus(source, exchangeRate)));
const ok = sources.filter(source => source.fetchStatus === 'ok').length;
const exchangeOk = !exchangeRate.isFallback;
const sourceStatuses = new Map(sources.map(source => [providerKey(source.provider), source.fetchStatus]));
const fetchedRates = new Map();
for (const model of sources.flatMap(source => source.models || [])) {
  const key = pricingKey(model);
  const previous = fetchedRates.get(key);
  if (previous) {
    if (!sameFetchedPricing(previous, model)) {
      throw new Error(`Conflicting fetched pricing model: ${key}`);
    }
    continue;
  }
  fetchedRates.set(key, model);
}
const pricing = {
  mode: 'official-cache',
  verifiedAt: fetchedAt.slice(0, 10),
  fetchedAt,
  exchangeRate,
  sources: sources.map(({ body, models, ...source }) => source),
  models: serializeOfficialPricingModels(OFFICIAL_PRICE_TABLE).map(model => {
    const fetched = fetchedRates.get(pricingKey(model));
    const previous = previousModels.get(pricingKey(model));
    const aliases = uniqueModelAliases([
      ...(STABLE_ALIASES.get(pricingKey(fetched || model)) || []),
      ...(model.aliases || []),
      ...(fetched?.aliases || [])
    ]);
    return fetched
      ? {
          ...model,
          ...fetched,
          aliases,
          ratesPerMTok: {
            ...(model.ratesPerMTok || {}),
            ...(fetched.ratesPerMTok || {})
          },
          pricingFetchStatus: fetched.pricingFetchStatus || 'official-page'
        }
      : fallbackPricingModel(model, previous, exchangeRate, sourceStatuses.get(providerKey(model.sourceProvider || model.provider)));
  })
};

if (ok === 0 || !exchangeOk) {
  const reason = ok === 0
    ? `official sources reachable=0/${sources.length}`
    : `exchange rate unavailable (${exchangeRate.error || 'fallback rate'})`;
  console.log(`[pricing] skipped cache write; ${reason}`);
  for (const source of sources) {
    console.log(`[pricing] ${source.provider}: ${source.fetchStatus} (${source.fetchError || source.httpStatus || 'unknown error'})`);
  }
  process.exitCode = 1;
} else {
  validateOfficialPricingRefresh(pricing.models);
  await mkdir(resolve(process.cwd(), 'data'), { recursive: true });
  await writeFile(pricingCachePath, `${JSON.stringify(pricing, null, 2)}\n`, 'utf8');
  await updateBuiltinPricingTable(pricingSourcePath, pricing);

  const parsed = pricing.models.filter(model => (
    model.pricingFetchStatus?.startsWith('official-page') || model.pricingFetchStatus === 'official-api'
  )).length;
  console.log(`[pricing] wrote ${pricingCachePath}`);
  console.log(`[pricing] updated built-in table ${pricingSourcePath}`);
  console.log(`[pricing] official sources reachable=${ok}/${sources.length} parsedModels=${parsed}/${pricing.models.length}`);
  for (const source of sources) {
    const suffix = source.fetchStatus === 'ok'
      ? `${source.httpStatus || 'ok'} ${source.contentLength} bytes, parsed=${source.models?.length || 0}`
      : source.httpStatus
        ? `${source.httpStatus} ${source.contentLength ?? 0} bytes`
        : source.fetchError;
    console.log(`[pricing] ${source.provider}: ${source.fetchStatus} (${suffix})`);
  }
}

async function updateBuiltinPricingTable(filePath, pricing) {
  const source = await readFile(filePath, 'utf8');
  const withDate = source.replace(
    /const VERIFIED_AT = '[^']+';/,
    `const VERIFIED_AT = '${pricing.verifiedAt}';`
  );
  const tableStart = withDate.indexOf('export const OFFICIAL_PRICE_TABLE = [');
  const tableEndWithSemi = withDate.indexOf('\n];', tableStart);
  const tableEndWithoutSemi = withDate.indexOf('\n]\n', tableStart);
  const tableEnd = tableEndWithSemi >= 0 ? tableEndWithSemi : tableEndWithoutSemi;
  if (tableStart < 0 || tableEnd < 0) {
    throw new Error('Unable to locate OFFICIAL_PRICE_TABLE block in pricing.ts');
  }
  const existingEndLength = tableEndWithSemi >= 0 ? 3 : 2;
  const nextTable = `export const OFFICIAL_PRICE_TABLE = [\n${pricing.models.map(officialRateSource).join(',\n')}\n];`;
  const nextSource = `${withDate.slice(0, tableStart)}${nextTable}${withDate.slice(tableEnd + existingEndLength)}`;
  if (nextSource !== source) await writeFile(filePath, nextSource, 'utf8');
}

async function readPreviousPricingModels(filePath) {
  try {
    const payload = JSON.parse(await readFile(filePath, 'utf8'));
    return new Map((payload.models || []).map(model => [pricingKey(model), model]));
  } catch {
    return new Map();
  }
}

function fallbackPricingModel(model, previous, exchangeRate, sourceStatus = null) {
  const normalizedModel = {
    ...model,
    aliases: uniqueModelAliases(model.aliases || [model.model])
  };
  const fallbackStatus = fallbackPricingFetchStatus(previous, sourceStatus);
  const officialRates = model.officialRatesPerMTok || previous?.officialRatesPerMTok || null;
  if (officialRates?.currency !== 'CNY' || !officialRates.ratesPerMTok) {
    return { ...normalizedModel, pricingFetchStatus: fallbackStatus };
  }
  const ratesPerMTok = cnyToUsdRates(officialRates.ratesPerMTok, exchangeRate);
  if (!ratesPerMTok || !isFiniteRate(ratesPerMTok.input) || !isFiniteRate(ratesPerMTok.output)) {
    return { ...normalizedModel, pricingFetchStatus: fallbackStatus };
  }

  return {
    ...normalizedModel,
    ratesPerMTok,
    officialRatesPerMTok: {
      ...officialRates,
      exchangeRate: exchangeRate.rate
    },
    pricingFetchStatus: sourceStatus === 'parse-error' ? 'cached-official-cny-parse-error' : 'cached-official-cny',
    note: model.note || previous?.note
  };
}

function fallbackPricingFetchStatus(previous, sourceStatus) {
  const previousStatus = String(previous?.pricingFetchStatus || '');
  if (previousStatus.startsWith('official-')) return `cached-${previousStatus}`;
  if (previousStatus.startsWith('cached-official-')) return previousStatus;
  if (previousStatus === 'cached-fallback-parse-error') return previousStatus;
  if (previousStatus === 'fallback-parse-error') return 'cached-fallback-parse-error';
  return sourceStatus === 'parse-error' ? 'fallback-parse-error' : 'fallback-table';
}

function officialRateSource(model) {
  const lines = [
    `  officialRate({`,
    `    provider: ${literal(model.provider)},`,
    `    model: ${literal(model.model)},`,
    `    aliases: ${arrayLiteral(model.aliases || [model.model])},`
  ];
  if (model.ratesPerMTok) {
    const rates = model.ratesPerMTok;
    lines.push(`    input: ${numberLiteral(rates.input)},`);
    lines.push(`    cachedInput: ${numberLiteral(rates.cachedInput ?? rates.input)},`);
    if (rates.cacheWrite5m != null) lines.push(`    cacheWrite5m: ${numberLiteral(rates.cacheWrite5m)},`);
    if (rates.cacheWrite1h != null) lines.push(`    cacheWrite1h: ${numberLiteral(rates.cacheWrite1h)},`);
    lines.push(`    output: ${numberLiteral(rates.output)},`);
  }
  if (model.officialRatesPerMTok) {
    lines.push(`    officialRatesPerMTok: ${JSON.stringify(model.officialRatesPerMTok)},`);
  }
  // 价目时间表须随内置表回写，否则刷新后按日期取价的历史档丢失
  if (model.rateSchedule?.length) {
    lines.push(`    rateSchedule: ${JSON.stringify(model.rateSchedule)},`);
  }
  const tail = [
    `    source: ${literal(model.sourceProvider || model.provider)}`,
    model.unavailableReason ? `    unavailableReason: ${literal(model.unavailableReason)}` : null,
    model.note ? `    note: ${literal(model.note)}` : null
  ].filter(Boolean);
  lines.push(...tail.map((line, index) => index < tail.length - 1 ? `${line},` : line));
  return `${lines.join('\n')}\n  })`;
}

function literal(value) {
  return JSON.stringify(String(value || ''));
}

function arrayLiteral(values) {
  return `[${values.map(literal).join(', ')}]`;
}

function numberLiteral(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return Number.isInteger(number) ? String(number) : String(number);
}

function uniqueModelAliases(values) {
  return Array.from(new Set(
    values
      .map(value => String(value || '').trim().toLowerCase().replace(/(?<=\d)\.(?=\d)/g, '-'))
      .filter(Boolean)
  ));
}

async function fetchSourceStatus(source, exchangeRate) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'user-agent': 'token-work-roi-pricing-cache/1.0'
      }
    });
    const text = await readResponseText(response, MAX_PRICING_PAGE_BYTES);
    const assets = response.ok ? await fetchSourceAssets(source, text) : [];
    if (response.ok && isDoubaoSource(source)) assets.push(await fetchDoubaoPricingTables());
    const parseBody = [text, ...assets.map(asset => asset.body || '')].join('\n');
    const models = response.ok ? parseSourceModels(source, parseBody, exchangeRate) : [];
    const parseError = response.ok && sourceHasPricingParser(source) && models.length === 0;
    return {
      ...source,
      fetchedAt,
      fetchStatus: response.ok ? (parseError ? 'parse-error' : 'ok') : 'http-error',
      fetchError: parseError ? 'no supported pricing rows found' : null,
      httpStatus: response.status,
      contentLength: Buffer.byteLength(text, 'utf8'),
      assets: assets.map(({ body, ...asset }) => asset),
      models
    };
  } catch (error) {
    return {
      ...source,
      fetchedAt,
      fetchStatus: 'error',
      fetchError: error?.name === 'AbortError' ? 'timeout' : error?.message || String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSourceAssets(source, body): Promise<PricingAsset[]> {
  const urls = [...new Set((source.assetUrls?.length ? source.assetUrls : discoverAssetUrls(source, body))
    .map(url => sameOriginHttpsAssetUrl(url, source.url))
    .filter(Boolean))]
    .slice(0, MAX_PRICING_ASSETS);
  if (!urls.length) return [];
  const assets = await Promise.all(urls.map(url => fetchAsset(url)));
  const nestedUrls = [...new Set(assets.flatMap(asset => discoverAssetUrls(source, asset.body || '')))];
  const seen = new Set(assets.map(asset => asset.url));
  const nestedAssets = await Promise.all(
    nestedUrls
      .map(url => sameOriginHttpsAssetUrl(url, source.url))
      .filter(url => url && !seen.has(url))
      .slice(0, Math.max(0, MAX_PRICING_ASSETS - assets.length))
      .map(url => fetchAsset(url))
  );
  return [...assets, ...nestedAssets];
}

function sameOriginHttpsAssetUrl(value, sourceUrl) {
  try {
    const asset = new URL(value);
    const source = new URL(sourceUrl);
    if (asset.protocol !== 'https:') return null;
    if (asset.origin !== source.origin && !isTrustedPricingAssetUrl(asset, source)) return null;
    return asset.toString();
  } catch {
    return null;
  }
}

function isTrustedPricingAssetUrl(asset, source) {
  return source.hostname === 'open.bigmodel.cn'
    && asset.hostname === 'static.bigmodel.cn'
    && /^\/wd-paas-front\/js\/app\.[a-z0-9]+\.js$/i.test(asset.pathname);
}

async function fetchAsset(url): Promise<PricingAsset> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'text/javascript,application/javascript,text/plain,*/*;q=0.8',
        'user-agent': 'token-work-roi-pricing-cache/1.0'
      }
    });
    const body = await readResponseText(response, MAX_PRICING_ASSET_BYTES);
    return {
      url,
      fetchStatus: response.ok ? 'ok' : 'http-error',
      httpStatus: response.status,
      contentLength: Buffer.byteLength(body, 'utf8'),
      body: response.ok ? body : ''
    };
  } catch (error) {
    return {
      url,
      fetchStatus: 'error',
      fetchError: error?.name === 'AbortError' ? 'timeout' : error?.message || String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDoubaoPricingTables(): Promise<PricingAsset> {
  const navigation = await fetchDoubaoPricingApi('GetNavigationV2', { Product: 'ark_subscription' });
  if (!navigation.body) return navigation;

  let templateCode = '';
  try {
    const navigationTree = JSON.parse(navigation.body)?.Result?.Navigation;
    const entries = walkPricingValues(typeof navigationTree === 'string' ? JSON.parse(navigationTree) : navigationTree);
    const product = entries.find(value => value?.Product === 'ark_subscription');
    templateCode = product?.TemplateInfoList?.find(item => item?.Type === 1)?.TemplateCode || '';
  } catch {
    return { ...navigation, fetchStatus: 'error', fetchError: 'invalid pricing navigation response', body: '' };
  }
  if (!templateCode) {
    return { ...navigation, fetchStatus: 'error', fetchError: 'Ark pricing template not found', body: '' };
  }

  return fetchDoubaoPricingApi('GetTable', { TemplateCode: templateCode });
}

function walkPricingValues(value) {
  if (Array.isArray(value)) return value.flatMap(walkPricingValues);
  if (!value || typeof value !== 'object') return [];
  return [value, ...Object.values(value).flatMap(walkPricingValues)];
}

async function fetchDoubaoPricingApi(action, payload): Promise<PricingAsset> {
  const url = new URL('https://www.volcengine.com/anonymous-api/trade/price');
  url.searchParams.set('Action', action);
  url.searchParams.set('Version', '2020-01-01');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'token-work-roi-pricing-cache/1.0'
      },
      body: JSON.stringify(payload)
    });
    const body = await readResponseText(response, MAX_PRICING_ASSET_BYTES);
    return {
      url: url.toString(),
      fetchStatus: response.ok ? 'ok' : 'http-error',
      httpStatus: response.status,
      contentLength: Buffer.byteLength(body, 'utf8'),
      body: response.ok ? body : ''
    };
  } catch (error) {
    return {
      url: url.toString(),
      fetchStatus: 'error',
      fetchError: error?.name === 'AbortError' ? 'timeout' : error?.message || String(error),
      body: ''
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseText(response, maxBytes) {
  const advertisedLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    throw new Error(`response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return '';

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > maxBytes) {
      throw new Error(`response exceeds ${maxBytes} bytes`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function discoverAssetUrls(source, body) {
  if (isZhipuSource(source)) {
    return Array.from(
      body.matchAll(/<script[^>]+src="([^"]*\/js\/app\.[^"]+\.js)"/g),
      match => absoluteUrl(match[1], source.url)
    );
  }
  return [];
}

function parseSourceModels(source, body, exchangeRate) {
  if (isOpenAiGpt6AstraSource(source)) return parseOpenAiGpt6AstraModel(body);
  if (isOpenAiGpt56Source(source)) return parseOpenAiGpt56Models(body);
  if (source.provider === 'xai') return parseXaiModels(body);
  if (source.provider === 'anthropic-mythos') return parseAnthropicMythosModels(body);
  if (source.provider === 'anthropic') return parseAnthropicModels(body);
  if (source.provider === 'deepseek') return parseDeepSeekModels(body);
  if (source.provider === 'xiaomi') return parseXiaomiModels(body, {
    provider: 'xiaomi',
    sourceProvider: 'xiaomi',
    models: ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro-ultraspeed', 'mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-pro'],
    startMarker: 'Overseas Pricing of the Model'
  });
  if (isZhipuSource(source)) return parseZaiModels(body, exchangeRate);
  if (isDoubaoSource(source)) return parseVolcengineModels(body, exchangeRate);
  if (source.provider === 'Gemini') return parseGeminiModels(body);
  if (source.provider === 'Kimi') return parseKimiModels(body, exchangeRate);
  if (isQwenSource(source)) return parseQwenModels(body, exchangeRate);
  if (isTencentHunyuanSource(source)) return parseTencentHunyuanModels(body, exchangeRate);
  return [];
}

function sourceHasPricingParser(source) {
  return isOpenAiGpt6AstraSource(source)
    || isOpenAiGpt56Source(source)
    || source.provider === 'xai'
    || source.provider === 'anthropic-mythos'
    || source.provider === 'anthropic'
    || source.provider === 'deepseek'
    || source.provider === 'xiaomi'
    || isZhipuSource(source)
    || isDoubaoSource(source)
    || source.provider === 'Gemini'
    || source.provider === 'Kimi'
    || isQwenSource(source)
    || isTencentHunyuanSource(source);
}

function parseOpenAiGpt6AstraModel(body) {
  const text = tableText(body).toLowerCase();
  const expectedRates = [
    /\binput\s*\$\s*10(?:\.00)?\b/,
    /\bcached input\s*\$\s*1(?:\.00)?\b/,
    /\bcache writes?\s*\$\s*12\.50\b/,
    /\boutput\s*\$\s*50(?:\.00)?\b/
  ];
  if (!text.includes('gpt-6-astra') || !expectedRates.every(pattern => pattern.test(text))) return [];
  return [rateModel('openai', 'gpt-6-astra', {
    input: 10,
    cachedInput: 1,
    cacheWrite5m: 12.5,
    cacheWrite1h: 12.5,
    output: 50
  }, 'openai-gpt-6-astra', 'official-page', null, 'OpenAI GPT-6 Astra standard API rate. Cache write is input x 1.25; cached input is input x 0.1.')];
}

function parseOpenAiGpt56Models(body) {
  const text = tableText(body).toLowerCase();
  const expected: Array<[string, number, number, string]> = [
    ['gpt-5.6-sol', 5, 30, 'OpenAI GPT-5.6 Sol flagship launch rate. Cache write is input × 1.25; cache read is input × 0.1.'],
    ['gpt-5.6-terra', 2.5, 15, 'OpenAI GPT-5.6 Terra balanced launch rate. Cache write is input × 1.25; cache read is input × 0.1.'],
    ['gpt-5.6-luna', 1, 6, 'OpenAI GPT-5.6 Luna lightweight launch rate. Cache write is input × 1.25; cache read is input × 0.1.']
  ];
  const pageMentionsAllModels = expected.every(([model]) => text.includes(model));
  const pageMentionsCacheRules = mentionsPercent(text, 90) && mentionsPercent(text, 25);
  return expected
    .filter(([, input, output]) => {
      if (!pageMentionsAllModels || !pageMentionsCacheRules) return false;
      return mentionsUsdPrice(text, input) && mentionsUsdPrice(text, output);
    })
    .map(([model, inputRate, outputRate, note]) => rateModel('openai', model, {
      input: inputRate,
      cachedInput: inputRate * 0.1,
      cacheWrite5m: inputRate * 1.25,
      cacheWrite1h: inputRate * 1.25,
      output: outputRate
    }, 'openai-gpt-5.6', 'official-page', null, note));
}

function mentionsUsdPrice(text, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return false;
  const variants = new Set([
    number.toString(),
    number.toFixed(1),
    number.toFixed(2)
  ]);
  return [...variants].some(item => new RegExp(`\\$\\s*${escapeRegex(item)}`).test(text));
}

function mentionsPercent(text, value) {
  return new RegExp(`${value}\\s*%`).test(text);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseAnthropicModels(body) {
  // 计价页改为模型卡结构，价格是纯文本（无 data-value），按卡片内标签取价避免串行
  const cards = body.split('__modelCard').slice(1);
  const priceOf = (card, label) => {
    // 标签与价格之间不允许出现下一个标签，避免该档缺价时误取下一档的价格
    const match = card.match(new RegExp(`__priceLabel[^>]*>${label}</p>(?:(?!__priceLabel)[\\s\\S]){0,120}?__priceValue[^>]*>\\$([0-9.]+)`));
    return match ? Number(match[1]) : null;
  };
  const rates = cards.map(card => {
    const name = card.match(/__modelName[^>]*>([^<]+)</)?.[1];
    if (!name) return null;
    const input = priceOf(card, 'Input');
    const output = priceOf(card, 'Output');
    if (input == null || output == null) return null;
    return {
      label: name.toLowerCase(),
      input,
      output,
      cachedInput: priceOf(card, 'Read') ?? input,
      cacheWrite5m: priceOf(card, 'Write') ?? input,
      cacheWrite1h: input * 2,
    };
  }).filter(Boolean);

  const opus = rates.find(rate => rate.label.includes('opus 4.8'));
  const opus5 = rates.find(rate => /opus\s+5(?![.-]\d)/.test(rate.label));
  const opus55 = rates.find(rate => rate.label.includes('opus 5.5'));
  const fable5 = rates.find(rate => /fable\s+5(?![.-]\d)/.test(rate.label));
  const fable51 = rates.find(rate => rate.label.includes('fable 5.1'));
  const sonnet5 = rates.find(rate => rate.label.includes('sonnet 5'));
  const sonnet = rates.find(rate => rate.label.includes('sonnet 4.6'));
  const opus45 = rates.find(rate => rate.label.includes('opus 4.5'));
  const sonnet45 = rates.find(rate => rate.label.includes('sonnet 4.5'));
  const haiku = rates.find(rate => rate.label.includes('haiku 4.5'));
  return [
    rateModel('anthropic', 'claude-fable-5', fable5, 'anthropic'),
    rateModel('anthropic', 'claude-fable-5.1', fable51, 'anthropic', 'official-page', null, 'First-party Claude Fable 5.1 pricing; cache write defaults to 5-minute prompt caching.'),
    rateModel('anthropic', 'claude-opus-5', opus5, 'anthropic'),
    rateModel('anthropic', 'claude-opus-5-5', opus55, 'anthropic'),
    ...['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6'].map(model => rateModel('anthropic', model, opus, 'anthropic')),
    rateModel('anthropic', 'claude-opus-4-5', opus45, 'anthropic'),
    rateModel('anthropic', 'claude-sonnet-5', sonnet5, 'anthropic'),
    rateModel('anthropic', 'claude-sonnet-4-6', sonnet, 'anthropic'),
    rateModel('anthropic', 'claude-sonnet-4-5', sonnet45, 'anthropic'),
    rateModel('anthropic', 'claude-haiku-4-5', haiku, 'anthropic')
  ].filter(Boolean);
}

function parseAnthropicMythosModels(body) {
  const text = tableText(body).replace(/\|/g, ' ').replace(/\s+/g, ' ');
  const match = text.match(
    /Pricing for Claude Mythos 5\.1 starts at \s*\$\s*([0-9.]+) per million input tokens and \s*\$\s*([0-9.]+) per million output tokens/i
  );
  if (!match) return [];
  const input = Number(match[1]);
  return [rateModel('anthropic', 'claude-mythos-5.1', {
    input,
    cachedInput: input,
    cacheWrite5m: input,
    cacheWrite1h: input,
    output: Number(match[2])
  }, 'anthropic-mythos', 'official-page', null, 'Claude Mythos 5.1 is limited to vetted trusted-access partners; separate prompt-cache rates are not published.')];
}

// xAI 模型卡：逐模型做名称与美元价双向校验，对不上的模型跳过，由 fallback 沿用内置价
const XAI_MODEL_SPECS = [
  { model: 'grok-4.5', label: /grok[\s-]*4\.5/, input: 2, cachedInput: 0.3, output: 6, note: 'xAI Grok 4.5 public model page lists input and output rates; cached-input rate verified against the official models page.' },
  { model: 'grok-4.6', label: /grok[\s-]*4\.6/, input: 2, cachedInput: 0.5, output: 6, note: 'xAI Grok 4.6 public model page rate; cached input is input × 0.25.' },
  { model: 'grok-4.3', label: /grok[\s-]*4\.3/, input: 1.25, cachedInput: 0.2, output: 2.5, note: 'xAI Grok 4.3 public model page rate; cached input is input × 0.1.' },
  { model: 'grok-4.20-0309-reasoning', label: /grok[\s-]*4\.20[\s\S]{0,60}reasoning/, input: 1.25, cachedInput: 0.2, output: 2.5, note: 'xAI Grok 4.20 reasoning (0309 release) public model page rate; cached input is input × 0.1.' },
  { model: 'grok-4.20-0309-non-reasoning', label: /grok[\s-]*4\.20[\s\S]{0,60}non-reasoning/, input: 1.25, cachedInput: 0.2, output: 2.5, note: 'xAI Grok 4.20 non-reasoning (0309 release) public model page rate; cached input is input × 0.1.' },
  { model: 'grok-4.20-0309-multi-agent-0309', label: /grok[\s-]*4\.20[\s\S]{0,60}multi-agent/, input: 1.25, cachedInput: 0.2, output: 2.5, note: 'xAI Grok 4.20 multi-agent (0309 release) public model page rate; cached input is input × 0.1.' },
  { model: 'grok-build-0.1', label: /grok[\s-]*build/, input: 1, cachedInput: 0.2, output: 2, note: 'xAI Grok Build public model page rate; cached input is input × 0.1.' }
];

function parseXaiModels(body) {
  const text = tableText(body).toLowerCase();
  if (!XAI_MODEL_SPECS.some(({ label }) => label.test(text))) return [];
  return XAI_MODEL_SPECS
    .filter(spec => spec.label.test(text) && mentionsUsdPrice(text, spec.input) && mentionsUsdPrice(text, spec.output))
    .map(spec => rateModel('xai', spec.model, {
      input: spec.input,
      cachedInput: spec.cachedInput,
      cacheWrite5m: spec.input,
      cacheWrite1h: spec.input,
      output: spec.output
    }, 'xai', 'official-page', null, spec.note));
}

function parseDeepSeekModels(body) {
  const text = tableText(body);
  if (!/deepseek-flash/i.test(text) || !/deepseek-v4\.1-flash/i.test(text)) return [];
  const hit = deepSeekPeakRates(text, 'CACHE HIT');
  const miss = deepSeekPeakRates(text, 'CACHE MISS');
  const output = deepSeekPeakRates(text, '1M OUTPUT TOKENS');
  if (!hit || !miss || !output) return [];
  return [
    rateModel('deepseek', 'deepseek-flash', {
      cachedInput: hit[0],
      input: miss[0],
      output: output[0],
      cacheWrite5m: miss[0],
      cacheWrite1h: miss[0]
    }, 'deepseek', 'official-page', null, 'DeepSeek-V4.1-Flash uses the deepseek-flash API name. Peak rates are used because historical collection records do not contain the provider billing window; off-peak rates are half of these values.'),
    rateModel('deepseek', 'deepseek-v4-pro', {
      cachedInput: hit[1],
      input: miss[1],
      output: output[1],
      cacheWrite5m: miss[1],
      cacheWrite1h: miss[1]
    }, 'deepseek')
  ].filter(Boolean);
}

function deepSeekPeakRates(text, label) {
  const start = text.indexOf(label);
  if (start < 0) return null;
  const next = text.indexOf('1M ', start + label.length);
  const values = Array.from(
    text.slice(start, next < 0 ? undefined : next).matchAll(/\$([0-9.]+)/g),
    match => Number(match[1])
  );
  if (values.length >= 4) return [values[2], values[3]];
  if (values.length >= 2) return [values[0], values[1]];
  return null;
}

function parseZaiModels(body, exchangeRate) {
  const pairs = [
    ['glm-5.3', 'GLM-5.3'],
    ['glm-5.3-flash', 'GLM-5.3-Flash'],
    ['glm-5.3-flashx', 'GLM-5.3-FlashX'],
    ['glm-5.2', 'GLM-5.2'],
    ['glm-5.1', 'GLM-5.1'],
    ['glm-5v-turbo', 'GLM-5V-Turbo'],
    ['glm-4.6v', 'GLM-4.6V'],
    ['glm-4.6v-flashx', 'GLM-4.6V-FlashX'],
    ['glm-4.6v-flash', 'GLM-4.6V-Flash'],
    ['glm-4.5v', 'GLM-4.5V'],
    ['glm-5-turbo', 'GLM-5-Turbo'],
    ['glm-5', 'GLM-5'],
    ['glm-4.7', 'GLM-4.7'],
    ['glm-4.5-air', 'GLM-4.5-Air'],
    ['glm-4.7-flashx', 'GLM-4.7-FlashX'],
    ['glm-4.7-flash', 'GLM-4.7-Flash']
  ];
  return pairs.map(([model, label]) => {
    const block = modelBlock(body, label);
    // 页面暂缺的模型沿用内置现价，避免刷新因条目数校验失败而中断
    if (!block) return carriedRateModel(model, exchangeRate);
    const baselineCny = OFFICIAL_PRICE_TABLE.find(row => row.provider === 'Zhipu GLM' && row.model === model)?.officialRatesPerMTok?.ratesPerMTok;
    const input = lastPriceValue(block, 'inPrice', baselineCny?.input);
    const output = lastPriceValue(block, 'outPrice', baselineCny?.output);
    const cachedInput = lastPriceValue(block, 'hit', baselineCny?.cachedInput);
    if (input == null || output == null) return null;
    return rateModel('Zhipu GLM', model, cnyToUsdRates({
      input,
      output,
      cachedInput,
      cacheWrite5m: input,
      cacheWrite1h: input
    }, exchangeRate), 'Zhipu GLM', 'official-page-asset', {
      currency: 'CNY',
      unit: '1M tokens',
      ratesPerMTok: {
        input,
        output,
        cachedInput: cachedInput ?? input,
        cacheWrite5m: input,
        cacheWrite1h: input
      },
      exchangeRate: exchangeRate.rate,
      sourceUnit: '元 / 1M tokens'
    });
  }).filter(Boolean);
}

// 价格数组不带档位标注，可能按 [促销, 标准] 或 [短上下文, 长上下文] 排列，固定取末位会错档：
// 优先取与内置表当前 CNY 价相等的档位（沿用现价），对不上再取末位（真调价时进 diff 人工核对）
function lastPriceValue(block, field, baselineCny) {
  const array = block.match(new RegExp(`${field}:\\[([^\\]]*)\\]`))?.[1];
  if (!array) return null;
  const values = (array.match(/"([^"]*)"/g) || [])
    .map(value => cnyPriceFromValue(value.replace(/"/g, '')))
    .filter(value => value != null);
  if (!values.length) return null;
  if (baselineCny != null && values.includes(baselineCny)) return baselineCny;
  return values[values.length - 1];
}

function cnyPriceFromValue(value) {
  if (!value || value.includes('免费')) return 0;
  const number = Number(value.match(/[0-9.]+/)?.[0]);
  return Number.isFinite(number) ? number : null;
}

function carriedRateModel(model, exchangeRate) {
  const baseline = OFFICIAL_PRICE_TABLE.find(row => row.provider === 'Zhipu GLM' && row.model === model);
  if (!baseline?.ratesPerMTok) return null;
  // 页面下架的模型沿用内置 CNY 原价并按当前汇率重算 USD，保留官方价溯源
  const officialRates = baseline.officialRatesPerMTok;
  const cnyRates = officialRates?.currency === 'CNY' ? officialRates.ratesPerMTok : null;
  const ratesPerMTok = cnyRates && cnyRates.input != null && cnyRates.output != null
    ? cnyToUsdRates({ ...cnyRates, input: cnyRates.input, output: cnyRates.output } as ParsedRates, exchangeRate)
    : baseline.ratesPerMTok;
  if (!ratesPerMTok) return null;
  return rateModel('Zhipu GLM', model, ratesPerMTok, 'Zhipu GLM', 'baseline-carried', officialRates
    ? { ...officialRates, exchangeRate: exchangeRate.rate }
    : null);
}

function parseVolcengineModels(body, exchangeRate) {
  const normalized = body.replace(/\\u002F/g, '/').replace(/\\"/g, '"');
  const pairs = [
    ['doubao-seed-evolving', 'Doubao_Seed_Evolving'],
    ['doubao-seed-2.1-pro', 'Doubao_Seed_2.1_pro'],
    ['doubao-seed-2.1-turbo', 'Doubao_Seed_2.1_turbo'],
    ['doubao-seed-2.0-lite', 'Doubao_Seed_2.0_Lite'],
    ['doubao-seed-2.0-code', 'Doubao_Seed_2.0_code'],
    ['doubao-seed-2.0-pro', 'Doubao_Seed_2.0_pro'],
    ['doubao-seed-2.0-mini', 'Doubao_Seed_2.0_mini']
  ];
  return pairs.map(([model, label]) => {
    // 接口响应本身是合法 JSON，其 DiscountInfo 含转义引号，反斜杠还原会把 JSON 改坏导致整源解析失败
    const apiRates = volcengineApiInferenceRates(body, label);
    const rates = apiRates || volcengineInferenceRates(normalized, label);
    if (!rates) return null;
    const cacheWriteRate = apiRates ? 0 : rates.input;
    return rateModel('DoubaoSeed', model, cnyToUsdRates({
      ...rates,
      cachedInput: rates.cachedInput ?? rates.input,
      cacheWrite5m: cacheWriteRate,
      cacheWrite1h: cacheWriteRate
    }, exchangeRate), 'DoubaoSeed', apiRates ? 'official-api' : 'official-page-asset', {
      currency: 'CNY',
      unit: '1M tokens',
      ratesPerMTok: {
        ...rates,
        cachedInput: rates.cachedInput ?? rates.input,
        cacheWrite5m: cacheWriteRate,
        cacheWrite1h: cacheWriteRate
      },
      exchangeRate: exchangeRate.rate,
      sourceUnit: '元 / 1M tokens'
    });
  }).filter(Boolean);
}

function volcengineApiInferenceRates(body, configurationCode): ParsedRates | null {
  try {
    const rows = parseVolcenginePricingResponse(body)?.Result?.TableList
      ?.flatMap(table => table?.Rows || [])
      .filter(row => String(row?.ConfigurationCode || '').toLowerCase() === configurationCode.toLowerCase()) || [];
    // 2.0 系列的接口价按 32K/128K/256K 分档，取最低档作为基准价，长上下文档位不做区分
    const baseTierRows = /^doubao_seed_2\.0_(lite|code|pro|mini)$/i.test(configurationCode)
      ? rows.filter(row => /_32k_/i.test(String(row?.ChargeItemCode || '')))
      : rows;
    const input = volcengineApiPrice(baseTierRows, 'infer_input_');
    const output = volcengineApiPrice(baseTierRows, 'infer_output_');
    const cachedInput = volcengineApiPrice(baseTierRows, 'infer_kvcache_hit_');
    if (input == null || output == null) return null;
    return {
      input: input * 1000,
      output: output * 1000,
      ...(cachedInput == null ? {} : { cachedInput: cachedInput * 1000 })
    };
  } catch {
    return null;
  }
}

function parseVolcenginePricingResponse(body) {
  try {
    return JSON.parse(body);
  } catch {
    const start = body.lastIndexOf('\n{"ResponseMetadata"');
    return start < 0 ? null : JSON.parse(body.slice(start + 1));
  }
}

function volcengineApiPrice(rows, chargeKind) {
  const row = rows.find(item => {
    const code = String(item?.ChargeItemCode || '').toLowerCase();
    return code.includes(chargeKind) && !code.includes('(batch)');
  });
  const amount = Number(row?.PriceInfoList?.[0]?.OriginalAmount ?? row?.PriceInfoList?.[0]?.Price);
  return Number.isFinite(amount) ? amount : null;
}

function parseGeminiModels(body) {
  const models = [
    ['gemini-3.8-flash', 'gemini-3.8-flash', 0],
    ['gemini-3.7-flash', 'gemini-3.7-flash', 0],
    ['gemini-3.6-flash', 'gemini-3.6-flash', 0],
    ['gemini-3.5-flash', 'gemini-3.5-flash', 0],
    ['gemini-3.5-flash-lite', 'gemini-3.5-flash-lite', 0],
    ['gemini-2.5-flash-lite', 'gemini-2.5-flash-lite', 0],
    ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite', 0],
    ['gemini-3.1-pro-preview', 'gemini-3.1-pro-preview', 0],
    ['gemini-2.5-flash', 'gemini-2.5-flash', 0],
    ['gemini-2.5-pro', 'gemini-2.5-pro', 0],
    ['gemini-2.5-pro-long-context', 'gemini-2.5-pro', 1]
  ];
  return models.map(([model, sourceModel, tier]) => {
    const rows = geminiStandardPricingRows(body, sourceModel);
    if (rows.length < 3) return null;
    const input = usdAmounts(rows[0])[tier];
    const output = usdAmounts(rows[1])[tier];
    const cachedInput = usdAmounts(rows[2])[tier];
    if (![input, output, cachedInput].every(isFiniteRate)) return null;
    return rateModel('Gemini', model, {
      input,
      cachedInput,
      cacheWrite5m: input,
      cacheWrite1h: input,
      output
    }, 'Gemini');
  }).filter(Boolean);
}

function geminiStandardPricingRows(body, model) {
  const marker = new RegExp(`<code[^>]*>\\s*${escapeRegex(model)}[\\s\\S]*?<\\/code>`, 'i').exec(body);
  if (!marker) return [];
  const nextModel = body.indexOf('<div class="models-section"', marker.index + marker[0].length);
  const sectionStart = body.indexOf('<section ', marker.index + marker[0].length);
  if (sectionStart < 0 || (nextModel >= 0 && sectionStart > nextModel)) return [];
  const sectionEnd = body.indexOf('</section>', sectionStart);
  const tableStart = body.indexOf('<table class="pricing-table"', sectionStart);
  if (sectionEnd < 0 || tableStart < 0 || tableStart > sectionEnd) return [];
  const tableEnd = body.indexOf('</table>', tableStart);
  if (tableEnd < 0 || tableEnd > sectionEnd) return [];
  const tbody = body.slice(tableStart, tableEnd).match(/<tbody>([\s\S]*?)<\/tbody>/i)?.[1] || '';
  return Array.from(tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi), match => match[1]);
}

function usdAmounts(value) {
  return Array.from(
    value.matchAll(/(?:\$\s*([0-9]+(?:\.[0-9]+)?)|([0-9]+(?:\.[0-9]+)?)\s*(?:USD|美元))/gi),
    match => Number(match[1] ?? match[2])
  );
}

function parseKimiModels(body, exchangeRate) {
  const rows = Array.from(
    body.matchAll(/\["(kimi-(?:k3|k2\.(?:7-code(?:-highspeed)?|6|5)))",\s*"1M tokens",\s*"¥([0-9.]+)",\s*"¥([0-9.]+)",\s*"¥([0-9.]+)"/g),
    match => ({
      model: match[1],
      cachedInput: Number(match[2]),
      input: Number(match[3]),
      output: Number(match[4])
    })
  );
  return rows.map(row => rateModel('Kimi', row.model, cnyToUsdRates({
    input: row.input,
    cachedInput: row.cachedInput,
    cacheWrite5m: row.input,
    cacheWrite1h: row.input,
    output: row.output
  }, exchangeRate), 'Kimi', 'official-page-asset', {
    currency: 'CNY',
    unit: '1M tokens',
    ratesPerMTok: {
      input: row.input,
      cachedInput: row.cachedInput,
      cacheWrite5m: row.input,
      cacheWrite1h: row.input,
      output: row.output
    },
    exchangeRate: exchangeRate.rate,
    sourceUnit: '元 / 1M tokens'
  }, 'Official Kimi API CNY rate parsed from the current model pricing pages.')).filter(Boolean);
}

function parseTencentHunyuanModels(body, exchangeRate) {
  const text = tableText(body);
  const models: Array<[string, RegExp]> = [
    ['hy3', /Hy3/i],
    ['hy4-preview', /Hy4\s*-?\s*Preview/i]
  ];
  return models.map(([model, label]) => {
    const match = text.match(new RegExp(
      `${label.source}\\s*\\|+\\s*-\\s*\\|+\\s*-\\s*\\|+\\s*([0-9]+(?:\\.[0-9]+)?)\\s*\\|+\\s*([0-9]+(?:\\.[0-9]+)?)\\s*\\|+\\s*([0-9]+(?:\\.[0-9]+)?)`,
      'i'
    ));
    if (!match) return null;
    const [input, output, cachedInput] = match.slice(1).map(Number);
    const cnyRates = { input, output, cachedInput, cacheWrite5m: input, cacheWrite1h: input };
    const rates = cnyToUsdRates(cnyRates, exchangeRate);
    if (!rates) return null;
    return rateModel('Tencent Hunyuan', model, rates, 'Tencent Hunyuan', 'official-page', {
      currency: 'CNY',
      unit: '1M tokens',
      ratesPerMTok: cnyRates,
      exchangeRate: exchangeRate.rate,
      sourceUnit: '元 / 1M tokens'
    }, `Official Tencent TokenHub ${model} RMB rate converted to USD at the last verified refresh rate.`);
  }).filter(Boolean);
}

function parseQwenModels(body, exchangeRate) {
  const pairs = [
    ['qwen3.8', 'qwen3.8-max'],
    ['qwen3.8-flash', 'qwen3.8-flash'],
    ['qwen3.7-plus', 'qwen3.7-plus'],
    ['qwen3.7-max', 'qwen3.7-max'],
    ['qwen3.6-flash', 'qwen3.6-flash'],
    ['qwen3-coder-plus', 'qwen3-coder-plus'],
    ['qwen3-coder-flash', 'qwen3-coder-flash'],
    ['qwen-coder-plus', 'qwen-coder-plus'],
    ['qwen-coder-turbo', 'qwen-coder-turbo']
  ];
  const qwenModels = pairs
    .map(([model, label]) => {
      const rates = qwenRates(body, label);
      if (!rates) return null;
      return rateModel('Qwen', model, cnyToUsdRates({
        ...rates,
        cachedInput: rates.input,
        cacheWrite5m: rates.input,
        cacheWrite1h: rates.input
      }, exchangeRate), 'Qwen', 'official-page', {
        currency: 'CNY',
        unit: '1M tokens',
        ratesPerMTok: {
          ...rates,
          cachedInput: rates.input,
          cacheWrite5m: rates.input,
          cacheWrite1h: rates.input
        },
        exchangeRate: exchangeRate.rate,
        sourceUnit: '元 / 1M tokens'
      });
    })
    .filter(Boolean);
  const miniMaxRates = qwenRates(body, 'MiniMax/MiniMax-M3');
  if (!miniMaxRates) return qwenModels;

  return [
    ...qwenModels,
    rateModel('MiniMax', 'minimax-m3', cnyToUsdRates({
      ...miniMaxRates,
      cachedInput: miniMaxRates.input,
      cacheWrite5m: miniMaxRates.input,
      cacheWrite1h: miniMaxRates.input
    }, exchangeRate), 'Qwen', 'official-page', {
      currency: 'CNY',
      unit: '1M tokens',
      ratesPerMTok: {
        ...miniMaxRates,
        cachedInput: miniMaxRates.input,
        cacheWrite5m: miniMaxRates.input,
        cacheWrite1h: miniMaxRates.input
      },
      exchangeRate: exchangeRate.rate,
      sourceUnit: '元 / 1M tokens'
    }, 'Official Alibaba Cloud Model Studio rate for MiniMax-M3. This does not represent a direct MiniMax API price.')
  ];
}

function qwenRates(body, label): ParsedRates | null {
  const start = body.indexOf(`>${label}<`);
  if (start < 0) return null;
  const segment = body.slice(start, start + 5000);
  const text = tableText(segment);
  const prices = Array.from(text.matchAll(/([0-9]+(?:\.[0-9]+)?)\|+\s*元/g), match => Number(match[1]));
  if (prices.length < 2) return null;
  return {
    input: prices[0],
    output: prices[1]
  };
}

function volcengineInferenceRates(body, label): ParsedRates | null {
  const input = volcenginePriceFor(body, label, 'infer-prompt');
  const output = volcenginePriceFor(body, label, 'infer-completion');
  if (input == null || output == null) return null;
  return {
    input: input * 1000,
    output: output * 1000
  };
}

function volcenginePriceFor(body, label, chargeKind) {
  const escaped = escapeRegExp(label);
  const pattern = new RegExp(
    `"ConfigurationCode":"${escaped}"[^}]*"ChargeItemCode":"${escaped}-${chargeKind}[^"]*"[^}]*"Unit":"千tokens"[^}]*?(?:"Price"|"price"|"DefaultPrice"|"SalePrice")\\s*:?\\s*"?([0-9.]+)"?`,
    'i'
  );
  const match = body.match(pattern);
  return match ? Number(match[1]) : null;
}

// 新版计价页同一行用「、」聚合多个型号并带 (to be deprecated) 标记，按 <tr> 行解析可避免型号前缀误配与正文误命中
function parseXiaomiModels(body, { provider, sourceProvider, models, startMarker = 'Overseas Pricing of the Model' }) {
  const segment = startMarker ? body.slice(Math.max(0, body.indexOf(startMarker))) : body;
  const rows = Array.from(segment.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi), match => match[1])
    .map(row => {
      const cellText = row.replace(/<[^>]+>/g, '|').replace(/\s+/g, ' ');
      const prices = Array.from(cellText.matchAll(/\$\s*([0-9]+(?:\.[0-9]+)?)/g), m => Number(m[1]));
      const modelNames = Array.from(cellText.matchAll(/(mimo-[a-z0-9](?:[a-z0-9.-]*)?)/gi), m => m[1].toLowerCase());
      return { modelNames, prices };
    })
    .filter(row => row.prices.length === 3 && row.modelNames.length > 0);
  return models.map(model => {
    const hit = rows.find(row => row.modelNames.includes(model));
    if (!hit) return null;
    return rateModel(provider, model, {
      cachedInput: hit.prices[0],
      input: hit.prices[1],
      output: hit.prices[2],
      cacheWrite5m: hit.prices[1],
      cacheWrite1h: hit.prices[1]
    }, sourceProvider, 'official-page');
  }).filter(Boolean);
}

function rateModel(provider, model, rates: ParsedRates, sourceProvider, pricingFetchStatus = 'official-page', officialRatesPerMTok = null, note = null) {
  if (!rates || !isFiniteRate(rates.input) || !isFiniteRate(rates.output)) return null;
  const ratesPerMTok: ParsedRates = {
    input: rates.input,
    cachedInput: isFiniteRate(rates.cachedInput) ? rates.cachedInput : rates.input,
    output: rates.output
  };
  if (isFiniteRate(rates.cacheWrite5m)) ratesPerMTok.cacheWrite5m = rates.cacheWrite5m;
  if (isFiniteRate(rates.cacheWrite1h)) ratesPerMTok.cacheWrite1h = rates.cacheWrite1h;
  const row: Record<string, unknown> = {
    provider,
    model,
    aliases: [model],
    priced: true,
    unavailableReason: null,
    ratesPerMTok,
    officialRatesPerMTok,
    pricingFetchStatus,
    sourceProvider
  };
  if (note) row.note = note;
  return row;
}

function modelBlock(body, label) {
  const start = body.indexOf(`name:"${label}"`);
  if (start < 0) return null;
  const next = body.indexOf('{name:', start + label.length + 8);
  return body.slice(start, next > start ? next : start + 1200);
}

function cnyPrice(block, pattern) {
  return cnyPriceFromValue(block.match(pattern)?.[1]);
}

function cnyToUsdRates(rates: ParsedRates, exchangeRate): ParsedRates | null {
  const divisor = Number(exchangeRate?.rate || 0);
  if (!Number.isFinite(divisor) || divisor <= 0) return null;
  return {
    input: rates.input / divisor,
    output: rates.output / divisor,
    ...(rates.cachedInput == null ? {} : { cachedInput: rates.cachedInput / divisor }),
    ...(rates.cacheWrite5m == null ? {} : { cacheWrite5m: rates.cacheWrite5m / divisor }),
    ...(rates.cacheWrite1h == null ? {} : { cacheWrite1h: rates.cacheWrite1h / divisor })
  };
}

function tableText(body) {
  return body.replace(/<[^>]+>/g, '|').replace(/\s+/g, ' ');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pricingKey(row) {
  return `${providerKey(row.provider)}::${String(row.model || '').toLowerCase().replace(/(?<=\d)\.(?=\d)/g, '-')}`;
}

function sameFetchedPricing(left, right) {
  return JSON.stringify({
    provider: providerKey(left.provider),
    model: pricingKey(left),
    ratesPerMTok: left.ratesPerMTok || null,
    officialRatesPerMTok: left.officialRatesPerMTok || null,
    priced: left.priced,
    unavailableReason: left.unavailableReason || null
  }) === JSON.stringify({
    provider: providerKey(right.provider),
    model: pricingKey(right),
    ratesPerMTok: right.ratesPerMTok || null,
    officialRatesPerMTok: right.officialRatesPerMTok || null,
    priced: right.priced,
    unavailableReason: right.unavailableReason || null
  });
}

function isZhipuSource(source) {
  return providerKey(source?.provider) === 'zhipu glm';
}

function isTencentHunyuanSource(source) {
  return providerKey(source?.provider) === 'tencent hunyuan';
}

function isDoubaoSource(source) {
  return providerKey(source?.provider) === 'doubaoseed';
}

function isQwenSource(source) {
  return providerKey(source?.provider) === 'qwen';
}

function isOpenAiGpt56Source(source) {
  return providerKey(source?.provider) === 'openai gpt 5.6';
}

function isOpenAiGpt6AstraSource(source) {
  return providerKey(source?.provider) === 'openai gpt 6 astra';
}

function providerKey(provider) {
  const normalized = String(provider || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (['zai', 'z ai', 'zhipu', 'zhipu ai', 'zhipu glm', 'bigmodel'].includes(normalized)) return 'zhipu glm';
  if (['volcengine', 'volc engine', 'ark', 'doubao', 'doubao seed', 'doubaoseed', 'bytedance'].includes(normalized)) return 'doubaoseed';
  if (['qwen', 'tongyi', 'tongyi qianwen', 'aliyun', 'alibaba', 'alibaba cloud', 'dashscope', 'model studio'].includes(normalized)) return 'qwen';
  return normalized;
}

function isFiniteRate(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0;
}

function absoluteUrl(value, baseUrl) {
  if (value.startsWith('//')) return `https:${value}`;
  if (/^(static|js|css)\//.test(value)) return new URL(`/${value}`, baseUrl).toString();
  return new URL(value, baseUrl).toString();
}
