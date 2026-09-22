import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pricingCache from '../data/official-pricing.json' with { type: 'json' };
import {
  attachOfficialPricing,
  calculateCost,
  calculateOfficialCost,
  loadPricing,
  OFFICIAL_PRICE_TABLE,
  resolveOfficialPricing,
  serializeOfficialPricingModels,
  validateOfficialPricingRefresh
} from '../src/pricing.ts';

test('calculates official cost from supplied pricing data', () => {
  const pricingData = {
    models: [{
      provider: 'Fixture Provider',
      model: 'fixture-standard',
      aliases: ['fixture-standard', 'fixture-standard-alias'],
      priced: true,
      ratesPerMTok: {
        input: 2,
        cachedInput: 0.25,
        cacheWrite5m: 2.5,
        cacheWrite1h: 2.5,
        output: 4
      },
      sourceProvider: 'Fixture Provider'
    }, {
      provider: 'anthropic',
      model: 'fixture-anthropic',
      aliases: ['fixture-anthropic'],
      priced: true,
      ratesPerMTok: {
        input: 1,
        cachedInput: 0.1,
        cacheWrite5m: 3,
        cacheWrite1h: 6,
        output: 5
      },
      sourceProvider: 'anthropic'
    }]
  };
  const standard = calculateOfficialCost('fixture-standard-alias', {
    input: 2_000_000,
    cacheRead: 500_000,
    cacheWrite: 250_000,
    output: 3_000_000
  }, { pricingData });
  const anthropicHour = calculateOfficialCost('fixture-anthropic', {
    cacheWrite: 1_000_000
  }, { pricingData, anthropicCacheWriteTtl: '1h' });
  const attached = attachOfficialPricing({
    model: 'fixture-standard',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 500_000,
    cachedInputTokens: 500_000
  }, 'fixture-standard', null, pricingData);

  assert.equal(standard.priced, true);
  assert.equal(standard.provider, 'Fixture Provider');
  assert.equal(standard.resolvedModel, 'fixture-standard');
  assert.equal(standard.totalUSD, 16.75);
  assert.equal(anthropicHour.totalUSD, 6);
  assert.equal(attached.costUSD, 6.25);
  assert.equal(attached.pricingStatus, 'priced');
});

test('recognizes refreshed OpenAI GPT-5.6 models and aliases', () => {
  const sol = calculateOfficialCost('openai/gpt-5.6-sol', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
    output: 1_000_000
  });
  const terra = calculateOfficialCost('gpt-5-6-terra', {
    input: 1_000_000,
    output: 1_000_000
  });
  const luna = calculateOfficialCost('gpt-5.6-luna', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
    output: 1_000_000
  });

  assert.equal(sol.priced, true);
  assert.equal(sol.provider, 'openai');
  assert.equal(sol.resolvedModel, 'gpt-5.6-sol');
  assert.equal(terra.priced, true);
  assert.equal(terra.resolvedModel, 'gpt-5.6-terra');
  assert.equal(luna.priced, true);
  assert.equal(luna.resolvedModel, 'gpt-5.6-luna');
});

test('calculates the official GPT-6 Astra API rate', () => {
  const astra = calculateOfficialCost('openai/gpt-6-astra', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
    output: 1_000_000
  });

  assert.equal(astra.priced, true);
  assert.equal(astra.resolvedModel, 'gpt-6-astra');
  assert.equal(astra.totalUSD, 73.5);
});

test('keeps normalized official pricing aliases unique', () => {
  for (const rate of OFFICIAL_PRICE_TABLE) {
    assert.equal(new Set(rate.aliases).size, rate.aliases.length, rate.model);
  }
});

test('bundled pricing table passes refresh validation', () => {
  assert.doesNotThrow(() => validateOfficialPricingRefresh(serializeOfficialPricingModels()));
});

test('bundled pricing cache matches the built-in table', () => {
  const cachedByKey = new Map(pricingCache.models.map(model => [`${model.provider}::${model.model}`, model]));

  assert.equal(pricingCache.models.length, OFFICIAL_PRICE_TABLE.length);
  for (const rate of OFFICIAL_PRICE_TABLE) {
    const cached = cachedByKey.get(`${rate.provider}::${rate.model}`);
    assert.ok(cached, rate.model);
    assert.equal(cached.priced, rate.priced, rate.model);
    assert.deepEqual(cached.aliases, rate.aliases, rate.model);
    assert.deepEqual(cached.ratesPerMTok, rate.ratesPerMTok, rate.model);
    assert.deepEqual(cached.officialRatesPerMTok, rate.officialRatesPerMTok, rate.model);
  }
});

