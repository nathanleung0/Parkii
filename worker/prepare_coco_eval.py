"""Fetch a small reproducible vehicle slice from official COCO val2017 annotations/images."""
import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path
import random
import re
import urllib.request
import zipfile

BASE = "https://s3.amazonaws.com/images.cocodataset.org/"
ANNOTATIONS = BASE + "annotations/annotations_trainval2017.zip"
VEHICLES = {3, 4, 6, 8}


class RangeFile(io.RawIOBase):
    """Read only the required ZIP blocks rather than all 253 MB of train/val annotations."""
    def __init__(self, url):
        self.url, self.position, self.blocks = url, 0, {}
        request = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(request, timeout=30) as response:
            self.length = int(response.headers["Content-Length"])
        self.block_size = 1024 * 1024

    def seek(self, offset, whence=0):
        self.position = offset if whence == 0 else self.position + offset if whence == 1 else self.length + offset
        if not 0 <= self.position <= self.length:
            raise ValueError("Invalid remote ZIP seek")
        return self.position

    def tell(self):
        return self.position

    def read(self, size=-1):
        remaining = self.length - self.position if size < 0 else min(size, self.length-self.position)
        chunks = []
        while remaining:
            index = self.position // self.block_size
            if index not in self.blocks:
                first = index * self.block_size
                last = min(first + self.block_size, self.length) - 1
                request = urllib.request.Request(self.url, headers={"Range": f"bytes={first}-{last}"})
                with urllib.request.urlopen(request, timeout=30) as response:
                    if response.status != 206:
                        raise RuntimeError("Official dataset server did not honor byte ranges")
                    raw = response.read(self.block_size + 1)
                    if len(raw) != last-first+1:
                        raise RuntimeError("Incomplete annotation ZIP range")
                    self.blocks[index] = raw
            offset = self.position % self.block_size
            part = self.blocks[index][offset:offset+remaining]
            if not part:
                raise RuntimeError("Unexpected annotation ZIP end")
            chunks.append(part)
            self.position += len(part)
            remaining -= len(part)
        return b"".join(chunks)


def prepare(args):
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=True)
    annotations_path = root / "instances_val2017.json"
    if not annotations_path.exists():
        remote = RangeFile(ANNOTATIONS)
        with zipfile.ZipFile(remote) as archive:
            info = archive.getinfo("annotations/instances_val2017.json")
            if info.file_size > 64*1024*1024:
                raise ValueError("Unexpected validation annotation size")
            raw = archive.read(info)
        annotations_path.write_bytes(raw)
        print(f"Downloaded {len(raw)} bytes of validation annotations from the official archive", flush=True)
    annotations = json.loads(annotations_path.read_text(encoding="utf-8"))
    images = {image["id"]: image for image in annotations["images"]}
    grouped = defaultdict(list)
    for annotation in annotations["annotations"]:
        if annotation["category_id"] in VEHICLES:
            grouped[annotation["image_id"]].append(annotation)
    positive = sorted(i for i in images if 1 <= sum(not a.get("iscrowd", 0) for a in grouped[i]) <= 30)
    negative = sorted(i for i in images if not grouped[i])
    rng = random.Random(args.seed)
    rng.shuffle(positive)
    rng.shuffle(negative)
    count = args.count
    pos_count = count*3//4
    chosen = [(i, True) for i in positive[:pos_count]] + [(i, False) for i in negative[:count-pos_count]]
    # One third is for choosing settings; two thirds remain held out from our selection.
    validation_pos = pos_count//3
    validation_neg = (count-pos_count)//3
    validation_ids = set(positive[:validation_pos] + negative[:validation_neg])
    def fetch(pair):
        image_id, _ = pair
        image = images[image_id]
        name = image["file_name"]
        if not re.fullmatch(r"[0-9]{12}\.jpg", name):
            raise ValueError("Unexpected official image filename")
        target = root / "frames" / name
        target.parent.mkdir(exist_ok=True)
        if not target.exists():
            with urllib.request.urlopen(BASE + "val2017/" + name, timeout=30) as response:
                raw = response.read(10*1024*1024+1)
            if len(raw) > 10*1024*1024 or not raw.startswith(b"\xff\xd8\xff"):
                raise ValueError("Invalid or oversized COCO JPEG")
            target.write_bytes(raw)
        raw = target.read_bytes()
        boxes, crowd = [], []
        for annotation in grouped[image_id]:
            x,y,w,h = annotation["bbox"]
            if w <= 0 or h <= 0:
                continue
            row = [x/image["width"], y/image["height"], (x+w)/image["width"], (y+h)/image["height"]]
            (crowd if annotation.get("iscrowd",0) else boxes).append(row)
        return {"image_id": image_id, "frame": name, "width": image["width"], "height": image["height"],
                "split": "validation" if image_id in validation_ids else "test", "boxes": boxes, "crowd": crowd,
                "sha256": hashlib.sha256(raw).hexdigest(), "license_id": image.get("license")}
    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(fetch, chosen))
    manifest = {"dataset": "COCO val2017 vehicle-family slice", "seed": args.seed,
                "annotation_source": ANNOTATIONS, "annotation_sha256": hashlib.sha256(annotations_path.read_bytes()).hexdigest(),
                "label_source": "official COCO human annotations, not model predictions",
                "category_ids": sorted(VEHICLES), "licenses": annotations.get("licenses",[]),
                "caveat": "Generic vehicle detection benchmark; not a measured Castro empty-parking accuracy gain.",
                "images": sorted(rows,key=lambda row:row["frame"])}
    (root / "manifest.json").write_text(json.dumps(manifest,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"images":len(rows), "vehicle_instances":sum(len(r['boxes']) for r in rows),
                      "validation":sum(r['split']=='validation' for r in rows), "test":sum(r['split']=='test' for r in rows)}),flush=True)


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output",default="worker/recordings/coco-vehicles")
    parser.add_argument("--count",type=int,default=48)
    parser.add_argument("--seed",type=int,default=20261024)
    args=parser.parse_args()
    if args.count < 12 or args.count % 12 or args.count > 240:
        parser.error("count must be a multiple of 12 between 12 and 240")
    prepare(args)
