import type { MouseEvent, ReactNode } from "react";
import { STATUS_COLOR, displayStatus, type Camera, type Stall } from "./util";

// Latest camera frame with vehicle boxes and stall polygons overlaid.
// Overlay uses a 0..1 viewBox, matching the normalized coordinates in Convex.
export function CameraFrame({
  camera,
  stalls,
  now,
  session,
  highlight,
  onClick,
  children,
}: {
  camera: Camera;
  stalls: Stall[];
  now: number;
  session: string;
  highlight?: string | null;
  onClick?: (x: number, y: number) => void;
  children?: ReactNode;
}) {
  const handleClick = (e: MouseEvent<SVGSVGElement>) => {
    if (!onClick) return;
    const r = e.currentTarget.getBoundingClientRect();
    onClick((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };
  return (
    <div className="frame">
      {camera.frameUrl ? (
        <img src={camera.frameUrl} alt={camera.name} />
      ) : camera.storeFrames === false ? (
        <div className="frame-empty">Picture not shown for this city camera (operator terms). Outlines show live spaces.</div>
      ) : (
        <div className="frame-empty">Waiting for first frame…</div>
      )}
      <svg
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        onClick={handleClick}
        style={{ cursor: onClick ? "crosshair" : "default" }}
      >
        {(camera.vehicles ?? []).map(([x1, y1, x2, y2], i) => (
          <rect
            key={i}
            x={x1}
            y={y1}
            width={x2 - x1}
            height={y2 - y1}
            fill="none"
            stroke="#38bdf8"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            strokeDasharray="4 3"
          />
        ))}
        {stalls.map((s) => {
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
      </svg>
    </div>
  );
}
