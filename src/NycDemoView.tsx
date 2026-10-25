import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { Map as MapGL, Marker, NavigationControl, type MapRef } from "react-map-gl/maplibre";
import { api } from "../convex/_generated/api";
import { serviceAreaFor } from "../convex/areas";
import { deriveCoverageFreshness } from "./coverageFreshness";
import { MAP_STYLE, STALE_MS, STATUS_COLOR, ago, displayStatus, sessionId, useNow } from "./util";
import { VehicleBoxes } from "./VehicleBoxes";

const NYC_CENTER: [number, number] = [40.77234, -73.9587];
type ReviewDraft = { label: string; polygon: number[][]; lat?: number; lng?: number };
type NycSelection = { point: [number, number]; label: string; selectedId: string | null };

function readSelection(): NycSelection {
  const fallback: NycSelection = {
    point: NYC_CENTER, label: "3rd Avenue & 76th Street", selectedId: null,
  };
  try {
    const stored = JSON.parse(sessionStorage.getItem("parkii-nyc-selection") ?? "null");
    if (!stored || !Array.isArray(stored.point) || stored.point.length !== 2 ||
        !stored.point.every((value: unknown) => typeof value === "number" && Number.isFinite(value)) ||
        typeof stored.label !== "string" ||
        (stored.selectedId !== null && typeof stored.selectedId !== "string")) return fallback;
    return stored as NycSelection;
  } catch { return fallback; }
}

function distanceLabel(meters: number): string {
  return meters < 1_000 ? `${meters} m` : `${(meters / 1_000).toFixed(1)} km`;
}