test('rejects invalid pricing refresh data', () => {
  const baseline = [{
    provider: 'Fixture Provider',
    model: 'fixture-cny',
    aliases: ['fixture-cny'],
    priced: true,
    unavailableReason: null,
    ratesPerMTok: {
      input: 1,
      cachedInput: 0.25,
      cacheWrite5m: 1,
      cacheWrite1h: 1,
      output: 2
    },
    source: null,
    note: null
  }];
  const refreshed = [{
    provider: 'Fixture Provider',
    model: 'fixture-cny',
    aliases: ['fixture-cny'],
    priced: true,
    ratesPerMTok: {
      input: 1,
      cachedInput: 0.25,
      cacheWrite5m: 1,
      cacheWrite1h: 1,
      output: 2
    },
    officialRatesPerMTok: {
      currency: 'CNY',
      unit: '1M tokens',
      ratesPerMTok: {
        input: 7,
        cachedInput: 1.75,
        cacheWrite5m: 7,
        cacheWrite1h: 7,
        output: 14
      },
      exchangeRate: 7
    }
  }];

  assert.doesNotThrow(() => validateOfficialPricingRefresh(refreshed, baseline));
  assert.throws(() => validateOfficialPricingRefresh([{
    ...refreshed[0],
    ratesPerMTok: { ...refreshed[0].ratesPerMTok, output: 3 }
  }], baseline), /inconsistent CNY conversion/);
  assert.throws(() => validateOfficialPricingRefresh([{
    ...refreshed[0],
    aliases: ['fixture-cny', 'fixture-cny']
  }], baseline), /invalid aliases/);
  assert.throws(() => validateOfficialPricingRefresh([{
    ...refreshed[0],
    ratesPerMTok: { ...refreshed[0].ratesPerMTok, input: -1 }
  }], baseline), /invalid input rate/);
  assert.doesNotThrow(() => validateOfficialPricingRefresh([{
    ...refreshed[0],
    model: 'fixture-newly-priced',
    aliases: ['fixture-newly-priced']
  }], [{
    ...baseline[0],
    model: 'fixture-newly-priced',
    aliases: ['fixture-newly-priced'],
    priced: false,
    unavailableReason: 'No published rate.',
    ratesPerMTok: null
  }]));
  assert.throws(() => validateOfficialPricingRefresh([], baseline), /model count changed/);
});

test('calculates Gemini API USD price from official rates', () => {
  for (const model of [
    'google/gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro-preview-customtools',
    'gemini-2.5-flash',
    'google/gemini-2.5-pro',
    'gemini-2.5-pro-long-context'
  ]) {
    const cost = calculateOfficialCost(model, {
      input: 1_000_000,
      cacheRead: 1_000_000,
      output: 1_000_000
    });
    assert.equal(cost.priced, true, model);
    assert.equal(cost.provider, 'Gemini', model);
  }
});

test('keeps historical DeepSeek V4 Flash pricing separate from V4.1 Flash', () => {
  const cost = calculateOfficialCost('DeepSeek V4.1 Flash', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000
  });
  const retired = calculateOfficialCost('deepseek-v4-flash-0731', { input: 1_000_000 });

  assert.equal(cost.priced, true);
  assert.equal(cost.provider, 'deepseek');
  assert.equal(cost.resolvedModel, 'deepseek-flash');
  assert.equal(cost.totalUSD, 1.506);
  assert.equal(retired.resolvedModel, 'deepseek-v4-flash');
  assert.equal(retired.totalUSD, 0.14);
});

test('prices GLM-5.3 and GLM-5.3-Flash from current official RMB rates', () => {
  const glm53 = calculateOfficialCost('glm-5.3', {
    input: 1_000_000,
    output: 1_000_000
  });
  const flash = calculateOfficialCost('GLM-5.3-Flash', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000
  });
  const rate = OFFICIAL_PRICE_TABLE.find(item => item.model === 'glm-5.3');
  const flashRate = OFFICIAL_PRICE_TABLE.find(item => item.model === 'glm-5.3-flash');

  assert.ok(rate?.officialRatesPerMTok);
  assert.ok(flashRate?.officialRatesPerMTok);
  assert.equal(glm53.priced, true);
  assert.equal(glm53.provider, 'Zhipu GLM');
  assert.equal(glm53.resolvedModel, 'glm-5.3');
  assert.equal(flash.priced, true);
  assert.equal(flash.resolvedModel, 'glm-5.3-flash');
  assert.equal(flash.model, 'glm-5.3-flash');
  assert.equal(calculateOfficialCost('glm-99-1-flash', {}).model, 'glm-99.1-flash');
  assert.equal(rate.officialRatesPerMTok.currency, 'CNY');

  const exchangeRate = Number(rate.officialRatesPerMTok.exchangeRate);
  const inputRate = Number(rate.officialRatesPerMTok.ratesPerMTok.input);
  const outputRate = Number(rate.officialRatesPerMTok.ratesPerMTok.output);
  const flashRates = flashRate.officialRatesPerMTok.ratesPerMTok;
  assert.ok(Number.isFinite(exchangeRate) && exchangeRate > 0);
  assert.ok(Number.isFinite(inputRate) && Number.isFinite(outputRate));
  assert.ok(Math.abs(glm53.totalUSD - (inputRate + outputRate) / exchangeRate) < 1e-12);
  assert.ok(Math.abs(flash.totalUSD - (
    flashRates.input + flashRates.cachedInput + flashRates.output
  ) / flashRate.officialRatesPerMTok.exchangeRate) < 1e-12);
});

