import importlib.util
from pathlib import Path
import unittest


path = Path(__file__).resolve().parents[1] / "sharding.py"
spec = importlib.util.spec_from_file_location("parksight_sharding", path)
sharding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sharding)


class ShardingTest(unittest.TestCase):
    def test_every_camera_has_exactly_one_owner_and_assignment_is_stable(self):
        cameras = [f"camera-{n}" for n in range(1000)]
        owners = [[index for index in range(7) if sharding.belongs_to_shard(cam, index, 7)] for cam in cameras]
        self.assertTrue(all(len(found) == 1 for found in owners))
        self.assertEqual(owners, [[index for index in range(7) if sharding.belongs_to_shard(cam, index, 7)] for cam in cameras])


if __name__ == "__main__":
    unittest.main()
