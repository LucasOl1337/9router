import { getChartData } from "@/lib/usageDb";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d"]);

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "7d";
  if (!VALID_PERIODS.has(period)) return Response.json({ error: "Invalid period" }, { status: 400 });
  const rawOffset = searchParams.get("timezoneOffset");
  const offset = rawOffset === null ? undefined : Number(rawOffset);
  const timezoneOffset = Number.isFinite(offset) && offset >= -840 && offset <= 840 ? offset : undefined;
  return Response.json(await getChartData(period, { timezoneOffset }));
}