test('prices Hy4 Preview from official Tencent TokenHub rates', () => {
  const cost = calculateOfficialCost('Hy4 Preview', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000
  });
  const rate = OFFICIAL_PRICE_TABLE.find(item => item.model === 'hy4-preview');

  assert.ok(rate?.officialRatesPerMTok);
  assert.equal(cost.priced, true);
  assert.equal(cost.provider, 'Tencent Hunyuan');
  assert.equal(cost.resolvedModel, 'hy4-preview');
  assert.equal(rate.officialRatesPerMTok.currency, 'CNY');

  const { input, cachedInput, output } = rate.officialRatesPerMTok.ratesPerMTok;
  assert.ok(Math.abs(cost.totalUSD - (
    input + cachedInput + output
  ) / rate.officialRatesPerMTok.exchangeRate) < 1e-12);
});

test('resolves current model labels with vendor separators', () => {
  for (const [model, resolvedModel] of [
    ['GLM 5.3 Flash', 'glm-5.3-flash'],
    ['DeepSeek V4 Pro', 'deepseek-v4-pro'],
    ['Doubao Seed Evolving', 'doubao-seed-evolving'],
    ['gpt_5.6_sol', 'gpt-5.6-sol']
  ]) {
    const cost = calculateOfficialCost(model, { input: 1_000_000 });
    assert.equal(cost.priced, true, model);
    assert.equal(cost.resolvedModel, resolvedModel, model);
  }
});

test('calculates GLM-5V-Turbo price from official RMB rates', () => {
  const cost = calculateOfficialCost('GLM-5v-Turbo', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000
  });
  const rate = OFFICIAL_PRICE_TABLE.find(item => item.model === 'glm-5v-turbo');

  assert.ok(rate?.officialRatesPerMTok);
  assert.equal(cost.priced, true);
  assert.equal(cost.provider, 'Zhipu GLM');
  assert.equal(cost.resolvedModel, 'glm-5v-turbo');
  assert.equal(rate.officialRatesPerMTok.currency, 'CNY');
  const { input, cachedInput, output } = rate.officialRatesPerMTok.ratesPerMTok;
  assert.ok(Math.abs(cost.totalUSD - (input + cachedInput + output) / rate.officialRatesPerMTok.exchangeRate) < 1e-12);
});

test('calculates Tencent TokenHub Hy3 price from official RMB rates', () => {
  const cost = calculateOfficialCost('hunyuan-hy3', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000
  }, { pricingData: pricingCache });
  const rate = pricingCache.models.find(item => item.model === 'hy3');

  assert.ok(rate?.officialRatesPerMTok);
  assert.equal(cost.priced, true);
  assert.equal(cost.provider, 'Tencent Hunyuan');
  assert.equal(cost.resolvedModel, 'hy3');
  assert.equal(rate.officialRatesPerMTok.currency, 'CNY');
  const { input, cachedInput, output } = rate.officialRatesPerMTok.ratesPerMTok;
  assert.ok(Math.abs(cost.totalUSD - (input + cachedInput + output) / rate.officialRatesPerMTok.exchangeRate) < 1e-12);
  assert.equal(calculateOfficialCost('hy3-x', {}, { pricingData: pricingCache }).resolvedModel, 'hy3');
});

