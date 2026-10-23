#!/usr/bin/env python3
"""nbtcheck.py - read a Minecraft level.dat that the browser wrote.

The port's saves are not a port-specific format: EaglercraftX runs Mojang's own
SaveHandler/AnvilSaveHandler over its IndexedDB-backed virtual filesystem, so
what lands in IndexedDB is a real 1.8.8 Anvil world - level.dat (gzip NBT),
region/*.mca, stats/, data/idcounts.dat. This reads the level.dat back out and
prints the fields, which is the check that "saved in your browser" actually
means "saved in the game's own format".

  python3 tools/nbtcheck.py shots/world/level.dat
"""
import gzip
import io
import json
import struct
import sys


def read_nbt(buf):
    pos = 0

    def r(n):
        nonlocal pos
        d = buf[pos:pos + n]
        if len(d) != n:
            raise EOFError("short read")
        pos += n
        return d

    def val(tid):
        if tid == 0:
            return None
        if tid == 1:
            return struct.unpack(">b", r(1))[0]
        if tid == 2:
            return struct.unpack(">h", r(2))[0]
        if tid == 3:
            return struct.unpack(">i", r(4))[0]
        if tid == 4:
            return struct.unpack(">q", r(8))[0]
        if tid == 5:
            return struct.unpack(">f", r(4))[0]
        if tid == 6:
            return struct.unpack(">d", r(8))[0]
        if tid == 7:
            return list(r(struct.unpack(">i", r(4))[0]))
        if tid == 8:
            return r(struct.unpack(">H", r(2))[0]).decode("utf-8", "replace")
        if tid == 9:
            et = r(1)[0]
            return [val(et) for _ in range(struct.unpack(">i", r(4))[0])]
        if tid == 10:
            out = {}
            while True:
                t = r(1)[0]
                if t == 0:
                    return out
                name = r(struct.unpack(">H", r(2))[0]).decode("utf-8", "replace")
                out[name] = val(t)
            return out
        if tid == 11:
            return list(struct.unpack(">%di" % struct.unpack(">i", r(4))[0], r(0)))
        raise ValueError("tag type %d at %d" % (tid, pos))

    tid = r(1)[0]
    name = r(struct.unpack(">H", r(2))[0]).decode("utf-8", "replace")
    return (name, val(tid))


def main():
    path = sys.argv[1]
    raw = open(path, "rb").read()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    name, root = read_nbt(raw)
    data = root.get("Data", {})
    out = {
        "file": path,
        "bytes_gzipped": len(open(path, "rb").read()),
        "root_tag": name,
        "LevelName": data.get("LevelName"),
        "GameType": data.get("GameType"),
        "hardcore": data.get("hardcore"),
        "Difficulty": data.get("Difficulty"),
        "version_name": (data.get("Version") or {}).get("Name"),
        "version_id": (data.get("Version") or {}).get("Id"),
        "LastPlayed": data.get("LastPlayed"),
        "seed": data.get("RandomSeed") or data.get("WorldGenSettings", {}).get("Seed") if isinstance(data.get("WorldGenSettings"), dict) else data.get("RandomSeed"),
        "SpawnX": data.get("SpawnX"), "SpawnY": data.get("SpawnY"), "SpawnZ": data.get("SpawnZ"),
        "Player_pos": ((data.get("Player") or {}).get("Pos")),
        "Player_dimension": (data.get("Player") or {}).get("Dimension"),
        "Player_Inventory_items": len(((data.get("Player") or {}).get("Inventory") or {})),
        "WorldInfo": bool(data.get("WorldInfo")),
        "top_level_keys": sorted(data.keys())[:12],
    }
    print(json.dumps(out, indent=2, default=str))


if __name__ == "__main__":
    main()
