import { useEffect, useState } from "react";
import { DriverView } from "./DriverView";
import { NycDemoView } from "./NycDemoView";
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
  const calibrate = hash === "#/calibrate" || hash === "#/calibrate/sf";
  const sfCalibration = hash === "#/calibrate/sf";
  const sfPilot = hash === "#/sf";
  return (
    <div className="app">
      <header className="app-header">
        <a href="#/" className="brand">
          <span>Parkii</span>
        </a>
        <span className="tagline">Street cameras and observed parking</span>
        <nav aria-label="Main navigation">
          <a href="#/" className={!calibrate && !sfPilot ? "active" : ""}>Find parking</a>
          <a href="#/sf" className={sfPilot ? "active" : ""}>SF pilot</a>
          <a href="#/calibrate" className={calibrate ? "active" : ""}>Calibrate</a>
        </nav>
      </header>
      {sfCalibration ? <Calibrate /> : sfPilot ? <DriverView /> : <NycDemoView calibrationMode={calibrate} />}
    </div>
  );
}