test('calculates Alibaba Cloud official prices for Qwen3.8 and MiniMax-M3', () => {
  for (const expected of [
    { model: 'qwen3.8', provider: 'Qwen' },
    { model: 'minimax-m3', provider: 'MiniMax' }
  ]) {
    const cost = calculateOfficialCost(expected.model, { input: 1_000_000, output: 1_000_000 });
    const rate = OFFICIAL_PRICE_TABLE.find(item => item.model === expected.model);

    assert.ok(rate?.officialRatesPerMTok, expected.model);
    assert.equal(cost.priced, true, expected.model);
    assert.equal(cost.provider, expected.provider, expected.model);
    assert.equal(cost.resolvedModel, expected.model, expected.model);
    assert.equal(cost.source?.provider, 'Qwen', expected.model);
    assert.equal(rate.officialRatesPerMTok.currency, 'CNY', expected.model);
    assert.ok(rate.officialRatesPerMTok.ratesPerMTok.input > 0, expected.model);
    assert.ok(rate.officialRatesPerMTok.ratesPerMTok.output > 0, expected.model);
  }
  assert.equal(resolveOfficialPricing('qwen3.8-max')?.model, 'qwen3.8');
});

test('recognizes other current cross-provider model ids without inventing prices', () => {
  const cases = [
    ['gemini-3.8-flash', 'Gemini'],
    ['gemini-3.7-flash', 'Gemini'],
    ['grok-4.6', 'xai']
  ];
  for (const [model, provider] of cases) {
    const cost = calculateOfficialCost(model, { input: 1_000_000, output: 1_000_000 });
    assert.equal(cost.priced, false, model);
    assert.equal(cost.provider, provider, model);
    assert.equal(cost.resolvedModel, model, model);
    assert.equal(cost.totalUSD, 0, model);
  }
});

test('keeps cached official provenance when a pricing page is temporarily unavailable', () => {
  const byModel = new Map(pricingCache.models.map(row => [row.model, row]));
  for (const model of ['grok-4.5', 'claude-fable-5', 'claude-opus-5']) {
    assert.match(byModel.get(model).pricingFetchStatus, /^(official-page|cached-official-page)$/);
  }
  for (const model of ['gemini-3.5-flash', 'gemini-3.1-pro-preview']) {
    assert.match(byModel.get(model).pricingFetchStatus, /^(official-page|fallback-parse-error|cached-fallback-parse-error)$/);
  }
});

test('calculates Kimi API USD price from official RMB rates', () => {
  for (const model of ['kimi-k3', 'kimi-k2.7-code']) {
    const cost = calculateOfficialCost(model, {
      input: 1_000_000,
      cacheRead: 1_000_000,
      output: 1_000_000
    });
    assert.equal(cost.priced, true, model);
    assert.equal(cost.provider, 'Kimi', model);
  }
  const light = calculateOfficialCost('moonshotai/kimi-k2.5', {
    input: 1_000_000,
    output: 1_000_000
  });

  assert.equal(calculateOfficialCost('kimi-k2-7-code', { input: 1_000_000 }).resolvedModel, 'kimi-k2.7-code');
  assert.equal(calculateOfficialCost('kimi/kimi-k2-5', { input: 1_000_000 }).provider, 'Kimi');
  assert.equal(light.priced, true);
});

test('calculates Qwen API USD price from official RMB rates', () => {
  const coder = calculateOfficialCost('qwen3-coder', {
    input: 1_000_000,
    output: 1_000_000
  }, { provider: 'aliyun' });
  const plus = calculateOfficialCost('tongyi/qwen3.7-plus', {
    input: 1_000_000,
    output: 1_000_000
  });

  assert.equal(coder.priced, true);
  assert.equal(coder.provider, 'Qwen');
  assert.equal(coder.resolvedModel, 'qwen3-coder-plus');
  assert.equal(plus.priced, true);
  assert.equal(plus.provider, 'Qwen');
});

test('calculates Claude prompt-cache costs', () => {
  for (const model of ['anthropic/claude-opus-5-20260728', 'claude-opus-4-7', 'anthropic/claude-sonnet-5']) {
    const cost = calculateOfficialCost(model, {
      input: 1_000_000,
      cacheWrite: 1_000_000,
      cacheRead: 1_000_000,
      output: 1_000_000
    });
    assert.equal(cost.priced, true, model);
    assert.equal(cost.provider, 'anthropic', model);
  }
  const opus5 = calculateOfficialCost('anthropic/claude-opus-5-20260728', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
    output: 1_000_000
  });
  assert.equal(opus5.resolvedModel, 'claude-opus-5');
  assert.equal(opus5.totalUSD, (
    opus5.ratesPerMTok.input
    + opus5.ratesPerMTok.cachedInput
    + opus5.ratesPerMTok.cacheWrite
    + opus5.ratesPerMTok.output
  ));
});

