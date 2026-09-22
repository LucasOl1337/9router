import { NextResponse } from "next/server";
import { getFederatedUsageStats } from "@/lib/usageFederation";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);

function timezoneOffset(searchParams) {
  const value = searchParams.get("timezoneOffset");
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= -840 && parsed <= 840 ? parsed : undefined;
}

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    const stats = await getFederatedUsageStats(period, timezoneOffset(searchParams));
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[API] Failed to get usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
