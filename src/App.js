import './App.css';
import 'leaflet/dist/leaflet.css';
import '@mdi/font/css/materialdesignicons.min.css';
import { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';

// In development, CRA's proxy (defined in package.json) will forward this
// relative path to https://app.driverschat.com to avoid CORS issues.
const API_URL = '/api/messages/warning-messages';
const AUTH_TOKEN = process.env.REACT_APP_X_AUTH;

const markerIcon = L.divIcon({
  className: 'custom-marker-icon',
  html: '<i class="mdi mdi-map-marker-alert"></i>',
  iconSize: [32, 32],
  iconAnchor: [16, 32],
});

function App() {
  const [warnings, setWarnings] = useState([]);
  const audioRef = useRef(null);

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

  // Default view: Europe-wide; if we have warnings, center & zoom in on the first one
  const hasWarnings = warnings.length > 0;
  const center = hasWarnings ? [warnings[0].point[0], warnings[0].point[1]] : [54.0, 15.0];
  const zoom = hasWarnings ? 8 : 4;

  return (
    <div className="App">
      <div className="Map-wrapper">
        <MapContainer
          center={center}
          zoom={zoom}
          scrollWheelZoom={true}
          className="Leaflet-map"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {warnings.map((w) => (
            <Marker
              key={w.id}
              position={[w.point[0], w.point[1]]}
              icon={markerIcon}
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

