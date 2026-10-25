import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Map as MapGL, Marker, NavigationControl, type MapRef } from "react-map-gl/maplibre";
import { api } from "../convex/_generated/api";
import { CameraFrame } from "./CameraFrame";
import { VoiceAsk } from "./VoiceAsk";
import {
  CASTRO_CENTER,
  MAP_STYLE,
  STATUS_COLOR,
  ago,
  displayStatus,
  sessionId,
  useNow,
  type Stall,
} from "./util";

export function DriverView() {
  const [you, setYou] = useState<[number, number]>([37.76255, -122.4351]); // Castro & Market
  const [locationLabel, setLocationLabel] = useState("Castro & Market");
  const session = useMemo(sessionId, []);
  const cameras = useQuery(api.parking.listCamerasNear, { lat: you[0], lng: you[1] }) ?? [];
  const stalls = useQuery(api.parking.listStallsNear, { lat: you[0], lng: you[1], sessionId: session }) ?? [];
  const coverage = useQuery(api.parking.coverage, { lat: you[0], lng: you[1] });
  const findSpot = useMutation(api.parking.findSpot);
  const releaseHold = useMutation(api.parking.releaseHold);
  const now = useNow();

  const [selectedCam, setSelectedCam] = useState<string | null>(null);
  const [spot, setSpot] = useState<Awaited<ReturnType<typeof findSpot>> | undefined>();
  const [busy, setBusy] = useState(false);
  const [findError, setFindError] = useState(false);
  const [navPulse, setNavPulse] = useState(false);
  const mapRef = useRef<MapRef>(null);
  const mounted = useRef(false);

  const counts = useMemo(() => {
    const c = { open: 0, taken: 0, held: 0, stale: 0 };
    for (const s of stalls) c[displayStatus(s, now, session)]++;
    return c;
  }, [stalls, now, session]);

  const cam = cameras.find((c) => c._id === selectedCam) ?? cameras[0];
  const camStalls = (camId: string) => stalls.filter((s) => s.cameraId === camId);
  const coverageTone = !coverage ? "checking" : coverage.observedStalls === 0 ? "none" : coverage.freshStalls === 0 ? "delayed" : "fresh";

  async function onFind() {
    setBusy(true);
    setFindError(false);
    try {
      const res = await findSpot({ lat: you[0], lng: you[1], sessionId: session });
      setSpot(res);
      if (res) {
        const st = stalls.find((s) => s._id === res.stallId);
        if (st) setSelectedCam(st.cameraId);
      }
    } catch {
      setFindError(true);
    } finally {
      setBusy(false);
    }
  }

  async function onRelease() {
    await releaseHold({ sessionId: session });
    setSpot(undefined);
  }

  function useMyLocation() {
    navigator.geolocation?.getCurrentPosition((p) => moveLocation([p.coords.latitude, p.coords.longitude], "Current location"));
  }

  const holdLeft = spot ? Math.max(0, Math.round((spot.expiresAt - now) / 1000)) : 0;

  // Fly to the destination when it moves. On phones, keep it visible above the search sheet.
  function focusPoint() {
    const map = mapRef.current;
    if (!map) return;
    const zoom = Math.max(15, map.getZoom());
    if (window.matchMedia("(max-width: 900px)").matches) {
      // Bottom padding of 46% puts the point 23% above center, like main's Leaflet panBy.
      const bottom = Math.round(map.getContainer().clientHeight * 0.46);
      map.jumpTo({ center: [you[1], you[0]], zoom, padding: { top: 0, left: 0, right: 0, bottom } });
    } else if (mounted.current) {
      map.flyTo({ center: [you[1], you[0]], zoom, padding: { top: 0, left: 0, right: 0, bottom: 0 } });
    }
    mounted.current = true;
  }
  useEffect(focusPoint, [you[0], you[1]]);
  useEffect(() => {
    window.addEventListener("resize", focusPoint);
    return () => window.removeEventListener("resize", focusPoint);
  });

  function moveLocation(point: [number, number], label = "Selected map location") {
    if (spot) void releaseHold({ sessionId: session });
    setYou(point);
    setLocationLabel(label);
    setSpot(undefined);
    setSelectedCam(null);
  }

  return (
    <main className="driver">
      <section className="map-wrap" aria-label="Parking map">
        <div className="map">
          <MapGL
            ref={mapRef}
            initialViewState={{ latitude: you[0], longitude: you[1], zoom: 13 }}
            maxZoom={20}
            mapStyle={MAP_STYLE}
            onLoad={focusPoint}
            onClick={(e) => moveLocation([e.lngLat.lat, e.lngLat.lng])}
          >
            <NavigationControl position="top-right" showCompass={false} />
            <Marker latitude={you[0]} longitude={you[1]} style={{ zIndex: 1 }}>
              <div className="you-pin" data-tip="Selected destination" />
            </Marker>
            {cameras.map((c) => (
              <Marker
                key={c._id}
                latitude={c.lat}
                longitude={c.lng}
                onClick={(e) => {
                  e.originalEvent.stopPropagation();
                  setSelectedCam(c._id);
                }}
              >
                <div className="cam-pin" data-tip={`${c.name} · ${ago(c.lastSeen, now)}`}><span /></div>
              </Marker>
            ))}
            {stalls.map((s) => (
              <StallDot key={s._id} s={s} now={now} session={session} active={spot?.stallId === s._id} onClick={() => setSelectedCam(s.cameraId)} />
            ))}
          </MapGL>
        </div>
        <div className="map-hint"><span className="map-hint-icon">⌖</span> Click anywhere on the map to search there</div>
        <div className="legend">
          {(["open", "taken", "held", "stale"] as const).map((k) => (
            <span key={k}>
              <i style={{ background: STATUS_COLOR[k] }} /> {k} {counts[k]}
            </span>
          ))}
        </div>
      </section>

      <aside className="panel driver-panel">
        <div className="search-section">
          <p className="eyebrow">PARKSIGHT · SAN FRANCISCO</p>
          <h1>Where do you want to park?</h1>
          <p className="section-intro">Choose a point on the map. We’ll check the spaces nearby cameras can actually see.</p>

          <div className="destination-card">
            <span className="destination-pin" aria-hidden="true" />
            <div className="destination-copy">
              <span className="field-label">DESTINATION</span>
              <strong>{locationLabel}</strong>
              <span>{you[0].toFixed(5)}, {you[1].toFixed(5)}</span>
            </div>
            <button className="location-button" onClick={useMyLocation} title="Use my GPS location" aria-label="Use my GPS location">⌖</button>
          </div>

          <button className="primary search-button" onClick={onFind} disabled={busy}>
            <span>{busy ? "Searching…" : spot ? "Find another spot" : "Find parking near here"}</span>
            <span aria-hidden="true">→</span>
          </button>

          <div className={`coverage-banner ${coverageTone}`} role="status">
            <span className="coverage-dot" aria-hidden="true" />
            <div>
              <strong>{coverageTone === "fresh" ? "Recent camera coverage" : coverageTone === "delayed" ? "Camera data delayed" : coverageTone === "none" ? "No camera coverage here" : "Checking camera coverage"}</strong>
              <span>{coverageTone === "fresh" ? `${coverage!.freshStalls} monitored ${coverage!.freshStalls === 1 ? "space" : "spaces"} updated recently` : coverageTone === "delayed" ? "Nearby spaces have no recent observation" : coverageTone === "none" ? "Try another point on the map" : "Looking for monitored curb spaces nearby"}</span>
            </div>
          </div>

          <div className="voice-heading"><span>Or ask ParkSight</span></div>
          <VoiceAsk
            lat={you[0]}
            lng={you[1]}
            sessionId={session}
            selectedCamera={cam?.name}
            onResult={(r) => {
              if (r.spotChanged) setSpot(r.spot);
              if (r.spot) {
                const st = stalls.find((s) => s._id === r.spot!.stallId);
                if (st) setSelectedCam(st.cameraId);
              }
              // Apply the agent's UI actions in order (after the spot, so show_camera wins).
              for (const a of r.actions) {
                if (a.kind === "show_camera") setSelectedCam(a.cameraId);
                else if (a.kind === "set_location") {
                  setYou([a.lat, a.lng]);
                  setLocationLabel(a.label);
                }
                else if (a.kind === "navigate" && r.spot) {
                  const win = window.open(mapsLink(r.spot), "_blank", "noreferrer");
                  if (!win) setNavPulse(true); // popup blocked: point at the Navigate button instead
                }
              }
            }}
          />
          {findError && <p className="feedback error">Search is unavailable right now. Please try again.</p>}
          {spot === null && (
            <p className="feedback">
              {coverage?.observedStalls === 0
                ? "No camera-observed parking within 600 m of this location yet."
                : coverage?.freshStalls === 0
                  ? "Nearby camera data is stale. Try again later."
                  : "No nearby open spots with fresh camera data right now."}
            </p>
          )}
          {spot && (
            <div className="result">
              <span className="field-label">NEAREST OBSERVED SPACE</span>
              <div className="result-title"><strong>{spot.label}</strong><span>{spot.distanceM} m away</span></div>
              <p className="result-source">{spot.camera} · processed {spot.ageS}s ago · {Math.round(spot.confidence * 100)}% detection agreement</p>
              <div className="hold"><strong>ParkSight hold · {Math.floor(holdLeft / 60)}:{String(holdLeft % 60).padStart(2, "0")}</strong><span>Other ParkSight users won’t be sent here. The street space can still be taken.</span></div>
              <div className="result-actions">
                <a
                  className={navPulse ? "primary link nav-pulse" : "primary link"}
                  target="_blank"
                  rel="noreferrer"
                  href={mapsLink(spot)}
                  onClick={() => setNavPulse(false)}
                >
                  Navigate ↗
                </a>
                <button className="ghost" onClick={onRelease}>Release hold</button>
              </div>
            </div>
          )}
        </div>

        {cam ? (
          <section className="camera-section" aria-label="Nearby camera view">
            <div className="section-heading">
              <div><p className="eyebrow">NEARBY CAMERAS</p><h2>Street view</h2></div>
              <span className={now - (cam.lastSeen ?? 0) < 60_000 ? "camera-badge live" : "camera-badge offline"}>{now - (cam.lastSeen ?? 0) < 60_000 ? "Recent" : "Waiting for feed"}</span>
            </div>
            <div className="cam-tabs">
              {cameras.map((c) => (
                <button key={c._id} className={c._id === cam._id ? "tab active" : "tab"} onClick={() => setSelectedCam(c._id)}>
                  {c.name}
                </button>
              ))}
            </div>
            <CameraFrame camera={cam} stalls={camStalls(cam._id)} now={now} session={session} highlight={spot?.stallId} />
            <div className="cam-meta">
              Processed {ago(cam.lastSeen, now)} · {cam.vehicles?.length ?? 0} vehicles detected
            </div>
            <p className="source-credit">Source: {cam.sourceAttribution ?? "SF Bay Times Castro Street Cams"}</p>
            <ul className="stall-list">
              {camStalls(cam._id).map((s) => {
                const st = displayStatus(s, now, session);
                return (
                  <li key={s._id}>
                    <i style={{ background: STATUS_COLOR[st] }} /> {s.label} <span className="muted">{st}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : (
          <section className="camera-empty"><p className="eyebrow">NEARBY CAMERAS</p><h2>No view at this point</h2><p>Move the destination pin toward a monitored street to see camera observations.</p></section>
        )}
        <p className="fineprint">
          Camera feeds can lag behind real traffic. A ParkSight hold does not reserve a public street space.
        </p>
      </aside>
    </main>
  );
}

function mapsLink(p: { lat: number; lng: number }) {
  return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving`;
}

function StallDot({ s, now, session, active, onClick }: { s: Stall; now: number; session: string; active: boolean; onClick: () => void }) {
  const st = displayStatus(s, now, session);
  return (
    <Marker
      latitude={s.lat}
      longitude={s.lng}
      onClick={(e) => {
        e.originalEvent.stopPropagation();
        onClick();
      }}
    >
      <div
        className={active ? "stall-dot active" : "stall-dot"}
        style={{ background: STATUS_COLOR[st] }}
        data-tip={`${s.label}: ${st} · ${ago(s.updatedAt, now)}`}
      />
    </Marker>
  );
}
