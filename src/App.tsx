import { useEffect, useState } from "react";
import { DriverView } from "./DriverView";
import { Calibrate } from "./Calibrate";

function useHash(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHash();
  const calibrate = hash === "#/calibrate";
  return (
    <div className="app">
      <header>
        <a href="#/" className="brand">
          <span className="logo">P</span> ParkSight
        </a>
        <span className="tagline">Live street parking from public cameras · Castro, SF</span>
        <nav>
          <a href="#/" className={!calibrate ? "active" : ""}>Driver</a>
          <a href="#/calibrate" className={calibrate ? "active" : ""}>Calibrate</a>
        </nav>
      </header>
      {calibrate ? <Calibrate /> : <DriverView />}
    </div>
  );
}
