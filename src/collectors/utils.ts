import { loadCollectorConfig } from '../collector-config.ts';

const REASONING_TIERS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'auto', 'none']);
const CHINA_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

export function localDateFromTimestamp(value, fallback = 'unknown') {
  if (value == null || value === '') return fallback;

  let ms;
  if (typeof value === 'number') {
    ms = value > 1e12 ? value : value * 1000;
  } else {
    ms = new Date(value).getTime();
  }

  if (!Number.isFinite(ms)) return fallback;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return fallback;

  const parts = CHINA_DATE_FORMATTER.formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function normalizeModelForGrouping(modelId, usageDate = null) {
  let name = String(modelId || 'unknown').trim().toLowerCase();
  if (!name) return 'unknown';

  if (name.endsWith(')')) {
    const openIndex = name.lastIndexOf('(');
    if (openIndex > 0) {
      const base = name.slice(0, openIndex);
      const tier = name.slice(openIndex + 1, -1);
      if (base.trim() === base && REASONING_TIERS.has(tier)) {
        name = base;
      }
    }
  }

  if (name.length > 9) {
    const suffix = name.slice(-8);
    if (/^\d{8}$/.test(suffix) && name.at(-9) === '-') {
      name = name.slice(0, -9);
    }
  }

  if (name.includes('claude')) {
    name = name.replace(/(?<=\d)\.(?=\d)/g, '-');
  }

  if (['hy3-x', 'hy3_x', 'hunyuan-hy3-x', 'hunyuan_hy3_x'].includes(name)) {
    return applyConfiguredModelAlias('hy3', usageDate);
  }

  // WorkBuddy recorded this release label for the Kimi K3 model. Keep the
  // canonical model name stable without treating later K3 variants as K3.
  if (name === 'kimi-k3-1') return applyConfiguredModelAlias('kimi-k3', usageDate);

  return applyConfiguredModelAlias(name, usageDate);
}

/**
 * 代理供应商让客户端记录假 slug，真实模型不落盘。collectors.json 顶层
 * modelAliases 两种形态："slug": "real"（全局），或 "slug": {to, from}
 * （仅本地日期 ≥ from 重映射，用于供应商切换前后同 slug 是不同模型）。
 * 键匹配归一化分组名，档位/日期后缀变体同样命中；usageDate 非严格
 * YYYY-MM-DD（含 'unknown' 回退值）时 scoped 条目一律惰性。
 */
let aliasState = null;

function applyConfiguredModelAlias(name, usageDate = null) {
  const aliases = modelAliasMap();
  if (!aliases) return name;
  const base = baseModelKey(name);
  const hit = aliasLookup(aliases.unscoped, name, base);
  if (hit) return hit;
  if (usageDate && aliases.scoped.length) {
    // cutoff 是字典序比较，非严格日期（如 'unknown'）不得通过
    if (!/^\d{4}-\d{2}-\d{2}$/.test(usageDate)) return name;
    let scopedTo = null;
    for (const entry of aliases.scoped) {
      if (entry.from <= usageDate && (entry.key === name || entry.key === base)) {
        scopedTo = entry.to;
      }
    }
    if (scopedTo) return scopedTo;
  }
  return name;
}

// 档位后缀变体（"slug (high)"）归属同一基模型
function baseModelKey(name) {
  const openIndex = name.lastIndexOf('(');
  if (openIndex > 0 && name.endsWith(')')) {
    const tier = name.slice(openIndex + 1, -1).trim();
    if (REASONING_TIERS.has(tier)) {
      return name.slice(0, openIndex).trim();
    }
  }
  return null;
}

function aliasLookup(map, name, base = baseModelKey(name)) {
  if (!map) return null;
  const hit = map.get(name);
  if (hit) return hit;
  return base ? (map.get(base) || null) : null;
}

function modelAliasMap() {
  const raw = loadCollectorConfig().modelAliases;
  if (aliasState && aliasState.source === raw) return aliasState.map;
  const unscoped = new Map();
  const scoped = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [slug, target] of Object.entries(raw)) {
      const key = String(slug).trim().toLowerCase();
      if (!key) continue;
      if (target && typeof target === 'object' && !Array.isArray(target)) {
        const to = String(target.to ?? '').trim().toLowerCase();
        const from = String(target.from ?? '').trim();
        if (to && from && key !== to && /^\d{4}-\d{2}-\d{2}$/.test(from)) scoped.push({ from, to, key });
      } else {
        const to = String(target ?? '').trim().toLowerCase();
        if (to && key !== to) unscoped.set(key, to);
      }
    }
  }
  scoped.sort((left, right) => left.from.localeCompare(right.from));
  aliasState = {
    source: raw,
    map: (unscoped.size || scoped.length) ? { unscoped, scoped } : null
  };
  return aliasState.map;
}

// 规范名与去重 ID 分离；实现在零依赖叶子模块，浏览器经 pricing.ts 可达
export { canonicalModelName } from '../model-name.ts';

export function canonicalProvider(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().replace(/-/g, '_').split(/[/.]/);
  for (const part of parts) {
    const value = part.trim().toLowerCase();
    if (!value || value === 'unknown') continue;
    if (value === 'x_ai' || value === 'xai') return 'xai';
    if (value === 'z_ai' || value === 'zai' || value === 'zhipu' || value === 'zhipu glm' || value === 'bigmodel') return 'Zhipu GLM';
    if (value === 'doubao' || value === 'doubao seed' || value === 'doubaoseed' || value === 'volcengine' || value === 'ark' || value === 'bytedance') return 'DoubaoSeed';
    if (value === 'moonshot' || value === 'moonshotai' || value === 'kimi') return 'Kimi';
    if (value === 'meta' || value === 'meta_llama') return 'meta_llama';
    if (value === 'azure' || value === 'azure_ai') return 'azure_ai';
    if (value === 'anthropic' || value === 'vertex' || value === 'vertex_ai') return 'anthropic';
    if (value === 'together' || value === 'together_ai') return 'together_ai';
    if (value === 'fireworks' || value === 'fireworks_ai') return 'fireworks_ai';
    if (value === 'google' || value === 'gemini') return 'Gemini';
    if (value === 'openai' || value === 'openai_codex') return 'openai';
    if (value === 'mistral' || value === 'mistralai') return 'mistralai';
    if (value === 'ai21') return 'ai21';
    if (!/\d/.test(value)) return value;
  }
  return null;
}

export function inferProviderFromModel(model) {
  const lower = String(model || '').toLowerCase();
  if (lower.includes('kimi') || lower.includes('moonshot')) return 'Kimi';
  if (lower.includes('claude') || lower.includes('anthropic') || /\b(opus|sonnet|haiku)\b/.test(lower)) return 'anthropic';
  if (lower.includes('gpt') || lower.includes('openai') || /\b(o1|o3|o4)\b/.test(lower)) return 'openai';
  if (lower.includes('gemini') || lower.includes('google')) return 'Gemini';
  if (lower.includes('grok')) return 'xai';
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('mimo') || lower.includes('xiaomi')) return 'xiaomi';
  if (lower.includes('mistral') || lower.includes('mixtral')) return 'mistral';
  if (lower.includes('llama') || /\bmeta\b/.test(lower)) return 'meta';
  if (lower.includes('qwen')) return 'qwen';
  if (lower.includes('glm')) return 'Zhipu GLM';
  if (lower.includes('doubao')) return 'DoubaoSeed';
  return null;
}
