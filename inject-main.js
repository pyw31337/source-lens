/* Source Lens — runs in the page (MAIN world) at document_start.
   1) Watches fetch/XHR for media URLs and stream manifests (.m3u8 / .mpd).
   2) Reads platform JSON (Instagram, Facebook, generic JSON-LD) and groups video URLs per video.
   3) Notices DRM (Encrypted Media Extensions) so the extension can say "protected" instead of failing silently. */
(() => {
  // Versioned guard: a page that still has the 1.0 hooks (opened before the update) also gets the 1.1 video hooks.
  if (window.__sourceLensMain === '1.1') return;
  window.__sourceLensMain = '1.1';
  const root = document.documentElement;
  const fire = (name, detail) => { try { root.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* ignore */ } };

  try { performance.setResourceTimingBufferSize?.(3000); } catch { /* ignore */ }

  // ------------------------------------------------------------------ DRM detection
  const markDrm = (system, el) => {
    try {
      root.setAttribute('data-sl-drm', system || 'eme');
      if (el && el.setAttribute) el.setAttribute('data-sl-drm', system || 'eme');
    } catch { /* ignore */ }
    fire('sl-drm', { system: system || 'eme' });
  };
  try {
    const rmksa = navigator.requestMediaKeySystemAccess;
    if (rmksa) {
      navigator.requestMediaKeySystemAccess = function (system, configs) {
        const p = rmksa.call(this, system, configs);
        // Only a *granted* real key system (not ClearKey probes) counts.
        p.then(() => { if (!/clearkey/i.test(system)) root.setAttribute('data-sl-drm-capable', system); }).catch(() => {});
        return p;
      };
    }
    const setMediaKeys = HTMLMediaElement.prototype.setMediaKeys;
    if (setMediaKeys) {
      HTMLMediaElement.prototype.setMediaKeys = function (keys) {
        if (keys) markDrm(root.getAttribute('data-sl-drm-capable') || 'eme', this);
        return setMediaKeys.call(this, keys);
      };
    }
  } catch { /* ignore */ }

  // ------------------------------------------------------------------ network URLs
  const videoLike = /(?:\.mp4|\.m4v|\.webm|\.mov|\.m3u8|\.mpd|\.ts|\.m4s)(?:$|[?#])|videoplayback|vod-progressive|playable_url|bytevod|mime_type=video/i;
  const emit = (url, via, extra) => {
    if (!url || typeof url !== 'string') return;
    let clean = url.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    try { clean = new URL(clean, location.href).href; } catch { return; }
    if (!/^https?:/i.test(clean)) return;
    if (!videoLike.test(clean)) return;
    fire('sl-media-url', { url: clean, via, ...(extra || {}) });
  };

  // ------------------------------------------------------------------ JSON video groups
  const groups = new Map();
  let emitTimer = 0;
  const flushGroups = () => {
    emitTimer = 0;
    fire('sl-video-groups', { groups: [...groups.values()].slice(-60) });
  };
  const scheduleEmit = () => { if (!emitTimer) emitTimer = setTimeout(flushGroups, 120); };

  const MARKERS = /video_versions|browser_native_(?:hd|sd)_url|playable_url|dash_manifest|video_dash_manifest|manifest_xml|"contentUrl"|progressive_url|hd_src|video_url/;
  const normId = v => String(v).replace(/^POLARIS_/, '');
  const isMpd = s => typeof s === 'string' && s.length > 60 && /<MPD[\s>]/.test(s.slice(0, 600));
  const httpUrl = s => typeof s === 'string' && /^https?:\/\//i.test(s) ? s : '';

  function groupFor(id) {
    const key = id || 'page';
    let g = groups.get(key);
    if (!g) {
      g = { id: key, progressive: [], mpd: '', mpdUrl: '', hls: '', width: 0, height: 0, duration: 0, hasAudio: null, thumb: '', code: '', title: '', t: Date.now() };
      groups.set(key, g);
    }
    return g;
  }
  function addProg(g, url, info) {
    url = httpUrl(url);
    if (!url || g.progressive.some(p => p.url === url)) return;
    g.progressive.push({ url, width: info.width || 0, height: info.height || 0, label: info.label || '', from: info.from || '' });
    g.t = Date.now();
  }

  function walk(rootNode, budget = 600000) {
    const stack = [[rootNode, '']];
    let found = false;
    while (stack.length && budget-- > 0) {
      const [node, inherited] = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) if (node[i] && typeof node[i] === 'object') stack.push([node[i], inherited]);
        continue;
      }
      const rawId = node.pk ?? node.id ?? node.videoId ?? node.video_id;
      const id = (typeof rawId === 'string' || typeof rawId === 'number') && String(rawId).length > 3 ? normId(rawId) : inherited;
      let g = null;
      const G = () => (g = g || groupFor(id));
      // Instagram
      if (Array.isArray(node.video_versions) && node.video_versions.length) {
        node.video_versions.forEach(v => addProg(G(), v?.url, { width: v?.width, height: v?.height, from: 'video_versions' }));
        if (node.original_width) { g.width = node.original_width; g.height = node.original_height || 0; }
        if (typeof node.has_audio === 'boolean') g.hasAudio = node.has_audio;
        if (node.video_duration) g.duration = Number(node.video_duration) || 0;
        if (node.code) g.code = String(node.code);
        const thumb = node.image_versions2?.candidates?.[0]?.url;
        if (thumb) g.thumb = thumb;
        const cap = node.caption?.text;
        if (typeof cap === 'string') g.title = cap.slice(0, 80);
        found = true;
      }
      if (isMpd(node.video_dash_manifest)) { G().mpd = node.video_dash_manifest; found = true; }
      // Facebook
      const fbHd = httpUrl(node.browser_native_hd_url) || httpUrl(node.playable_url_quality_hd) || httpUrl(node.hd_src_no_ratelimit) || httpUrl(node.hd_src);
      const fbSd = httpUrl(node.browser_native_sd_url) || httpUrl(node.playable_url) || httpUrl(node.sd_src_no_ratelimit) || httpUrl(node.sd_src);
      if (fbHd) { addProg(G(), fbHd, { label: 'HD', from: 'hd' }); found = true; }
      if (fbSd) { addProg(G(), fbSd, { label: 'SD', from: 'sd' }); found = true; }
      if (Array.isArray(node.progressive_urls)) {
        node.progressive_urls.forEach(p => { if (httpUrl(p?.progressive_url)) { addProg(G(), p.progressive_url, { label: p.metadata?.quality || '', from: 'progressive_urls' }); found = true; } });
      }
      for (const k of ['dash_manifest_xml_string', 'manifest_xml', 'dash_manifest']) {
        if (isMpd(node[k])) { G().mpd = node[k]; found = true; }
      }
      if (Array.isArray(node.dash_manifests)) node.dash_manifests.forEach(m => { if (isMpd(m?.manifest_xml)) { G().mpd = m.manifest_xml; found = true; } });
      if (httpUrl(node.dash_manifest_url)) { G().mpdUrl = node.dash_manifest_url; found = true; }
      if (g) {
        if (node.playable_duration_in_ms) g.duration = node.playable_duration_in_ms / 1000;
        if (!g.width && node.width && node.height && (fbHd || fbSd)) { g.width = node.width; g.height = node.height; }
        const t = node.preferred_thumbnail?.image?.uri || node.thumbnailImage?.uri;
        if (t && !g.thumb) g.thumb = t;
      }
      if (!g && id && (node.playable_duration_in_ms || node.__typename === 'Video') && node.width && node.height) {
        const existing = groups.get(id);
        if (existing && !existing.width) { existing.width = node.width; existing.height = node.height; }
        if (existing && node.playable_duration_in_ms) existing.duration = node.playable_duration_in_ms / 1000;
      }
      // Generic JSON-LD VideoObject / simple players
      if (node['@type'] === 'VideoObject' || node.video_url || node.videoUrl) {
        const u = httpUrl(node.contentUrl) || httpUrl(node.video_url) || httpUrl(node.videoUrl);
        if (u) {
          const gg = groupFor(id || `ld:${u.split('?')[0]}`);
          if (/\.m3u8(?:$|[?#])/i.test(u)) gg.hls = u;
          else if (/\.mpd(?:$|[?#])/i.test(u)) gg.mpdUrl = u;
          else addProg(gg, u, { from: 'json-ld' });
          if (typeof node.name === 'string' && !gg.title) gg.title = node.name.slice(0, 80);
          found = true;
        }
      }
      const keys = Object.keys(node);
      for (let i = keys.length - 1; i >= 0; i--) {
        const v = node[keys[i]];
        if (v && typeof v === 'object') stack.push([v, id]);
      }
    }
    return found;
  }

  function parseLoose(text) {
    if (!text) return [];
    let t = String(text).trim().replace(/^for\s*\(;;\);\s*/, '').replace(/^\)\]\}'\s*/, '');
    try { return [JSON.parse(t)]; } catch { /* maybe NDJSON */ }
    const out = [];
    for (const line of t.split('\n')) {
      const s = line.trim();
      if (!s || (s[0] !== '{' && s[0] !== '[')) continue;
      try { out.push(JSON.parse(s)); } catch { /* skip */ }
    }
    return out;
  }

  function sniffJson(text) {
    if (!text || text.length > 15_000_000 || !MARKERS.test(text)) return;
    let any = false;
    for (const obj of parseLoose(text)) if (walk(obj)) any = true;
    if (any) scheduleEmit();
  }

  const seenScripts = new WeakSet();
  function scanScripts() {
    let any = false;
    for (const s of document.scripts) {
      if (seenScripts.has(s)) continue;
      const type = (s.type || '').toLowerCase();
      const text = s.textContent || '';
      if (!text) continue;
      if (type === 'application/json' || type === 'application/ld+json') {
        seenScripts.add(s);
        if (!MARKERS.test(text) && type !== 'application/ld+json') continue;
        for (const obj of parseLoose(text)) if (walk(obj)) any = true;
      } else if (!type || /javascript/.test(type)) {
        // Only mark inline scripts once they are complete (DOM ready), and only look for manifest URLs.
        if (document.readyState === 'loading') continue;
        seenScripts.add(s);
        const re = /https?:(?:\\?\/){2}[^"'\s<>]+?\.(?:m3u8|mpd)(?:\?[^"'\s<>]*)?(?=["'\s<>])/g;
        let m, n = 0;
        while ((m = re.exec(text)) && n++ < 20) emit(m[0].replace(/\\\//g, '/'), 'script');
      }
    }
    if (any) scheduleEmit();
    else if (groups.size) scheduleEmit();
  }

  // ------------------------------------------------------------------ hooks
  const watchText = (url, ct, getText) => {
    try {
      if (/mpegurl|m3u8/i.test(ct) || /\.m3u8(?:$|[?#])/i.test(url)) emit(url, 'manifest', { manifest: 'hls' });
      else if (/dash\+xml/i.test(ct) || /\.mpd(?:$|[?#])/i.test(url)) emit(url, 'manifest', { manifest: 'dash' });
      else if (/json|javascript|text\/html|text\/plain/i.test(ct) && /graphql|api|ajax|query|bulk-route|web_info|\/info\b/i.test(url)) getText().then(sniffJson).catch(() => {});
    } catch { /* ignore */ }
  };
  try {
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      let url = '';
      try { url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || String(args[0] || '')); emit(url, 'fetch'); } catch { /* ignore */ }
      const pending = origFetch.apply(this, args);
      if (pending && typeof pending.then === 'function') {
        pending.then(res => {
          try {
            const ct = res.headers?.get?.('content-type') || '';
            watchText(res.url || url, ct, () => res.clone().text());
          } catch { /* ignore */ }
        }).catch(() => {});
      }
      return pending;
    };
  } catch { /* ignore */ }

  try {
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      const u = String(url || '');
      try { emit(u, 'xhr'); } catch { /* ignore */ }
      this.addEventListener('load', () => {
        try {
          const ct = this.getResponseHeader?.('content-type') || '';
          const rt = this.responseType;
          watchText(this.responseURL || u, ct, () => Promise.resolve(rt === '' || rt === 'text' ? this.responseText : (rt === 'json' ? JSON.stringify(this.response) : '')));
        } catch { /* ignore */ }
      });
      return open.call(this, method, url, ...rest);
    };
  } catch { /* ignore */ }

  // ------------------------------------------------------------------ triggers
  const kick = () => { try { scanScripts(); } catch { /* ignore */ } };
  document.addEventListener('DOMContentLoaded', kick, { once: true });
  window.addEventListener('load', () => setTimeout(kick, 300), { once: true });
  root.addEventListener('sl-extract-now', () => { kick(); flushGroups(); });
  // SPA navigation (Instagram/Facebook swap pages without reloading)
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) { lastHref = location.href; setTimeout(kick, 800); }
  }, 1000);
})();
