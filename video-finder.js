/* Source Lens — video finder (isolated content-script world).
   Turns everything we know about the page's videos into a ranked list of saveable items:
   kind = direct (a real file), dash / hls (stream we can download + merge), record (only by recording), drm (protected). */
(() => {
  if (window.__slVideo) return;
  const SL = globalThis.SourceLens;
  const MT = globalThis.SourceLensMedia;
  const V = window.__slVideo = {};
  const root = document.documentElement;
  const st = { groups: [], net: new Map(), drm: '', probes: new Map(), probing: new Set(), sw: [], swAt: 0, listeners: new Set(), mpdCache: new Map() };
  const changed = () => { clearTimeout(changed.t); changed.t = setTimeout(() => st.listeners.forEach(fn => { try { fn(); } catch { /* ignore */ } }), 150); };
  V.onChange = fn => st.listeners.add(fn);

  const host = () => location.hostname.replace(/^www\.|^m\./, '');
  const site = () => {
    const h = location.hostname;
    if (/(^|\.)instagram\.com$/.test(h)) return 'instagram';
    if (/(^|\.)facebook\.com$|(^|\.)fb\.watch$/.test(h)) return 'facebook';
    if (/(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$|(^|\.)youtu\.be$/.test(h)) return 'youtube';
    if (/(^|\.)tiktok\.com$/.test(h)) return 'tiktok';
    return 'other';
  };
  V.site = site;
  const NOISE = /googlevideo\.com|\/videoplayback|bytestart=|byteend=|[?&]range=|\/range\/|init\.mp4$|\.m4s(?:$|[?#])|\.ts(?:$|[?#])|\.m4a(?:$|[?#])|\.aac(?:$|[?#])/i;
  const isManifest = url => /\.m3u8(?:$|[?#])|\.mpd(?:$|[?#])|format=m3u8|manifest\(format=/i.test(url);
  const manifestType = url => (/\.mpd(?:$|[?#])|format=mpd/i.test(url) ? 'dash' : 'hls');
  const FILE = /\.(?:mp4|m4v|webm|mov|mkv)(?:$|[?#])/i;

  // ------------------------------------------------------------------ inputs
  root.addEventListener('sl-video-groups', ev => {
    const groups = ev.detail?.groups;
    if (Array.isArray(groups)) { st.groups = groups; changed(); }
  });
  root.addEventListener('sl-media-url', ev => {
    const url = ev.detail?.url;
    if (!url) return;
    const manifest = ev.detail.manifest || (isManifest(url) ? manifestType(url) : '');
    if (!manifest && (!FILE.test(url) || NOISE.test(url))) return;
    if (!st.net.has(url)) {
      st.net.set(url, { url, manifest, t: Date.now() });
      if (st.net.size > 120) st.net.delete(st.net.keys().next().value);
      if (manifest) probe(url);
      changed();
    }
  });
  root.addEventListener('sl-drm', ev => { st.drm = ev.detail?.system || 'eme'; changed(); });
  try {
    new PerformanceObserver(list => {
      list.getEntries().forEach(e => {
        if (isManifest(e.name) && !st.net.has(e.name)) {
          st.net.set(e.name, { url: e.name, manifest: manifestType(e.name), t: Date.now() });
          probe(e.name);
          changed();
        }
      });
    }).observe({ type: 'resource', buffered: true });
  } catch { /* ignore */ }

  function probe(url) {
    if (st.probes.has(url) || st.probing.has(url) || st.probing.size > 8) return;
    st.probing.add(url);
    try {
      chrome.runtime.sendMessage({ type: 'probeManifest', url, referer: location.href }, res => {
        void chrome.runtime.lastError;
        st.probing.delete(url);
        st.probes.set(url, res && !res.error ? res : { error: res?.error || 'probe failed' });
        changed();
      });
    } catch { st.probing.delete(url); }
  }

  function refreshSw() {
    if (Date.now() - st.swAt < 1500) return;
    st.swAt = Date.now();
    try {
      chrome.runtime.sendMessage({ type: 'tabMedia' }, res => {
        void chrome.runtime.lastError;
        const list = res?.items || [];
        const before = st.sw.length;
        st.sw = list;
        list.forEach(m => { if (m.manifest) probe(m.url); });
        if (list.length !== before) changed();
      });
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ helpers
  function efgTag(url) {
    try {
      const efg = new URL(url).searchParams.get('efg');
      if (!efg) return '';
      const json = JSON.parse(atob(efg.replace(/-/g, '+').replace(/_/g, '/')));
      return String(json.vencode_tag || '');
    } catch { return ''; }
  }
  function codecName(s) {
    s = String(s || '').toLowerCase();
    if (/av01|av1/.test(s)) return 'AV1';
    if (/vp09|vp9/.test(s)) return 'VP9';
    if (/vp8/.test(s)) return 'VP8';
    if (/hvc1|hev1|hevc|h265/.test(s)) return 'HEVC';
    if (/avc|h264|baseline|dash_main|dash_high|_h264|x264/.test(s)) return 'H.264';
    return '';
  }
  const pLabel = (w, h) => { const m = Math.min(w || 0, h || 0) || Math.max(w || 0, h || 0); return m ? `${m}p` : ''; };
  function codecNote(codec) {
    if (codec === 'AV1' || codec === 'VP9') return ` · ${codec} 코덱이라 구형 Mac 기본 플레이어(QuickTime)에서는 안 열릴 수 있어요. Chrome이나 VLC로 열면 됩니다.`;
    return '';
  }
  function slug(text) {
    return String(text || '').normalize('NFC').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/_+/g, '_').replace(/^[_-]+|[_-]+$/g, '').slice(0, 40).replace(/[_-]+$/, '');
  }
  function title() {
    const t = document.querySelector('meta[property="og:title"]')?.content || document.title || '';
    const parts = t.split(/\s+\|\s+/).filter(x => !/^(?:[\d.,]+\s*[KMB천만]?\s*(?:views?|reactions?|회|조회|반응))|^By\s|^(?:Facebook|Instagram|YouTube)$|views ·|조회수/i.test(x.trim()));
    return (parts.join(' ') || t).replace(/\s*[|•·-]\s*(Instagram|Facebook|YouTube)\s*$/i, '').replace(/^\(\d+\)\s*/, '');
  }
  V.fileName = (item, ext) => {
    const base = [host(), slug(item.title || item.code || title()) || 'video', item.quality || ''].filter(Boolean).join('-');
    return `${base}.${ext || item.ext || 'mp4'}`;
  };
  function urlPath(url) { try { return new URL(url).pathname; } catch { return url; } }

  function parseMpdCached(xml) {
    if (st.mpdCache.has(xml)) return st.mpdCache.get(xml);
    let res = null;
    try { res = MT.parseMpd(xml, location.href); } catch { res = null; }
    st.mpdCache.set(xml, res);
    if (st.mpdCache.size > 40) st.mpdCache.delete(st.mpdCache.keys().next().value);
    return res;
  }

  function loadedPaths() {
    const set = new Set();
    try {
      performance.getEntriesByType('resource').forEach(e => {
        if (/fbcdn|cdninstagram|scontent/.test(e.name)) set.add(urlPath(e.name));
      });
    } catch { /* ignore */ }
    return set;
  }

  function pageVideos() {
    const out = [];
    const visit = rootNode => {
      rootNode.querySelectorAll('video').forEach(v => { if (!v.closest('#sl-host')) out.push(v); });
      rootNode.querySelectorAll('*').forEach(el => { if (el.shadowRoot) visit(el.shadowRoot); });
    };
    try { visit(document); } catch { /* ignore */ }
    return out;
  }
  V.pageVideos = pageVideos;
  let vidSeq = 0;
  V.vidOf = video => {
    if (!video.dataset.slVid) video.dataset.slVid = String(++vidSeq);
    return video.dataset.slVid;
  };
  V.videoByVid = vid => pageVideos().find(v => v.dataset.slVid === String(vid)) || null;
  const isDrm = video => !!(video && (video.mediaKeys || video.hasAttribute('data-sl-drm')));
  V.isDrm = isDrm;

  // ------------------------------------------------------------------ collect
  V.collect = () => {
    try { root.dispatchEvent(new CustomEvent('sl-extract-now')); } catch { /* ignore */ }
    refreshSw();
    const items = [];
    const seen = new Set();
    const push = item => {
      const key = item.kind + ':' + (item.url || item.job?.url || item.job?.xml?.slice(0, 200) || item.vid);
      if (seen.has(key)) return;
      seen.add(key);
      items.push(item);
    };
    const s = site();
    const paths = loadedPaths();
    const pageTitle = title();

    // 1) Platform JSON groups (Instagram / Facebook / JSON-LD)
    const groups = (st.groups || []).filter(g => g.progressive?.length || g.mpd || g.mpdUrl || g.hls);
    groups.forEach(g => {
      const mpd = g.mpd ? parseMpdCached(g.mpd) : null;
      const urls = [...g.progressive.map(p => p.url), ...(mpd ? [...mpd.video, ...mpd.audio].map(r => r.segments[0]?.url || '') : [])];
      g.playing = urls.some(u => u && paths.has(urlPath(u)));
    });
    groups.sort((a, b) => (Number(b.playing) - Number(a.playing)) || (b.t - a.t));
    const platformName = s === 'instagram' ? '인스타그램' : s === 'facebook' ? '페이스북' : '페이지';
    groups.slice(0, 12).forEach(g => {
      const mpd = g.mpd ? parseMpdCached(g.mpd) : null;
      const base = { type: 'video', group: g.id, playing: !!g.playing, title: g.title || pageTitle, code: g.code, poster: g.thumb, duration: g.duration || 0 };
      const prog = g.progressive.map(p => {
        const tag = efgTag(p.url);
        const tagH = Number((/\.(\d{3,4})\./.exec(tag) || [])[1]) || 0;
        const w = p.width || 0, h = p.height || 0;
        const q = pLabel(w, h) || (tagH ? `${tagH}p` : '') || p.label || '';
        const rank = Math.min(w, h) || tagH || (p.label === 'HD' ? 720 : p.label === 'SD' ? 360 : 0);
        return { p, codec: codecName(tag) || (s === 'instagram' ? 'H.264' : ''), quality: q, rank, w, h };
      }).sort((a, b) => b.rank - a.rank);
      const byQ = new Set();
      let bestProg = 0;
      prog.forEach(x => {
        if (byQ.has(x.quality || x.p.url)) return;
        byQ.add(x.quality || x.p.url);
        bestProg = Math.max(bestProg, x.rank);
        const audio = g.hasAudio === false ? false : (s === 'facebook' || s === 'instagram' ? true : null);
        push({
          ...base, kind: 'direct', url: x.p.url, quality: x.quality, rank: x.rank, codec: x.codec, audio,
          width: x.w || g.width || 0, height: x.h || g.height || 0, ext: 'mp4',
          source: `${platformName} 원본 파일`,
          note: (audio === false ? '원본 파일 (원래 소리 없는 영상) · 바로 저장' : audio ? '원본 파일 (소리 포함) · 바로 저장' : '원본 파일 · 바로 저장') + codecNote(x.codec)
        });
      });
      if (mpd && !mpd.drm && !mpd.live && mpd.video.length) {
        const best = MT.pickDashVideo(mpd.video);
        const rank = Math.min(best.width || 0, best.height || 0) || best.height;
        if (rank > bestProg) {
          const codec = codecName(best.codecs);
          push({
            ...base, kind: 'dash', quality: best.label || pLabel(best.width, best.height), rank, codec, audio: mpd.audio.length > 0,
            width: best.width, height: best.height, ext: 'mp4', source: `${platformName} 고화질 스트림`,
            job: { kind: 'dash', xml: g.mpd, base: location.href, referer: location.href, title: base.title, code: g.code },
            note: `최고화질 · 영상과 소리가 따로 있어 받은 뒤 하나의 MP4로 합칩니다${mpd.audio.length ? '' : ' (소리 트랙 없음)'}` + codecNote(codec)
          });
        }
      } else if (mpd && mpd.drm) {
        push({ ...base, kind: 'drm', quality: '', source: platformName, url: `drm:${g.id}`, note: 'DRM(Widevine) 보호 영상이라 저장할 수 없습니다.' });
      }
      if (g.mpdUrl && !g.mpd && !/dash_mpd_debug/.test(g.mpdUrl)) push({ ...base, kind: 'dash', url: g.mpdUrl, quality: '', source: 'DASH 스트림', job: { kind: 'dash', url: g.mpdUrl, referer: location.href, title: base.title }, note: '스트리밍(DASH) · 조각을 모두 받아 하나의 MP4로 합칩니다' });
      if (g.hls) push({ ...base, kind: 'hls', url: g.hls, quality: '', source: 'HLS 스트림', job: { kind: 'hls', url: g.hls, referer: location.href, title: base.title }, note: '스트리밍(HLS) · 조각을 모두 받아 하나의 MP4로 합칩니다' });
    });

    // 2) Stream manifests seen on the network (hls.js, dash.js, video.js, Shaka …)
    const manifests = new Map();
    [...st.net.values()].filter(n => n.manifest).forEach(n => manifests.set(n.url, n));
    st.sw.filter(m => m.manifest).forEach(m => { if (!manifests.has(m.url)) manifests.set(m.url, { url: m.url, manifest: m.manifest, t: m.t }); });
    const childOfMaster = new Set();
    st.probes.forEach(p => (p.variants || []).forEach(v => childOfMaster.add(v.url)));
    st.probes.forEach(p => (p.audio || []).forEach(a => childOfMaster.add(a)));
    [...manifests.values()].sort((a, b) => b.t - a.t).forEach(n => {
      if (childOfMaster.has(n.url)) return;
      if (s === 'youtube' && /googlevideo|youtube\.com\/api\/manifest/i.test(n.url)) return;
      const p = st.probes.get(n.url);
      const type = p?.type || n.manifest;
      const label = type === 'dash' ? 'DASH' : 'HLS';
      const base = { type: 'video', url: n.url, title: pageTitle, source: `${label} 스트림`, ext: 'mp4' };
      if (p?.drm) {
        push({ ...base, kind: 'drm', quality: p.best ? `${p.best}p` : '', note: `DRM(${p.drm}) 보호 스트림이라 저장할 수 없습니다. 녹화해도 검은 화면이 됩니다.` });
        return;
      }
      if (p && !p.error && !p.master && !p.segments && type === 'hls') return; // empty / not a media playlist
      const quality = p?.best ? `${p.best}p` : '';
      const extra = p?.heights?.length > 1 ? ` · 화질 ${p.heights.map(h => `${h}p`).join('/')} 중 선택 가능` : '';
      const live = p?.live ? ' · 라이브 방송은 지금까지 올라온 구간만 저장됩니다' : '';
      push({
        ...base, kind: type, quality, rank: p?.best || 0, codec: codecName(p?.codecs), audio: p ? p.audio !== false : null,
        duration: p?.duration || 0, live: !!p?.live,
        job: { kind: type, url: n.url, referer: location.href, title: pageTitle },
        note: `스트리밍(${label}) · 조각을 모두 받아 하나의 MP4로 합칩니다${extra}${live}${p?.error ? ' · (미리 확인 실패, 저장 시 다시 시도)' : ''}`
      });
    });

    // 3) Plain files: <video src>, <source>, network .mp4/.webm
    const videos = pageVideos();
    const fileUrls = new Map();
    videos.forEach(v => {
      [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map(x => x.src)].forEach(u => {
        if (u && /^https?:/i.test(u) && !isManifest(u) && !NOISE.test(u)) fileUrls.set(u, { el: v, w: v.videoWidth, h: v.videoHeight });
        else if (u && isManifest(u) && !manifests.has(u)) {
          push({ type: 'video', kind: manifestType(u), url: u, quality: '', source: '영상 태그 스트림', title: pageTitle, ext: 'mp4', job: { kind: manifestType(u), url: u, referer: location.href, title: pageTitle }, note: '스트리밍 · 조각을 모두 받아 하나의 MP4로 합칩니다' });
          probe(u);
        }
      });
    });
    if (s !== 'instagram' && s !== 'facebook' && s !== 'youtube') {
      [...st.net.values()].filter(n => !n.manifest).forEach(n => { if (!fileUrls.has(n.url)) fileUrls.set(n.url, {}); });
      st.sw.filter(m => !m.manifest && (m.size || 0) > 200_000).forEach(m => { if (!fileUrls.has(m.url)) fileUrls.set(m.url, { size: m.size }); });
    }
    fileUrls.forEach((info, url) => {
      if (/googlevideo|fbcdn|cdninstagram/.test(url)) return;
      push({
        type: 'video', kind: 'direct', url, quality: pLabel(info.w, info.h), rank: Math.min(info.w || 0, info.h || 0), width: info.w || 0, height: info.h || 0,
        audio: null, size: info.size || 0, element: info.el || null, title: pageTitle, ext: (/\.(webm|mov|m4v|mkv)(?:$|[?#])/i.exec(url) || [0, 'mp4'])[1].toLowerCase(),
        source: info.el ? '영상 파일' : '네트워크 영상 파일', note: '원본 파일 · 바로 저장'
      });
    });

    // 4) Every visible player: recording fallback (or DRM notice)
    const hasSaveable = items.some(i => i.kind !== 'drm');
    videos.filter(v => {
      const r = v.getBoundingClientRect();
      return (v.videoWidth || r.width) >= 120 && r.width >= 80 && r.height >= 60;
    }).sort((a, b) => (Number(!b.paused) - Number(!a.paused)) || (b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)).slice(0, 4).forEach(v => {
      const vid = V.vidOf(v);
      const q = pLabel(v.videoWidth, v.videoHeight);
      const base = { type: 'video', url: `video:${vid}`, vid, element: v, quality: q, width: v.videoWidth, height: v.videoHeight, playing: !v.paused, title: pageTitle, duration: Number.isFinite(v.duration) ? v.duration : 0 };
      if (isDrm(v) || (st.drm && /^blob:/i.test(v.currentSrc || ''))) {
        push({ ...base, kind: 'drm', source: '보호된 영상', note: `DRM(${st.drm || 'Widevine'}) 보호 영상이라 저장할 수 없습니다. 녹화해도 검은 화면이 됩니다.` });
        return;
      }
      const yt = s === 'youtube';
      push({
        ...base, kind: 'record', audio: true, ext: 'mp4', source: yt ? '유튜브 플레이어' : '재생 중인 영상',
        note: yt
          ? '유튜브는 파일 주소를 주지 않습니다(SABR 스트리밍). 재생하면서 녹화해 저장합니다 · 영상 길이만큼 걸려요'
          : hasSaveable
            ? '위 방법이 안 될 때 쓰는 녹화 저장 · 영상 길이만큼 걸려요'
            : '파일 주소가 없어(스트리밍 전용) 재생하면서 녹화해 저장합니다 · 영상 길이만큼 걸려요'
      });
    });

    const order = { direct: 0, dash: 1, hls: 1, record: 3, drm: 4 };
    items.forEach((it, i) => { it._i = i; });
    const live = i => Number(!!(i.group && i.playing));
    items.sort((a, b) => (live(b) - live(a)) || (order[a.kind] - order[b.kind])
      || (a.group && a.group === b.group ? (b.rank || 0) - (a.rank || 0) : 0) || a._i - b._i);
    // Best per kind for the one-click button: prefer the playing group's best file / stream.
    items.forEach(it => {
      it.badge = { direct: '원본 파일', dash: 'DASH → MP4', hls: 'HLS → MP4', record: '녹화', drm: 'DRM 보호' }[it.kind];
      if (it.kind === 'direct' && it.audio === false) it.badge = '원본 파일';
      it.file = V.fileName(it, it.ext);
    });
    return items;
  };

  /** The single best thing to do for "one-click save". */
  V.best = (items, video) => {
    items = items || V.collect();
    if (video) {
      if (isDrm(video)) return items.find(i => i.kind === 'drm' && i.element === video) || { kind: 'drm', note: 'DRM 보호 영상입니다.' };
      const src = video.currentSrc || '';
      const exact = items.find(i => i.kind === 'direct' && i.url === src);
      if (exact) return exact;
    }
    const playingGroup = items.find(i => i.group && i.playing)?.group;
    const pool = playingGroup ? items.filter(i => i.group === playingGroup) : items;
    const pick = kinds => {
      const list = pool.filter(i => kinds.includes(i.kind));
      return list.sort((a, b) => (b.rank || 0) - (a.rank || 0))[0];
    };
    const directWithAudio = pick(['direct']);
    const stream = pick(['dash', 'hls']);
    // Prefer a merged high-quality stream only when it is clearly better than the file.
    if (directWithAudio && stream && stream.group && (stream.rank || 0) > (directWithAudio.rank || 0) * 1.3) return stream;
    if (directWithAudio) return directWithAudio;
    if (stream) return stream;
    const drm = items.find(i => i.kind === 'drm');
    const rec = items.filter(i => i.kind === 'record').find(i => !video || i.element === video) || items.find(i => i.kind === 'record');
    if (drm && (!rec || drm.element === rec.element || !drm.element)) return drm;
    return rec || drm || null;
  };

  /** Starts a stream download job (opens the Source Lens downloader tab). */
  V.startJob = (item, preferHeight) => new Promise(resolve => {
    const job = { ...item.job, quality: preferHeight || 0, file: item.file, title: item.title || title(), host: host() };
    chrome.runtime.sendMessage({ type: 'mediaJob', job }, res => {
      const err = chrome.runtime.lastError?.message;
      resolve(err ? { ok: false, error: err } : (res || { ok: true }));
    });
  });

  V.downloadDirect = item => new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'downloadUrl', url: item.url, filename: `source-lens/${item.file || V.fileName(item, item.ext)}` }, res => {
      const err = chrome.runtime.lastError?.message;
      resolve(err ? { ok: false, error: err } : (res || { ok: true }));
    });
  });

  V.plain = item => ({
    type: 'video', kind: item.kind, badge: item.badge, url: /^video:|^drm:/.test(item.url || '') ? '' : (item.url || ''), vid: item.vid || '',
    quality: item.quality || '', codec: item.codec || '', audio: item.audio, note: item.note || '', source: item.source || '',
    width: item.width || 0, height: item.height || 0, playing: !!item.playing, poster: item.poster || '', file: item.file,
    duration: item.duration || 0, job: item.job ? { ...item.job } : null, title: item.title || ''
  });
})();
