import { getUsageStats } from "@/lib/usageDb";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);

export const dynamic = "force-dynamic";

function publicStats(stats) {
  return {
    totalRequests: stats.totalRequests,
    totalPromptTokens: stats.totalPromptTokens,
    totalCompletionTokens: stats.totalCompletionTokens,
    totalCachedTokens: stats.totalCachedTokens,
    totalCost: stats.totalCost,
    byProvider: stats.byProvider,
    byModel: stats.byModel,
    byAccount: {},
    byApiKey: {},
    byEndpoint: stats.byEndpoint,
    activeRequests: (stats.activeRequests || []).map(({ model, provider, count }) => ({ model, provider, count })),
    recentRequests: (stats.recentRequests || []).map(({
      timestamp, model, provider, promptTokens, completionTokens, cachedTokens, status,
    }) => ({ timestamp, model, provider, promptTokens, completionTokens, cachedTokens, status })),
    last10Minutes: stats.last10Minutes,
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "7d";
  if (!VALID_PERIODS.has(period)) return Response.json({ error: "Invalid period" }, { status: 400 });
  const rawOffset = searchParams.get("timezoneOffset");
  const offset = rawOffset === null ? undefined : Number(rawOffset);
  const timezoneOffset = Number.isFinite(offset) && offset >= -840 && offset <= 840 ? offset : undefined;
  return Response.json(publicStats(await getUsageStats(period, { timezoneOffset })));
}
