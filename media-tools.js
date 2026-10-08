/* Source Lens media tools: HLS/DASH manifest parsing, MPEG-TS -> MP4 remux, fragmented MP4 demux,
   and a plain MP4 writer that can merge separate video/audio tracks into one playable file.
   Pure JS, no remote code. Works in extension pages, content scripts and Node (for tests). */
(function (root) {
  const MT = root.SourceLensMedia = root.SourceLensMedia || {};

  // ---------------------------------------------------------------- HLS
  function attrs(line) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(line))) out[m[1]] = m[2].replace(/^"|"$/g, '');
    return out;
  }
  function resolve(url, base) {
    try { return new URL(url, base).href; } catch { return url; }
  }

  MT.parseHls = function parseHls(text, baseUrl) {
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length || !/^#EXTM3U/.test(lines[0])) throw new Error('HLS 재생목록이 아닙니다');
    const out = { master: false, variants: [], audio: [], segments: [], map: null, endList: false, drm: '', targetDuration: 0, mediaSequence: 0 };
    let pending = null;
    let inf = 0;
    let key = null;
    let seq = 0;
    let nextRange = null;
    let lastRangeEnd = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        out.master = true;
        const a = attrs(line.slice(18));
        const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
        pending = { bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0, width: w || 0, height: h || 0, codecs: a.CODECS || '', audio: a.AUDIO || '' };
      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = attrs(line.slice(13));
        if (a.TYPE === 'AUDIO' && a.URI) out.audio.push({ group: a['GROUP-ID'], name: a.NAME || '', lang: a.LANGUAGE || '', def: a.DEFAULT === 'YES', url: resolve(a.URI, baseUrl) });
      } else if (line.startsWith('#EXT-X-SESSION-KEY:') || line.startsWith('#EXT-X-KEY:')) {
        const a = attrs(line.slice(line.indexOf(':') + 1));
        const method = a.METHOD || 'NONE';
        const fmt = (a.KEYFORMAT || 'identity').toLowerCase();
        if (method === 'NONE') { key = null; continue; }
        if (method !== 'AES-128' || fmt !== 'identity') {
          out.drm = method === 'SAMPLE-AES' || method === 'SAMPLE-AES-CTR' || fmt !== 'identity' ? `${method} ${fmt}` : method;
          continue;
        }
        if (line.startsWith('#EXT-X-KEY:')) key = { method, url: resolve(a.URI, baseUrl), iv: a.IV || '' };
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const a = attrs(line.slice(11));
        out.map = { url: resolve(a.URI, baseUrl), range: a.BYTERANGE ? parseRange(a.BYTERANGE, 0).range : null, key };
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        seq = out.mediaSequence = Number(line.slice(22)) || 0;
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        out.targetDuration = Number(line.slice(22)) || 0;
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        out.endList = true;
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        const r = parseRange(line.slice(17), lastRangeEnd);
        nextRange = r.range;
        lastRangeEnd = r.end;
      } else if (line.startsWith('#EXTINF:')) {
        inf = parseFloat(line.slice(8)) || 0;
      } else if (!line.startsWith('#')) {
        if (pending) {
          out.variants.push({ ...pending, url: resolve(line, baseUrl) });
        } else {
          out.segments.push({ url: resolve(line, baseUrl), duration: inf, seq, key, range: nextRange });
          seq += 1;
        }
        pending = null;
        inf = 0;
        nextRange = null;
      }
    }
    out.variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
    out.duration = out.segments.reduce((n, s) => n + s.duration, 0);
    return out;
  };
  function parseRange(spec, prevEnd) {
    const [len, off] = spec.split('@').map(Number);
    const start = Number.isFinite(off) ? off : prevEnd;
    return { range: [start, start + len - 1], end: start + len };
  }

  // ---------------------------------------------------------------- DASH
  function durationSeconds(iso) {
    const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/.exec(iso || '');
    if (!m) return 0;
    return (Number(m[1]) || 0) * 86400 + (Number(m[2]) || 0) * 3600 + (Number(m[3]) || 0) * 60 + (parseFloat(m[4]) || 0);
  }
  function kids(el, name) { return el ? [...el.children].filter(c => c.localName === name) : []; }
  function kid(el, name) { return kids(el, name)[0] || null; }
  function fillTemplate(tpl, vars) {
    return tpl.replace(/\$(RepresentationID|Number|Time|Bandwidth)(?:%0(\d+)d)?\$/g, (_m, k, pad) => {
      const v = String(vars[k] ?? '');
      return pad ? v.padStart(Number(pad), '0') : v;
    }).replace(/\$\$/g, '$');
  }

  MT.parseMpd = function parseMpd(xml, baseUrl, DOMParserImpl) {
    const P = DOMParserImpl || root.DOMParser;
    const doc = new P().parseFromString(xml, 'application/xml');
    const mpd = doc.documentElement;
    if (!mpd || mpd.localName !== 'MPD') throw new Error('DASH 매니페스트가 아닙니다');
    const out = { live: mpd.getAttribute('type') === 'dynamic', drm: '', video: [], audio: [], duration: durationSeconds(mpd.getAttribute('mediaPresentationDuration')) };
    if (doc.getElementsByTagName('ContentProtection').length || /ContentProtection/.test(xml)) {
      const cp = doc.getElementsByTagName('ContentProtection')[0];
      out.drm = cp?.getAttribute('schemeIdUri') || 'ContentProtection';
    }
    let base = baseUrl || '';
    const baseOf = (el, inherited) => {
      const b = kid(el, 'BaseURL');
      return b ? resolve(b.textContent.trim(), inherited) : inherited;
    };
    base = baseOf(mpd, base);
    const period = kid(mpd, 'Period');
    if (!period) return out;
    const pBase = baseOf(period, base);
    const pDur = durationSeconds(period.getAttribute('duration')) || out.duration;
    for (const set of kids(period, 'AdaptationSet')) {
      const sBase = baseOf(set, pBase);
      const setMime = set.getAttribute('mimeType') || '';
      const setType = set.getAttribute('contentType') || setMime.split('/')[0];
      for (const rep of kids(set, 'Representation')) {
        const mime = rep.getAttribute('mimeType') || setMime;
        const type = setType || mime.split('/')[0];
        if (type !== 'video' && type !== 'audio') continue;
        const rBase = baseOf(rep, sBase);
        const info = {
          id: rep.getAttribute('id') || '',
          type,
          mime,
          codecs: rep.getAttribute('codecs') || set.getAttribute('codecs') || '',
          bandwidth: Number(rep.getAttribute('bandwidth')) || 0,
          width: Number(rep.getAttribute('width') || set.getAttribute('width')) || 0,
          height: Number(rep.getAttribute('height') || set.getAttribute('height')) || 0,
          label: rep.getAttribute('FBQualityLabel') || '',
          init: null,
          segments: []
        };
        const tpl = kid(rep, 'SegmentTemplate') || kid(set, 'SegmentTemplate');
        const list = kid(rep, 'SegmentList') || kid(set, 'SegmentList');
        const sb = kid(rep, 'SegmentBase') || kid(set, 'SegmentBase');
        const vars = { RepresentationID: info.id, Bandwidth: info.bandwidth };
        if (tpl) {
          const timescale = Number(tpl.getAttribute('timescale')) || 1;
          const start = Number(tpl.getAttribute('startNumber') ?? 1);
          const initT = tpl.getAttribute('initialization');
          if (initT) info.init = { url: resolve(fillTemplate(initT, vars), rBase) };
          const media = tpl.getAttribute('media') || '';
          const timeline = kid(tpl, 'SegmentTimeline');
          if (timeline) {
            let t = 0, n = start;
            for (const s of kids(timeline, 'S')) {
              if (s.hasAttribute('t')) t = Number(s.getAttribute('t'));
              const d = Number(s.getAttribute('d'));
              const r = Number(s.getAttribute('r') || 0);
              const reps = r < 0 ? Math.max(0, Math.ceil((pDur * timescale - t) / d) - 1) : r;
              for (let i = 0; i <= reps; i++) {
                info.segments.push({ url: resolve(fillTemplate(media, { ...vars, Number: n, Time: t }), rBase) });
                t += d; n += 1;
              }
            }
          } else {
            const d = Number(tpl.getAttribute('duration')) || 0;
            const count = d ? Math.ceil((pDur * timescale) / d) : 0;
            for (let i = 0; i < count; i++) info.segments.push({ url: resolve(fillTemplate(media, { ...vars, Number: start + i, Time: i * d }), rBase) });
          }
        } else if (list) {
          const initEl = kid(list, 'Initialization');
          if (initEl) info.init = { url: resolve(initEl.getAttribute('sourceURL') || rBase, rBase), range: initEl.getAttribute('range') };
          for (const s of kids(list, 'SegmentURL')) info.segments.push({ url: resolve(s.getAttribute('media') || rBase, rBase), range: s.getAttribute('mediaRange') });
        } else {
          // SegmentBase / plain BaseURL: the whole track is one file.
          info.segments.push({ url: rBase, whole: true, indexRange: sb?.getAttribute('indexRange') || '' });
        }
        (type === 'video' ? out.video : out.audio).push(info);
      }
    }
    out.video.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
    out.audio.sort((a, b) => b.bandwidth - a.bandwidth);
    return out;
  };

  /** Regex-level summary of a manifest (works without DOMParser, e.g. in the service worker). */
  MT.summarize = function summarize(text, url) {
    text = String(text || '');
    if (/^\s*#EXTM3U/.test(text)) {
      const p = MT.parseHls(text, url);
      const heights = [...new Set(p.variants.map(v => Math.min(v.width || 0, v.height || 0) || v.height).filter(Boolean))].sort((a, b) => b - a);
      return {
        type: 'hls', master: p.master, drm: p.drm, live: !p.master && !p.endList, segments: p.segments.length,
        duration: Math.round(p.duration), heights, best: heights[0] || 0, codecs: p.variants[0]?.codecs || '',
        variants: p.variants.map(v => ({ url: v.url, height: v.height, width: v.width, bandwidth: v.bandwidth })),
        audio: p.audio.map(a => a.url)
      };
    }
    if (/<MPD[\s>]/.test(text)) {
      const heights = new Set();
      const re = /<Representation\b[^>]*>/g;
      let m, codecs = '', hasAudio = false;
      while ((m = re.exec(text))) {
        const tag = m[0];
        const w = Number((/\swidth="(\d+)"/.exec(tag) || [])[1]) || 0;
        const h = Number((/\sheight="(\d+)"/.exec(tag) || [])[1]) || 0;
        if (h) { heights.add(Math.min(w || h, h)); codecs = codecs || (/codecs="([^"]+)"/.exec(tag) || [])[1] || ''; }
        if (/audio|mp4a|opus|ac-3|ec-3/.test(tag)) hasAudio = true;
      }
      if (/contentType="audio"|mimeType="audio/.test(text)) hasAudio = true;
      const list = [...heights].sort((a, b) => b - a);
      const cp = /<(?:\w+:)?ContentProtection\b[^>]*schemeIdUri="([^"]+)"/i.exec(text);
      const drm = cp ? (/edef8ba9/i.test(cp[1]) ? 'Widevine' : /9a04f079/i.test(cp[1]) ? 'PlayReady' : /94ce86fb/i.test(cp[1]) ? 'FairPlay' : 'CENC') : '';
      return {
        type: 'dash', master: true, drm, live: /type="dynamic"/.test(text), heights: list, best: list[0] || 0, codecs, audio: hasAudio,
        duration: Math.round(durationSeconds((/mediaPresentationDuration="([^"]+)"/.exec(text) || [])[1]))
      };
    }
    throw new Error('스트림 매니페스트가 아닙니다');
  };

  MT.pickDashVideo = function pickDashVideo(video, maxHeight) {
    const ok = video.filter(v => !maxHeight || v.height <= maxHeight);
    const pool = ok.length ? ok : video;
    if (!pool.length) return null;
    const top = pool[0].height;
    // Same height: prefer H.264 (plays everywhere, incl. QuickTime on Mac).
    return pool.filter(v => v.height === top).sort((a, b) => (Number(/^avc/.test(b.codecs)) - Number(/^avc/.test(a.codecs))) || (b.bandwidth - a.bandwidth))[0];
  };

  // ---------------------------------------------------------------- bytes helpers
  function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
  function u64(b, o) { return u32(b, o) * 4294967296 + u32(b, o + 4); }
  function s32(b, o) { return u32(b, o) | 0; }
  function str4(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

  function* boxes(buf, start, end) {
    let o = start;
    while (o + 8 <= end) {
      let size = u32(buf, o);
      const type = str4(buf, o + 4);
      let header = 8;
      if (size === 1) { size = u64(buf, o + 8); header = 16; }
      else if (size === 0) size = end - o;
      if (size < header || o + size > end) { yield { type, start: o, header, end: end, truncated: true }; return; }
      yield { type, start: o, header, end: o + size };
      o += size;
    }
  }
  function findBox(buf, start, end, path) {
    const [head, ...rest] = path;
    for (const b of boxes(buf, start, end)) {
      if (b.type !== head) continue;
      if (!rest.length) return b;
      const inner = findBox(buf, b.start + b.header + (FULL_CONTAINER[b.type] || 0), b.end, rest);
      if (inner) return inner;
    }
    return null;
  }
  const FULL_CONTAINER = { stsd: 8, meta: 4 };

  // ---------------------------------------------------------------- fragmented MP4 demux
  /** Parses an init segment (ftyp+moov). Returns tracks keyed by track_ID. */
  MT.parseInit = function parseInit(buf) {
    const tracks = {};
    const moov = findBox(buf, 0, buf.length, ['moov']);
    if (!moov) throw new Error('MP4 초기화 정보(moov)가 없습니다');
    const trex = {};
    const mvex = findBox(buf, moov.start + 8, moov.end, ['mvex']);
    if (mvex) for (const b of boxes(buf, mvex.start + 8, mvex.end)) {
      if (b.type !== 'trex') continue;
      const p = b.start + 12;
      trex[u32(buf, p)] = { duration: u32(buf, p + 8), size: u32(buf, p + 12), flags: u32(buf, p + 16) };
    }
    for (const trak of boxes(buf, moov.start + 8, moov.end)) {
      if (trak.type !== 'trak') continue;
      const tkhd = findBox(buf, trak.start + 8, trak.end, ['tkhd']);
      const v = buf[tkhd.start + 8];
      const id = u32(buf, tkhd.start + 8 + (v === 1 ? 20 : 12));
      const tkW = u32(buf, tkhd.end - 8) / 65536, tkH = u32(buf, tkhd.end - 4) / 65536;
      const mdhd = findBox(buf, trak.start + 8, trak.end, ['mdia', 'mdhd']);
      const mv = buf[mdhd.start + 8];
      const timescale = u32(buf, mdhd.start + 8 + (mv === 1 ? 20 : 12));
      const lang = u16(buf, mdhd.start + 8 + (mv === 1 ? 32 : 20));
      const hdlr = findBox(buf, trak.start + 8, trak.end, ['mdia', 'hdlr']);
      const handler = str4(buf, hdlr.start + 16);
      const stsd = findBox(buf, trak.start + 8, trak.end, ['mdia', 'minf', 'stbl', 'stsd']);
      const entry = [...boxes(buf, stsd.start + 16, stsd.end)][0];
      const sampleEntry = buf.slice(entry.start, entry.end);
      let width = tkW, height = tkH;
      if (handler === 'vide' && sampleEntry.length > 36) { width = u16(sampleEntry, 32); height = u16(sampleEntry, 34); }
      tracks[id] = {
        id, handler, type: handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : handler,
        timescale, lang, width, height, sampleEntry, codec: str4(sampleEntry, 4),
        trex: trex[id] || { duration: 0, size: 0, flags: 0 }, samples: [], nextDts: 0
      };
    }
    return tracks;
  };

  /** Appends samples from moof/mdat pairs in `buf` (one media segment or a whole fMP4 file). */
  MT.parseFragments = function parseFragments(buf, tracks) {
    for (const box of boxes(buf, 0, buf.length)) {
      if (box.type !== 'moof') continue;
      let prevEnd = null;
      for (const traf of boxes(buf, box.start + 8, box.end)) {
        if (traf.type !== 'traf') continue;
        let track = null, base = box.start, dur = 0, size = 0, flags = 0, tfdt = null;
        for (const b of boxes(buf, traf.start + 8, traf.end)) {
          const p = b.start + 8;
          if (b.type === 'tfhd') {
            const f = u32(buf, p) & 0xffffff;
            track = tracks[u32(buf, p + 4)];
            if (!track) break;
            dur = track.trex.duration; size = track.trex.size; flags = track.trex.flags;
            let q = p + 8;
            if (f & 0x1) { base = u64(buf, q); q += 8; } else if (!(f & 0x20000) && prevEnd !== null) base = prevEnd;
            if (f & 0x2) q += 4;
            if (f & 0x8) { dur = u32(buf, q); q += 4; }
            if (f & 0x10) { size = u32(buf, q); q += 4; }
            if (f & 0x20) { flags = u32(buf, q); q += 4; }
          } else if (b.type === 'tfdt' && track) {
            tfdt = buf[p] === 1 ? u64(buf, p + 4) : u32(buf, p + 4);
          } else if (b.type === 'trun' && track) {
            const v = buf[p];
            const f = u32(buf, p) & 0xffffff;
            const count = u32(buf, p + 4);
            let q = p + 8;
            let dataOff = base;
            if (f & 0x1) { dataOff = base + s32(buf, q); q += 4; }
            let firstFlags = null;
            if (f & 0x4) { firstFlags = u32(buf, q); q += 4; }
            if (tfdt !== null) { track.nextDts = tfdt; tfdt = null; }
            let off = dataOff;
            for (let i = 0; i < count; i++) {
              const d = f & 0x100 ? u32(buf, (q += 4) - 4) : dur;
              const s = f & 0x200 ? u32(buf, (q += 4) - 4) : size;
              let fl = f & 0x400 ? u32(buf, (q += 4) - 4) : (i === 0 && firstFlags !== null ? firstFlags : flags);
              if (i === 0 && firstFlags !== null && (f & 0x400)) fl = firstFlags;
              let cto = 0;
              if (f & 0x800) { cto = v === 1 ? s32(buf, q) : u32(buf, q); q += 4; }
              if (off + s > buf.length) break;
              track.samples.push({ data: buf.subarray(off, off + s), duration: d, cto, key: track.type !== 'video' || !(fl & 0x10000), dts: track.nextDts });
              track.nextDts += d;
              off += s;
            }
            prevEnd = off;
          }
        }
      }
    }
    return tracks;
  };

  // ---------------------------------------------------------------- MPEG-TS demux (H.264 + AAC)
  const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

  MT.demuxTs = function demuxTs(chunks) {
    const pes = {};
    let pmtPid = -1;
    const streams = {};
    const video = { nals: [], samples: [], sps: null, pps: null };
    const audio = { samples: [], config: null, rate: 0, channels: 0, profile: 0 };
    let lastPts = { v: null, a: null };
    const unwrap = (key, ts) => {
      if (ts == null) return ts;
      const prev = lastPts[key];
      if (prev != null) {
        while (ts - prev > 4294967296) ts -= 8589934592;
        while (prev - ts > 4294967296) ts += 8589934592;
      }
      lastPts[key] = ts;
      return ts;
    };
    const flush = pid => {
      const p = pes[pid];
      if (!p || !p.parts.length) return;
      const len = p.parts.reduce((n, x) => n + x.length, 0);
      const data = new Uint8Array(len);
      let o = 0;
      for (const x of p.parts) { data.set(x, o); o += x.length; }
      p.parts = [];
      if (data[0] !== 0 || data[1] !== 0 || data[2] !== 1) return;
      const flags = data[7];
      const hlen = data[8];
      let pts = null, dts = null;
      const ts = q => (data[q] & 0x0e) * 536870912 + data[q + 1] * 4194304 + (data[q + 2] & 0xfe) * 16384 + data[q + 3] * 128 + (data[q + 4] >> 1);
      if (flags & 0x80) pts = ts(9);
      if (flags & 0x40) dts = ts(14); else dts = pts;
      const payload = data.subarray(9 + hlen);
      const st = streams[pid];
      if (st === 0x1b) handleH264(payload, unwrap('v', pts), unwrap('v2', dts));
      else if (st === 0x0f) handleAac(payload, unwrap('a', pts));
    };
    const handleH264 = (payload, pts, dts) => {
      const nals = [];
      let i = 0, start = -1;
      while (i + 3 <= payload.length) {
        if (payload[i] === 0 && payload[i + 1] === 0 && (payload[i + 2] === 1 || (payload[i + 2] === 0 && payload[i + 3] === 1))) {
          if (start >= 0) nals.push(payload.subarray(start, i));
          i += payload[i + 2] === 1 ? 3 : 4;
          start = i;
        } else i++;
      }
      if (start >= 0) nals.push(payload.subarray(start));
      const keep = [];
      let key = false;
      for (let nal of nals) {
        while (nal.length && nal[nal.length - 1] === 0) nal = nal.subarray(0, nal.length - 1);
        if (!nal.length) continue;
        const t = nal[0] & 0x1f;
        if (t === 7) { if (!video.sps) video.sps = nal.slice(); continue; }
        if (t === 8) { if (!video.pps) video.pps = nal.slice(); continue; }
        if (t === 9) continue;
        if (t === 5) key = true;
        keep.push(nal);
      }
      if (!keep.length || pts == null) return;
      const size = keep.reduce((n, x) => n + 4 + x.length, 0);
      const data = new Uint8Array(size);
      let o = 0;
      for (const n of keep) { data[o] = n.length >>> 24; data[o + 1] = (n.length >> 16) & 255; data[o + 2] = (n.length >> 8) & 255; data[o + 3] = n.length & 255; data.set(n, o + 4); o += 4 + n.length; }
      video.samples.push({ data, pts, dts: dts ?? pts, key });
    };
    const handleAac = (payload, pts) => {
      let i = 0, n = 0;
      while (i + 7 <= payload.length) {
        if (payload[i] !== 0xff || (payload[i + 1] & 0xf6) !== 0xf0) { i++; continue; }
        const protAbsent = payload[i + 1] & 1;
        const profile = (payload[i + 2] >> 6) + 1;
        const fi = (payload[i + 2] >> 2) & 15;
        const ch = ((payload[i + 2] & 1) << 2) | (payload[i + 3] >> 6);
        const flen = ((payload[i + 3] & 3) << 11) | (payload[i + 4] << 3) | (payload[i + 5] >> 5);
        const hl = protAbsent ? 7 : 9;
        if (flen < hl || i + flen > payload.length) break;
        if (!audio.config) {
          audio.rate = ADTS_RATES[fi] || 44100; audio.channels = ch; audio.profile = profile;
          audio.config = new Uint8Array([(profile << 3) | (fi >> 1), ((fi & 1) << 7) | (ch << 3)]);
        }
        const fpts = pts == null ? null : pts + Math.round(n * 1024 * 90000 / audio.rate);
        audio.samples.push({ data: payload.slice(i + hl, i + flen), pts: fpts });
        i += flen; n++;
      }
    };
    for (const chunk of chunks) {
      for (let o = 0; o + 188 <= chunk.length; o += 188) {
        if (chunk[o] !== 0x47) { // resync
          const next = chunk.indexOf(0x47, o + 1);
          if (next < 0) break;
          o = next - 188;
          continue;
        }
        const pusi = chunk[o + 1] & 0x40;
        const pid = ((chunk[o + 1] & 0x1f) << 8) | chunk[o + 2];
        const afc = (chunk[o + 3] >> 4) & 3;
        let p = o + 4;
        if (afc === 2) continue;
        if (afc === 3) p += 1 + chunk[o + 4];
        if (p >= o + 188) continue;
        if (pid === 0) {
          if (pusi) p += 1 + chunk[p];
          const secLen = ((chunk[p + 1] & 0x0f) << 8) | chunk[p + 2];
          for (let q = p + 8; q < p + 3 + secLen - 4; q += 4) {
            const prog = u16(chunk, q);
            if (prog !== 0) pmtPid = ((chunk[q + 2] & 0x1f) << 8) | chunk[q + 3];
          }
        } else if (pid === pmtPid) {
          if (pusi) p += 1 + chunk[p];
          const secLen = ((chunk[p + 1] & 0x0f) << 8) | chunk[p + 2];
          const infoLen = ((chunk[p + 10] & 0x0f) << 8) | chunk[p + 11];
          let q = p + 12 + infoLen;
          const end = p + 3 + secLen - 4;
          while (q + 5 <= end) {
            const type = chunk[q];
            const epid = ((chunk[q + 1] & 0x1f) << 8) | chunk[q + 2];
            const esLen = ((chunk[q + 3] & 0x0f) << 8) | chunk[q + 4];
            if (!(epid in streams)) streams[epid] = type;
            q += 5 + esLen;
          }
        } else if (pid in streams) {
          if (pusi) flush(pid);
          (pes[pid] = pes[pid] || { parts: [] }).parts.push(chunk.subarray(p, o + 188));
        }
      }
    }
    Object.keys(pes).forEach(pid => flush(Number(pid)));
    const types = Object.values(streams);
    const unsupported = types.filter(t => ![0x1b, 0x0f, 0x15, 0x06].includes(t));
    return { video, audio, streamTypes: types, unsupported };
  };

  function bitReader(bytes) {
    // strip emulation prevention bytes
    const clean = [];
    for (let i = 0; i < bytes.length; i++) {
      if (i >= 2 && bytes[i] === 3 && bytes[i - 1] === 0 && bytes[i - 2] === 0) continue;
      clean.push(bytes[i]);
    }
    let pos = 0;
    const bit = () => (clean[pos >> 3] >> (7 - (pos++ & 7))) & 1;
    const bits = n => { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + bit(); return v; };
    const ue = () => { let z = 0; while (!bit() && z < 32) z++; return (2 ** z) - 1 + bits(z); };
    const se = () => { const v = ue(); return v & 1 ? (v + 1) / 2 : -v / 2; };
    return { bit, bits, ue, se };
  }
  MT.parseSps = function parseSps(sps) {
    const r = bitReader(sps.subarray(1));
    const profile = r.bits(8); r.bits(8); r.bits(8); r.ue();
    let chroma = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = r.ue();
      if (chroma === 3) r.bit();
      r.ue(); r.ue(); r.bit();
      if (r.bit()) {
        for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
          if (r.bit()) {
            const size = i < 6 ? 16 : 64;
            let last = 8, next = 8;
            for (let j = 0; j < size; j++) { if (next !== 0) next = (last + r.se() + 256) % 256; last = next === 0 ? last : next; }
          }
        }
      }
    }
    r.ue();
    const pocType = r.ue();
    if (pocType === 0) r.ue();
    else if (pocType === 1) { r.bit(); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
    r.ue(); r.bit();
    const wMbs = r.ue() + 1, hMapUnits = r.ue() + 1;
    const frameMbsOnly = r.bit();
    if (!frameMbsOnly) r.bit();
    r.bit();
    let cl = 0, cr = 0, ct = 0, cb = 0;
    if (r.bit()) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
    const subW = chroma === 1 || chroma === 2 ? 2 : 1, subH = chroma === 1 ? 2 : 1;
    const width = wMbs * 16 - (cl + cr) * subW;
    const height = (2 - frameMbsOnly) * hMapUnits * 16 - (ct + cb) * subH * (2 - frameMbsOnly);
    return { width, height };
  };

  /** Converts demuxed TS streams into writer tracks. */
  MT.tsToTracks = function tsToTracks(demuxed) {
    const tracks = [];
    const v = demuxed.video;
    if (v.samples.length && v.sps && v.pps) {
      const { width, height } = MT.parseSps(v.sps);
      const avcC = concat([new Uint8Array([1, v.sps[1], v.sps[2], v.sps[3], 0xff, 0xe1, v.sps.length >> 8, v.sps.length & 255]), v.sps, new Uint8Array([1, v.pps.length >> 8, v.pps.length & 255]), v.pps]);
      const samples = v.samples.slice().sort((a, b) => a.dts - b.dts);
      const out = samples.map((s, i) => ({
        data: s.data, key: s.key, dts: s.dts, cto: s.pts - s.dts,
        duration: i + 1 < samples.length ? samples[i + 1].dts - s.dts : (i ? samples[i].dts - samples[i - 1].dts : 3000)
      }));
      tracks.push({ type: 'video', timescale: 90000, width, height, sampleEntry: avc1Entry(width, height, avcC), samples: out, startPts: Math.min(...samples.slice(0, 30).map(s => s.pts)) });
    }
    const a = demuxed.audio;
    if (a.samples.length && a.config) {
      const scale = a.rate;
      const first = a.samples.find(s => s.pts != null)?.pts ?? 0;
      const samples = a.samples.map(s => ({ data: s.data, key: true, duration: 1024, cto: 0 }));
      tracks.push({ type: 'audio', timescale: scale, sampleRate: a.rate, channels: a.channels, sampleEntry: mp4aEntry(a.rate, a.channels, a.config), samples, startPts: first });
    }
    // Align: express start offsets (seconds) relative to the earliest track.
    const base = Math.min(...tracks.map(t => t.startPts));
    tracks.forEach(t => { t.delay = (t.startPts - base) / 90000; });
    return tracks;
  };

  /** Packed ADTS audio (HLS .aac renditions, optional ID3 header) -> writer track. */
  MT.adtsToTrack = function adtsToTrack(chunks) {
    const samples = [];
    let config = null, rate = 44100, channels = 2;
    for (const buf of chunks) {
      let i = 0;
      while (i + 10 <= buf.length && buf[i] === 0x49 && buf[i + 1] === 0x44 && buf[i + 2] === 0x33) {
        const size = ((buf[i + 6] & 0x7f) << 21) | ((buf[i + 7] & 0x7f) << 14) | ((buf[i + 8] & 0x7f) << 7) | (buf[i + 9] & 0x7f);
        i += 10 + size;
      }
      while (i + 7 <= buf.length) {
        if (buf[i] !== 0xff || (buf[i + 1] & 0xf6) !== 0xf0) { i++; continue; }
        const protAbsent = buf[i + 1] & 1;
        const profile = (buf[i + 2] >> 6) + 1;
        const fi = (buf[i + 2] >> 2) & 15;
        const ch = ((buf[i + 2] & 1) << 2) | (buf[i + 3] >> 6);
        const flen = ((buf[i + 3] & 3) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5);
        const hl = protAbsent ? 7 : 9;
        if (flen < hl || i + flen > buf.length) break;
        if (!config) { rate = ADTS_RATES[fi] || 44100; channels = ch || 2; config = new Uint8Array([(profile << 3) | (fi >> 1), ((fi & 1) << 7) | (ch << 3)]); }
        samples.push({ data: buf.subarray(i + hl, i + flen), duration: 1024, cto: 0, key: true });
        i += flen;
      }
    }
    if (!samples.length) return null;
    return { type: 'audio', timescale: rate, sampleEntry: mp4aEntry(rate, channels, config), samples, delay: 0 };
  };

  /** What kind of media segment is this? */
  MT.sniff = function sniff(buf) {
    if (!buf || buf.length < 8) return 'unknown';
    if (buf[0] === 0x47 && (buf.length < 189 || buf[188] === 0x47)) return 'ts';
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
      // ID3 then ADTS (packed audio) or TS
      return 'adts';
    }
    if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return 'adts';
    const t = str4(buf, 4);
    if (['ftyp', 'styp', 'moof', 'moov', 'sidx', 'free', 'emsg', 'prft'].includes(t)) return 'mp4';
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
    return 'unknown';
  };

  /** Converts fMP4-demuxed tracks into writer tracks. */
  MT.fmp4ToTracks = function fmp4ToTracks(parsed) {
    return Object.values(parsed).filter(t => (t.type === 'video' || t.type === 'audio') && t.samples.length).map(t => ({
      type: t.type, timescale: t.timescale, width: t.width, height: t.height, sampleEntry: t.sampleEntry, lang: t.lang,
      samples: t.samples, delay: 0, startTime: t.samples[0].dts / t.timescale
    }));
  };

  // ---------------------------------------------------------------- MP4 writer
  function concat(parts) {
    const len = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function be(n, bytes) {
    const out = new Uint8Array(bytes);
    for (let i = bytes - 1; i >= 0; i--) { out[i] = n % 256; n = Math.floor(n / 256); }
    return out;
  }
  function box(type, ...parts) {
    const body = concat(parts.map(p => (p instanceof Uint8Array ? p : new Uint8Array(p))));
    return concat([be(body.length + 8, 4), new TextEncoder().encode(type), body]);
  }
  function full(type, version, flags, ...parts) {
    return box(type, new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
  }
  const MATRIX = concat([be(0x10000, 4), be(0, 4), be(0, 4), be(0, 4), be(0x10000, 4), be(0, 4), be(0, 4), be(0, 4), be(0x40000000, 4)]);

  function avc1Entry(width, height, avcC) {
    return box('avc1', new Uint8Array(6), be(1, 2), new Uint8Array(16), be(width, 2), be(height, 2),
      be(0x00480000, 4), be(0x00480000, 4), be(0, 4), be(1, 2), new Uint8Array(32), be(0x18, 2), be(0xffff, 2), box('avcC', avcC));
  }
  function mp4aEntry(rate, channels, config) {
    const dsi = concat([new Uint8Array([0x05, config.length]), config]);
    const dcd = concat([new Uint8Array([0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0]), be(128000, 4), be(128000, 4), dsi]);
    const esd = concat([new Uint8Array([0x03, 3 + dcd.length + 3, 0, 1, 0]), dcd, new Uint8Array([0x06, 1, 2])]);
    return box('mp4a', new Uint8Array(6), be(1, 2), new Uint8Array(8), be(channels || 2, 2), be(16, 2), be(0, 4), be(rate * 65536, 4), full('esds', 0, 0, esd));
  }

  /**
   * Writes a non-fragmented MP4 from tracks [{type,timescale,width,height,sampleEntry,samples:[{data,duration,cto,key}],delay}].
   * Returns an array of parts (Uint8Array) suitable for `new Blob(parts)` without copying sample data.
   */
  MT.writeMp4 = function writeMp4(tracks) {
    tracks = tracks.filter(t => t.samples.length);
    if (!tracks.length) throw new Error('저장할 영상/소리 데이터가 없습니다');
    const movieScale = 1000;
    const ftyp = box('ftyp', new TextEncoder().encode('isom'), be(0x200, 4), new TextEncoder().encode('isomiso2avc1mp41'));
    let mdatSize = 8;
    tracks.forEach(t => { t.bytes = t.samples.reduce((n, s) => n + s.data.length, 0); mdatSize += t.bytes; });
    const large = mdatSize > 0xffffffff;
    const build = mdatStart => {
      let offset = mdatStart + (large ? 16 : 8);
      const traks = tracks.map((t, i) => {
        const id = i + 1;
        const chunkOffset = offset;
        offset += t.bytes;
        const mediaDur = t.samples.reduce((n, s) => n + s.duration, 0);
        const delayMovie = Math.round((t.delay || 0) * movieScale);
        const tkDur = Math.round(mediaDur / t.timescale * movieScale) + delayMovie;
        t.movieDuration = tkDur;
        const isV = t.type === 'video';
        const tkhd = full('tkhd', 0, 3, be(0, 4), be(0, 4), be(id, 4), be(0, 4), be(tkDur, 4), new Uint8Array(8), be(0, 2), be(0, 2), be(isV ? 0 : 0x0100, 2), be(0, 2), MATRIX, be(isV ? (t.width || 0) * 65536 : 0, 4), be(isV ? (t.height || 0) * 65536 : 0, 4));
        const firstCto = t.samples[0].cto || 0;
        const edits = [];
        if (delayMovie > 0) edits.push(concat([be(delayMovie, 4), be(0xffffffff, 4), be(0x10000, 4)]));
        edits.push(concat([be(Math.round(mediaDur / t.timescale * movieScale), 4), be(Math.max(0, firstCto), 4), be(0x10000, 4)]));
        const edts = box('edts', full('elst', 0, 0, be(edits.length, 4), ...edits));
        const mdhd = full('mdhd', 0, 0, be(0, 4), be(0, 4), be(t.timescale, 4), be(mediaDur, 4), be(t.lang || 0x55c4, 2), be(0, 2));
        const hdlr = full('hdlr', 0, 0, be(0, 4), new TextEncoder().encode(isV ? 'vide' : 'soun'), new Uint8Array(12), new TextEncoder().encode(isV ? 'VideoHandler\0' : 'SoundHandler\0'));
        const xmhd = isV ? full('vmhd', 0, 1, new Uint8Array(8)) : full('smhd', 0, 0, new Uint8Array(4));
        const dinf = box('dinf', full('dref', 0, 0, be(1, 4), full('url ', 0, 1)));
        const stsd = full('stsd', 0, 0, be(1, 4), t.sampleEntry);
        // stts (run-length)
        const stts = [];
        for (const s of t.samples) {
          const last = stts[stts.length - 1];
          if (last && last[1] === s.duration) last[0]++; else stts.push([1, s.duration]);
        }
        const sttsBox = full('stts', 0, 0, be(stts.length, 4), ...stts.map(([c, d]) => concat([be(c, 4), be(d, 4)])));
        const needCtts = t.samples.some(s => s.cto);
        let cttsBox = new Uint8Array(0);
        if (needCtts) {
          const runs = [];
          for (const s of t.samples) {
            const last = runs[runs.length - 1];
            if (last && last[1] === s.cto) last[0]++; else runs.push([1, s.cto]);
          }
          const neg = runs.some(r => r[1] < 0);
          cttsBox = full('ctts', neg ? 1 : 0, 0, be(runs.length, 4), ...runs.map(([c, o]) => concat([be(c, 4), be(o < 0 ? 0x100000000 + o : o, 4)])));
        }
        let stssBox = new Uint8Array(0);
        if (isV && t.samples.some(s => !s.key)) {
          const keys = [];
          t.samples.forEach((s, k) => { if (s.key) keys.push(k + 1); });
          stssBox = full('stss', 0, 0, be(keys.length, 4), ...keys.map(k => be(k, 4)));
        }
        const sizes = new Uint8Array(t.samples.length * 4);
        t.samples.forEach((s, k) => sizes.set(be(s.data.length, 4), k * 4));
        const stsz = full('stsz', 0, 0, be(0, 4), be(t.samples.length, 4), sizes);
        const stsc = full('stsc', 0, 0, be(1, 4), be(1, 4), be(t.samples.length, 4), be(1, 4));
        const stco = large ? full('co64', 0, 0, be(1, 4), be(chunkOffset, 8)) : full('stco', 0, 0, be(1, 4), be(chunkOffset, 4));
        const stbl = box('stbl', stsd, sttsBox, cttsBox, stssBox, stsc, stsz, stco);
        return box('trak', tkhd, edts, box('mdia', mdhd, hdlr, box('minf', xmhd, dinf, stbl)));
      });
      const dur = Math.max(...tracks.map(t => t.movieDuration));
      const mvhd = full('mvhd', 0, 0, be(0, 4), be(0, 4), be(movieScale, 4), be(dur, 4), be(0x10000, 4), be(0x0100, 2), new Uint8Array(10), MATRIX, new Uint8Array(24), be(tracks.length + 1, 4));
      return box('moov', mvhd, ...traks);
    };
    // moov size does not depend on offsets (fixed-width fields), so build twice.
    const probe = build(0);
    const moov = build(ftyp.length + probe.length);
    const mdatHeader = large ? concat([be(1, 4), new TextEncoder().encode('mdat'), be(mdatSize + 8, 8)]) : concat([be(mdatSize, 4), new TextEncoder().encode('mdat')]);
    const parts = [ftyp, moov, mdatHeader];
    tracks.forEach(t => t.samples.forEach(s => parts.push(s.data)));
    return parts;
  };

  /** Uses each track's first timestamp (startTime, seconds) to keep audio and video in sync. */
  MT.alignTracks = function alignTracks(tracks) {
    const starts = tracks.map(t => (Number.isFinite(t.startTime) ? t.startTime : null)).filter(v => v !== null);
    if (starts.length === tracks.length && starts.length > 1) {
      const min = Math.min(...starts);
      tracks.forEach(t => { const d = t.startTime - min; t.delay = d > 0.001 && d < 30 ? d : 0; });
    }
    return tracks;
  };

  MT.concat = concat;
  if (typeof module !== 'undefined' && module.exports) module.exports = MT;
})(typeof globalThis !== 'undefined' ? globalThis : this);