test('prices Claude Fable 5.1 with the official cache read and write rates', () => {
  const grok = calculateOfficialCost('xai/grok-4-5', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
    output: 1_000_000
  });
  const fable = calculateOfficialCost('claude-fable-5.1', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
    output: 1_000_000
  });
  const fableHour = calculateOfficialCost('claude-fable-5.1', {
    cacheWrite: 1_000_000
  }, { anthropicCacheWriteTtl: '1h' });

  assert.equal(grok.priced, true);
  assert.equal(grok.provider, 'xai');
  assert.equal(grok.resolvedModel, 'grok-4.5');
  assert.equal(fable.priced, true);
  assert.equal(fable.provider, 'anthropic');
  assert.equal(fable.resolvedModel, 'claude-fable-5.1');
  assert.equal(fable.ratesPerMTok.cachedInput, 0.25);
  assert.equal(fable.ratesPerMTok.cacheWrite, 12.5);
  assert.equal(fableHour.ratesPerMTok.cacheWrite, 20);
});

test('prices Claude Mythos 5.1 without inventing cache discounts', () => {
  const cost = calculateOfficialCost('anthropic/claude-mythos-5.1', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000
  });

  assert.equal(cost.priced, true);
  assert.equal(cost.resolvedModel, 'claude-mythos-5.1');
  assert.equal(cost.provider, 'anthropic');
  assert.equal(cost.source.url, 'https://www.anthropic.com/claude/mythos');
  assert.equal(cost.ratesPerMTok.cachedInput, 10);
});

test('supports official DeepSeek and Xiaomi cache-hit pricing', () => {
  const deepseek = calculateOfficialCost('deepseek-v4-pro', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000
  });
  const mimo = calculateOfficialCost('mimo-v2.5-pro', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000
  });

  assert.equal(deepseek.priced, true);
  assert.equal(deepseek.provider, 'deepseek');
  assert.equal(mimo.priced, true);
  assert.equal(mimo.provider, 'xiaomi');
});

test('does not invent prices for research-preview or unknown models', () => {
  const spark = calculateOfficialCost('gpt-5.3-codex-spark', {
    input: 1_000_000,
    output: 1_000_000
  });
  const unknown = calculateCost('made-up-model', { input: 1_000_000, output: 1_000_000 });

  assert.equal(spark.priced, false);
  assert.equal(spark.totalUSD, 0);
  assert.match(spark.reason, /research preview/);
  assert.equal(unknown, 0);
});

test('resolves dated provider aliases without falling through to shorter model names', () => {
  assert.equal(resolveOfficialPricing('openai/gpt-5.3-codex-spark').priced, false);
  assert.equal(resolveOfficialPricing('claude-opus-4.7-20260420').model, 'claude-opus-4-7');
  assert.equal(resolveOfficialPricing('GLM 5.3 Flash Plus'), null);
  assert.equal(resolveOfficialPricing('DeepSeek V4 Pro Preview'), null);
});

test('does not let a source provider hint hide explicit model provider pricing', () => {
  const glm = calculateOfficialCost('glm-5.2', {
    input: 1_000_000,
    output: 1_000_000
  }, { provider: 'anthropic' });
  const mimo = calculateOfficialCost('mimo-v2-pro', {
    input: 1_000_000,
    output: 1_000_000
  }, { provider: 'anthropic' });
  const qwen = calculateOfficialCost('qwen3-coder-plus', {
    input: 1_000_000,
    output: 1_000_000
  }, { provider: 'anthropic' });

  assert.equal(glm.priced, true);
  assert.equal(glm.provider, 'Zhipu GLM');
  assert.equal(mimo.priced, true);
  assert.equal(mimo.provider, 'xiaomi');
  assert.equal(qwen.priced, true);
  assert.equal(qwen.provider, 'Qwen');
});

test('prices current DoubaoSeed models without inventing unknown rates', () => {
  const current = calculateOfficialCost('doubao_seed_2_1_pro', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
    output: 1_000_000
  }, { provider: 'DoubaoSeed' });
  const evolving = calculateOfficialCost('doubao_seed_evolving', {
    input: 1_000_000,
    output: 1_000_000
  }, { provider: 'DoubaoSeed' });
  const unknown = calculateOfficialCost('doubao-unlisted-model', {
    input: 1_000_000,
    output: 1_000_000
  }, { provider: 'DoubaoSeed' });

  assert.equal(current.priced, true);
  assert.equal(current.provider, 'DoubaoSeed');
  assert.equal(current.ratesPerMTok.cacheWrite, 0);
  assert.equal(evolving.priced, true);
  assert.equal(evolving.resolvedModel, 'doubao-seed-evolving');
  assert.equal(unknown.priced, false);
  assert.equal(unknown.totalUSD, 0);
});

