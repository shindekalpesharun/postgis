import { NextResponse } from "next/server";

type TileRouteContext = {
  params: Promise<{ z: string; x: string; y: string }>;
};

export async function GET(_request: Request, { params }: TileRouteContext) {
  const { z, x, y } = await params;
  const backendUrl = process.env.BACKEND_INTERNAL_URL ?? "http://localhost:8000";

  try {
    const tile = await fetch(
      `${backendUrl}/api/tiles/${encodeURIComponent(z)}/${encodeURIComponent(x)}/${encodeURIComponent(y)}`,
      { headers: { Accept: "application/x-protobuf" } },
    );

    return new Response(await tile.arrayBuffer(), {
      status: tile.status,
      headers: {
        "Content-Type": tile.headers.get("Content-Type") ?? "application/x-protobuf",
        "Cache-Control": tile.headers.get("Cache-Control") ?? "no-store",
      },
    });
  } catch (error) {
    console.error("Failed to proxy map tile:", error);
    return NextResponse.json(
      { success: false, message: "Map tile service is unavailable" },
      { status: 502 },
    );
  }
}
