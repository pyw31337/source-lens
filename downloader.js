/* Source Lens downloader: fetches HLS / DASH streams, decrypts AES-128 (HLS clear-key only),
   merges video + audio into one MP4 and saves it. Never touches DRM-protected streams. */
const api = globalThis.chrome;
const MT = globalThis.SourceLensMedia;
const $ = s => document.querySelector(s);
const jobId = location.hash.slice(1);
const CONCURRENCY = 6;
const ui = {
  status(text, kind) { const el = $('#status'); el.textContent = text; el.className = kind || ''; },
  detail(text) { $('#detail').textContent = text || ''; },
  bar(p) { $('#bar').style.width = `${Math.max(0, Math.min(100, p * 100)).toFixed(1)}%`; }
};
let job = null;
let controller = null;
let running = false;
let plan = null; // { choices:[{label, value}], chosen }
let savedId = null;

const fmtMB = n => `${(n / 1048576).toFixed(n > 104857600 ? 0 : 1)}MB`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
class UserError extends Error {}

async function prefsFolder() {
  try {
    const p = (await api.storage.local.get('slPrefs')).slPrefs || {};
    return String(p.folder || 'source-lens').replace(/[\\:*?"<>|]+/g, '_').replace(/^\/+|\/+$/g, '').replace(/\.\.+/g, '_') || 'source-lens';
  } catch { return 'source-lens'; }
}
function slug(t) { return String(t || '').normalize('NFC').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/_+/g, '_').replace(/^[_-]+|[_-]+$/g, '').slice(0, 40).replace(/[_-]+$/, ''); }
function fileName(quality, ext) {
  const host = job.host || (() => { try { return new URL(job.referer).hostname.replace(/^www\./, ''); } catch { return 'video'; } })();
  return [host, slug(job.title || job.code) || 'video', quality].filter(Boolean).join('-') + `.${ext}`;
}

// ---------------------------------------------------------------- network
async function setReferer() {
  if (!job.referer || !api.declarativeNetRequest?.updateSessionRules) return;
  try {
    const tab = await api.tabs.getCurrent();
    const id = 900000 + (tab.id % 90000);
    const origin = new URL(job.referer).origin;
    await api.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{
        id, priority: 3,
        action: { type: 'modifyHeaders', requestHeaders: [
          { header: 'referer', operation: 'set', value: job.referer },
          { header: 'origin', operation: 'set', value: origin }
        ] },
        condition: { tabIds: [tab.id], resourceTypes: ['xmlhttprequest', 'media', 'other'] }
      }]
    });
    window.addEventListener('pagehide', () => api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }));
  } catch (e) { console.warn('referer rule', e); }
}

async function get(url, { range, asText, onBytes, signal } = {}) {
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const credentials of attempt % 2 ? ['include'] : ['omit']) {
      try {
        const headers = range ? { Range: `bytes=${range[0]}-${range[1] ?? ''}` } : {};
        const res = await fetch(url, { credentials, headers, signal, cache: 'no-store', redirect: 'follow' });
        if (!res.ok) { last = `HTTP ${res.status}`; if (res.status === 404 || res.status === 410) attempt = 9; continue; }
        if (asText) return await res.text();
        if (!onBytes || !res.body) return new Uint8Array(await res.arrayBuffer());
        const reader = res.body.getReader();
        const parts = [];
        let n = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value); n += value.length; onBytes(value.length);
        }
        return MT.concat(parts);
      } catch (e) {
        if (signal?.aborted) throw e;
        last = String(e.message || e);
      }
    }
    await sleep(400 * (attempt + 1));
  }
  throw new Error(`${last} · ${url.slice(0, 90)}`);
}

async function pool(tasks, n, signal) {
  const out = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) {
      if (signal.aborted) throw new DOMException('취소됨', 'AbortError');
      const k = i++;
      out[k] = await tasks[k]();
    }
  }));
  return out;
}