export function NycDemoView({ calibrationMode = false }: { calibrationMode?: boolean }) {
  const initialSelection = useMemo(readSelection, []);
  const session = useMemo(sessionId, []);
  const findSpot = useMutation(api.parking.findSpot);
  const releaseHold = useMutation(api.parking.releaseHold);
  const [point, setPoint] = useState<[number, number]>(initialSelection.point);
  const [label, setLabel] = useState(initialSelection.label);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelection.selectedId);
  const [imageFailed, setImageFailed] = useState(false);
  const [imageSize, setImageSize] = useState<[number, number]>([4, 3]);
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [adminSecret, setAdminSecret] = useState("");
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [analysisUnavailable, setAnalysisUnavailable] = useState(false);
  const [spot, setSpot] = useState<Awaited<ReturnType<typeof findSpot>> | undefined>();
  const [busy, setBusy] = useState(false);
  const [findError, setFindError] = useState(false);
  const inNyc = serviceAreaFor(point[0], point[1]) === "nyc";
  const catalog = useQuery(api.nycCameras.nearby, { lat: point[0], lng: point[1] });
  const cameras = catalog?.cameras ?? [];
  const selected = cameras.find((camera) => camera.id === selectedId) ?? cameras[0];
  const reviewStalls = useQuery(api.nycCameras.listReviewStalls,
    calibrationMode && selected ? { cameraId: selected.id } : "skip") ?? [];
  const coverage = useQuery(api.parking.coverage,
    !calibrationMode && inNyc ? { lat: point[0], lng: point[1] } : "skip");
  const nearbyStalls = useQuery(api.parking.listStallsNear,
    !calibrationMode && inNyc ? { lat: point[0], lng: point[1], sessionId: session } : "skip");
  const observation = useQuery(api.nycCameras.observation, selected ? { cameraId: selected.id } : "skip");
  const requestAnalysis = useMutation(api.nycCameras.requestAnalysis);
  const saveReviewStall = useMutation(api.nycCameras.saveReviewStall);
  const deleteReviewStall = useMutation(api.nycCameras.deleteReviewStall);
  const now = useNow(15_000);
  const liveCoverage = deriveCoverageFreshness(coverage, nearbyStalls, point, now, STALE_MS);
  const holdLeft = spot ? Math.max(0, Math.round((spot.expiresAt - now) / 1000)) : 0;
  const imageVersion = Math.floor(now / 60_000);
  const analyzed = observation?.frameUrl && now - observation.observedAt < 90_000 ? observation : null;
  const imageSrc = selected ? analyzed?.frameUrl ?? `${selected.imageUrl}?v=${imageVersion}` : null;
  const mapRef = useRef<MapRef>(null);
  const cameraRef = useRef<HTMLElement>(null);

  useEffect(() => {
    try { sessionStorage.setItem("parkii-nyc-selection", JSON.stringify({ point, label, selectedId })); }
    catch { /* Storage can be unavailable in private browser sessions. */ }
  }, [point, label, selectedId]);
  useEffect(() => setImageFailed(false), [imageSrc]);
  useEffect(() => {
    if (!selected?.id) return;
    let active = true;
    const request = () => {
      void requestAnalysis({ cameraId: selected.id })
        .then((accepted) => { if (active) setAnalysisUnavailable(!accepted); })
        .catch(() => { if (active) setAnalysisUnavailable(true); });
    };
    request();
    const timer = window.setInterval(request, 45_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [selected?.id, requestAnalysis]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const mobile = window.matchMedia("(max-width: 900px)").matches;
    const bottom = mobile ? Math.round(map.getContainer().clientHeight * 0.46) : 0;
    map.easeTo({ center: [point[1], point[0]], padding: { top: 0, right: 0, bottom, left: 0 } });
  }, [point]);

  function movePoint(next: [number, number], nextLabel = "Selected map location") {
    if (spot) void releaseHold({ sessionId: session });
    setPoint(next);
    setLabel(nextLabel);
    setSelectedId(null);
    setDraft(null);
    setReviewError(null);
    setSpot(undefined);
    setFindError(false);
  }

  async function onFind() {
    if (!inNyc) return;
    setBusy(true);
    setFindError(false);
    try {
      setSpot(await findSpot({ lat: point[0], lng: point[1], sessionId: session }));
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

  function chooseCamera(id: string) {
    setSelectedId(id);
    setDraft(null);
    setReviewError(null);
    setAnalysisUnavailable(false);
  }

  function addReviewCorner(event: MouseEvent<SVGSVGElement>) {
    if (!draft || draft.polygon.length >= 4) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.round(((event.clientX - rect.left) / rect.width) * 10_000) / 10_000;
    const y = Math.round(((event.clientY - rect.top) / rect.height) * 10_000) / 10_000;
    setDraft((current) => current ? { ...current, polygon: [...current.polygon, [x, y]] } : null);
  }

  async function saveCandidate() {
    if (!selected || !draft || draft.polygon.length !== 4 || draft.lat === undefined || draft.lng === undefined) return;
    try {
      await saveReviewStall({
        adminSecret, cameraId: selected.id, label: draft.label,
        polygon: draft.polygon, lat: draft.lat, lng: draft.lng,
      });
      setDraft(null);
      setReviewError(null);
    } catch {
      setReviewError("Could not save. Check the calibration key, four corners, and map point within 250 m of the camera.");
    }
  }

  async function removeCandidate(id: typeof reviewStalls[number]["_id"]) {
    try {
      await deleteReviewStall({ adminSecret, id });
      setReviewError(null);
    } catch {
      setReviewError("Could not remove this candidate. Check the calibration key.");
    }
  }

  function useMyLocation() {
    navigator.geolocation?.getCurrentPosition((position) =>
      movePoint([position.coords.latitude, position.coords.longitude], "Current location"));
  }

  return (
    <main className="driver nyc-demo">
      <section className="map-wrap" aria-label="New York City camera map">
        <div className="map">
          <MapGL
            ref={mapRef}
            initialViewState={{ latitude: point[0], longitude: point[1], zoom: 14 }}
            maxZoom={20}
            mapStyle={MAP_STYLE}
            onClick={(event) => {
              const location: [number, number] = [event.lngLat.lat, event.lngLat.lng];
              if (draft) setDraft({ ...draft, lat: location[0], lng: location[1] });
              else movePoint(location);
            }}
          >
            <NavigationControl position="top-right" showCompass={false} />
            <Marker latitude={point[0]} longitude={point[1]} style={{ zIndex: 1 }}>
              <div className="you-pin" data-tip="Selected destination" />
            </Marker>
            {cameras.map((camera) => (
              <Marker key={camera.id} latitude={camera.lat} longitude={camera.lng}
                onClick={(event) => {
                  event.originalEvent.stopPropagation();
                  chooseCamera(camera.id);
                }}>
                <div className="cam-pin" data-tip={`${camera.name} · ${distanceLabel(camera.distanceM)}`}><span /></div>
              </Marker>
            ))}
            {!calibrationMode && nearbyStalls?.map((stall) => (
              <Marker key={stall._id} latitude={stall.lat} longitude={stall.lng}
                onClick={(event) => event.originalEvent.stopPropagation()}>
                <div className={spot?.stallId === stall._id ? "stall-dot active" : "stall-dot"}
                  style={{ background: STATUS_COLOR[displayStatus(stall, now, session)] }}
                  data-tip={`${stall.label}: ${displayStatus(stall, now, session)}`} />
              </Marker>
            ))}
            {calibrationMode && reviewStalls.map((candidate) => (
              <Marker key={candidate._id} latitude={candidate.lat} longitude={candidate.lng}
                onClick={(event) => event.originalEvent.stopPropagation()}>
                <div className="mini-dot review-candidate-dot" data-tip={`${candidate.label} · unverified candidate`} />
              </Marker>
            ))}
          </MapGL>
        </div>
        <div className="map-hint"><span className="map-hint-icon">⌖</span> {draft ? "Click the map to locate this possible space" : calibrationMode ? "Click anywhere in NYC to review a camera" : "Click anywhere in NYC to search there"}</div>
      </section>

      <aside className="panel driver-panel">
        <div className="search-section">
          <p className="eyebrow">{calibrationMode ? "PARKII · NEW YORK CITY CALIBRATION" : "PARKII · NEW YORK CITY"}</p>
          <h1>{calibrationMode ? "Review a camera view." : "Where do you want to park?"}</h1>
          <p className="section-intro">{calibrationMode
            ? "Place the pin anywhere in NYC to inspect a camera and mark possible parking spaces for review."
            : "Choose a point in NYC. We’ll check monitored parking spaces and show nearby camera views."}</p>
          <div className="destination-card">
            <span className="destination-pin" aria-hidden="true" />
            <div className="destination-copy">
              <span className="field-label">DESTINATION</span>
              <strong>{label}</strong>
              <span>{point[0].toFixed(5)}, {point[1].toFixed(5)}</span>
            </div>
            <button className="location-button" onClick={useMyLocation} title="Use my GPS location" aria-label="Use my GPS location">⌖</button>
          </div>
          {!calibrationMode && <>
            <button className="primary search-button" onClick={() => void onFind()} disabled={busy || !inNyc}>
              <span>{busy ? "Searching…" : spot ? "Find another spot" : "Find parking near here"}</span>
              <span aria-hidden="true">→</span>
            </button>
            <div className={`coverage-banner ${inNyc ? liveCoverage.tone : "none"}`} role="status">
              <span className="coverage-dot" aria-hidden="true" />
              <div>
                <strong>{!inNyc ? "Choose a location in NYC" :
                  liveCoverage.tone === "checking" ? "Checking parking coverage" :
                  liveCoverage.tone === "none" ? "No monitored parking here yet" :
                  liveCoverage.tone === "delayed" ? "Parking camera data delayed" : "Recent parking observations"}</strong>
                <span>{!inNyc ? "Move the pin to New York City to search." :
                  liveCoverage.tone === "fresh" ? `${liveCoverage.freshStalls} monitored spaces updated recently` :
                  liveCoverage.tone === "none" ? "Nearby traffic cameras do not establish open or legal spaces." :
                  liveCoverage.tone === "delayed" ? "Nearby monitored spaces have no recent observation." : "Looking for calibrated spaces nearby…"}</span>
              </div>
            </div>
            {findError && <p className="feedback error">Search is unavailable right now. Please try again.</p>}
            {spot === null && <p className="feedback">{liveCoverage.noResultMessage} Camera vehicle labels alone cannot confirm a legal parking space.</p>}
            {spot && <div className="result">
              <span className="field-label">NEAREST OBSERVED SPACE</span>
              <div className="result-title"><strong>{spot.label}</strong><span>{spot.distanceM} m away</span></div>
              <p className="result-source">{spot.camera} · processed {spot.ageS}s ago · {Math.round(spot.confidence * 100)}% detection agreement</p>
              <div className="hold"><strong>Parkii hold · {Math.floor(holdLeft / 60)}:{String(holdLeft % 60).padStart(2, "0")}</strong><span>Other Parkii users won’t be sent here. The street space can still be taken.</span></div>
              <div className="result-actions">
                <a className="primary link" target="_blank" rel="noreferrer"
                  href={`https://www.google.com/maps/dir/?api=1&destination=${spot.lat},${spot.lng}&travelmode=driving`}>Navigate ↗</a>
                <button className="ghost" onClick={() => void onRelease()}>Release hold</button>
              </div>
            </div>}
          </>}
          <div className="coverage-banner none" role="status">
            <span className="coverage-dot" aria-hidden="true" />
            <div>
              <strong>{catalog === undefined ? "Finding camera views" : selected ? `${catalog?.total ?? 0} NYC DOT cameras in the catalog` : "No NYC camera view available here"}</strong>
              <span>{selected
                ? `Closest view is ${distanceLabel(cameras[0].distanceM)} from the pin. These are traffic images, not verified parking spaces.`
                : catalog === undefined ? "Checking the camera catalog…" : catalog.fetchedAt === null
                  ? "The NYC camera catalog has not loaded yet."
                  : "Try another location inside New York City."}</span>
            </div>
          </div>
          <p className="feedback">Camera labels identify possible vehicles. They do not show where parking is legal or open. {calibrationMode
            ? "Operator notes here stay out of parking search until a space and feed are configured for occupancy."
            : <>Only calibrated spaces with recent observations can produce a result. <a href="#/sf">Try the SF pilot</a> for current spot recommendations.</>}</p>
          {calibrationMode && <p className="feedback">Working on the SF pilot? <a href="#/calibrate/sf">Open SF calibration</a>.</p>}
        </div>

        {selected ? (
          <section className="camera-section" ref={cameraRef} aria-label="Nearest NYC DOT camera">
            <div className="section-heading">
              <div><p className="eyebrow">CLOSEST CAMERA VIEWS</p><h2>{selected.name}</h2></div>
              <span className="camera-badge">{distanceLabel(selected.distanceM)} away</span>
            </div>
            <div className="cam-tabs">
              {cameras.map((camera) => (
                <button key={camera.id} className={camera.id === selected.id ? "tab active" : "tab"}
                  onClick={() => { chooseCamera(camera.id); cameraRef.current?.scrollIntoView({ block: "nearest" }); }}>
                  {camera.name} · {distanceLabel(camera.distanceM)}
                </button>
              ))}
            </div>
            <div className="frame nyc-review-frame" style={{ aspectRatio: `${imageSize[0]} / ${imageSize[1]}` }}>
              {imageFailed ? <div className="frame-empty">This camera image is unavailable right now. Choose another view.</div> :
                <img key={imageSrc} src={imageSrc ?? undefined}
                  alt={`NYC DOT traffic camera at ${selected.name}`}
                  onLoad={(event) => setImageSize([event.currentTarget.naturalWidth, event.currentTarget.naturalHeight])}
                  onError={() => setImageFailed(true)} />}
              <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="review-overlay"
                onClick={draft ? addReviewCorner : undefined}
                style={{ cursor: draft ? "crosshair" : "default", pointerEvents: draft ? "auto" : "none" }}>
                {analyzed && <VehicleBoxes vehicles={analyzed.vehicles} />}
                {calibrationMode && reviewStalls.map((candidate) => (
                  <polygon key={candidate._id} points={candidate.polygon.map(([x, y]) => `${x},${y}`).join(" ")}
                    fill="#f59e0b" fillOpacity={0.18} stroke="#f59e0b" strokeWidth={2}
                    strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
                ))}
                {draft && draft.polygon.length > 0 && <>
                  <polygon points={draft.polygon.map(([x, y]) => `${x},${y}`).join(" ")}
                    fill="#276ef1" fillOpacity={0.18} stroke="#276ef1" strokeWidth={2}
                    vectorEffect="non-scaling-stroke" />
                  {draft.polygon.map(([x, y], index) => (
                    <circle key={index} cx={x} cy={y} r={0.008} fill="#276ef1"
                      stroke="white" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                  ))}
                </>}
              </svg>
            </div>
            <div className="cam-meta">{selected.area} · {analyzed
              ? `Processed ${ago(analyzed.observedAt, now)} · ${analyzed.vehicles.length} vehicle candidates · dashed outlines show model labels`
              : analysisUnavailable ? "Analysis queue busy · camera preview only" : "Camera preview · selected view is waiting for analysis"}</div>
            <p className="source-credit">Source: NYC DOT Traffic Management Center. Cameras may move or go offline. Always follow posted parking signs.</p>
            {calibrationMode && <div className="nyc-review-workflow">
              <p className="eyebrow">PARKING SPACE REVIEW</p>
              <h3>Review a possible parking space</h3>
              <p>This is an internal annotation tool, not a city permit. Orange outlines are unverified notes. Check posted signs and camera stability before any space can be used for recommendations.</p>
              <label className="secret-field">Operator edit key
                <input type="password" value={adminSecret} onChange={(event) => setAdminSecret(event.target.value)} placeholder="Operator key" />
              </label>
              {reviewError && <p className="feedback error">{reviewError}</p>}
              {!draft ? (
                <button className="ghost" onClick={() => setDraft({ label: `Candidate ${reviewStalls.length + 1}`, polygon: [] })}>+ Mark possible space</button>
              ) : (
                <div className="draft">
                  <label>Candidate label
                    <input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
                  </label>
                  <ol className="steps">
                    <li>Click four corners on the camera image ({draft.polygon.length}/4).</li>
                    <li>Click the map to place the curb location {draft.lat !== undefined ? `(${draft.lat.toFixed(5)}, ${draft.lng!.toFixed(5)})` : "(required)"}.</li>
                  </ol>
                  <div className="draft-actions">
                    <button className="primary" onClick={() => void saveCandidate()}
                      disabled={draft.polygon.length !== 4 || draft.lat === undefined || draft.lng === undefined || !adminSecret}>Save for review</button>
                    <button className="ghost" onClick={() => setDraft(null)}>Cancel</button>
                  </div>
                </div>
              )}
              {reviewStalls.length > 0 && <ul className="stall-list">
                {reviewStalls.map((candidate) => (
                  <li key={candidate._id}><i style={{ background: "#f59e0b" }} />{candidate.label}
                    <span className="muted">unverified</span>
                    <button className="ghost small" onClick={() => void removeCandidate(candidate._id)}>Remove</button>
                  </li>
                ))}
              </ul>}
            </div>}
          </section>
        ) : (
          <section className="camera-empty"><p className="eyebrow">CAMERA VIEWS</p><h2>No camera to show</h2><p>Move the pin to another point in New York City, or try again when the catalog is available.</p></section>
        )}
        <p className="fineprint">NYC DOT and the City of New York do not guarantee the accuracy or suitability of these images for parking decisions.</p>
      </aside>
    </main>
  );
}
