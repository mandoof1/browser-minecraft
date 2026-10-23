/* assetcache.js - the asset half of this port.
 *
 * Upstream EaglercraftX loads its data with one line:
 *
 *     assetsEPK = new Uint8Array(await fetch("assets.epk").then(r => r.arrayBuffer()));
 *
 * which is fine on a laptop and terrible on a hosted port: 26 MB of code and
 * assets (classes.wasm 14.2 MB, assets.epk 11.7 MB, lang.epk 7.5 MB) come back
 * on every single page load, and a free PaaS instance that spins down between
 * visits makes every visit feel like a cold boot.
 *
 * So the port layer does what the 2026 ports do instead:
 *
 *   HTTP Range in fixed blocks  ->  Origin Private File System  ->  blob: URL
 *
 * which is the Halo CE pattern ("copy only the needed maps into origin-private
 * storage in small chunks") and the GTA V pattern (4 KB Range blocks cached in
 * OPFS), plus the wasm.ltd cache-busting trick: every cache key is the SHA-256
 * from manifest.json, so a rebuilt engine can never be served stale.
 *
 * Two sinks are exposed:
 *   mcAsset.bytes(name)   -> Uint8Array   (for getEPKFiles / the EPW buffer)
 *   mcAsset.blobURL(name) -> blob: URL    (for <script src> and wasm fetch)
 */
(function () {
  const CHUNK = 512 * 1024;
  const mem = new Map();          // name -> { bytes, source }
  let manifest = null;
  let opfsRoot = null;
  let opfsBroken = false;

  /* manifest.json lives one level above the per-target build directories, and
   * its keys are target-relative ("wasm/classes.wasm"), which is also what the
   * OPFS cache key and the ?v= cache busting are derived from */
  async function loadManifest() {
    if (manifest) return manifest;
    try {
      const r = await fetch("/build/manifest.json", { cache: "no-store" });
      manifest = await r.json();
    } catch (e) {
      manifest = { artifacts: {}, engine: {}, toolchain: {} };
    }
    return manifest;
  }

  function entry(name) {
    const arts = (manifest && manifest.artifacts) || {};
    return arts[name] || arts["../" + name] || null;
  }

  /* OPFS is not available everywhere (and is missing on some insecure origins),
   * so every use of it is wrapped and the cache simply stops being a cache. */
  async function cacheFile(name) {
    if (opfsBroken || !navigator.storage || !navigator.storage.getDirectory) return null;
    const info = entry(name);
    const key = name.replace(/[^a-z0-9.]/gi, "_") + "." + (info ? info.sha256.slice(0, 16) : "unpinned");
    try {
      if (!opfsRoot) opfsRoot = await navigator.storage.getDirectory();
      const dir = await opfsRoot.getDirectoryHandle("mc-assets", { create: true });
      const fh = await dir.getFileHandle(key, { create: true });
      return { fh, key };
    } catch (e) {
      opfsBroken = true;
      return null;
    }
  }

  /* the wasm.ltd trick: version the URL by content hash, so an artifact can be
   * served with an immutable long cache lifetime and still be impossible to
   * reuse by accident after a rebuild */
  function versioned(url, name) {
    const info = entry(name);
    return url + (url.indexOf("?") < 0 ? "?" : "&") + "v=" + (info ? info.sha256.slice(0, 16) : "dev");
  }

  async function headInfo(url) {
    let size = null, ranges = false;
    try {
      /* a 1-byte ranged GET rather than HEAD: some stacks answer HEAD without
       * Accept-Ranges, and Chromium reports an aborted HEAD as a failed request */
      const h = await fetch(url, { headers: { Range: "bytes=0-0" } });
      if (h.status === 206) {
        ranges = true;
        const cr = h.headers.get("content-range") || "";
        size = Number(cr.split("/")[1] || 0) || null;
      } else {
        size = Number(h.headers.get("content-length") || 0) || null;
        ranges = /bytes/i.test(h.headers.get("accept-ranges") || "");
      }
      await h.arrayBuffer();
    } catch (e) { /* fall back to a plain GET */ }
    return { size, ranges };
  }

  async function fromOPFS(cf, expectBytes) {
    const f = await cf.fh.getFile();
    if (f.size !== expectBytes) return null;
    const out = new Uint8Array(await f.arrayBuffer());
    return out;
  }

  async function rangeFetch(url, size, onProgress, writer) {
    let got = 0;
    const out = new Uint8Array(size);
    while (got < size) {
      const end = Math.min(got + CHUNK, size) - 1;
      const r = await fetch(url, { headers: { Range: "bytes=" + got + "-" + end } });
      if (!(r.status === 206 || (r.status === 200 && got === 0)))
        throw new Error("range request failed: HTTP " + r.status);
      const part = new Uint8Array(await r.arrayBuffer());
      out.set(part, got);
      if (writer) await writer.write(part);
      got += part.length;
      onProgress && onProgress(got, size);
      if (part.length === 0) break;
    }
    return out;
  }

  async function plainFetch(url, onProgress) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("fetch failed: HTTP " + resp.status);
    const total = Number(resp.headers.get("content-length") || 0) || null;
    const reader = resp.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress && onProgress(got, total);
    }
    const out = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  const api = {
    async init(base) {
      await loadManifest(base);
      return manifest;
    },

    manifest() { return manifest; },

    /* bytes for one artifact, from OPFS when it already matches the pinned hash */
    async bytes(name, opts) {
      const base = (opts && opts.base) || "/build/";
      const onProgress = opts && opts.onProgress;
      const nocache = opts && opts.nocache;
      const hit = mem.get(name);
      if (hit) return { bytes: hit.bytes, source: hit.source + " (memory)" };

      const url = versioned(base + name, name);
      const cf = nocache ? null : await cacheFile(name);

      if (cf) {
        const info = entry(name);
        const cached = await fromOPFS(cf, info ? info.bytes : -1);
        if (cached) {
          mem.set(name, { bytes: cached, source: "opfs-cache" });
          onProgress && onProgress(cached.length, cached.length);
          return { bytes: cached, source: "opfs-cache" };
        }
      }

      const { size, ranges } = await headInfo(url);
      let bytes, source;
      if (ranges && size) {
        const writer = cf ? await cf.fh.createWritable() : null;
        bytes = await rangeFetch(url, size, onProgress, writer);
        if (writer) await writer.close();
        source = "http-range";
      } else {
        bytes = await plainFetch(url, onProgress);
        if (cf) {
          const w = await cf.fh.createWritable();
          await w.write(bytes);
          await w.close();
        }
        source = "http-stream";
      }

      const info = entry(name);
      if (info && bytes.length !== info.bytes)
        throw new Error(name + ": got " + bytes.length + " bytes, manifest says " + info.bytes);

      mem.set(name, { bytes, source });
      return { bytes, source };
    },

    async blobURL(name, mime, opts) {
      const r = await api.bytes(name, opts);
      const blob = new Blob([r.bytes], { type: mime || "application/octet-stream" });
      return { url: URL.createObjectURL(blob), bytes: r.bytes.length, source: r.source };
    },

    counters() {
      const out = {};
      for (const [k, v] of mem) out[k] = { bytes: v.bytes.length, source: v.source };
      return out;
    },

    /* keep the OPFS copy warm without holding it in memory: used for the
     * artifacts this visit is not going to need yet */
    async warm(name, base) {
      try { await api.bytes(name, { base }); return true; } catch (e) { return false; }
    }
  };

  window.mcAsset = api;
})();
