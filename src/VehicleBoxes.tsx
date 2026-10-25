const CLASS_NAMES: Record<number, string> = {
  2: "Car",
  3: "Motorcycle",
  5: "Bus",
  7: "Truck",
};

// The SVG parent uses normalized 0..1 image coordinates. These are model
// candidates, not verified vehicle or parking-space classifications.
export function VehicleBoxes({ vehicles }: { vehicles: number[][] }) {
  return <>
    {vehicles.map(([x1, y1, x2, y2, score, classId], index) => {
      const label = `${CLASS_NAMES[classId] ?? "Vehicle"} ${Math.round(score * 100)}%`;
      const color = score >= 0.65 ? "#22d3ee" : "#fbbf24";
      return <g key={index}>
        <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1}
          fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke"
          className="detected-object" />
        <text x={x1} y={Math.max(0.022, y1 - 0.008)} fill={color}
          stroke="#111" strokeWidth={0.003} paintOrder="stroke" fontWeight="bold"
          fontSize={0.021}>{label}</text>
        <title>{`${label} · model candidate`}</title>
      </g>;
    })}
  </>;
}
