import { describe, expect, it } from "vitest";
import { mergeChartData, mergeUsageStats, parseUsagePeers } from "@/lib/usageFederation.js";

function stats({ requests, prompt, completion, model, timestamp }) {
  return {
    totalRequests: requests,
    totalPromptTokens: prompt,
    totalCompletionTokens: completion,
    totalCachedTokens: 0,
    totalCost: 0,
    byProvider: { codex: { requests, promptTokens: prompt, completionTokens: completion } },
    byModel: {
      [`${model} (codex)`]: {
        requests, promptTokens: prompt, completionTokens: completion,
        rawModel: model, provider: "codex", lastUsed: timestamp,
      },
    },
    byAccount: {}, byApiKey: {}, byEndpoint: {},
    activeRequests: [],
    recentRequests: [{ timestamp, model, provider: "codex", promptTokens: prompt, completionTokens: completion }],
    last10Minutes: [{ requests, promptTokens: prompt, completionTokens: completion, cost: 0 }],
  };
}

describe("usage federation", () => {
  it("parses named peers without reading credential values", () => {
    expect(parseUsagePeers("Railway|https://router.example/v1/|RAILWAY_KEY;broken"))
      .toEqual([{ label: "Railway", url: "https://router.example/v1", apiKeyEnv: "RAILWAY_KEY" }]);
  });

  it("sums totals while keeping same-model rows separate by origin", () => {
    const local = stats({ requests: 2, prompt: 100, completion: 20, model: "gpt-5.6-sol-high", timestamp: "2026-09-22T03:00:00Z" });
    const railway = stats({ requests: 3, prompt: 200, completion: 30, model: "gpt-5.6-sol-high", timestamp: "2026-09-22T04:00:00Z" });
    const merged = mergeUsageStats([
      { label: "Local", stats: local },
      { label: "Railway", stats: railway },
    ]);

    expect(merged.totalRequests).toBe(5);
    expect(merged.totalPromptTokens).toBe(300);
    expect(merged.totalCompletionTokens).toBe(50);
    expect(Object.values(merged.byModel)).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: "Local", requests: 2 }),
      expect.objectContaining({ origin: "Railway", requests: 3 }),
    ]));
    expect(merged.recentRequests[0]).toMatchObject({ origin: "Railway" });
    expect(merged.sources).toEqual([
      expect.objectContaining({ label: "Local", available: true, tokens: 120 }),
      expect.objectContaining({ label: "Railway", available: true, tokens: 230 }),
    ]);
  });

  it("keeps local stats available when a peer is down", () => {
    const local = stats({ requests: 1, prompt: 10, completion: 2, model: "gpt", timestamp: "2026-09-22T03:00:00Z" });
    const merged = mergeUsageStats([
      { label: "Local", stats: local },
      { label: "Railway", error: "HTTP 503" },
    ]);
    expect(merged.totalRequests).toBe(1);
    expect(merged.sources[1]).toMatchObject({ label: "Railway", available: false, error: "HTTP 503" });
  });

  it("sums aligned chart buckets and preserves per-origin values", () => {
    expect(mergeChartData([
      { label: "Local", data: [{ label: "00:00", tokens: 10, cost: 1 }] },
      { label: "Railway", data: [{ label: "00:00", tokens: 20, cost: 2 }] },
    ])).toEqual([{ label: "00:00", tokens: 30, cost: 3, sources: {
      Local: { tokens: 10, cost: 1 }, Railway: { tokens: 20, cost: 2 },
    } }]);
  });
});