test('prices gpt-image-2 and Doubao Seed 2.0 Lite from official token rates', () => {
  const image = calculateOfficialCost('gpt_image_2', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000
  }, { pricingData: pricingCache });
  const lite = calculateOfficialCost('doubao_seed_2_0_lite', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000
  }, { provider: 'DoubaoSeed', pricingData: pricingCache });

  assert.equal(image.priced, true);
  assert.equal(image.provider, 'openai');
  assert.equal(image.totalUSD, image.ratesPerMTok.input + image.ratesPerMTok.cachedInput + image.ratesPerMTok.output);
  assert.equal(lite.priced, true);
  assert.equal(lite.provider, 'DoubaoSeed');
  const cachedLite = pricingCache.models.find(model => model.model === 'doubao-seed-2.0-lite');
  assert.ok(cachedLite?.officialRatesPerMTok);
  const { exchangeRate, ratesPerMTok } = cachedLite.officialRatesPerMTok;
  assert.equal(cachedLite.officialRatesPerMTok.currency, 'CNY');
  assert.ok(ratesPerMTok.input > 0);
  assert.ok(ratesPerMTok.cachedInput > 0);
  assert.ok(ratesPerMTok.output > 0);
  assert.ok(Math.abs(lite.ratesPerMTok.input - ratesPerMTok.input / exchangeRate) < 1e-12);
  assert.ok(Math.abs(lite.ratesPerMTok.cachedInput - ratesPerMTok.cachedInput / exchangeRate) < 1e-12);
  assert.ok(Math.abs(lite.ratesPerMTok.output - ratesPerMTok.output / exchangeRate) < 1e-12);
});

test('uses official pricing cache when provided', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'token-work-pricing-'));
  const cachePath = join(dir, 'official-pricing.json');
  await writeFile(cachePath, JSON.stringify({
    mode: 'official-cache',
    verifiedAt: '2026-06-23',
    fetchedAt: '2026-06-23T00:00:00.000Z',
    models: [{
      provider: 'openai',
      model: 'gpt-5.5',
      aliases: ['gpt-5.5'],
      priced: true,
      ratesPerMTok: {
        input: 10,
        cachedInput: 1,
        cacheWrite5m: 10,
        cacheWrite1h: 10,
        output: 40
      },
      sourceProvider: 'openai'
    }, {
      provider: 'Zhipu GLM',
      model: 'glm-4.5-air',
      aliases: ['glm-4.5-air'],
      priced: true,
      ratesPerMTok: {
        input: 1,
        cachedInput: 0.2,
        cacheWrite5m: 1,
        cacheWrite1h: 1,
        output: 2
      },
      officialRatesPerMTok: {
        currency: 'CNY',
        unit: '1M tokens',
        ratesPerMTok: {
          input: 7,
          cachedInput: 1.4,
          output: 14
        },
        exchangeRate: 7
      },
      sourceProvider: 'Zhipu GLM',
      pricingFetchStatus: 'official-page'
    }]
  }), 'utf8');

  const pricingData = await loadPricing(cachePath);
  const official = calculateOfficialCost('gpt-5.5', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000
  }, { pricingData });

  assert.equal(pricingData.mode, 'official-cache');
  assert.equal(official.totalUSD, 51);
  assert.equal(calculateCost('gpt-5.5', { input: 1_000_000 }, pricingData), 10);
  assert.equal(calculateOfficialCost('glm-4.5-air', {
    input: 1_000_000,
    output: 1_000_000
  }, { provider: 'Zhipu GLM', pricingData }).totalUSD, 3);
});

test('prices GLM-5.3-FlashX from the official RMB rate', () => {
  const cost = calculateOfficialCost('GLM-5.3-FlashX', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000
  });
  const rate = OFFICIAL_PRICE_TABLE.find(item => item.model === 'glm-5.3-flashx');

  assert.ok(rate?.officialRatesPerMTok);
  assert.equal(cost.priced, true);
  assert.equal(cost.provider, 'Zhipu GLM');
  assert.equal(cost.resolvedModel, 'glm-5.3-flashx');
  assert.equal(rate.officialRatesPerMTok.currency, 'CNY');
  const { input, cachedInput, output } = rate.officialRatesPerMTok.ratesPerMTok;
  assert.equal(input, 2);
  assert.equal(cachedInput, 0.57);
  assert.equal(output, 7);
  assert.ok(Math.abs(cost.totalUSD - (input + cachedInput + output) / rate.officialRatesPerMTok.exchangeRate) < 1e-12);
  assert.equal(calculateOfficialCost('glm-5-3-flashx', { input: 1_000_000 }).resolvedModel, 'glm-5.3-flashx');
});

