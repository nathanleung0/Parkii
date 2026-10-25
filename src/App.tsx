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
      <header className="app-header">
        <a href="#/" className="brand">
          <span className="logo">P</span>
          <span>ParkSight</span>
        </a>
        <span className="tagline">Camera-observed street parking</span>
        <nav aria-label="Main navigation">
          <a href="#/" className={!calibrate ? "active" : ""}>Find parking</a>
          <a href="#/calibrate" className={calibrate ? "active" : ""}>Calibrate</a>
        </nav>
      </header>
      {calibrate ? <Calibrate /> : <DriverView />}
    </div>
  );
}
