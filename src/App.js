import './App.css';
import 'leaflet/dist/leaflet.css';
import '@mdi/font/css/materialdesignicons.min.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Rectangle, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';

// In development, CRA's proxy (defined in package.json) will forward this
// relative path to https://app.driverschat.com to avoid CORS issues.
const API_URL = '/api/messages/warning-messages';
const AUTH_TOKEN = process.env.REACT_APP_X_AUTH;

const warningMarkerIcon = L.divIcon({
  className: 'custom-marker-icon',
  html: '<i class="mdi mdi-map-marker-alert"></i>',
  iconSize: [32, 32],
  iconAnchor: [16, 32],
});

const POLICE_BADGE_SVG = `
  <svg
    class="police-marker-icon__svg"
    width="44"
    height="44"
    viewBox="0 0 64 64"
    role="img"
    aria-hidden="true"
  >
    <path
      d="M32 6c8 6 16 7 22 8v18c0 15-9 23-22 28C19 55 10 47 10 32V14c6-1 14-2 22-8z"
      fill="#1565c0"
      stroke="#ffffff"
      stroke-width="3"
      stroke-linejoin="round"
    />
    <path
      d="M32 13c6 4 12 5 16 6v13c0 10-6 15-16 20-10-5-16-10-16-20V19c4-1 10-2 16-6z"
      fill="#1e88e5"
      opacity="0.95"
    />
    <path
      d="M32 22l2.9 6.3 6.8.6-5.2 4.5 1.6 6.7-6.1-3.5-6.1 3.5 1.6-6.7-5.2-4.5 6.8-.6L32 22z"
      fill="#ffeb3b"
      stroke="#0d47a1"
      stroke-width="1.4"
      stroke-linejoin="round"
    />
  </svg>
`;

function buildPoliceMarkerHtml(count) {
  return `
    <div class="police-marker-icon__wrap" aria-label="Police">
      ${POLICE_BADGE_SVG}
    </div>
  `;
}

const policeMarkerIcon = L.divIcon({
  className: 'police-marker-icon',
  // Inline SVG so it always renders (no reliance on icon-font glyph names)
  html: buildPoliceMarkerHtml(1),
  iconSize: [44, 44],
  iconAnchor: [22, 44],
});

const SPEED_CAMERA_SVG = `
  <svg
    class="speedcam-marker-icon__svg"
    width="34"
    height="34"
    viewBox="0 0 64 64"
    role="img"
    aria-hidden="true"
  >
    <path
      d="M10 22c0-4 3-7 7-7h30c4 0 7 3 7 7v20c0 4-3 7-7 7H17c-4 0-7-3-7-7V22z"
      fill="#0b0b0b"
      stroke="#ffffff"
      stroke-width="3"
      stroke-linejoin="round"
    />
    <circle cx="32" cy="32" r="10" fill="#1e88e5" stroke="#ffffff" stroke-width="3" />
    <circle cx="32" cy="32" r="4" fill="#0b0b0b" />
    <path
      d="M20 15l6-7h12l6 7"
      fill="#ffeb3b"
      stroke="#0b0b0b"
      stroke-width="3"
      stroke-linejoin="round"
    />
  </svg>
`;

const speedCamMarkerIcon = L.divIcon({
  className: 'speedcam-marker-icon',
  html: `
    <div class="speedcam-marker-icon__wrap" aria-label="Speed camera">
      ${SPEED_CAMERA_SVG}
    </div>
  `,
  iconSize: [34, 34],
  iconAnchor: [17, 34],
});

const WAZE_ALERTS_BASE_URL = '/waze/live-map/api/georss?types=alerts';
const MAX_WAZE_TILE_BOXES_PER_REQUEST = 24;
const MIN_WAZE_FETCH_INTERVAL_MS = 2500;
const DEFAULT_WAZE_RETRY_AFTER_SEC = 30;
const POLICE_CLUSTER_RADIUS_METERS = 200;
const SPEED_RADAR_CLUSTER_RADIUS_METERS = 200;
const SPEED_RADARS_WORLD_CSV_URL = `${process.env.PUBLIC_URL || ''}/SCDB_Speed.csv`;
const MIN_SPEED_RADAR_RENDER_ZOOM = 6;
const MAX_VISIBLE_SPEED_RADARS = 8000;
const SPEED_RADAR_VIEW_PADDING_METERS = 50_000;

