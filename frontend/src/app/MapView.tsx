"use client";

import mapboxgl, { type FilterSpecification, type Map as MapboxMap } from "mapbox-gl";
import { useEffect, useRef, useState } from "react";

type MapStats = {
  roads: number;
  potholes: number;
  high: number;
  medium: number;
  low: number;
};

type Severity = "high" | "medium" | "low";

const severityOptions: { value: Severity; label: string; color: string }[] = [
  { value: "high", label: "High", color: "#dc2626" },
  { value: "medium", label: "Medium", color: "#f59e0b" },
  { value: "low", label: "Low", color: "#16a34a" },
];

const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

const buildSeverityFilter = (
  selectedSeverities: Severity[],
  pointCountOperator: ">" | "<=",
): FilterSpecification => [
  "all",
  [pointCountOperator, ["get", "point_count"], 1],
  ["in", ["get", "severity"], ["literal", selectedSeverities]],
];

export default function MapView() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<MapboxMap | null>(null);
  const [stats, setStats] = useState<MapStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState<number | null>(null);
  const [selectedSeverities, setSelectedSeverities] = useState<Severity[]>([
    "high",
    "medium",
    "low",
  ]);
  const selectedSeveritiesRef = useRef(selectedSeverities);

  useEffect(() => {
    selectedSeveritiesRef.current = selectedSeverities;
  }, [selectedSeverities]);

  useEffect(() => {
    let active = true;

    fetch("/api/stats")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Unable to load road and pothole statistics.");
        }
        const result = await response.json();
        if (!result.success) {
          throw new Error(result.message ?? "Unable to load map statistics.");
        }
        return result as MapStats & { success: boolean };
      })
      .then((result) => {
        if (active) {
          setStats(result);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Unable to load map statistics.");
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const map = mapInstance.current;
    if (!map || !map.isStyleLoaded()) {
      return;
    }

    const clusterFilter = buildSeverityFilter(selectedSeverities, ">");
    const pointFilter = buildSeverityFilter(selectedSeverities, "<=");
    map.setFilter("pothole-clusters", clusterFilter);
    map.setFilter("pothole-cluster-count", clusterFilter);
    map.setFilter("pothole-points", pointFilter);
  }, [selectedSeverities]);

  useEffect(() => {
    if (!token || !mapContainer.current || mapInstance.current) {
      return;
    }

    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: [75.7139, 19.7515],
      zoom: 6,
      attributionControl: true,
    });

    mapInstance.current = map;
    setZoomLevel(map.getZoom());
    map.on("zoom", () => setZoomLevel(map.getZoom()));
    map.addControl(new mapboxgl.NavigationControl(), "top-right");
    map.on("error", (event) => {
      console.error("Mapbox map error:", event.error);
      setError("The map could not load. Check your Mapbox public token and network connection.");
    });
    map.on("load", () => {
      const activeSeverities = selectedSeveritiesRef.current;

      map.addSource("potholes", {
        type: "vector",
        tiles: [`${window.location.origin}/api/tiles/{z}/{x}/{y}?v=1`],
        minzoom: 0,
        maxzoom: 22,
        promoteId: "id",
      });

      map.addLayer({
        id: "pothole-clusters",
        type: "circle",
        source: "potholes",
        "source-layer": "potholes",
        filter: buildSeverityFilter(activeSeverities, ">"),
        paint: {
          "circle-color": [
            "match",
            ["get", "severity"],
            "high",
            "#dc2626",
            "medium",
            "#f59e0b",
            "low",
            "#16a34a",
            "#64748b",
          ],
          "circle-radius": [
            "step",
            ["get", "point_count"],
            9,
            10,
            12,
            50,
            16,
            200,
            21,
            1000,
            27,
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
          "circle-opacity": 0.88,
        },
      });

      map.addLayer({
        id: "pothole-cluster-count",
        type: "symbol",
        source: "potholes",
        "source-layer": "potholes",
        filter: buildSeverityFilter(activeSeverities, ">"),
        layout: {
          "text-field": ["to-string", ["get", "point_count"]],
          "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Regular"],
          "text-size": 11,
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": "#ffffff",
        },
      });

      map.addLayer({
        id: "pothole-points",
        type: "circle",
        source: "potholes",
        "source-layer": "potholes",
        filter: buildSeverityFilter(activeSeverities, "<="),
        paint: {
          "circle-color": [
            "match",
            ["get", "severity"],
            "high",
            "#dc2626",
            "medium",
            "#f59e0b",
            "low",
            "#16a34a",
            "#64748b",
          ],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3, 14, 6, 18, 9],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
          "circle-opacity": 0.88,
        },
      });

      map.on("click", "pothole-points", (event) => {
        const feature = map.queryRenderedFeatures(event.point, {
          layers: ["pothole-points"],
        })[0];
        if (!feature) {
          return;
        }

        const properties = feature.toJSON().properties;
        if (!properties) {
          return;
        }

        const content = document.createElement("div");
        content.className = "map-popup";
        const title = document.createElement("strong");
        title.textContent = `Pothole #${String(properties.id ?? "unknown")}`;
        const severity = document.createElement("span");
        severity.textContent = `Severity: ${String(properties.severity ?? "unknown")}`;
        content.append(title, severity);

        new mapboxgl.Popup({ closeButton: true })
          .setLngLat(event.lngLat)
          .setDOMContent(content)
          .addTo(map);
      });
      map.on("click", "pothole-clusters", (event) => {
        const feature = map.queryRenderedFeatures(event.point, {
          layers: ["pothole-clusters"],
        })[0];
        if (!feature) {
          return;
        }

        const coordinates = feature.toJSON().geometry;
        if (!coordinates) {
          return;
        }

        if (coordinates.type !== "Point") {
          return;
        }

        const [longitude, latitude] = coordinates.coordinates;
        if (typeof longitude !== "number" || typeof latitude !== "number") {
          return;
        }

        map.easeTo({
          center: [longitude, latitude],
          zoom: Math.min(map.getZoom() + 2, 22),
          duration: 400,
        });
      });
      map.on("mouseenter", "pothole-points", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "pothole-points", () => {
        map.getCanvas().style.cursor = "";
      });
      map.on("mouseenter", "pothole-clusters", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "pothole-clusters", () => {
        map.getCanvas().style.cursor = "";
      });
    });

    return () => {
      map.remove();
      mapInstance.current = null;
    };
  }, []);

  return (
    <main className="map-page">
      <header className="map-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">P</span>
          <div>
            <p className="eyebrow">Maharashtra road intelligence</p>
            <h1>Road condition map</h1>
          </div>
        </div>
        <div className="header-status">
          <span className="status-dot" />
          Live PostGIS data
        </div>
      </header>

      <section className="map-layout">
        <aside className="map-sidebar">
          <div>
            <p className="eyebrow">City overview</p>
            <h2>Potholes across Maharashtra</h2>
            <p className="sidebar-copy">
              Explore reported road issues. Zoom in to inspect individual locations.
            </p>
          </div>

          <div className="stat-card">
            <span className="stat-label">Potholes mapped</span>
            <strong>{stats?.potholes.toLocaleString() ?? "—"}</strong>
            <span className="stat-caption">Vector tiles load for the visible map area</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Road segments</span>
            <strong>{stats?.roads.toLocaleString() ?? "—"}</strong>
          </div>

          <div className="legend">
            <p className="stat-label">Severity</p>
            <div><span className="legend-dot high" />High <span>{stats?.high.toLocaleString() ?? "—"}</span></div>
            <div><span className="legend-dot medium" />Medium <span>{stats?.medium.toLocaleString() ?? "—"}</span></div>
            <div><span className="legend-dot low" />Low <span>{stats?.low.toLocaleString() ?? "—"}</span></div>
          </div>

          <div className="filter-panel">
            <p className="stat-label">Filter potholes</p>
            <div className="severity-toggle-group">
              {severityOptions.map(({ value, label, color }) => {
                const isActive = selectedSeverities.includes(value);
                return (
                  <button
                    key={value}
                    type="button"
                    className={`severity-toggle ${isActive ? "active" : ""}`}
                    aria-pressed={isActive}
                    onClick={() => {
                      setSelectedSeverities((current) => {
                        if (current.includes(value)) {
                          if (current.length === 1) {
                            return current;
                          }
                          return current.filter((item) => item !== value);
                        }
                        return [...current, value];
                      });
                    }}
                  >
                    <span className="legend-dot" style={{ background: color }} />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          {error && <p className="map-error" role="status">{error}</p>}
          {!token && (
            <div className="token-notice">
              <strong>Mapbox token required</strong>
              <p>
                Add a public Mapbox token as <code>NEXT_PUBLIC_MAPBOX_TOKEN</code>
                in the project root <code>.env</code>, then rebuild the frontend.
              </p>
            </div>
          )}
          <p className="sidebar-footnote">Map data is for demonstration purposes.</p>
        </aside>

        <div className="map-frame">
          <div className="map-container" ref={mapContainer} aria-label="Interactive map of Maharashtra potholes" />
          <div className="zoom-indicator" aria-live="polite">
            <span>Zoom</span>
            <strong>{zoomLevel === null ? "—" : zoomLevel.toFixed(1)}</strong>
          </div>
          {!token && (
            <div className="map-placeholder">
              <span className="placeholder-pin">●</span>
              <strong>Connect a Mapbox token to view the map</strong>
              <span>Your PostGIS data and map tiles are ready.</span>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
