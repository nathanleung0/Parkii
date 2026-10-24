import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CircleMarker, MapContainer, TileLayer, Tooltip, useMapEvents } from "react-leaflet";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { CameraFrame } from "./CameraFrame";
import { STATUS_COLOR, ago, displayStatus, sessionId, useNow } from "./util";

type Draft = {
  id?: Id<"stalls">;
  label: string;
  polygon: number[][];
  lat?: number;
  lng?: number;
};

function MapPicker({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onPick(e.latlng.lat, e.latlng.lng) });
  return null;
}

export function Calibrate() {
  const cameras = useQuery(api.parking.listCameras) ?? [];
  const stalls = useQuery(api.parking.listStalls) ?? [];
  const upsert = useMutation(api.parking.upsertStall);
  const remove = useMutation(api.parking.deleteStall);
  const now = useNow();
  const session = useMemo(sessionId, []);

  const [camId, setCamId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const cam = cameras.find((c) => c._id === camId) ?? cameras[0];
  if (!cam) return <main className="calibrate"><p className="muted">Loading cameras… (run `npm run seed` if empty)</p></main>;

  const camStalls = stalls.filter((s) => s.cameraId === cam._id);
  const otherStalls = draft?.id ? camStalls.filter((s) => s._id !== draft.id) : camStalls;

  function newDraft() {
    setDraft({ label: `${cam!.camId.replace("castro-cam", "C")}-${camStalls.length + 1}`, polygon: [] });
  }

  function addPoint(x: number, y: number) {
    if (!draft || draft.polygon.length >= 4) return;
    setDraft({ ...draft, polygon: [...draft.polygon, [round(x), round(y)]] });
  }

  async function save() {
    if (!draft || draft.polygon.length < 3) return;
    await upsert({
      id: draft.id,
      cameraId: cam!._id,
      label: draft.label,
      polygon: draft.polygon,
      lat: draft.lat ?? cam!.lat,
      lng: draft.lng ?? cam!.lng,
    });
    setDraft(null);
  }

  return (
    <main className="calibrate">
      <section>
        <div className="cam-tabs">
          {cameras.map((c) => (
            <button
              key={c._id}
              className={c._id === cam._id ? "tab active" : "tab"}
              onClick={() => {
                setCamId(c._id);
                setDraft(null);
              }}
            >
              {c.name}
            </button>
          ))}
        </div>
        <CameraFrame camera={cam} stalls={otherStalls} now={now} session={session} onClick={draft ? addPoint : undefined}>
          {draft && draft.polygon.length > 0 && (
            <>
              <polygon
                points={draft.polygon.map(([x, y]) => `${x},${y}`).join(" ")}
                fill="#2563eb"
                fillOpacity={0.3}
                stroke="#2563eb"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
              {draft.polygon.map(([x, y], i) => (
                <circle key={i} cx={x} cy={y} r={0.006} fill="#fff" stroke="#2563eb" strokeWidth={2} vectorEffect="non-scaling-stroke" />
              ))}
            </>
          )}
        </CameraFrame>
        <div className="cam-meta">
          Frame updated {ago(cam.lastSeen, now)} · blue dashed boxes = detected vehicles
        </div>
        <p className="muted">
          Draw each stall as a quadrilateral on the patch of road where a parked car's wheels sit (the lower part of the car). A
          stall reads "taken" when ≥40% of a detected vehicle's footprint (bottom third of its box) falls inside it. Avoid
          parklets and travel lanes.
        </p>
      </section>

      <aside className="panel">
        <div className="card">
          {!draft ? (
            <button className="primary" onClick={newDraft}>+ New stall</button>
          ) : (
            <div className="draft">
              <label>
                Label <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
              </label>
              <ol className="steps">
                <li className={draft.polygon.length >= 4 ? "done" : ""}>
                  Click 4 corners on the frame ({draft.polygon.length}/4){" "}
                  {draft.polygon.length > 0 && (
                    <button className="ghost small" onClick={() => setDraft({ ...draft, polygon: [] })}>reset</button>
                  )}
                </li>
                <li className={draft.lat ? "done" : ""}>
                  Click the map where this stall is {draft.lat ? `(${draft.lat.toFixed(5)}, ${draft.lng!.toFixed(5)})` : "(defaults to camera)"}
                </li>
              </ol>
              <div className="find-row">
                <button className="primary" onClick={save} disabled={draft.polygon.length < 3}>Save</button>
                <button className="ghost" onClick={() => setDraft(null)}>Cancel</button>
              </div>
            </div>
          )}
          <MapContainer center={[cam.lat, cam.lng]} zoom={19} maxZoom={20} className="mini-map" key={cam._id}>
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" maxNativeZoom={19} maxZoom={20} />
            {draft && <MapPicker onPick={(lat, lng) => setDraft({ ...draft, lat, lng })} />}
            <CircleMarker center={[cam.lat, cam.lng]} radius={6} pathOptions={{ color: "#111", fillColor: "#111", fillOpacity: 1 }}>
              <Tooltip>{cam.name}</Tooltip>
            </CircleMarker>
            {camStalls.map((s) => (
              <CircleMarker
                key={s._id}
                center={[s.lat, s.lng]}
                radius={6}
                pathOptions={{ color: "#fff", weight: 2, fillColor: STATUS_COLOR[displayStatus(s, now, session)], fillOpacity: 1 }}
              >
                <Tooltip>{s.label}</Tooltip>
              </CircleMarker>
            ))}
            {draft?.lat && (
              <CircleMarker center={[draft.lat, draft.lng!]} radius={7} pathOptions={{ color: "#2563eb", fillColor: "#2563eb", fillOpacity: 1 }} />
            )}
          </MapContainer>
        </div>

        <div className="card">
          <h3>Stalls on this camera</h3>
          <ul className="stall-list">
            {camStalls.map((s) => (
              <li key={s._id}>
                <i style={{ background: STATUS_COLOR[displayStatus(s, now, session)] }} /> {s.label}
                <span className="muted"> {s.status}</span>
                <span className="actions">
                  <button className="ghost small" onClick={() => setDraft({ id: s._id, label: s.label, polygon: s.polygon, lat: s.lat, lng: s.lng })}>
                    edit
                  </button>
                  <button className="ghost small danger" onClick={() => remove({ id: s._id })}>delete</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </main>
  );
}

function round(n: number) {
  return Math.round(n * 10000) / 10000;
}
