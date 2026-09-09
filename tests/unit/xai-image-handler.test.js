/**
 * App-side image handler: xai credentialFallback to grok-cli.
 *
 * When there is no xai sqlite row, POST xai/grok-imagine-image-2.0 must reuse
 * the grok-cli OAuth connection instead of returning "No credentials for provider: xai".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const authMocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true, cooldownMs: 0 })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
}));
const tokenMocks = vi.hoisted(() => ({
  checkAndRefreshToken: vi.fn(async (_p, creds) => creds),
  updateProviderCredentials: vi.fn(async () => {}),
}));
const dbMocks = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({ requireApiKey: false })),
  getComboByName: vi.fn(async () => null),
  getModelAliases: vi.fn(async () => ({})),
  getProviderNodes: vi.fn(async () => []),
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
}));

vi.mock("@/sse/services/auth.js", () => authMocks);
vi.mock("@/sse/services/tokenRefresh.js", () => tokenMocks);
vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { handleImageGeneration } from "@/sse/handlers/imageGeneration.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";

const originalFetch = global.fetch;

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const makeRequest = (body) =>
  new Request("http://localhost/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const grokCliAccount = (overrides = {}) => ({
  connectionId: "gcli-1",
  connectionName: "grok-cli",
  accessToken: "gcli-tok",
  refreshToken: "gcli-ref",
  authType: "oauth",
  ...overrides,
});

beforeEach(() => {
  global.fetch = vi.fn();
  authMocks.getProviderCredentials.mockReset();
  authMocks.markAccountUnavailable.mockClear();
  authMocks.clearAccountError.mockClear();
  tokenMocks.checkAndRefreshToken.mockClear();
  dbMocks.getProviderConnections.mockReset();
  dbMocks.getCombos.mockResolvedValue([]);
  dbMocks.getCustomModels.mockResolvedValue([]);
  dbMocks.getModelAliases.mockResolvedValue({});
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("handleImageGeneration xai credentialFallback", () => {
  it("reuses grok-cli OAuth when xai has no connection", async () => {
    authMocks.getProviderCredentials.mockImplementation(async (provider) => {
      if (provider === "xai") return null;
      if (provider === "grok-cli") return grokCliAccount();
      return null;
    });
    global.fetch.mockResolvedValueOnce(
      jsonResponse({ created: 1, data: [{ b64_json: "cHdu" }] })
    );

    const res = await handleImageGeneration(
      makeRequest({
        model: "xai/grok-imagine-image-2.0",
        prompt: "a red cube",
        n: 1,
        response_format: "b64_json",
      })
    );

    expect(res.status).toBe(200);
    expect(authMocks.getProviderCredentials).toHaveBeenCalledWith(
      "xai",
      expect.any(Set),
      "grok-imagine-image-2.0",
      expect.objectContaining({ preferredConnectionId: null })
    );
    expect(authMocks.getProviderCredentials).toHaveBeenCalledWith(
      "grok-cli",
      expect.any(Set),
      "grok-imagine-image-2.0",
      expect.objectContaining({ preferredConnectionId: null })
    );
    expect(tokenMocks.checkAndRefreshToken).toHaveBeenCalledWith("grok-cli", expect.objectContaining({
      connectionId: "gcli-1",
    }));
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.x.ai/v1/images/generations",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer gcli-tok" }),
      })
    );
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent.model).toBe("grok-imagine-image-2.0");
  });


  it("forwards an x-connection-id pin to the grok-cli fallback lookup", async () => {
    authMocks.getProviderCredentials.mockImplementation(async (provider) => {
      if (provider === "xai") return null;
      if (provider === "grok-cli") return grokCliAccount({ connectionId: "gcli-2" });
      return null;
    });
    global.fetch.mockResolvedValueOnce(
      jsonResponse({ created: 1, data: [{ b64_json: "cGlu" }] })
    );

    const request = new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-connection-id": "gcli-2" },
      body: JSON.stringify({
        model: "xai/grok-imagine-image-2.0",
        prompt: "a red cube",
        n: 1,
        response_format: "b64_json",
      }),
    });

    const res = await handleImageGeneration(request);

    expect(res.status).toBe(200);
    expect(authMocks.getProviderCredentials).toHaveBeenCalledWith(
      "grok-cli",
      expect.any(Set),
      "grok-imagine-image-2.0",
      expect.objectContaining({ preferredConnectionId: "gcli-2" })
    );
  });

  it("still errors when neither xai nor grok-cli has credentials", async () => {
    authMocks.getProviderCredentials.mockResolvedValue(null);

    const res = await handleImageGeneration(
      makeRequest({
        model: "xai/grok-imagine-image-2.0",
        prompt: "a red cube",
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.message || body.error || JSON.stringify(body)).toMatch(/No credentials for provider: xai/);
  });
});

describe("buildModelsList image catalog with grok-cli fallback", () => {
  it("lists xai/grok-imagine-image-2.0 when only grok-cli is connected", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      { provider: "grok-cli", isActive: true, providerSpecificData: {} },
      { provider: "codex", isActive: true, providerSpecificData: {} },
    ]);

    const data = await buildModelsList(["image"]);
    const ids = data.map((m) => m.id);
    expect(ids).toContain("xai/grok-imagine-image-2.0");
    expect(ids).toContain("xai/grok-imagine-image");
    expect(ids).toContain("cx/gpt-5.5-image");
    expect(ids).toContain("cx/gpt-image-2");
  });

  it("does not list ollama-search on the web catalog just because ollama is connected", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      { provider: "ollama", isActive: true, providerSpecificData: {} },
    ]);

    const data = await buildModelsList(["webSearch", "webFetch"]);
    const ids = data.map((m) => m.id);
    expect(ids.some((id) => id.startsWith("ollama-search/"))).toBe(false);
  });

  it("does not list xai chat models on the LLM catalog just because grok-cli is connected", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      { provider: "grok-cli", isActive: true, providerSpecificData: {} },
    ]);

    const data = await buildModelsList(["llm"]);
    const ids = data.map((m) => m.id);
    expect(ids.some((id) => id.startsWith("xai/"))).toBe(false);
  });
});