test('keeps recorded promo-period GLM-5.3-Flash costs reproducible by usage date', () => {
  const promoRates = {
    input: 0.05946333743333045,
    cachedInput: 0.017095709512082505,
    cacheWrite: 0.05946333743333045,
    output: 0.20812168101665654
  };
  const tokens = {
    input: 10523,
    cacheRead: 128704,
    output: 372
  };
  const historical = calculateOfficialCost('GLM-5.3-Flash', tokens, { usageDate: '2026-09-17' });
  const current = calculateOfficialCost('GLM-5.3-Flash', tokens, { usageDate: '2026-09-18' });
  const undated = calculateOfficialCost('GLM-5.3-Flash', tokens);

  assert.equal(historical.ratesPerMTok.cacheWrite, promoRates.cacheWrite);
  assert.equal(historical.totalUSD,
    promoRates.input * tokens.input / 1_000_000
    + promoRates.cachedInput * tokens.cacheRead / 1_000_000
    + promoRates.output * tokens.output / 1_000_000);
  assert.ok(current.totalUSD > historical.totalUSD);
  // 无日期走主价(随汇率浮动),与当期档只差汇率漂移,容差 1%
  assert.ok(Math.abs(undated.totalUSD - current.totalUSD) / current.totalUSD < 1e-2);
  // 无效日期回退主价
  assert.equal(calculateOfficialCost('GLM-5.3-Flash', tokens, { usageDate: 'unknown' }).totalUSD, undated.totalUSD);
});

test('pricing cache without a schedule inherits the built-in rate schedule', () => {
  const flashRow = pricingCache.models.find(model => model.model === 'glm-5.3-flash');
  assert.ok(flashRow?.rateSchedule?.length === 2);
  const withoutSchedule = { ...flashRow };
  delete withoutSchedule.rateSchedule;
  const tokens = { input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 };
  const historical = calculateOfficialCost('glm-5.3-flash', tokens, {
    pricingData: { models: [withoutSchedule] },
    usageDate: '2026-09-10'
  });

  assert.ok(Math.abs(historical.ratesPerMTok.input - 0.05946333743333045) < 1e-15);
  assert.ok(Math.abs(historical.ratesPerMTok.output - 0.20812168101665654) < 1e-15);
});

test('prices newly released vendor models at their official rates', () => {
  const cases = [
    ['gpt-5.4', 'openai'],
    ['gpt-5.4-nano', 'openai'],
    ['gpt-5.4-pro', 'openai'],
    ['gpt-5.5-pro', 'openai'],
    ['gpt-5.6-cyber', 'openai'],
    ['gpt-image-2.5-sunburst', 'openai'],
    ['gpt-image-2.5-flare', 'openai'],
    ['grok-4.3', 'xai'],
    ['grok-4.20-0309-reasoning', 'xai'],
    ['grok-4.20-0309-non-reasoning', 'xai'],
    ['grok-4.20-0309-multi-agent-0309', 'xai'],
    ['grok-build-0.1', 'xai'],
    ['claude-opus-4-5', 'anthropic'],
    ['claude-sonnet-4-5', 'anthropic'],
    ['gemini-3.6-flash', 'Gemini'],
    ['gemini-3.5-flash-lite', 'Gemini'],
    ['gemini-2.5-flash-lite', 'Gemini'],
    ['gemini-3.1-flash-image', 'Gemini'],
    ['gemini-3.1-flash-lite-image', 'Gemini'],
    ['gemini-3-pro-image', 'Gemini']
  ];
  for (const [model, provider] of cases) {
    const cost = calculateOfficialCost(model, { input: 1_000_000, output: 1_000_000 });
    assert.equal(cost.priced, true, model);
    assert.equal(cost.provider, provider, model);
    assert.equal(cost.resolvedModel, model, model);
    assert.ok(cost.totalUSD > 0, model);
  }
  const opus45 = calculateOfficialCost('claude-opus-4.5', {
    input: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
    output: 1_000_000
  });
  assert.equal(opus45.ratesPerMTok.cachedInput, 0.5);
  assert.equal(opus45.ratesPerMTok.cacheWrite, 6.25);
});