function inferWazeEnvFromBounds(bounds) {
  if (!bounds) return 'na';
  const center = bounds.getCenter();
  const lat = center.lat;
  const lng = normalizeLng(center.lng);
  // Heuristic: North America longitudes roughly [-170, -30]
  if (lng <= -30 && lng >= -170 && lat >= 5 && lat <= 85) return 'na';
  return 'row';
}

function isPoliceAlert(alert) {
  const type = String(alert?.type || '').toLowerCase();
  const subtype = String(alert?.subtype || '').toLowerCase();
  return type.includes('police') || subtype.includes('police');
}

function normalizeLng(lng) {
  // Leaflet can return longitudes outside [-180, 180] when the map wraps.
  // Normalize for upstream APIs that expect standard lon range.
  const n = ((lng + 180) % 360 + 360) % 360 - 180;
  // Avoid returning -180 when 180 is more intuitive at the boundary.
  return n === -180 ? 180 : n;
}

function clampLat(lat) {
  // WebMercator practical max latitude
  return Math.max(Math.min(lat, 85.05112878), -85.05112878);
}

function haversineMeters(a, b) {
  const R = 6371000; // meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function clusterPoliceAlerts(alerts, radiusMeters) {
  // Simple greedy clustering (good enough for typical alert counts).
  // Each cluster has a representative "center" (average lat/lng) and items.
  const remaining = alerts.slice();
  const clusters = [];

  while (remaining.length) {
    const seed = remaining.pop();
    const cluster = [seed];
    let changed = true;

    // Pull in points that are close to ANY point in the cluster (single-linkage).
    while (changed) {
      changed = false;
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        const candidate = remaining[i];
        const nearAny = cluster.some(
          (p) => haversineMeters(p.location, candidate.location) <= radiusMeters
        );
        if (nearAny) {
          cluster.push(candidate);
          remaining.splice(i, 1);
          changed = true;
        }
      }
    }

    // Center as average lat/lng
    const center = cluster.reduce(
      (acc, p) => {
        acc.lat += p.location.lat;
        acc.lng += p.location.lng;
        return acc;
      },
      { lat: 0, lng: 0 }
    );
    center.lat /= cluster.length;
    center.lng /= cluster.length;

    // Primary (for popup details): latest pubMillis
    const primary = cluster.reduce((best, cur) => {
      const bestTs = best?.pubMillis || 0;
      const curTs = cur?.pubMillis || 0;
      return curTs >= bestTs ? cur : best;
    }, cluster[0]);

    clusters.push({
      id: primary?.id || `${center.lat}-${center.lng}-${cluster.length}`,
      center,
      primary,
      count: cluster.length,
      items: cluster,
    });
  }

  return clusters;
}

function clusterPoints(points, radiusMeters) {
  // Generic clustering for points shaped like { lat, lng, ... }.
  const remaining = points.slice();
  const clusters = [];

  while (remaining.length) {
    const seed = remaining.pop();
    const cluster = [seed];
    let changed = true;

    while (changed) {
      changed = false;
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        const candidate = remaining[i];
        const nearAny = cluster.some(
          (p) => haversineMeters({ lat: p.lat, lng: p.lng }, { lat: candidate.lat, lng: candidate.lng }) <= radiusMeters
        );
        if (nearAny) {
          cluster.push(candidate);
          remaining.splice(i, 1);
          changed = true;
        }
      }
    }

    const center = cluster.reduce(
      (acc, p) => {
        acc.lat += p.lat;
        acc.lng += p.lng;
        return acc;
      },
      { lat: 0, lng: 0 }
    );
    center.lat /= cluster.length;
    center.lng /= cluster.length;

    const primary = cluster[0];

    clusters.push({
      id: primary?.id || `${center.lat}-${center.lng}-${cluster.length}`,
      center,
      count: cluster.length,
      items: cluster,
      primary,
    });
  }

  return clusters;
}

function parseSpeedRadarCsv(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const points = [];

  for (const line of lines) {
    const firstComma = line.indexOf(',');
    const secondComma = firstComma >= 0 ? line.indexOf(',', firstComma + 1) : -1;
    if (firstComma < 0 || secondComma < 0) continue;

    // Format seems to be: lng,lat,<desc...>[,]<[id]>...
    const lngStr = line.slice(0, firstComma).trim();
    const latStr = line.slice(firstComma + 1, secondComma).trim();
    const rest = line.slice(secondComma + 1);

    const lng = Number(lngStr);
    const lat = Number(latStr);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const idMatch = rest.match(/\[([^\]]+)\]/);
    if (!idMatch) continue;
    const id = String(idMatch[1]).trim();

    const bracketIdx = rest.indexOf('[');
    let desc = bracketIdx >= 0 ? rest.slice(0, bracketIdx).trim() : '';
    if (desc.startsWith('"') && desc.endsWith('"')) desc = desc.slice(1, -1);

    points.push({ id, lat, lng, desc });
  }

  const byId = new Map(points.map((p) => [p.id, p]));
  return Array.from(byId.values());
}

