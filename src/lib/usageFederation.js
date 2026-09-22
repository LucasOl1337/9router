import { getChartData, getUsageStats } from "@/lib/usageDb";

const DEFAULT_TIMEOUT_MS = 5000;
const COUNTER_FIELDS = ["requests", "promptTokens", "completionTokens", "cachedTokens", "cost"];
const DETAIL_MAPS = ["byProvider", "byModel", "byAccount", "byApiKey", "byEndpoint"];

function numeric(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function parseUsagePeers(value = process.env.NINEROUTER_USAGE_PEERS || "") {
  return String(value)
    .split(";")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [label, rawUrl, apiKeyEnv] = record.split("|").map((part) => part?.trim());
      if (!label || !rawUrl || !apiKeyEnv) return null;
      try {
        const url = new URL(rawUrl);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        return { label, url: url.toString().replace(/\/$/, ""), apiKeyEnv };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function tagMap(map, origin) {
  const tagged = {};
  for (const [key, value] of Object.entries(map || {})) {
    tagged[`${origin}|${key}`] = { ...value, origin };
  }
  return tagged;
}

function tagStats(stats, origin) {
  const tagged = { ...stats, origin };
  for (const name of DETAIL_MAPS) tagged[name] = tagMap(stats?.[name], origin);
  tagged.activeRequests = (stats?.activeRequests || []).map((item) => ({ ...item, origin }));
  tagged.recentRequests = (stats?.recentRequests || []).map((item) => ({ ...item, origin }));
  return tagged;
}

function addCounters(target, source) {
  for (const field of COUNTER_FIELDS) target[field] = numeric(target[field]) + numeric(source?.[field]);
  if (source?.lastUsed && (!target.lastUsed || new Date(source.lastUsed) > new Date(target.lastUsed))) {
    target.lastUsed = source.lastUsed;
  }
  return target;
}

export function mergeUsageStats(sources) {
  const valid = sources.filter((source) => source?.stats);
  if (!valid.length) return null;

  const first = tagStats(valid[0].stats, valid[0].label);
  const merged = {
    ...first,
    totalRequests: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCachedTokens: 0,
    totalCost: 0,
    byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
    activeRequests: [], recentRequests: [], last10Minutes: [],
    sources: sources.map(({ label, stats, error }) => ({
      label,
      available: Boolean(stats),
      error: error || null,
      requests: numeric(stats?.totalRequests),
      tokens: numeric(stats?.totalPromptTokens) + numeric(stats?.totalCompletionTokens),
    })),
  };

  for (const source of valid) {
    const tagged = tagStats(source.stats, source.label);
    merged.totalRequests += numeric(tagged.totalRequests);
    merged.totalPromptTokens += numeric(tagged.totalPromptTokens);
    merged.totalCompletionTokens += numeric(tagged.totalCompletionTokens);
    merged.totalCachedTokens += numeric(tagged.totalCachedTokens);
    merged.totalCost += numeric(tagged.totalCost);

    for (const name of DETAIL_MAPS) Object.assign(merged[name], tagged[name]);
    merged.activeRequests.push(...tagged.activeRequests);
    merged.recentRequests.push(...tagged.recentRequests);
    for (let i = 0; i < (tagged.last10Minutes || []).length; i++) {
      merged.last10Minutes[i] ||= { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
      addCounters(merged.last10Minutes[i], tagged.last10Minutes[i]);
    }
  }

  merged.recentRequests.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  merged.recentRequests = merged.recentRequests.slice(0, 20);
  return merged;
}

export function mergeChartData(sources) {
  const labels = [];
  const byLabel = new Map();
  for (const { label: origin, data } of sources) {
    for (const point of data || []) {
      if (!byLabel.has(point.label)) {
        labels.push(point.label);
        byLabel.set(point.label, { label: point.label, tokens: 0, cost: 0, sources: {} });
      }
      const target = byLabel.get(point.label);
      target.tokens += numeric(point.tokens);
      target.cost += numeric(point.cost);
      target.sources[origin] = { tokens: numeric(point.tokens), cost: numeric(point.cost) };
    }
  }
  return labels.map((label) => byLabel.get(label));
}

async function fetchPeer(peer, path, searchParams) {
  const apiKey = process.env[peer.apiKeyEnv];
  if (!apiKey) throw new Error(`missing credential env ${peer.apiKeyEnv}`);
  const url = new URL(`${peer.url}${path}`);
  for (const [key, value] of searchParams.entries()) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function peerResults(path, searchParams, dataKey) {
  return Promise.all(parseUsagePeers().map(async (peer) => {
    try {
      return { label: peer.label, [dataKey]: await fetchPeer(peer, path, searchParams) };
    } catch (error) {
      console.warn(`[usage-federation] ${peer.label}: ${error.message}`);
      return { label: peer.label, error: error.message };
    }
  }));
}

export async function getFederatedUsageStats(period, timezoneOffset = undefined) {
  const local = await getUsageStats(period, { timezoneOffset });
  const params = new URLSearchParams({ period });
  if (timezoneOffset !== undefined) params.set("timezoneOffset", String(timezoneOffset));
  const peers = await peerResults("/v1/usage/stats", params, "stats");
  return mergeUsageStats([{ label: "Local", stats: local }, ...peers]);
}

export async function getFederatedChartData(period, timezoneOffset = undefined) {
  const local = await getChartData(period, { timezoneOffset });
  const params = new URLSearchParams({ period });
  if (timezoneOffset !== undefined) params.set("timezoneOffset", String(timezoneOffset));
  const peers = await peerResults("/v1/usage/chart", params, "data");
  return mergeChartData([{ label: "Local", data: local }, ...peers]);
}
