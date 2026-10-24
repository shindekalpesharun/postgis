import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";

dotenv.config();

const app = express();
const CLUSTER_MAX_ZOOM = 8;

app.use(cors());
app.use(express.json());

app.get("/api/tiles/:z/:x/:y", async (req, res) => {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);

  if (
    !Number.isInteger(z) ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    z < 0 ||
    z > 22 ||
    x < 0 ||
    y < 0 ||
    x >= 2 ** z ||
    y >= 2 ** z
  ) {
    res.status(400).json({ success: false, message: "Invalid tile coordinates" });
    return;
  }

  try {
    const shouldCluster = z <= CLUSTER_MAX_ZOOM;
    const featuresQuery = shouldCluster
      ? Prisma.sql`
          SELECT
            NULL::bigint AS id,
            clusters.severity,
            NULL::bigint AS road_id,
            clusters.point_count,
            clusters.high_count,
            clusters.medium_count,
            clusters.low_count,
            ST_AsMVTGeom(
              ST_Transform(clusters.location::geometry, 3857),
              bounds.geom,
              4096,
              64,
              true
            ) AS geom
          FROM pothole_map_clusters AS clusters
          CROSS JOIN bounds
          CROSS JOIN bounds_geo
          WHERE clusters.location && bounds_geo.geom
        `
      : Prisma.sql`
          SELECT
            potholes.id,
            potholes.severity,
            potholes.road_id,
            1 AS point_count,
            CASE WHEN potholes.severity = 'high' THEN 1 ELSE 0 END AS high_count,
            CASE WHEN potholes.severity = 'medium' THEN 1 ELSE 0 END AS medium_count,
            CASE WHEN potholes.severity = 'low' THEN 1 ELSE 0 END AS low_count,
            ST_AsMVTGeom(
              ST_Transform(potholes.location::geometry, 3857),
              bounds.geom,
              4096,
              64,
              true
            ) AS geom
          FROM potholes
          CROSS JOIN bounds
          CROSS JOIN bounds_geo
          WHERE potholes.location && bounds_geo.geom
        `;
    const rows = await prisma.$queryRaw<
      { tile: Uint8Array | null; feature_count: number }[]
    >(
      Prisma.sql`
        WITH bounds AS (
          SELECT ST_TileEnvelope(${z}::int, ${x}::int, ${y}::int) AS geom
        ),
        bounds_geo AS (
          SELECT ST_Transform(geom, 4326)::geography AS geom
          FROM bounds
        ),
        features AS (${featuresQuery})
        SELECT
          ST_AsMVT(features, 'potholes', 4096, 'geom') AS tile,
          COUNT(*)::int AS feature_count
        FROM features
        WHERE geom IS NOT NULL
      `,
    );

    const tile = rows[0]?.tile ? Buffer.from(rows[0].tile) : Buffer.alloc(0);
    res
      .status(200)
      .set({
        "Content-Type": "application/x-protobuf",
        "Cache-Control": rows[0]?.feature_count
          ? "public, max-age=300, stale-while-revalidate=60"
          : "no-store",
      })
      .send(tile);
  } catch (error) {
    console.error("Failed to generate map tile:", error);
    res.status(500).json({ success: false, message: "Failed to generate map tile" });
  }
});

app.get("/api/stats", async (_req, res) => {
  try {
    const stats = await prisma.$queryRaw<
      { roads: number; potholes: number; high: number; medium: number; low: number }[]
    >`
      SELECT
        (SELECT COUNT(*)::int FROM roads) AS roads,
        COUNT(*)::int AS potholes,
        COUNT(*) FILTER (WHERE severity = 'high')::int AS high,
        COUNT(*) FILTER (WHERE severity = 'medium')::int AS medium,
        COUNT(*) FILTER (WHERE severity = 'low')::int AS low
      FROM potholes
    `;

    res.json({ success: true, ...stats[0] });
  } catch (error) {
    console.error("Failed to load map statistics:", error);
    res.status(500).json({ success: false, message: "Failed to load map statistics" });
  }
});

app.get("/api/db-test", async (_req, res) => {
  try {
    const result = await prisma.$queryRaw<
      { database: string; postgis_version: string }[]
    >`
      SELECT
        current_database() AS database,
        postgis_full_version() AS postgis_version
    `;

    res.json({ success: true, ...result[0] });
  } catch (error) {
    console.error("Database connection failed:", error);
    res.status(500).json({ success: false });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    message: "Rasta GIS API is running",
  });
});

const PORT = Number(process.env.PORT) || 5000;

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});