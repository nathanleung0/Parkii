import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Map as MapGL, Marker } from "react-map-gl/maplibre";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { serviceAreaFor } from "../convex/areas";
import { CameraFrame } from "./CameraFrame";
import { MAP_STYLE, STATUS_COLOR, ago, displayStatus, sessionId, useNow } from "./util";

type Draft = {
  id?: Id<"stalls">;
  label: string;
  polygon: number[][];
  lat?: number;
  lng?: number;
};

export function Calibrate() {
  const cameras = (useQuery(api.parking.listCameras) ?? [])
    .filter((camera) => serviceAreaFor(camera.lat, camera.lng) === "sf");
  const stalls = useQuery(api.parking.listStalls) ?? [];
  const upsert = useMutation(api.parking.upsertStall);
  const remove = useMutation(api.parking.deleteStall);
  const now = useNow();
  const session = useMemo(sessionId, []);

  const [camId, setCamId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    if (!draft || draft.polygon.length !== 4 || draft.lat === undefined || draft.lng === undefined) return;
    try {
      await upsert({
        id: draft.id,
        cameraId: cam!._id,
        label: draft.label,
        polygon: draft.polygon,
        lat: draft.lat,
        lng: draft.lng,
        placed: true,
      });
      setError(null);
      setDraft(null);
    } catch {
      setError("Could not save. Try again.");
    }
  }

  async function removeStall(id: Id<"stalls">) {
    try {
      await remove({ id });
      setError(null);
    } catch {
      setError("Could not delete. Try again.");
    }
  }

  return (
    <main className="calibrate">
      <section className="calibrate-workspace">
        <div className="calibrate-intro">
          <p className="eyebrow">OPERATOR WORKSPACE</p>
          <h1>Calibrate a camera</h1>
          <p>Mark the legal curb spaces this camera can see, then place each one on the map.</p>
        </div>
        <div className="calibrate-preview">
          <div className="calibrate-feed-heading">
            <div><span className="field-label">CAMERA FEED</span><h2>{cam.name}</h2></div>
            <span className={now - (cam.lastSeen ?? 0) < 60_000 ? "camera-badge live" : "camera-badge offline"}>{now - (cam.lastSeen ?? 0) < 60_000 ? "Recent" : "Waiting for feed"}</span>
          </div>
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
                  fill="#111111"
                  fillOpacity={0.3}
                  stroke="#111111"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
                {draft.polygon.map(([x, y], i) => (
                  <circle key={i} cx={x} cy={y} r={0.006} fill="#fff" stroke="#111111" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                ))}
              </>
            )}
          </CameraFrame>
          <div className="cam-meta">Frame processed {ago(cam.lastSeen, now)} · outlined regions are calibration data</div>
        </div>
        <p className="calibrate-guidance">Draw on the road where a parked car’s wheels sit. Avoid parklets, travel lanes, hydrants, and other spaces where parking is not legal.</p>
      </section>

      <aside className="panel calibrate-panel">
        <div className="card calibration-controls">
          <p className="eyebrow">STEP 01 · DEFINE A SPACE</p>
          <h2>Mark a legal stall</h2>
          <p className="section-intro">Draw four corners on the camera image, then pin the stall’s street location.</p>
          {error && <p className="feedback error">{error}</p>}
          {!draft ? (
            <button className="primary new-stall" onClick={newDraft}>+ Add parking stall</button>
          ) : (
            <div className="draft">
              <label>
                Stall label <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
              </label>
              <ol className="steps">
                <li className={draft.polygon.length >= 4 ? "done" : ""}>
                  Mark 4 corners on the frame ({draft.polygon.length}/4){" "}
                  {draft.polygon.length > 0 && (
                    <button className="ghost small" onClick={() => setDraft({ ...draft, polygon: [] })}>Reset</button>
                  )}
                </li>
                <li className={draft.lat ? "done" : ""}>
                  Pin its location on the map {draft.lat !== undefined ? `(${draft.lat.toFixed(5)}, ${draft.lng!.toFixed(5)})` : "(required)"}
                </li>
              </ol>
              <div className="draft-actions">
                <button className="primary" onClick={save} disabled={draft.polygon.length !== 4 || draft.lat === undefined || draft.lng === undefined}>Save</button>
                <button className="ghost" onClick={() => setDraft(null)}>Cancel</button>
              </div>
            </div>
          )}
          <div className="location-map-heading"><span className="field-label">STREET LOCATION</span><span>Click to place the stall</span></div>
          <div className="mini-map" key={cam._id}>
            <MapGL
              initialViewState={{ latitude: cam.lat, longitude: cam.lng, zoom: 19 }}
              maxZoom={20}
              mapStyle={MAP_STYLE}
              attributionControl={{ compact: true }}
              onClick={(e) => draft && setDraft({ ...draft, lat: e.lngLat.lat, lng: e.lngLat.lng })}
            >
              <Marker latitude={cam.lat} longitude={cam.lng}>
                <div className="mini-dot" style={{ background: "#111", borderColor: "#111" }} data-tip={cam.name} />
              </Marker>
              {camStalls.map((s) => (
                <Marker key={s._id} latitude={s.lat} longitude={s.lng}>
                  <div className="mini-dot" style={{ background: STATUS_COLOR[displayStatus(s, now, session)] }} data-tip={s.label} />
                </Marker>
              ))}
              {draft?.lat && (
                <Marker latitude={draft.lat} longitude={draft.lng!}>
                  <div className="mini-dot draft" />
                </Marker>
              )}
            </MapGL>
          </div>
        </div>

        <div className="card stall-inventory">
          <div className="inventory-heading"><div><p className="eyebrow">STEP 02 · REVIEW</p><h2>Camera stalls</h2></div><span>{camStalls.length}</span></div>
          <ul className="stall-list">
            {camStalls.map((s) => (
              <li key={s._id}>
                <i style={{ background: STATUS_COLOR[displayStatus(s, now, session)] }} /> {s.label}
                <span className="muted"> {s.placed === false ? "not on map yet" : s.status}</span>
                <span className="actions">
                  <button className="ghost small" onClick={() => setDraft({ id: s._id, label: s.label, polygon: s.polygon, lat: s.placed === false ? undefined : s.lat, lng: s.placed === false ? undefined : s.lng })}>
                    Edit
                  </button>
                  <button className="ghost small danger" onClick={() => void removeStall(s._id)}>Delete</button>
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