function progressTracker(totalSegments) {
  let done = 0, bytes = 0;
  const started = Date.now();
  return {
    seg() { done += 1; this.paint(); },
    add(n) { bytes += n; this.paint(); },
    paint() {
      ui.bar(totalSegments ? done / totalSegments : 0);
      const secs = (Date.now() - started) / 1000;
      const speed = secs > 1 ? ` · ${fmtMB(bytes / secs)}/s` : '';
      ui.status(`받는 중… ${done}/${totalSegments} 조각 · ${fmtMB(bytes)}${speed}`);
    },
    get bytes() { return bytes; }
  };
}

// ---------------------------------------------------------------- HLS
const keyCache = new Map();
async function decryptSegment(data, key, seq, signal) {
  if (!key) return data;
  if (!keyCache.has(key.url)) keyCache.set(key.url, get(key.url, { signal }).then(raw => crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt'])));
  const cryptoKey = await keyCache.get(key.url);
  let iv = new Uint8Array(16);
  if (key.iv) {
    const hex = key.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    new DataView(iv.buffer).setUint32(12, seq);
  }
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data));
}

async function fetchHlsMedia(pl, signal, prog) {
  if (pl.drm) throw new UserError(`이 스트림은 DRM(${pl.drm})으로 보호되어 저장할 수 없습니다.`);
  const tasks = pl.segments.map(seg => async () => {
    const raw = await get(seg.url, { range: seg.range, signal, onBytes: n => prog.add(n) });
    const data = await decryptSegment(raw, seg.key, seg.seq, signal);
    prog.seg();
    return data;
  });
  let init = null;
  if (pl.map) {
    init = await get(pl.map.url, { range: pl.map.range, signal });
    if (pl.map.key) init = await decryptSegment(init, pl.map.key, 0, signal);
  }
  return { init, segments: await pool(tasks, CONCURRENCY, signal) };
}

function tracksFromSegments(init, segments) {
  const kind = MT.sniff(init || segments[0]);
  if (kind === 'ts') {
    const dem = MT.demuxTs(segments);
    const tracks = MT.tsToTracks(dem);
    const hasV = tracks.some(t => t.type === 'video');
    const unsupported = dem.unsupported.length || (!hasV && dem.streamTypes.some(t => t === 0x24 || t === 0x1b));
    return { kind, tracks: unsupported ? [] : tracks, raw: segments, unsupported: !!unsupported };
  }
  if (kind === 'mp4') {
    const parsed = MT.parseInit(init || segments[0]);
    segments.forEach(seg => MT.parseFragments(seg, parsed));
    return { kind, tracks: MT.fmp4ToTracks(parsed), raw: init ? [init, ...segments] : segments };
  }
  if (kind === 'adts') {
    const t = MT.adtsToTrack(segments);
    return { kind, tracks: t ? [t] : [], raw: segments };
  }
  return { kind, tracks: [], raw: init ? [init, ...segments] : segments };
}

