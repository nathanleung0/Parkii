import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { STATUS_COLOR, STALE_MS, displayStatus, type Camera, type Stall } from "./util";
import { VehicleBoxes } from "./VehicleBoxes";

// Detection outlines match the processed image. Internal stall regions are
// shown only in calibration, both in normalized image coordinates.
export function CameraFrame({
  camera,
  stalls,
  now,
  session,
  highlight,
  onClick,
  showVehicles = true,
  showStalls = true,
  useLivePreview = false,
  children,
}: {
  camera: Camera;
  stalls: Stall[];
  now: number;
  session: string;
  highlight?: string | null;
  onClick?: (x: number, y: number) => void;
  showVehicles?: boolean;
  showStalls?: boolean;
  useLivePreview?: boolean;
  children?: ReactNode;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const previewOnly = camera.storeFrames !== false && useLivePreview && camera.previewUrl &&
    (!camera.frameUrl || now - (camera.lastSeen ?? 0) >= STALE_MS);
  const imageUrl = previewOnly
    ? `${camera.previewUrl}?t=${Math.floor(now / 60_000)}`
    : camera.frameUrl;
  useEffect(() => setImageFailed(false), [imageUrl]);
  const handleClick = (e: MouseEvent<SVGSVGElement>) => {
    if (!onClick) return;
    const r = e.currentTarget.getBoundingClientRect();
    onClick((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };
  return (
    <div className="frame">
      {camera.storeFrames === false ? (
        <div className="frame-empty">Picture not shown for this city camera (operator terms). Outlines show live spaces.</div>
      ) : imageUrl && !imageFailed ? (
        <img src={imageUrl} alt={camera.name} onError={() => setImageFailed(true)} />
      ) : (
        <div className="frame-empty">Camera preview unavailable</div>
      )}
      {(showVehicles || showStalls || onClick || children) && <svg
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        onClick={handleClick}
        style={{ cursor: onClick ? "crosshair" : "default" }}
      >
        {showVehicles && !previewOnly && <VehicleBoxes vehicles={camera.vehicles ?? []} />}
        {showStalls && stalls.map((s) => {
          const color = STATUS_COLOR[displayStatus(s, now, session)];
          return (
            <polygon
              key={s._id}
              points={s.polygon.map(([x, y]) => `${x},${y}`).join(" ")}
              fill={color}
              fillOpacity={highlight === s._id ? 0.55 : 0.3}
              stroke={color}
              strokeWidth={highlight === s._id ? 3 : 2}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {children}
      </svg>}
    </div>
  );
}