test('converts new GLM vision model CNY rates to USD at the refresh exchange rate', () => {
  // 官方 CNY 原价 [0,32K) 档：glm-4.6v 1/3、glm-4.6v-flashx 0.15/1.5、glm-4.5v 2/6，USD 随刷新汇率换算
  const cnyCases: Array<[string, number, number]> = [
    ['glm-4.6v', 1, 3],
    ['glm-4.6v-flashx', 0.15, 1.5],
    ['glm-4.5v', 2, 6]
  ];
  for (const [model, inputCny, outputCny] of cnyCases) {
    const cost = calculateOfficialCost(model, { input: 1_000_000, output: 1_000_000 });
    assert.equal(cost.priced, true, model);
    assert.equal(cost.provider, 'Zhipu GLM', model);
    const row = OFFICIAL_PRICE_TABLE.find(rate => rate.model === model);
    assert.ok(row?.officialRatesPerMTok, model);
    const rate = row.officialRatesPerMTok.exchangeRate;
    assert.equal(row.officialRatesPerMTok.ratesPerMTok.input, inputCny, model);
    assert.equal(row.officialRatesPerMTok.ratesPerMTok.output, outputCny, model);
    assert.ok(Math.abs(cost.ratesPerMTok.input - inputCny / rate) < 1e-15, model);
    assert.ok(Math.abs(cost.ratesPerMTok.output - outputCny / rate) < 1e-15, model);
  }
  const free = calculateOfficialCost('glm-4.6v-flash', { input: 1_000_000, output: 1_000_000 });
  assert.equal(free.priced, true);
  assert.equal(free.totalUSD, 0);
});

test('rateSchedule backfill prices previously unpriced models only from their effective date', () => {
  const tokens = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 };
  for (const model of ['gpt-5.4-mini', 'grok-4.6']) {
    for (const usageDate of [null, '2026-09-10']) {
      const cost = calculateOfficialCost(model, tokens, { usageDate });
      assert.equal(cost.priced, false, `${model} ${usageDate}`);
      assert.equal(cost.totalUSD, 0, `${model} ${usageDate}`);
    }
    const priced = calculateOfficialCost(model, tokens, { usageDate: '2026-09-18' });
    assert.equal(priced.priced, true, model);
    assert.ok(priced.totalUSD > 0, model);
  }
  const mini = calculateOfficialCost('gpt-5-4-mini', tokens, { usageDate: '2026-09-18' });
  assert.equal(mini.ratesPerMTok.input, 0.2);
  assert.equal(mini.ratesPerMTok.cachedInput, 0.02);
  assert.equal(mini.ratesPerMTok.output, 1.25);
  const grok = calculateOfficialCost('grok-4-6', tokens, { usageDate: '2026-09-18' });
  assert.equal(grok.ratesPerMTok.cachedInput, 0.5);
  for (const model of ['gemini-3.8-flash', 'gemini-3.7-flash']) {
    const cost = calculateOfficialCost(model, tokens, { usageDate: '2026-09-18' });
    assert.equal(cost.priced, true, model);
    assert.equal(cost.ratesPerMTok.input, 0.75, model);
    const standard = calculateOfficialCost(model, tokens, { usageDate: '2027-01-01' });
    assert.equal(standard.ratesPerMTok.input, 1.5, model);
  }
});

test('grok-4.5 and mythos cached-input history keeps pre-effective-date rates', () => {
  const tokens = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 };
  const grokHistorical = calculateOfficialCost('grok-4.5', tokens, { usageDate: '2026-09-10' });
  assert.equal(grokHistorical.ratesPerMTok.cachedInput, 2);
  const grokCurrent = calculateOfficialCost('grok-4.5', tokens);
  assert.equal(grokCurrent.ratesPerMTok.cachedInput, 0.3);
  const mythosUndated = calculateOfficialCost('claude-mythos-5.1', tokens);
  assert.equal(mythosUndated.ratesPerMTok.cachedInput, 10);
  assert.equal(mythosUndated.ratesPerMTok.cacheWrite, 10);
  const mythosDated = calculateOfficialCost('claude-mythos-5.1', tokens, { usageDate: '2026-09-18' });
  assert.equal(mythosDated.ratesPerMTok.cachedInput, 0.25);
  assert.equal(mythosDated.ratesPerMTok.cacheWrite, 12.5);
  const mythos5 = calculateOfficialCost('claude-mythos-5', tokens, { usageDate: '2026-09-18' });
  assert.equal(mythos5.ratesPerMTok.cachedInput, 1);
});

test('gemini-3.6-flash switches from launch promo to standard rates on 2027-01-01', () => {
  const tokens = { input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 };
  const promo = calculateOfficialCost('gemini-3.6-flash', tokens, { usageDate: '2026-12-31' });
  assert.equal(promo.ratesPerMTok.input, 0.75);
  assert.equal(promo.ratesPerMTok.output, 3.75);
  const standard = calculateOfficialCost('gemini-3.6-flash', tokens, { usageDate: '2027-01-01' });
  assert.equal(standard.ratesPerMTok.input, 1.5);
  assert.equal(standard.ratesPerMTok.output, 7.5);
  assert.ok(standard.totalUSD > promo.totalUSD);
  assert.equal(calculateOfficialCost('gemini-3.6-flash', tokens).totalUSD, promo.totalUSD);
});
