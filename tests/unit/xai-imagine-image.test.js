/**
 * xAI Imagine image models: registry wiring + OpenAI-compatible adapter body.
 *
 * Covers:
 *  - grok-imagine-image / grok-imagine-image-2.0 as kind image
 *  - imageConfig.bodyFields includes aspect_ratio, resolution, quality
 *  - credentialFallback to grok-cli (no cloned xai sqlite row)
 *  - adapter forwards Imagine fields and maps size → aspect_ratio
 *  - OAuth accessToken is sent as Bearer (grok-cli credential shape)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { PROVIDER_MEDIA, PROVIDER_MODELS } from "../../open-sse/providers/index.js";

const originalFetch = global.fetch;

describe("xAI Imagine registry wiring", () => {
  it("registers Imagine 1.0 and 2.0 as image models", () => {
    const ids = (PROVIDER_MODELS.xai || []).filter((m) => m.kind === "image").map((m) => m.id);
    expect(ids).toContain("grok-imagine-image");
    expect(ids).toContain("grok-imagine-image-2.0");
  });

  it("whitelists Imagine body fields and reuses grok-cli credentials", () => {
    expect(PROVIDER_MEDIA.xai.credentialFallback).toBe("grok-cli");
    expect(PROVIDER_MEDIA.xai.imageConfig.bodyFields).toEqual([
      "model",
      "prompt",
      "n",
      "response_format",
      "aspect_ratio",
      "resolution",
      "quality",
    ]);
  });
});

describe("xAI Imagine adapter", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("POSTs grok-imagine-image-2.0 with aspect_ratio, resolution, quality and grok-cli accessToken", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1234567890,
          data: [{ b64_json: "aW1hZ2luZQ==" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: {
        prompt: "a red cube",
        n: 1,
        aspect_ratio: "16:9",
        resolution: "1k",
        quality: "high",
        response_format: "b64_json",
      },
      modelInfo: { provider: "xai", model: "grok-imagine-image-2.0" },
      credentials: { accessToken: "grok-cli-token" },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.x.ai/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer grok-cli-token",
        }),
      })
    );

    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent).toEqual({
      model: "grok-imagine-image-2.0",
      prompt: "a red cube",
      n: 1,
      response_format: "b64_json",
      aspect_ratio: "16:9",
      resolution: "1k",
      quality: "high",
    });
    expect(sent).not.toHaveProperty("size");

    const responseBody = await result.response.json();
    expect(responseBody.data[0].b64_json).toBe("aW1hZ2luZQ==");
  });

  it("maps OpenAI size 1024x1024 to aspect_ratio 1:1 when aspect_ratio is omitted", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ created: 1, data: [{ url: "https://example.com/i.png" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "a cube", n: 1, size: "1024x1024", response_format: "b64_json" },
      modelInfo: { provider: "xai", model: "grok-imagine-image" },
      credentials: { accessToken: "tok" },
      log: null,
    });

    expect(result.success).toBe(true);
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent.aspect_ratio).toBe("1:1");
    expect(sent).not.toHaveProperty("size");
  });
});
