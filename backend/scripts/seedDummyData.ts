import { prisma } from "../src/db";

const DEFAULT_ROAD_TARGET = 10_000;
const DEFAULT_POTHOLE_TARGET = 100_000;
const POTHOLE_BATCH_SIZE = 25_000;
const MAHARASHTRA_BOUNDS = {
  minLongitude: 72.6,
  maxLongitude: 80.9,
  minLatitude: 15.6,
  maxLatitude: 22.1,
};

function parseTarget(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  const target = Number(value);
  if (!Number.isSafeInteger(target) || target < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }

  return target;
}

function parseArguments(args: string[]): {
  roadTarget: number;
  potholeTarget: number;
  resetGeneratedData: boolean;
  refreshMapClusters: boolean;
} {
  const positional: string[] = [];
  let resetGeneratedData = false;
  let refreshClusters = false;

  for (const argument of args) {
    if (argument === "--reset-generated") {
      if (resetGeneratedData) {
        throw new Error("--reset-generated can only be specified once.");
      }
      resetGeneratedData = true;
    } else if (argument === "--refresh-map-clusters") {
      if (refreshClusters) {
        throw new Error("--refresh-map-clusters can only be specified once.");
      }
      refreshClusters = true;
    } else if (argument === "--") {
      continue;
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }

  if (positional.length > 2) {
    throw new Error(
      "Usage: npm run db:seed:dummy -- [--reset-generated] [--refresh-map-clusters] [road-target] [pothole-target]",
    );
  }

  return {
    roadTarget: parseTarget(positional[0], DEFAULT_ROAD_TARGET, "Road target"),
    potholeTarget: parseTarget(
      positional[1],
      DEFAULT_POTHOLE_TARGET,
      "Pothole target",
    ),
    resetGeneratedData,
    refreshMapClusters: refreshClusters,
  };
}

async function getCounts(): Promise<{ roads: number; potholes: number }> {
  const counts = await prisma.$queryRaw<
    { roads: bigint; potholes: bigint }[]
  >`
    SELECT
      (SELECT COUNT(*) FROM roads) AS roads,
      (SELECT COUNT(*) FROM potholes) AS potholes
  `;

  return {
    roads: Number(counts[0].roads),
    potholes: Number(counts[0].potholes),
  };
}

async function createRoads(count: number): Promise<number> {
  if (count === 0) {
    return 0;
  }

  return prisma.$executeRaw`
    WITH current_code AS (
      SELECT COALESCE(
        MAX(SUBSTRING(road_code FROM 'MH-DUMMY-ROAD-([0-9]+)')::bigint),
        0
      ) AS last_number
      FROM roads
      WHERE road_code LIKE 'MH-DUMMY-ROAD-%'
    ),
    generated AS (
      SELECT
        current_code.last_number + series.sequence AS road_number,
        ${MAHARASHTRA_BOUNDS.minLongitude} + random() * ${MAHARASHTRA_BOUNDS.maxLongitude - MAHARASHTRA_BOUNDS.minLongitude} AS longitude,
        ${MAHARASHTRA_BOUNDS.minLatitude} + random() * ${MAHARASHTRA_BOUNDS.maxLatitude - MAHARASHTRA_BOUNDS.minLatitude} AS latitude,
        (random() - 0.5) * 0.01 AS longitude_delta,
        (random() - 0.5) * 0.01 AS latitude_delta
      FROM generate_series(1, ${count}) AS series(sequence)
      CROSS JOIN current_code
    )
    INSERT INTO roads (road_name, road_code, location)
    SELECT
      'Maharashtra Dummy Road ' || generated.road_number,
      'MH-DUMMY-ROAD-' || LPAD(generated.road_number::text, 6, '0'),
      ST_MakeLine(
        ST_SetSRID(
          ST_MakePoint(generated.longitude, generated.latitude),
          4326
        ),
        ST_SetSRID(
          ST_MakePoint(
            generated.longitude + generated.longitude_delta,
            generated.latitude + generated.latitude_delta
          ),
          4326
        )
      )::geography
    FROM generated
    ON CONFLICT (road_code) DO NOTHING
  `;
}

async function createPotholes(count: number): Promise<number> {
  const roadRows = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM roads
    WHERE location IS NOT NULL
  `;
  const roadCount = roadRows[0]?.count ?? 0;

  if (count > 0 && roadCount === 0) {
    throw new Error("Cannot create potholes because no roads have locations.");
  }

  let inserted = 0;

  while (inserted < count) {
    const batchSize = Math.min(POTHOLE_BATCH_SIZE, count - inserted);
    const batchInserted = await prisma.$executeRaw`
      WITH road_catalog AS MATERIALIZED (
        SELECT
          ARRAY_AGG(id ORDER BY id) AS road_ids,
          ARRAY_AGG(location::geometry ORDER BY id) AS road_geometries
        FROM roads
        WHERE location IS NOT NULL
      ),
      generated AS (
        SELECT
          series.sequence,
          CASE FLOOR(random() * 10)::int
            WHEN 0 THEN 'high'
            WHEN 1 THEN 'high'
            WHEN 2 THEN 'medium'
            WHEN 3 THEN 'medium'
            WHEN 4 THEN 'medium'
            WHEN 5 THEN 'medium'
            ELSE 'low'
          END AS severity,
          random() AS line_fraction,
          (random() - 0.5) * 0.001 AS longitude_offset,
          (random() - 0.5) * 0.001 AS latitude_offset
        FROM generate_series(1, ${batchSize}) AS series(sequence)
      )
      INSERT INTO potholes (road_id, severity, location)
      SELECT
        road_catalog.road_ids[road_index.value],
        generated.severity,
        ST_SetSRID(
          ST_MakePoint(
            ST_X(line.point) + generated.longitude_offset,
            ST_Y(line.point) + generated.latitude_offset
          ),
          4326
        )::geography
      FROM generated
      CROSS JOIN road_catalog
      CROSS JOIN LATERAL (
        SELECT MOD(
          generated.sequence - 1,
          CARDINALITY(road_catalog.road_ids)
        ) + 1 AS value
      ) AS road_index
      CROSS JOIN LATERAL (
        SELECT ST_LineInterpolatePoint(
          road_catalog.road_geometries[road_index.value],
          generated.line_fraction
        ) AS point
      ) AS line
    `;

    inserted += batchInserted;
    console.log(`Generated ${inserted.toLocaleString()} of ${count.toLocaleString()} potholes.`);
  }

  return inserted;
}

async function ensureMapClusterTable(): Promise<void> {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS pothole_map_clusters (
      cell_x INTEGER NOT NULL,
      cell_y INTEGER NOT NULL,
      location GEOGRAPHY(POINT, 4326) NOT NULL,
      severity TEXT NOT NULL,
      point_count INTEGER NOT NULL,
      high_count INTEGER NOT NULL,
      medium_count INTEGER NOT NULL,
      low_count INTEGER NOT NULL,
      PRIMARY KEY (cell_x, cell_y)
    )
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS pothole_map_clusters_location_idx
    ON pothole_map_clusters USING GIST (location)
  `;
}

async function refreshMapClusters(): Promise<number> {
  await ensureMapClusterTable();
  await prisma.$executeRaw`TRUNCATE TABLE pothole_map_clusters`;

  const inserted = await prisma.$executeRaw`
    INSERT INTO pothole_map_clusters (
      cell_x,
      cell_y,
      location,
      severity,
      point_count,
      high_count,
      medium_count,
      low_count
    )
    SELECT
      FLOOR((ST_X(location::geometry) + 180) / 0.04)::INTEGER AS cell_x,
      FLOOR((ST_Y(location::geometry) + 90) / 0.04)::INTEGER AS cell_y,
      ST_SetSRID(
        ST_MakePoint(
          AVG(ST_X(location::geometry)),
          AVG(ST_Y(location::geometry))
        ),
        4326
      )::geography AS location,
      CASE
        WHEN COUNT(*) FILTER (WHERE severity = 'high') >= COUNT(*) FILTER (WHERE severity = 'medium')
         AND COUNT(*) FILTER (WHERE severity = 'high') >= COUNT(*) FILTER (WHERE severity = 'low')
          THEN 'high'
        WHEN COUNT(*) FILTER (WHERE severity = 'medium') >= COUNT(*) FILTER (WHERE severity = 'low')
          THEN 'medium'
        ELSE 'low'
      END AS severity,
      COUNT(*)::INTEGER AS point_count,
      COUNT(*) FILTER (WHERE severity = 'high')::INTEGER AS high_count,
      COUNT(*) FILTER (WHERE severity = 'medium')::INTEGER AS medium_count,
      COUNT(*) FILTER (WHERE severity = 'low')::INTEGER AS low_count
    FROM potholes
    GROUP BY cell_x, cell_y
  `;

  return inserted;
}

async function resetGeneratedData(): Promise<"truncate" | "delete"> {
  await ensureMapClusterTable();
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS potholes_road_id_idx
    ON potholes (road_id)
  `;

  const resetSafety = await prisma.$queryRaw<
    { roads_are_generated: boolean; potholes_are_generated: boolean }[]
  >`
    SELECT
      NOT EXISTS (
        SELECT 1
        FROM roads
        WHERE NOT (
          road_code LIKE 'PUNE-DUMMY-ROAD-%'
          OR road_code LIKE 'INDIA-DUMMY-ROAD-%'
          OR road_code LIKE 'MH-DUMMY-ROAD-%'
          OR road_code IN (
            'PUNE-ROAD-001',
            'PUNE-ROAD-002',
            'PUNE-ROAD-003',
            'PUNE-ROAD-004',
            'PUNE-ROAD-005'
          )
        )
      ) AS roads_are_generated,
      NOT EXISTS (
        SELECT 1
        FROM potholes
        WHERE road_id IS NULL
      ) AS potholes_are_generated
  `;

  if (resetSafety[0].roads_are_generated && resetSafety[0].potholes_are_generated) {
    await prisma.$executeRaw`TRUNCATE TABLE potholes, roads RESTART IDENTITY`;
    await prisma.$executeRaw`TRUNCATE TABLE pothole_map_clusters`;
    return "truncate";
  }

  await prisma.$executeRaw`
    DELETE FROM potholes
    WHERE road_id IN (
      SELECT id
      FROM roads
      WHERE road_code LIKE 'PUNE-DUMMY-ROAD-%'
         OR road_code LIKE 'INDIA-DUMMY-ROAD-%'
         OR road_code LIKE 'MH-DUMMY-ROAD-%'
         OR road_code IN (
           'PUNE-ROAD-001',
           'PUNE-ROAD-002',
           'PUNE-ROAD-003',
           'PUNE-ROAD-004',
           'PUNE-ROAD-005'
         )
    )
  `;
  await prisma.$executeRaw`
    DELETE FROM roads
    WHERE road_code LIKE 'PUNE-DUMMY-ROAD-%'
       OR road_code LIKE 'INDIA-DUMMY-ROAD-%'
       OR road_code LIKE 'MH-DUMMY-ROAD-%'
       OR road_code IN (
         'PUNE-ROAD-001',
         'PUNE-ROAD-002',
         'PUNE-ROAD-003',
         'PUNE-ROAD-004',
         'PUNE-ROAD-005'
       )
  `;
  await prisma.$executeRaw`TRUNCATE TABLE pothole_map_clusters`;
  return "delete";
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));

  if (options.resetGeneratedData) {
    const resetMethod = await resetGeneratedData();
    console.log(
      resetMethod === "truncate"
        ? "Fast-reset generated roads and potholes."
        : "Removed generated roads and their potholes while preserving other records.",
    );
  }

  const { roadTarget, potholeTarget, refreshMapClusters: forceClusterRefresh } = options;
  let counts = await getCounts();
  const roadsToInsert = Math.max(0, roadTarget - counts.roads);
  const potholesToInsert = Math.max(0, potholeTarget - counts.potholes);

  if (potholesToInsert > 0 && roadTarget === 0 && roadsToInsert === 0) {
    throw new Error("Cannot create potholes without at least one road.");
  }

  const insertedRoads = await createRoads(roadsToInsert);
  const totalRoads = counts.roads + insertedRoads;

  if (potholesToInsert > 0 && totalRoads === 0) {
    throw new Error("Cannot create potholes because the roads table is empty.");
  }

  const insertedPotholes = await createPotholes(potholesToInsert);
  const totalPotholes = counts.potholes + insertedPotholes;
  await ensureMapClusterTable();
  const clusterRows = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM pothole_map_clusters
  `;
  const shouldRefreshClusters = forceClusterRefresh || insertedPotholes > 0 ||
    (totalPotholes > 0 && clusterRows[0].count === 0);
  const clusterCount = shouldRefreshClusters
    ? await refreshMapClusters()
    : clusterRows[0].count;

  console.log(
    [
      `Inserted ${insertedRoads} Maharashtra roads and ${insertedPotholes} potholes.`,
      `Totals: ${totalRoads} roads, ${totalPotholes} potholes.`,
      `Map cluster cells ready: ${clusterCount}.`,
      `Requested targets: ${roadTarget} roads, ${potholeTarget} potholes.`,
    ].join("\n"),
  );
}

main()
  .catch((error: unknown) => {
    console.error("Failed to generate Maharashtra dummy data:", error);
    process.exitCode = 1;
  })
   .finally(async () => {
    await prisma.$disconnect();
  });
