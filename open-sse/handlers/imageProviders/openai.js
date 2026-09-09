// OpenAI-compatible adapter (used by openai, minimax, openrouter, recraft)
import { PROVIDER_MEDIA } from "../../providers/index.js";
import { getModelsByProviderId } from "../../config/providerModels.js";
import { aspectRatioForSize } from "./_base.js";

const imageCfg = (id) => PROVIDER_MEDIA[id]?.imageConfig || {};
const imageUrl = (id) => imageCfg(id).baseUrl;

// bodyFields is provider-wide; anything beyond the base body is opt-in per model
// via its declared params (xAI: only grok-imagine-* takes aspect_ratio/resolution/quality).
const BASE_BODY_FIELDS = new Set(["model", "prompt", "n", "response_format"]);
function allowedBodyFields(providerId, model, bodyFields) {
  const params = getModelsByProviderId(providerId).find((m) => m.id === model)?.params || [];
  return bodyFields.filter((f) => BASE_BODY_FIELDS.has(f) || params.includes(f));
}

export default function createOpenAIAdapter(providerId) {
  const cfg = imageCfg(providerId);
  return {
    buildUrl: () => imageUrl(providerId),
    buildHeaders: (creds) => {
      const headers = { "Content-Type": "application/json", ...(cfg.headers || {}) };
      const key = creds?.apiKey || creds?.accessToken;
      if (key) headers["Authorization"] = `Bearer ${key}`;
      return headers;
    },
    buildBody: (model, body) => {
      const { prompt, n = 1, size = "1024x1024", quality, style, response_format } = body;
      const full = { model, prompt, n, size };
      if (quality) full.quality = quality;
      if (style) full.style = style;
      if (response_format) full.response_format = response_format;
      // bodyFields whitelist (e.g. xAI Imagine accepts aspect_ratio/resolution/quality)
      if (Array.isArray(cfg.bodyFields)) {
        const fields = allowedBodyFields(providerId, model, cfg.bodyFields);
        if (body.aspect_ratio) full.aspect_ratio = body.aspect_ratio;
        else if (fields.includes("aspect_ratio")) full.aspect_ratio = aspectRatioForSize(body.size) || undefined;
        if (body.resolution) full.resolution = body.resolution;
        const req = {};
        for (const f of fields) if (full[f] !== undefined) req[f] = full[f];
        return req;
      }
      return full;
    },
    normalize: (responseBody) => responseBody,
  };
}
