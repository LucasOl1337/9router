import { NextResponse } from "next/server";
import { getFederatedChartData } from "@/lib/usageFederation";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d"]);

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    const offsetValue = searchParams.get("timezoneOffset");
    const parsedOffset = offsetValue === null ? undefined : Number(offsetValue);
    const timezoneOffset = Number.isFinite(parsedOffset) && parsedOffset >= -840 && parsedOffset <= 840
      ? parsedOffset
      : undefined;
    const data = await getFederatedChartData(period, timezoneOffset);
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Failed to get chart data:", error);
    return NextResponse.json({ error: "Failed to fetch chart data" }, { status: 500 });
  }
}
