import { connection, NextResponse } from "next/server";

export async function GET() {
  await connection();
  const backendUrl = process.env.BACKEND_INTERNAL_URL ?? "http://localhost:8000";

  try {
    const stats = await fetch(`${backendUrl}/api/stats`, { cache: "no-store" });
    return NextResponse.json(await stats.json(), { status: stats.status });
  } catch (error) {
    console.error("Failed to proxy map statistics:", error);
    return NextResponse.json(
      { success: false, message: "Map statistics service is unavailable" },
      { status: 502 },
    );
  }
}