async function runHls(signal) {
  ui.status('재생목록을 읽는 중…');
  let text = await get(job.url, { asText: true, signal });
  let pl = MT.parseHls(text, job.url);
  let label = '';
  let audioPl = null;
  if (pl.drm) throw new UserError(`이 스트림은 DRM(${pl.drm})으로 보호되어 저장할 수 없습니다.`);
  if (pl.master) {
    if (!pl.variants.length) throw new UserError('재생목록에 화질 정보가 없습니다.');
    const seen = new Set();
    const choices = pl.variants.filter(v => {
      const k = `${v.height}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }).map(v => ({ value: v.url, label: v.height ? `${Math.min(v.width || v.height, v.height)}p · ${(v.bandwidth / 1e6).toFixed(1)}Mbps` : `${(v.bandwidth / 1e6).toFixed(1)}Mbps`, v }));
    const want = Number($('#quality').value ? 0 : job.quality) || 0;
    let chosen = choices.find(c => c.value === $('#quality').value)
      || choices.filter(c => MT.shortSide(c.v) <= (want || 1080)).sort((a, b) => (MT.shortSide(b.v) - MT.shortSide(a.v)) || (Number(/avc1/.test(b.v.codecs)) - Number(/avc1/.test(a.v.codecs))) || (b.v.bandwidth - a.v.bandwidth))[0]
      || choices.slice().sort((a, b) => (b.v.height - a.v.height) || (Number(/avc1/.test(b.v.codecs)) - Number(/avc1/.test(a.v.codecs))) || (b.v.bandwidth - a.v.bandwidth))[0];
    showChoices(choices, chosen.value);
    const v = chosen.v;
    label = v.height ? `${Math.min(v.width || v.height, v.height)}p` : '';
    ui.detail(`선택한 화질: ${chosen.label}${v.codecs ? ` · ${v.codecs}` : ''}`);
    text = await get(v.url, { asText: true, signal });
    const media = MT.parseHls(text, v.url);
    if (v.audio) {
      const group = pl.audio.filter(a => a.group === v.audio);
      const a = group.find(x => x.def) || group[0];
      if (a && a.url !== v.url) audioPl = MT.parseHls(await get(a.url, { asText: true, signal }), a.url);
    }
    pl = media;
  }
  if (!pl.segments.length) throw new UserError('받을 조각이 없습니다.');
  const live = !pl.endList;
  const total = pl.segments.length + (audioPl?.segments.length || 0);
  const prog = progressTracker(total);
  ui.status(`받는 중… 0/${total} 조각${live ? ' (라이브: 지금까지 올라온 구간만)' : ''}`);
  const main = await fetchHlsMedia(pl, signal, prog);
  const extra = audioPl ? await fetchHlsMedia(audioPl, signal, prog) : null;
  ui.status('하나의 MP4로 합치는 중…');
  await sleep(30);
  const a = tracksFromSegments(main.init, main.segments);
  const b = extra ? tracksFromSegments(extra.init, extra.segments) : null;
  let tracks = [...a.tracks, ...(b ? b.tracks.filter(t => t.type === 'audio' && !a.tracks.some(x => x.type === 'audio')) : [])];
  if (tracks.length && tracks.some(t => t.type === 'video')) {
    if (a.kind === 'mp4') MT.alignTracks(tracks);
    return save(MT.writeMp4(tracks), label, 'mp4', 'video/mp4');
  }
  // Could not remux (unusual codec): save the stream as-is, playable in VLC.
  const ext = a.kind === 'ts' ? 'ts' : a.kind === 'mp4' ? 'mp4' : 'bin';
  const note = a.unsupported ? '코덱이 특이해서(HEVC/AC-3 등) MP4로 합치지 못하고 원본 스트림(.ts) 그대로 저장했습니다. VLC로 재생하세요.' : '';
  await save(a.raw, label, ext, 'video/mp2t', note);
  if (b) await save(b.raw, `${label}-audio`, b.kind === 'adts' ? 'aac' : b.kind === 'mp4' ? 'm4a' : 'ts', 'audio/aac');
}

// ---------------------------------------------------------------- DASH
async function fetchRep(rep, signal, prog) {
  const out = [];
  if (rep.init && !rep.segments[0]?.whole) out.push(get(rep.init.url, { range: rangeOf(rep.init.range), signal }));
  const tasks = rep.segments.map(seg => async () => {
    const data = await get(seg.url, { range: rangeOf(seg.range), signal, onBytes: n => prog.add(n) });
    prog.seg();
    return data;
  });
  const init = out.length ? await out[0] : null;
  const segments = await pool(tasks, rep.segments[0]?.whole ? 2 : CONCURRENCY, signal);
  return { init, segments };
}
function rangeOf(spec) {
  if (!spec) return undefined;
  const [a, b] = String(spec).split('-').map(Number);
  return [a, b];
}

async function runDash(signal) {
  ui.status('매니페스트를 읽는 중…');
  const xml = job.xml || await get(job.url, { asText: true, signal });
  const mpd = MT.parseMpd(xml, job.url || job.base || job.referer);
  if (mpd.drm) throw new UserError(`이 영상은 DRM(${/edef8ba9/i.test(mpd.drm) ? 'Widevine' : mpd.drm})으로 보호되어 저장할 수 없습니다.`);
  if (mpd.live) throw new UserError('라이브 방송(DASH 실시간)은 저장할 수 없습니다. 방송이 끝나고 다시보기로 올라오면 다시 시도하세요.');
  if (!mpd.video.length && !mpd.audio.length) throw new UserError('매니페스트에 영상 트랙이 없습니다.');
  const pLabel = r => r.label || `${Math.min(r.width || r.height, r.height)}p`;
  const seen = new Set();
  const choices = mpd.video.filter(r => { const k = `${r.height}:${r.codecs.slice(0, 4)}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(r => ({ value: r.id || `${r.height}`, label: `${pLabel(r)} · ${codecLabel(r.codecs)} · ${(r.bandwidth / 1e6).toFixed(1)}Mbps`, r }));
  let video = null;
  if (choices.length) {
    const sel = choices.find(c => c.value === $('#quality').value);
    const want = Number(job.quality) || 0;
    // Default: best quality up to 1080p (sizes stay reasonable and it plays everywhere); 4K is in the menu.
    video = sel?.r || MT.pickDashVideo(mpd.video, want || 1080);
    showChoices(choices, choices.find(c => c.r === video)?.value);
  }
  const sameFamily = mpd.audio.filter(a => (a.mime || '').split('/')[1] === (video?.mime || 'video/mp4').split('/')[1]);
  const audio = (sameFamily.length ? sameFamily : mpd.audio).slice().sort((a, b) => (Number(/mp4a/.test(b.codecs)) - Number(/mp4a/.test(a.codecs))) || b.bandwidth - a.bandwidth)[0] || null;
  const label = video ? pLabel(video) : 'audio';
  ui.detail(`영상 ${video ? `${pLabel(video)} ${codecLabel(video.codecs)}` : '없음'} + 소리 ${audio ? codecLabel(audio.codecs) : '없음'}${/VP9|AV1/.test(codecLabel(video?.codecs)) ? ' · VP9/AV1은 구형 Mac QuickTime에서 안 열릴 수 있어요 (Chrome/VLC 재생)' : ''}`);
  const total = (video?.segments.length || 0) + (audio?.segments.length || 0);
  const prog = progressTracker(total);
  prog.paint();
  const [vData, aData] = await Promise.all([video ? fetchRep(video, signal, prog) : null, audio ? fetchRep(audio, signal, prog) : null]);
  ui.status('영상과 소리를 하나의 MP4로 합치는 중…');
  await sleep(30);
  const isWebm = r => /webm/.test(r?.mime || '');
  if (!isWebm(video) && !isWebm(audio)) {
    try {
      const tracks = [];
      for (const d of [vData, aData]) {
        if (!d) continue;
        const initBuf = d.init || d.segments[0];
        const parsed = MT.parseInit(initBuf);
        d.segments.forEach(seg => MT.parseFragments(seg, parsed));
        tracks.push(...MT.fmp4ToTracks(parsed));
      }
      if (tracks.length) {
        MT.alignTracks(tracks);
        return save(MT.writeMp4(tracks), label, 'mp4', 'video/mp4');
      }
    } catch (e) { console.warn('merge failed, saving separately', e); }
  }
  // Fallback: separate files (still complete and playable).
  if (vData) await save(vData.init ? [vData.init, ...vData.segments] : vData.segments, `${label}-영상`, isWebm(video) ? 'webm' : 'mp4', video.mime);
  if (aData) await save(aData.init ? [aData.init, ...aData.segments] : aData.segments, '소리', isWebm(audio) ? 'webm' : 'm4a', audio.mime,
    '영상과 소리를 하나로 합치지 못해 두 파일로 저장했습니다. 둘 다 같은 폴더에 있습니다.');
}

function codecLabel(c) {
  c = String(c || '').toLowerCase();
  if (/^avc/.test(c)) return 'H.264';
  if (/^vp0?9/.test(c)) return 'VP9';
  if (/^av01/.test(c)) return 'AV1';
  if (/^(hvc1|hev1)/.test(c)) return 'HEVC';
  if (/^mp4a/.test(c)) return 'AAC';
  if (/opus/.test(c)) return 'Opus';
  return c || '?';
}

// ---------------------------------------------------------------- UI + save
function showChoices(choices, chosen) {
  const sel = $('#quality');
  if (!sel.options.length) {
    choices.forEach(c => { const o = document.createElement('option'); o.value = c.value; o.textContent = c.label; sel.append(o); });
  }
  if (chosen) sel.value = chosen;
  $('#qualityRow').hidden = choices.length < 2;
}

async function save(parts, label, ext, mime, note) {
  const blob = new Blob(parts, { type: mime || 'application/octet-stream' });
  if (blob.size < 1024) throw new Error('받은 데이터가 비어 있습니다.');
  const url = URL.createObjectURL(blob);
  const folder = await prefsFolder();
  const name = `${folder}/${fileName(label, ext)}`;
  savedId = await new Promise((resolve, reject) => api.downloads.download({ url, filename: name, conflictAction: 'uniquify', saveAs: false }, id => {
    if (api.runtime.lastError) reject(new Error(api.runtime.lastError.message)); else resolve(id);
  }));
  api.downloads.onChanged.addListener(function onC(d) {
    if (d.id === savedId && d.state && d.state.current !== 'in_progress') { setTimeout(() => URL.revokeObjectURL(url), 5000); api.downloads.onChanged.removeListener(onC); }
  });
  ui.bar(1);
  ui.status(`저장 완료 · ${fmtMB(blob.size)} · ${fileName(label, ext)}`, 'done');
  if (note) ui.detail(note);
  $('#show').hidden = false;
  document.title = '✓ 저장 완료 · Source Lens';
  return { ok: true, size: blob.size };
}

async function run() {
  if (running) return;
  running = true;
  controller = new AbortController();
  $('#cancel').disabled = false;
  $('#restart').hidden = true;
  $('#show').hidden = true;
  ui.bar(0);
  document.title = '받는 중… · Source Lens';
  try {
    const kind = job.kind === 'dash' || (job.url && /\.mpd(?:$|[?#])/i.test(job.url)) ? 'dash' : 'hls';
    $('#kind').textContent = kind === 'dash' ? 'DASH 스트림 → 하나의 MP4로 합쳐 저장' : 'HLS 스트림 → 하나의 MP4로 합쳐 저장';
    if (kind === 'dash') await runDash(controller.signal); else await runHls(controller.signal);
    window.__slResult = { ok: true };
  } catch (e) {
    const aborted = controller.signal.aborted;
    const msg = aborted ? '취소했습니다.' : e instanceof UserError ? e.message : `저장하지 못했습니다: ${e.message || e}`;
    ui.status(msg, aborted ? '' : 'error');
    if (!aborted && !(e instanceof UserError)) ui.detail('사이트가 주소를 만료시켰을 수 있습니다. 원래 페이지를 새로고침하고 영상을 다시 재생한 뒤 다시 시도하세요.');
    document.title = aborted ? '취소됨 · Source Lens' : '실패 · Source Lens';
    window.__slResult = { ok: false, error: msg };
  } finally {
    running = false;
    $('#cancel').disabled = true;
    $('#restart').hidden = !$('#quality').options.length;
  }
}

$('#cancel').onclick = () => controller?.abort();
$('#restart').onclick = () => run();
$('#quality').onchange = () => { if (!running) $('#restart').hidden = false; };
$('#show').onclick = () => { if (savedId) api.downloads.show(savedId); };
window.addEventListener('beforeunload', e => { if (running) { e.preventDefault(); e.returnValue = ''; } });

(async () => {
  const key = `job:${jobId}`;
  job = (await api.storage.session.get(key))[key];
  if (!job) { ui.status('저장 작업 정보를 찾지 못했습니다. 원래 페이지에서 다시 눌러 주세요.', 'error'); $('#cancel').disabled = true; return; }
  $('#title').textContent = job.title || '영상';
  try { $('#from').textContent = `${new URL(job.referer).hostname} 에서 가져옴`; } catch { $('#from').textContent = ''; }
  await setReferer();
  run();
})();