function isPointInBounds(point, bounds) {
  if (!bounds) return false;
  const north = bounds.getNorth();
  const south = bounds.getSouth();
  const west = normalizeLng(bounds.getWest());
  const east = normalizeLng(bounds.getEast());

  if (point.lat > north || point.lat < south) return false;

  const lng = normalizeLng(point.lng);
  // Handle dateline crossing
  if (west > east) {
    return lng >= west || lng <= east;
  }
  return lng >= west && lng <= east;
}

function isPointInBoundsPadded(point, bounds, padMeters) {
  if (!bounds) return false;
  const c = bounds.getCenter();
  const latPad = padMeters / 111320; // ~ meters per degree latitude
  const lngPad =
    padMeters / (111320 * Math.max(0.15, Math.cos((c.lat * Math.PI) / 180))); // avoid blowups near poles

  const padded = L.latLngBounds(
    [bounds.getSouth() - latPad, bounds.getWest() - lngPad],
    [bounds.getNorth() + latPad, bounds.getEast() + lngPad]
  );
  return isPointInBounds(point, padded);
}

// WebMercator tile math (slippy map)
function lng2tileX(lng, z) {
  const n = 2 ** z;
  return Math.floor(((lng + 180) / 360) * n);
}
function lat2tileY(lat, z) {
  const n = 2 ** z;
  const latRad = (clampLat(lat) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
}
function tileX2lng(x, z) {
  const n = 2 ** z;
  return (x / n) * 360 - 180;
}
function tileY2lat(y, z) {
  const n = 2 ** z;
  const rad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return (rad * 180) / Math.PI;
}

function getNormalizedBoundsForDisplay(bounds) {
  if (!bounds) return null;
  const north = bounds.getNorth();
  const south = bounds.getSouth();
  const west = normalizeLng(bounds.getWest());
  const east = normalizeLng(bounds.getEast());
  return { north, south, west, east };
}

function buildWazeAlertsUrlsFromBoxes(boxes, env) {
  return boxes.map((b) => {
    const params = new URLSearchParams({
      env: String(env || 'na'),
      top: String(b.top),
      bottom: String(b.bottom),
      left: String(b.left),
      right: String(b.right),
    });
    return `${WAZE_ALERTS_BASE_URL}&${params.toString()}`;
  });
}

function parseRetryAfterToMs(retryAfterValue) {
  if (!retryAfterValue) return DEFAULT_WAZE_RETRY_AFTER_SEC * 1000;
  const asNumber = Number(retryAfterValue);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber * 1000;
  const asDate = Date.parse(retryAfterValue);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return DEFAULT_WAZE_RETRY_AFTER_SEC * 1000;
}

function buildWazeTileSnappedQuery(bounds, zoom) {
  // We compute tile-aligned boxes (for Waze-like snapping and optional debug rendering),
  // but we only REQUEST a union bounding box per longitudinal span to avoid 429s.
  // If too many tiles would be covered, we lower the zoom used for the query.
  if (!bounds) return { requestBoxes: [], debugBoxes: [], usedZoom: zoom };

  const north = clampLat(bounds.getNorth());
  const south = clampLat(bounds.getSouth());
  const west = normalizeLng(bounds.getWest());
  const east = normalizeLng(bounds.getEast());

  // Handle dateline crossing by splitting into two longitudinal spans.
  const spans = west > east ? [{ west, east: 180 }, { west: -180, east }] : [{ west, east }];

  let z = Math.max(0, Math.min(22, Math.round(zoom)));

  const computeAtZoom = (zz) => {
    const debugBoxes = [];
    const requestBoxes = [];

    for (const span of spans) {
      // Avoid edge-case where east=180 maps to x=n (one past last tile).
      const safeEast = span.east >= 180 ? 179.999999 : span.east;
      // Avoid edge-case where south hits the WebMercator extreme and maps outside the last tile row.
      const safeSouth = south <= -85.05112878 ? -85.05112877 : south;

      // For tile ranges, we treat "top" as north and "bottom" as south.
      const xMin = lng2tileX(span.west, zz);
      const xMax = lng2tileX(safeEast, zz);
      const yMin = lat2tileY(north, zz);
      const yMax = lat2tileY(safeSouth, zz);

      // Union box aligned to tile edges (one request per span)
      const unionLeft = tileX2lng(xMin, zz);
      const unionRight = tileX2lng(xMax + 1, zz);
      const unionTop = tileY2lat(yMin, zz);
      const unionBottom = tileY2lat(yMax + 1, zz);
      requestBoxes.push({ top: unionTop, bottom: unionBottom, left: unionLeft, right: unionRight });

      for (let x = xMin; x <= xMax; x += 1) {
        // Keep X in [0..n-1] (for dateline split spans, xMin..xMax is already in-range)
        const left = tileX2lng(x, zz);
        const right = tileX2lng(x + 1, zz);

        for (let y = yMin; y <= yMax; y += 1) {
          const top = tileY2lat(y, zz);
          const bottom = tileY2lat(y + 1, zz);
          debugBoxes.push({ top, bottom, left, right });
        }
      }
    }

    return { requestBoxes, debugBoxes, tileCount: debugBoxes.length };
  };

  let computed = computeAtZoom(z);
  while (computed.tileCount > MAX_WAZE_TILE_BOXES_PER_REQUEST && z > 0) {
    z -= 1;
    computed = computeAtZoom(z);
  }

  return { ...computed, usedZoom: z };
}

function MapBoundsWatcher({ onViewChange }) {
  const map = useMapEvents({
    moveend: () => onViewChange({ bounds: map.getBounds(), zoom: map.getZoom() }),
    zoomend: () => onViewChange({ bounds: map.getBounds(), zoom: map.getZoom() }),
  });

  useEffect(() => {
    onViewChange({ bounds: map.getBounds(), zoom: map.getZoom() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

function MapInstanceBridge({ onMap }) {
  const map = useMap();

  useEffect(() => {
    onMap(map);
    return () => onMap(null);
  }, [map, onMap]);

  return null;
}

function App() {
  const [warnings, setWarnings] = useState([]);
  const audioRef = useRef(null);
  const [mapInstance, setMapInstance] = useState(null);
  const [mapBounds, setMapBounds] = useState(null);
  const [mapZoom, setMapZoom] = useState(4);
  const [showWazeBoxes, setShowWazeBoxes] = useState(false);
  const [wazeEnvMode, setWazeEnvMode] = useState('auto'); // 'auto' | 'na' | 'row'
  const [mapStyle, setMapStyle] = useState('osm'); // 'cartoLight' | 'cartoDark' | 'cartoVoyager' | 'osm'

  const [policeAlerts, setPoliceAlerts] = useState([]);
  const [policeLoading, setPoliceLoading] = useState(false);
  const [policeError, setPoliceError] = useState('');
  const [policeLastUpdatedAt, setPoliceLastUpdatedAt] = useState(null);
  const policeBackoffUntilRef = useRef(0);
  const policeLastFetchAtRef = useRef(0);
  const policeLastQueryKeyRef = useRef('');

  const [showSpeedRadars, setShowSpeedRadars] = useState(true);
  const [speedRadarsWorld, setSpeedRadarsWorld] = useState([]);
  const [speedRadarsWorldError, setSpeedRadarsWorldError] = useState('');
  const [speedRadarsWorldName, setSpeedRadarsWorldName] = useState('');
  const [speedRadarsWorldLoading, setSpeedRadarsWorldLoading] = useState(false);

  useEffect(() => {
    let isMounted = true;

    const fetchWarnings = async () => {
      if (!AUTH_TOKEN) {
        // Fail fast in console if token is not configured
        console.error('Missing REACT_APP_X_AUTH environment variable');
        return;
      }

      try {
        const res = await fetch(API_URL, {
          headers: {
            'X-Auth': AUTH_TOKEN,
          },
        });

        if (!res.ok) {
          console.error('Failed to fetch warning messages:', res.status, res.statusText);
          return;
        }

        const data = await res.json();
        if (!isMounted || !Array.isArray(data)) return;

        // Keep a "session" of current markers and only add/remove changed ones
        setWarnings((prev) => {
          const prevById = new Map(prev.map((w) => [w.id, w]));
          const next = [];

          for (const item of data) {
            if (!item || !item.point || item.point.length !== 2) continue;

            const id = `${item.userId}-${item.url}-${item.created}`;
            const existing = prevById.get(id);

            const warning = existing || {
              id,
              userId: item.userId,
              url: item.url,
              point: item.point,
              created: item.created,
            };

            next.push(warning);
          }

          // Any items that disappeared from the API response will be dropped here,
          // so they are removed from the map automatically.
          return next;
        });
      } catch (err) {
        console.error('Error fetching warning messages:', err);
      }
    };

    // Initial load
    fetchWarnings();
    // Poll every 60 seconds
    const intervalId = setInterval(fetchWarnings, 60_000);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    // Load worldwide radars by default from public/SCDB_Speed.csv
    let isMounted = true;
    const controller = new AbortController();

    const run = async () => {
      setSpeedRadarsWorldError('');
      setSpeedRadarsWorldLoading(true);
      try {
        const res = await fetch(SPEED_RADARS_WORLD_CSV_URL, { signal: controller.signal });
        if (!res.ok) throw new Error(`Failed to load speed radars CSV (world) (${res.status})`);
        const text = await res.text();
        const parsed = parseSpeedRadarCsv(text);
        if (isMounted) {
          setSpeedRadarsWorld(parsed);
          setSpeedRadarsWorldName('SCDB_Speed.csv');
        }
      } catch (err) {
        if (!controller.signal.aborted && isMounted) {
          setSpeedRadarsWorldError(err?.message || 'Failed to load speed radars (world)');
        }
      } finally {
        if (!controller.signal.aborted && isMounted) setSpeedRadarsWorldLoading(false);
      }
    };

    run();

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!mapBounds) return;

    const controller = new AbortController();
    const debounceMs = 650;
    let timeoutId = null;

    const run = async () => {
      const now = Date.now();
      if (now < policeBackoffUntilRef.current) {
        const waitSec = Math.ceil((policeBackoffUntilRef.current - now) / 1000);
        setPoliceError(`Rate limited by Waze (429). Retrying in ~${waitSec}s…`);
        setPoliceLoading(false);
        return;
      }

      if (now - policeLastFetchAtRef.current < MIN_WAZE_FETCH_INTERVAL_MS) {
        // Too soon since last successful attempt; skip to avoid 429.
        return;
      }

      setPoliceLoading(true);
      setPoliceError('');

      try {
        const env = wazeEnvMode === 'auto' ? inferWazeEnvFromBounds(mapBounds) : wazeEnvMode;
        const { requestBoxes } = buildWazeTileSnappedQuery(mapBounds, mapZoom);
        const queryKey = JSON.stringify(requestBoxes.map((b) => ({
          top: Number(b.top.toFixed(5)),
          bottom: Number(b.bottom.toFixed(5)),
          left: Number(b.left.toFixed(5)),
          right: Number(b.right.toFixed(5)),
        }))).concat(`|env=${env}`);

        if (queryKey === policeLastQueryKeyRef.current) {
          // No meaningful change in snapped bbox; avoid hammering.
          setPoliceLoading(false);
          return;
        }

        policeLastQueryKeyRef.current = queryKey;

        const urls = buildWazeAlertsUrlsFromBoxes(requestBoxes, env);
        const responses = await Promise.all(
          urls.map((url) =>
            fetch(url, {
              signal: controller.signal,
              headers: {
                Accept: 'application/json',
              },
            })
          )
        );

        for (const res of responses) {
          if (!res.ok) {
            if (res.status === 429) {
              const retryAfter = res.headers.get('retry-after');
              const backoffMs = parseRetryAfterToMs(retryAfter);
              policeBackoffUntilRef.current = Date.now() + backoffMs;
              throw new Error('Waze rate limit hit (429)');
            }
            throw new Error(`Waze request failed (${res.status})`);
          }
        }

        const payloads = await Promise.all(responses.map((r) => r.json()));
        const alerts = payloads.flatMap((data) => (Array.isArray(data?.alerts) ? data.alerts : []));

        const police = alerts
          .filter(isPoliceAlert)
          .map((a) => {
            const lat = a?.location?.y;
            const lng = a?.location?.x;
            if (typeof lat !== 'number' || typeof lng !== 'number') return null;

            return {
              id:
                a?.uuid ||
                a?.id ||
                `${a?.type || 'unknown'}-${lng}-${lat}-${a?.pubMillis || ''}`,
              uuid: a?.uuid || null,
              type: a?.type || '',
              subtype: a?.subtype || '',
              street: a?.street || '',
              city: a?.city || '',
              pubMillis: a?.pubMillis || null,
              location: { lat, lng },
              raw: a,
            };
          })
          .filter(Boolean);

        if (!controller.signal.aborted) {
          // Dedupe by id/uuid in case we had to split requests over dateline
          const byId = new Map(police.map((p) => [p.id, p]));
          setPoliceAlerts(Array.from(byId.values()));
          setPoliceLastUpdatedAt(Date.now());
          policeLastFetchAtRef.current = Date.now();
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        if (String(err?.message || '').includes('429')) {
          const now = Date.now();
          const waitSec = Math.ceil((policeBackoffUntilRef.current - now) / 1000);
          setPoliceError(`Rate limited by Waze (429). Retrying in ~${Math.max(waitSec, 1)}s…`);
        } else {
          setPoliceError(err?.message || 'Failed to load police alerts');
        }
      } finally {
        if (!controller.signal.aborted) setPoliceLoading(false);
      }
    };

    timeoutId = setTimeout(run, debounceMs);

    return () => {
      controller.abort();
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [mapBounds, mapZoom, wazeEnvMode]);

  // Default view: Europe-wide; if we have warnings, center & zoom in on the first one
  const hasWarnings = warnings.length > 0;
  const center = hasWarnings ? [warnings[0].point[0], warnings[0].point[1]] : [54.0, 15.0];
  const zoom = hasWarnings ? 8 : 4;

  const policeSubtitle = useMemo(() => {
    const ts = policeLastUpdatedAt ? new Date(policeLastUpdatedAt).toLocaleTimeString() : '';
    if (policeLoading) return 'Loading…';
    if (policeError) return policeError;
    if (!policeLastUpdatedAt) return 'Waiting for map…';
    if (policeAlerts.length === 0) return ts ? `No police in this view (updated ${ts})` : 'No police in this view';
    return ts ? `Updated ${ts}` : 'Updated';
  }, [policeAlerts.length, policeError, policeLastUpdatedAt, policeLoading]);

  const policeClusters = useMemo(() => {
    return clusterPoliceAlerts(policeAlerts, POLICE_CLUSTER_RADIUS_METERS);
  }, [policeAlerts]);

  const speedRadarsInView = useMemo(() => {
    const active = speedRadarsWorld;
    if (!showSpeedRadars) return { clusters: [], inViewCount: 0, tooMany: false };
    if (!mapBounds) return { clusters: [], inViewCount: 0, tooMany: false };
    if (mapZoom < MIN_SPEED_RADAR_RENDER_ZOOM) return { clusters: [], inViewCount: 0, tooMany: false };
    if (speedRadarsWorldLoading) return { clusters: [], inViewCount: 0, tooMany: false };

    // Only render points in current viewport (performance for worldwide CSV)
    const visible = [];
    let inViewCount = 0;
    for (const p of active) {
      if (isPointInBoundsPadded(p, mapBounds, SPEED_RADAR_VIEW_PADDING_METERS)) {
        inViewCount += 1;
        if (visible.length <= MAX_VISIBLE_SPEED_RADARS) visible.push(p);
        if (inViewCount > MAX_VISIBLE_SPEED_RADARS) {
          // Don't render partial results; force the user to zoom in for a smaller viewport.
          return { clusters: [], inViewCount, tooMany: true };
        }
      }
    }
    return {
      clusters: clusterPoints(visible, SPEED_RADAR_CLUSTER_RADIUS_METERS),
      inViewCount,
      tooMany: false,
    };
  }, [mapBounds, mapZoom, showSpeedRadars, speedRadarsWorld, speedRadarsWorldLoading]);

  const boundsSubtitle = useMemo(() => {
    const b = getNormalizedBoundsForDisplay(mapBounds);
    if (!b) return '';
    return `top ${b.north.toFixed(5)} / bottom ${b.south.toFixed(5)} / left ${b.west.toFixed(
      5
    )} / right ${b.east.toFixed(5)}`;
  }, [mapBounds]);

  const wazeBoxesForDebug = useMemo(() => {
    const { debugBoxes, usedZoom } = buildWazeTileSnappedQuery(mapBounds, mapZoom);
    return { boxes: debugBoxes, usedZoom };
  }, [mapBounds, mapZoom]);

  const effectiveEnv = useMemo(() => {
    return wazeEnvMode === 'auto' ? inferWazeEnvFromBounds(mapBounds) : wazeEnvMode;
  }, [mapBounds, wazeEnvMode]);

  return (
    <div className="App">
      <div className="Map-wrapper">
        {speedRadarsWorldLoading ? (
          <div className="Map-preload">
            <div className="Map-preload-card">
              <div className="Map-preload-title">Loading speed radars…</div>
              <div className="Map-preload-subtitle">
                Parsing worldwide CSV ({speedRadarsWorldName || 'SCDB_Speed.csv'}). This can take a few seconds.
              </div>
            </div>
          </div>
        ) : null}
        <div className="Map-overlay">
          <div className="Map-overlay-title">Waze police alerts</div>
          <div className="Map-overlay-row">
            <span className="Map-overlay-label">Markers</span>
            <span className="Map-overlay-value">{policeClusters.length}</span>
          </div>
          <div className="Map-overlay-row">
            <label className="Map-overlay-label" htmlFor="waze-env">
              env
            </label>
            <select
              id="waze-env"
              value={wazeEnvMode}
              onChange={(e) => setWazeEnvMode(e.target.value)}
            >
              <option value="auto">auto ({effectiveEnv})</option>
              <option value="na">na</option>
              <option value="row">row</option>
            </select>
          </div>
          <div className="Map-overlay-row">
            <label className="Map-overlay-label" htmlFor="map-style">
              map
            </label>
            <div className="Map-overlay-map-controls">
              <select
                id="map-style"
                value={mapStyle}
                onChange={(e) => setMapStyle(e.target.value)}
              >
                <option value="osm">OpenStreetMap (default)</option>
                <option value="cartoVoyager">Carto Voyager (Google-like)</option>
                <option value="cartoLight">Carto Positron</option>
                <option value="cartoDark">Carto Dark Matter</option>
              </select>
              <div className="Map-overlay-zoom-buttons">
                <button
                  type="button"
                  className="Map-overlay-zoom-button"
                  aria-label="Zoom in"
                  onClick={() => mapInstance?.zoomIn()}
                >
                  +
                </button>
                <button
                  type="button"
                  className="Map-overlay-zoom-button"
                  aria-label="Zoom out"
                  onClick={() => mapInstance?.zoomOut()}
                >
                  −
                </button>
              </div>
            </div>
          </div>
          <div className="Map-overlay-row">
            <label className="Map-overlay-label" htmlFor="toggle-boxes">
              Show Waze boxes
            </label>
            <input
              id="toggle-boxes"
              type="checkbox"
              checked={showWazeBoxes}
              onChange={(e) => setShowWazeBoxes(e.target.checked)}
            />
          </div>
          <div className={`Map-overlay-subtitle ${policeError ? 'is-error' : ''}`}>
            {policeSubtitle}
          </div>
          <div className="Map-overlay-divider" />
          <div className="Map-overlay-title">Speed radars (world)</div>
          <div className="Map-overlay-row">
            <label className="Map-overlay-label" htmlFor="toggle-speed-radars">
              Show
            </label>
            <input
              id="toggle-speed-radars"
              type="checkbox"
              checked={showSpeedRadars}
              onChange={(e) => setShowSpeedRadars(e.target.checked)}
              disabled={speedRadarsWorldLoading}
            />
          </div>
          <div className="Map-overlay-row">
            <span className="Map-overlay-label">Markers</span>
            <span className="Map-overlay-value">
              {showSpeedRadars ? speedRadarsInView.clusters.length : 0}
            </span>
          </div>
          {speedRadarsWorldError ? (
            <div className="Map-overlay-subtitle is-error">{speedRadarsWorldError}</div>
          ) : speedRadarsWorldLoading ? (
            <div className="Map-overlay-subtitle">Loading speed radars…</div>
          ) : speedRadarsWorld.length > 0 && showSpeedRadars ? (
            mapZoom < MIN_SPEED_RADAR_RENDER_ZOOM ? (
              <div className="Map-overlay-subtitle">
                loaded {speedRadarsWorld.length} radars ({speedRadarsWorldName || 'SCDB_Speed.csv'}) • zoom in to ≥{MIN_SPEED_RADAR_RENDER_ZOOM} to render
              </div>
            ) : speedRadarsInView.tooMany ? (
              <div className="Map-overlay-subtitle is-error">
                too many radars in view ({speedRadarsInView.inViewCount}). Zoom in or reduce the area.
              </div>
            ) : speedRadarsInView.inViewCount === 0 ? (
              <div className="Map-overlay-subtitle">
                no radars found in/near this area (padding {Math.round(SPEED_RADAR_VIEW_PADDING_METERS / 1000)}km)
              </div>
            ) : (
              <div className="Map-overlay-subtitle">
                loaded {speedRadarsWorld.length} radars ({speedRadarsWorldName || 'SCDB_Speed.csv'}) • showing
                {speedRadarsInView.clusters.length} markers (≤{SPEED_RADAR_CLUSTER_RADIUS_METERS}m)
              </div>
            )
          ) : null}
          {boundsSubtitle ? <div className="Map-overlay-subtitle">{boundsSubtitle}</div> : null}
          {showWazeBoxes ? (
            <div className="Map-overlay-subtitle">
              boxes {wazeBoxesForDebug.boxes.length} (z {wazeBoxesForDebug.usedZoom})
            </div>
          ) : null}
        </div>

        <MapContainer
          center={center}
          zoom={zoom}
          scrollWheelZoom={true}
          className="Leaflet-map"
          zoomSnap={1}
          zoomDelta={1}
          zoomControl={false}
          whenCreated={setMapInstance}
        >
          <MapInstanceBridge onMap={setMapInstance} />
          <MapBoundsWatcher
            onViewChange={({ bounds, zoom: z }) => {
              setMapBounds(bounds);
              setMapZoom(z);
            }}
          />
          {mapStyle === 'osm' ? (
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
          ) : mapStyle === 'cartoVoyager' ? (
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
              url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
            />
          ) : mapStyle === 'cartoDark' ? (
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            />
          ) : (
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
              url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
            />
          )}

          {showWazeBoxes
            ? wazeBoxesForDebug.boxes.map((b) => (
                <Rectangle
                  // stable enough for debug; uses the box edges
                  key={`${b.top}-${b.bottom}-${b.left}-${b.right}`}
                  bounds={[
                    [b.bottom, b.left],
                    [b.top, b.right],
                  ]}
                  pathOptions={{ color: '#1e88e5', weight: 1, fillOpacity: 0.02 }}
                />
              ))
            : null}

          {showSpeedRadars
            ? speedRadarsInView.clusters.map((c) => (
                <Marker
                  key={`speed-${c.id}`}
                  position={[c.center.lat, c.center.lng]}
                  icon={speedCamMarkerIcon}
                >
                  <Popup>
                    <div>
                      <div>
                        <strong>Speed radars:</strong> {c.count} within ~{SPEED_RADAR_CLUSTER_RADIUS_METERS}m
                      </div>
                      {c.items.slice(0, 8).map((p) => (
                        <div key={p.id}>
                          <strong>{p.id}</strong> {p.desc ? `— ${p.desc}` : ''}
                        </div>
                      ))}
                      {c.items.length > 8 ? <div>…and {c.items.length - 8} more</div> : null}
                    </div>
                  </Popup>
                </Marker>
              ))
            : null}

          {policeClusters.map((c) => (
            <Marker
              key={c.id}
              position={[c.center.lat, c.center.lng]}
              icon={policeMarkerIcon}
            >
              <Popup>
                <div>
                  <div>
                    <strong>Type:</strong> {c.primary?.type}
                    {c.primary?.subtype ? ` (${c.primary.subtype})` : ''}
                  </div>
                  {c.count > 1 ? (
                    <div>
                      <strong>Cluster size:</strong> {c.count} alerts within ~{POLICE_CLUSTER_RADIUS_METERS}m
                    </div>
                  ) : null}
                  {c.primary?.city ? (
                    <div>
                      <strong>City:</strong> {c.primary.city}
                    </div>
                  ) : null}
                  {c.primary?.street ? (
                    <div>
                      <strong>Street:</strong> {c.primary.street}
                    </div>
                  ) : null}
                  {c.primary?.pubMillis ? (
                    <div>
                      <strong>Reported:</strong> {new Date(c.primary.pubMillis).toLocaleString()}
                    </div>
                  ) : null}
                </div>
              </Popup>
            </Marker>
          ))}

          {warnings.map((w) => (
            <Marker
              key={w.id}
              position={[w.point[0], w.point[1]]}
              icon={warningMarkerIcon}
            >
              <Popup>
                <div>
                  <div>
                    <strong>User:</strong> {w.userId}
                  </div>
                  <div>
                    <strong>Created:</strong>{' '}
                    {w.created ? new Date(w.created).toLocaleString() : ''}
                  </div>
                  <div className="Audio-controls">
                    <button
                      type="button"
                      className="Audio-play-button"
                      onClick={() => {
                        try {
                          if (audioRef.current) {
                            audioRef.current.pause();
                          }
                          const audio = new Audio(w.url);
                          audioRef.current = audio;
                          audio.play().catch((err) => {
                            // eslint-disable-next-line no-console
                            console.error('Audio play error:', err);
                          });
                        } catch (err) {
                          // eslint-disable-next-line no-console
                          console.error('Audio setup error:', err);
                        }
                      }}
                    >
                      <i className="mdi mdi-play-circle-outline" />
                    </button>
                  </div>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}

export default App;

