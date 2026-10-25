import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CircleMarker, MapContainer, Marker, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { api } from "../convex/_generated/api";
import { CameraFrame } from "./CameraFrame";
import { VoiceAsk } from "./VoiceAsk";
import {
  CASTRO_CENTER,
  STATUS_COLOR,
  ago,
  displayStatus,
  sessionId,
  useNow,
  type Stall,
} from "./util";

const youIcon = L.divIcon({ className: "you-pin", html: "<div></div>", iconSize: [18, 18] });
const camIcon = L.divIcon({ className: "cam-pin", html: "📷", iconSize: [22, 22] });

function ClickToMove({ onMove }: { onMove: (p: [number, number]) => void }) {
  useMapEvents({ click: (e) => onMove([e.latlng.lat, e.latlng.lng]) });
  return null;
}

function RecenterOnLocation({ point }: { point: [number, number] }) {
  const map = useMap();
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    map.flyTo(point, Math.max(16, map.getZoom()));
  }, [map, point[0], point[1]]);
  return null;
}

export function DriverView() {
  const [you, setYou] = useState<[number, number]>([37.76255, -122.4351]); // Castro & Market
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

  const counts = useMemo(() => {
    const c = { open: 0, taken: 0, held: 0, stale: 0 };
    for (const s of stalls) c[displayStatus(s, now, session)]++;
    return c;
  }, [stalls, now, session]);

  const cam = cameras.find((c) => c._id === selectedCam) ?? cameras[0];
  const camStalls = (camId: string) => stalls.filter((s) => s.cameraId === camId);

  async function onFind() {
    setBusy(true);
    try {
      const res = await findSpot({ lat: you[0], lng: you[1], sessionId: session });
      setSpot(res);
      if (res) {
        const st = stalls.find((s) => s._id === res.stallId);
        if (st) setSelectedCam(st.cameraId);
      }
    } finally {
      setBusy(false);
    }
  }

  async function onRelease() {
    await releaseHold({ sessionId: session });
    setSpot(undefined);
  }

  function useMyLocation() {
    navigator.geolocation?.getCurrentPosition((p) => moveLocation([p.coords.latitude, p.coords.longitude]));
  }

  const holdLeft = spot ? Math.max(0, Math.round((spot.expiresAt - now) / 1000)) : 0;

  function moveLocation(point: [number, number]) {
    setYou(point);
    setSpot(undefined);
    setSelectedCam(null);
  }

  return (
    <main className="driver">
      <section className="map-wrap">
        <MapContainer center={CASTRO_CENTER} zoom={13} maxZoom={20} className="map">
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            maxNativeZoom={19}
            maxZoom={20}
          />
          <ClickToMove onMove={moveLocation} />
          <RecenterOnLocation point={you} />
          <Marker position={you} icon={youIcon}>
            <Tooltip direction="top">You (click map to move)</Tooltip>
          </Marker>
          {cameras.map((c) => (
            <Marker key={c._id} position={[c.lat, c.lng]} icon={camIcon} eventHandlers={{ click: () => setSelectedCam(c._id) }}>
              <Tooltip direction="top">{c.name} · {ago(c.lastSeen, now)}</Tooltip>
            </Marker>
          ))}
          {stalls.map((s) => (
            <StallDot key={s._id} s={s} now={now} session={session} active={spot?.stallId === s._id} onClick={() => setSelectedCam(s.cameraId)} />
          ))}
        </MapContainer>
        <div className="legend">
          {(["open", "taken", "held", "stale"] as const).map((k) => (
            <span key={k}>
              <i style={{ background: STATUS_COLOR[k] }} /> {k} {counts[k]}
            </span>
          ))}
        </div>
      </section>

      <aside className="panel">
        <div className="card find">
          <div className="find-row">
            <button className="primary" onClick={onFind} disabled={busy}>
              {busy ? "Searching…" : spot ? "Find another spot" : "Find me a spot"}
            </button>
            <button className="ghost" onClick={useMyLocation} title="Use my GPS location">📍</button>
          </div>
          <VoiceAsk
            lat={you[0]}
            lng={you[1]}
            sessionId={session}
            onResult={(r) => {
              setSpot(r.spot);
              if (r.spot) {
                const st = stalls.find((s) => s._id === r.spot!.stallId);
                if (st) setSelectedCam(st.cameraId);
              }
            }}
          />
          <p className="muted">Move around the map and click your destination, or use GPS. Search covers 600 m around the pin.</p>
          {spot === null && (
            <p className="muted">
              {coverage?.observedStalls === 0
                ? "No camera-observed parking within 600 m of this location yet."
                : coverage?.freshStalls === 0
                  ? "Nearby camera data is stale. Try again later."
                  : "No nearby open spots with fresh camera data right now."}
            </p>
          )}
          {spot && (
            <div className="result">
              <div className="result-title">
                Spot <b>{spot.label}</b> on {spot.camera}
              </div>
              <div className="muted">
                {spot.distanceM} m away · processed {spot.ageS}s ago · {Math.round(spot.confidence * 100)}% detection agreement
              </div>
              <div className="hold">Not shown to other ParkSight users for {Math.floor(holdLeft / 60)}:{String(holdLeft % 60).padStart(2, "0")}. Street spaces can still be taken.</div>
              <div className="find-row">
                <a
                  className="primary link"
                  target="_blank"
                  rel="noreferrer"
                  href={`https://www.google.com/maps/dir/?api=1&destination=${spot.lat},${spot.lng}&travelmode=driving`}
                >
                  Navigate ↗
                </a>
                <button className="ghost" onClick={onRelease}>Release</button>
              </div>
            </div>
          )}
        </div>

        {cam && (
          <div className="card">
            <div className="cam-tabs">
              {cameras.map((c) => (
                <button key={c._id} className={c._id === cam._id ? "tab active" : "tab"} onClick={() => setSelectedCam(c._id)}>
                  {c.name}
                </button>
              ))}
            </div>
            <CameraFrame camera={cam} stalls={camStalls(cam._id)} now={now} session={session} highlight={spot?.stallId} />
            <div className="cam-meta">
              <span className={now - (cam.lastSeen ?? 0) < 60_000 ? "live" : "offline"}>●</span>
              Processed {ago(cam.lastSeen, now)} · {cam.vehicles?.length ?? 0} vehicles detected
            </div>
            <p className="muted">Source: {cam.sourceAttribution ?? "SF Bay Times Castro Street Cams"}</p>
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
          </div>
        )}
        <p className="fineprint">
          Camera feeds can lag behind real traffic. A ParkSight hold does not reserve a public street space.
        </p>
      </aside>
    </main>
  );
}

function StallDot({ s, now, session, active, onClick }: { s: Stall; now: number; session: string; active: boolean; onClick: () => void }) {
  const st = displayStatus(s, now, session);
  return (
    <CircleMarker
      center={[s.lat, s.lng]}
      radius={active ? 11 : 8}
      pathOptions={{ color: active ? "#1d4ed8" : "#fff", weight: active ? 4 : 2, fillColor: STATUS_COLOR[st], fillOpacity: 0.95 }}
      eventHandlers={{ click: onClick }}
    >
      <Tooltip>
        {s.label}: {st} · {ago(s.updatedAt, now)}
      </Tooltip>
    </CircleMarker>
  );
}
