#!/usr/bin/env python3
"""make-manifest.py - pin the artifacts.

Every browser port in the Oct-2026 wave starts the same way: name the exact
build and hash it (Halo pins cachebeta.exe by SHA-256). This writes
web/build/manifest.json with the size and SHA-256 of every artifact, plus the
engine revision and toolchain that produced it.

The port uses it for two things:
  * cache keys - the OPFS asset cache and the ?v= query string are keyed on the
    hash, so a rebuilt engine cannot serve a stale asset by accident
  * the /health endpoint and the boot log, so a deployed port can be checked
    against the build you think you shipped
"""
import hashlib
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git(args, cwd):
    try:
        return subprocess.check_output(["git", "-C", cwd] + args, text=True).strip()
    except Exception:
        return None


def main():
    out = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "web", "build"))
    engine = os.path.join(ROOT, "engine", "eaglercraft-1_8-workspace")

    files = {}
    for dirpath, _dirs, names in os.walk(out):
        for n in sorted(names):
            if n == "manifest.json":
                continue
            p = os.path.join(dirpath, n)
            rel = os.path.relpath(p, out).replace(os.sep, "/")
            files[rel] = {"bytes": os.path.getsize(p), "sha256": sha256(p)}

    manifest = {
        "engine": {
            "name": "EaglercraftX 1.8 (Mojang Minecraft 1.8.8, decompiled + patched)",
            "rev": git(["rev-parse", "HEAD"], engine),
            "commit_date": git(["log", "-1", "--format=%ci"], engine),
            "subject": git(["log", "-1", "--format=%s"], engine),
        },
        "toolchain": {
            "gradle": "8.14 (wrapper)",
            "java": os.environ.get("JAVA_HOME") or "system",
            "teavm": "0.12.1-EAGLER-R3 (Eaglercraft TeaVM fork)",
        },
        "artifacts": files,
        "total_bytes": sum(v["bytes"] for v in files.values()),
    }

    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
        f.write("\n")

    print("manifest: %d artifacts, %.1f MiB" % (len(files), manifest["total_bytes"] / 1048576))
    for k in sorted(files):
        print("  %-40s %10d  %s" % (k, files[k]["bytes"], files[k]["sha256"][:16]))


if __name__ == "__main__":
    main()
