import unittest
from datetime import datetime

from agents import street_rules as sr
from agents.street_rules import SF_TZ


def row(corridor, limits, side, weekday, start, end, weeks="11111", coords=((-122.4351, 37.7610), (-122.4351, 37.7619))):
    r = {"corridor": corridor, "limits": limits, "blockside": side, "weekday": weekday,
         "fromhour": str(start), "tohour": str(end), "holidays": "0",
         "line": {"type": "LineString", "coordinates": [list(c) for c in coords]}}
    for i, flag in enumerate(weeks, 1):
        r[f"week{i}"] = flag
    return r


def at(y, m, d, h, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=SF_TZ)


class StreetRulesTest(unittest.TestCase):
    def test_nearest_block_picks_one_block_face(self):
        near = row("Castro St", "17th St  -  18th St", "East", "Tues", 6, 8)
        near2 = row("Castro St", "17th St  -  18th St", "East", "Fri", 6, 8)
        far = row("18th St", "Castro St  -  Collingwood St", "North", "Thu", 6, 8,
                  coords=((-122.4340, 37.7609), (-122.4330, 37.7609)))
        picked = sr.nearest_block(37.7613, -122.4350, [far, near, near2])
        self.assertEqual({(s.corridor, s.weekday) for s in picked}, {("Castro St", 1), ("Castro St", 4)})

    def test_next_sweep_same_week(self):
        sweeps = sr.nearest_block(37.7613, -122.4350, [row("Castro St", "a - b", "East", "Tues", 6, 8)])
        start, s = sr.next_sweep(sweeps, at(2026, 10, 24, 12))  # Saturday noon
        self.assertEqual((start.year, start.month, start.day, start.hour), (2026, 10, 27, 6))  # next Tuesday

    def test_sweep_in_progress_counts(self):
        sweeps = sr.nearest_block(37.7613, -122.4350, [row("Castro St", "a - b", "East", "Tues", 6, 8)])
        d = sr.describe(sweeps, at(2026, 10, 27, 7))
        self.assertEqual(d["warning"], "now")

    def test_sweep_ended_today_rolls_to_next_week(self):
        sweeps = sr.nearest_block(37.7613, -122.4350, [row("Castro St", "a - b", "East", "Tues", 6, 8)])
        start, _ = sr.next_sweep(sweeps, at(2026, 10, 27, 9))
        self.assertEqual((start.month, start.day), (11, 3))

    def test_only_first_and_third_week(self):
        sweeps = sr.nearest_block(37.7613, -122.4350,
                                  [row("Castro St", "a - b", "East", "Tues", 6, 8, weeks="10100")])
        # Tuesday Oct 27 2026 is the 4th Tuesday -> skipped; next is Nov 3 (1st Tuesday)
        start, _ = sr.next_sweep(sweeps, at(2026, 10, 24, 12))
        self.assertEqual((start.month, start.day), (11, 3))

    def test_soon_warning_under_24h(self):
        sweeps = sr.nearest_block(37.7613, -122.4350, [row("Castro St", "a - b", "East", "Tues", 6, 8)])
        self.assertEqual(sr.describe(sweeps, at(2026, 10, 26, 20))["warning"], "soon")
        self.assertEqual(sr.describe(sweeps, at(2026, 10, 24, 12))["warning"], "later")

    def test_no_rows(self):
        d = sr.describe(sr.nearest_block(37.76, -122.43, []))
        self.assertIsNone(d["warning"])

    def test_lookup_survives_fetch_failure(self):
        def boom(_url):
            raise OSError("offline")
        d = sr.lookup(37.7613, -122.4350, fetch=boom)
        self.assertIsNone(d["text"])
        self.assertEqual(d["error"], "OSError")

    def test_lookup_uses_fetch(self):
        d = sr.lookup(37.7613, -122.4350, at(2026, 10, 24, 12),
                      fetch=lambda url: [row("Castro St", "a - b", "East", "Tues", 6, 8)])
        self.assertEqual(d["warning"], "later")
        self.assertIn("Castro St", d["text"])


if __name__ == "__main__":
    unittest.main()
