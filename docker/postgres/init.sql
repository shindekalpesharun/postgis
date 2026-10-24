CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS roads (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    road_name TEXT NOT NULL,
    road_code TEXT UNIQUE,
    location GEOGRAPHY(LINESTRING, 4326),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS potholes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    road_id BIGINT REFERENCES roads(id),
    severity TEXT NOT NULL,
    location GEOGRAPHY(POINT, 4326) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS roads_location_idx
    ON roads USING GIST (location);

CREATE INDEX IF NOT EXISTS potholes_location_idx
    ON potholes USING GIST (location);

CREATE INDEX IF NOT EXISTS potholes_road_id_idx
    ON potholes (road_id);

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
);

CREATE INDEX IF NOT EXISTS pothole_map_clusters_location_idx
    ON pothole_map_clusters USING GIST (location);

INSERT INTO roads (road_name, road_code, location)
VALUES
    (
        'FC Road',
        'PUNE-ROAD-001',
        ST_GeogFromText(
            'LINESTRING(73.8410 18.5190, 73.8420 18.5200, 73.8430 18.5210)'
        )
    ),
    (
        'JM Road',
        'PUNE-ROAD-002',
        ST_GeogFromText(
            'LINESTRING(73.8470 18.5200, 73.8480 18.5220, 73.8490 18.5240)'
        )
    ),
    (
        'Baner Road',
        'PUNE-ROAD-003',
        ST_GeogFromText(
            'LINESTRING(73.7790 18.5590, 73.7850 18.5610, 73.7910 18.5630)'
        )
    ),
    (
        'Paud Road',
        'PUNE-ROAD-004',
        ST_GeogFromText(
            'LINESTRING(73.8000 18.5070, 73.8050 18.5100, 73.8100 18.5130)'
        )
    ),
    (
        'Karve Road',
        'PUNE-ROAD-005',
        ST_GeogFromText(
            'LINESTRING(73.8260 18.5010, 73.8300 18.5040, 73.8340 18.5070)'
        )
    )
ON CONFLICT (road_code) DO NOTHING;

INSERT INTO potholes (road_id, severity, location)
SELECT
    roads.id,
    sample.severity,
    ST_SetSRID(ST_MakePoint(sample.longitude, sample.latitude), 4326)::geography
FROM (
    VALUES
        ('PUNE-ROAD-001', 'high',   73.8415, 18.5195),
        ('PUNE-ROAD-001', 'medium', 73.8420, 18.5200),
        ('PUNE-ROAD-001', 'low',    73.8425, 18.5205),
        ('PUNE-ROAD-002', 'high',   73.8475, 18.5205),
        ('PUNE-ROAD-002', 'medium', 73.8480, 18.5220),
        ('PUNE-ROAD-003', 'high',   73.7820, 18.5600),
        ('PUNE-ROAD-003', 'low',    73.7870, 18.5620),
        ('PUNE-ROAD-004', 'medium', 73.8020, 18.5080),
        ('PUNE-ROAD-004', 'high',   73.8070, 18.5110),
        ('PUNE-ROAD-005', 'low',    73.8310, 18.5050)
) AS sample(road_code, severity, longitude, latitude)
JOIN roads ON roads.road_code = sample.road_code
WHERE NOT EXISTS (
    SELECT 1
    FROM potholes
    WHERE potholes.road_id = roads.id
      AND ST_X(potholes.location::geometry) = sample.longitude
      AND ST_Y(potholes.location::geometry) = sample.latitude
);

TRUNCATE TABLE pothole_map_clusters;

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
GROUP BY cell_x, cell_y;
