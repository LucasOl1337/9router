import { describe, expect, it } from "vitest";
import codex from "../../open-sse/providers/registry/codex.js";
import grokCli from "../../open-sse/providers/registry/grok-cli.js";
import xai from "../../open-sse/providers/registry/xai.js";
import claude from "../../open-sse/providers/registry/claude.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";

describe("latest models in the gateway", () => {
  it("resolves GPT-6 through Codex with the subscription's actual effort levels", () => {
    for (const name of ["astra", "sol", "luna"]) {
      const id = `gpt-6-${name}`;
      expect(codex.models.some((model) => model.id === id)).toBe(true);
      expect(getCapabilitiesForModel("codex", id)).toMatchObject({
        contextWindow: 272000, vision: true, reasoning: true, thinkingCanDisable: false,
      });
      expect(getPricingForModel("codex", `cx/${id}(medium)`).input).toBeGreaterThan(0);
    }
    expect(getThinkingLevels("codex", "gpt-6-sol")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(getThinkingLevels("codex", "gpt-6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("resolves Grok 4.7 from CLI and xAI with its own price and effort", () => {
    expect(grokCli.models.some((model) => model.id === "grok-4.7")).toBe(true);
    expect(xai.models.some((model) => model.id === "grok-4.7")).toBe(true);
    expect(getCapabilitiesForModel("grok-cli", "grok-4.7").contextWindow).toBe(500000);
    expect(getThinkingLevels("grok-cli", "grok-4.7")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(getPricingForModel("grok-cli", "gcli/grok-4.7")).toMatchObject({ input: 2, output: 6 });
  });

  it("recognizes Opus 5.5 while leaving credential availability to the account", () => {
    expect(claude.models.some((model) => model.id === "claude-opus-5-5")).toBe(true);
    expect(getCapabilitiesForModel("claude", "claude-opus-5-5")).toMatchObject({
      reasoning: true, thinkingCanDisable: false, contextWindow: 1000000,
    });
    expect(getPricingForModel("claude", "claude-opus-5-5")).toMatchObject({ input: 4, output: 20 });
  });
});
