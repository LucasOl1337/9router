// Shared helpers for image provider adapters

export const POLL_INTERVAL_MS = 1500;
export const POLL_TIMEOUT_MS = 120000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SIZE_ASPECT_RATIOS = {
  "1024x1024": "1:1",
  "1024x1792": "9:16",
  "1792x1024": "16:9",
  "1024x1536": "2:3",
  "1536x1024": "3:2",
};

// Map OpenAI size to provider-specific aspect ratio, null when unmapped
export function aspectRatioForSize(size) {
  if (!size || typeof size !== "string") return null;
  return SIZE_ASPECT_RATIOS[size] || null;
}

// Map OpenAI size to provider-specific aspect ratio
export function sizeToAspectRatio(size) {
  return aspectRatioForSize(size) || "1:1";
}

// Fetch URL → base64 (for providers returning image URLs)
export async function urlToBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}
