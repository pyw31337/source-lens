try { importScripts('media-tools.js'); } catch (e) { console.warn('media-tools', e); }
const MT = globalThis.SourceLensMedia;
const requestsByTab = new Map();
const MAX = 400;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function fetchMedia(url) {
  const errors = [];
  for (const credentials of ['omit', 'include']) {
    try {
      const response = await fetch(url, { credentials, redirect: 'follow', cache: 'force-cache', mode: 'cors' });
      if (!response.ok) {
        errors.push(`${credentials}:${response.status}`);
        continue;
      }
      const mime = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0];
      const buffer = await response.arrayBuffer();
      if (!buffer.byteLength) {
        errors.push(`${credentials}:empty`);
        continue;
      }
      return { buffer, mime };
    } catch (error) {
      errors.push(`${credentials}:${error}`);
    }
  }
  throw new Error(errors.join(' | ') || 'fetch failed');
}

const metaCache = new Map();

async function resourceMeta(url) {
  if (metaCache.has(url)) return metaCache.get(url);
  let size = null, mime = '';
  const read = response => {
    mime = mime || (response.headers.get('content-type') || '').split(';')[0];
    const range = response.headers.get('content-range');
    const total = range && /\/(\d+)\s*$/.exec(range);
    const len = Number(response.headers.get('content-length'));
    if (total) size = Number(total[1]);
    else if (response.status === 200 && Number.isFinite(len) && len > 0) size = len;
  };
  try {
    const head = await fetch(url, { method: 'HEAD', credentials: 'omit', redirect: 'follow', cache: 'force-cache' });
    if (head.ok) read(head);
  } catch { /* try range */ }
  if (!size) {
    try {
      const controller = new AbortController();
      const response = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'omit', redirect: 'follow', signal: controller.signal });
      if (response.ok) read(response);
      controller.abort();
    } catch { /* ignore */ }
  }
  const result = { size, mime };
  metaCache.set(url, result);
  if (metaCache.size > 800) metaCache.delete(metaCache.keys().next().value);
  return result;
}

async function prefs() {
  try {
    const data = await chrome.storage.local.get('slPrefs');
    return data?.slPrefs || {};
  } catch {
    return {};
  }
}

async function targetName(filename) {
  const p = await prefs();
  const folder = String(p.folder || 'source-lens').replace(/[\\:*?"<>|]+/g, '_').replace(/^\/+|\/+$/g, '').replace(/\.\.+/g, '_') || 'source-lens';
  const name = String(filename || 'source-lens/media');
  return name.replace(/^source-lens\//, `${folder}/`);
}

function crcTable() {
  if (crcTable.t) return crcTable.t;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  crcTable.t = t;
  return t;
}

function crc32(bytes) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(files) {
  const encoder = new TextEncoder();
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name.replace(/\\/g, '/').slice(0, 180));
    const data = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes || []);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, data);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralStart = offset;
  for (const block of centrals) {
    parts.push(block);
    offset += block.length;
  }
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, offset - centralStart, true);
  ev.setUint32(16, centralStart, true);
  parts.push(eocd);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function downloadBase64(mime, base64, filename) {
  const name = await targetName(filename || 'source-lens/media');
  return new Promise(resolve => {
    chrome.downloads.download({
      url: `data:${mime};base64,${base64}`,
      filename: name,
      saveAs: false,
      conflictAction: 'uniquify'
    }, () => resolve({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message || '' }));
  });
}

function watchDownload(id, timeout) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      clearInterval(poll);
      resolve({ id, ...result });
    };
    const check = item => {
      if (!item) return;
      if (item.state === 'interrupted' || item.error) finish({ ok: false, error: item.error || 'interrupted' });
      else if (item.state === 'complete' || item.bytesReceived > 0) finish({ ok: true });
    };
    const onChanged = delta => {
      if (delta.id !== id) return;
      chrome.downloads.search({ id }, items => check(items?.[0]));
    };
    chrome.downloads.onChanged.addListener(onChanged);
    const poll = setInterval(() => chrome.downloads.search({ id }, items => check(items?.[0])), 400);
    const timer = setTimeout(() => finish({ ok: true, pending: true }), timeout);
  });
}

async function convertBuffer(buffer, mime, outMime) {
  const blob = new Blob([buffer], { type: mime || 'image/jpeg' });
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (outMime === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0);
  const out = await canvas.convertToBlob({ type: outMime, quality: 0.92 });
  return { buffer: await out.arrayBuffer(), mime: outMime };
}

if (chrome.webRequest?.onBeforeRequest) {
  chrome.webRequest.onBeforeRequest.addListener(details => {
    if (details.tabId < 0 || !/^https?:/i.test(details.url)) return;
    if (/\.(?:gif|ico)(?:$|[?#])/i.test(details.url) && /rsrc\.php|static\.cdninstagram|static\.xx\.fbcdn/i.test(details.url)) return;
    const list = requestsByTab.get(details.tabId) || [];
    list.push({ url: details.url, type: details.type, time: Date.now(), frameId: details.frameId });
    if (list.length > MAX) list.splice(0, list.length - MAX);
    requestsByTab.set(details.tabId, list);
  }, { urls: ['<all_urls>'], types: ['image', 'media', 'xmlhttprequest', 'other'] });
}

chrome.tabs.onRemoved.addListener(tabId => { requestsByTab.delete(tabId); forgetTabMedia(tabId); });

// ---------------------------------------------------------------- per-tab video sources (survive SW restarts)
const MEDIA_NOISE = /googlevideo\.com|\/videoplayback|bytestart=|byteend=|[?&]range=|\.m4s(?:$|[?#])|\.ts(?:$|[?#])|\.aac(?:$|[?#])|\.m4a(?:$|[?#])|fbcdn\.net|cdninstagram\.com|init\.mp4/i;
const tabMediaCache = new Map();
function mediaKey(tabId) { return `tm:${tabId}`; }
async function getTabMedia(tabId) {
  if (tabMediaCache.has(tabId)) return tabMediaCache.get(tabId);
  let list = [];
  try { list = (await chrome.storage.session.get(mediaKey(tabId)))[mediaKey(tabId)] || []; } catch { /* ignore */ }
  tabMediaCache.set(tabId, list);
  return list;
}
async function addTabMedia(tabId, entry) {
  const list = await getTabMedia(tabId);
  if (list.some(x => x.url === entry.url)) return;
  list.push(entry);
  if (list.length > 40) list.splice(0, list.length - 40);
  try { await chrome.storage.session.set({ [mediaKey(tabId)]: list }); } catch { /* ignore */ }
}
function forgetTabMedia(tabId) {
  tabMediaCache.delete(tabId);
  try { chrome.storage.session.remove(mediaKey(tabId)); } catch { /* ignore */ }
}
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) forgetTabMedia(tabId);
});
if (chrome.webRequest?.onHeadersReceived) {
  chrome.webRequest.onHeadersReceived.addListener(details => {
    if (details.tabId < 0 || details.statusCode >= 400 || !/^https?:/i.test(details.url)) return;
    if (details.initiator && details.initiator.startsWith('chrome-extension://')) return;
    const header = name => (details.responseHeaders || []).find(h => h.name.toLowerCase() === name)?.value || '';
    const ct = header('content-type').toLowerCase();
    const url = details.url;
    let manifest = '';
    if (/mpegurl/.test(ct) || /\.m3u8(?:$|[?#])/i.test(url)) manifest = 'hls';
    else if (/dash\+xml/.test(ct) || /\.mpd(?:$|[?#])/i.test(url)) manifest = 'dash';
    if (manifest) {
      if (/googlevideo\.com/.test(url)) return;
      addTabMedia(details.tabId, { url, manifest, t: Date.now(), frameId: details.frameId });
      return;
    }
    // Whole files are played by the <video> element itself ("media"); fetch/XHR video responses are stream pieces.
    if (details.type !== 'media' || !/^video\//.test(ct) || MEDIA_NOISE.test(url) || (details.statusCode === 206 && !header('content-range'))) return;
    const range = /\/(\d+)\s*$/.exec(header('content-range'));
    const size = range ? Number(range[1]) : Number(header('content-length')) || 0;
    if (size && size < 200_000) return;
    addTabMedia(details.tabId, { url, manifest: '', type: details.type, mime: ct.split(';')[0], size, t: Date.now(), frameId: details.frameId });
  }, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] }, ['responseHeaders']);
}

async function fetchText(url) {
  const errors = [];
  for (const credentials of ['omit', 'include']) {
    try {
      const res = await fetch(url, { credentials, redirect: 'follow', cache: 'no-store' });
      if (!res.ok) { errors.push(res.status); continue; }
      return { text: await res.text(), url: res.url || url };
    } catch (e) { errors.push(String(e)); }
  }
  throw new Error(`매니페스트를 받지 못했습니다 (${errors.join(', ')})`);
}

async function openJob(job, opener) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  await chrome.storage.session.set({ [`job:${id}`]: { ...job, created: Date.now() } });
  const opts = { url: chrome.runtime.getURL(`downloader.html#${id}`), active: true };
  if (opener?.id) { opts.index = opener.index + 1; opts.openerTabId = opener.id; opts.windowId = opener.windowId; }
  const tab = await chrome.tabs.create(opts);
  return { ok: true, id, tabId: tab.id };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'tabMedia') {
    const tabId = message.tabId || sender.tab?.id;
    getTabMedia(tabId).then(items => sendResponse({ items })).catch(() => sendResponse({ items: [] }));
    return true;
  }
  if (message?.type === 'probeManifest') {
    (async () => {
      try {
        const { text, url } = await fetchText(message.url);
        sendResponse({ ...MT.summarize(text, url), url: message.url });
      } catch (error) {
        sendResponse({ error: String(error.message || error) });
      }
    })();
    return true;
  }
  if (message?.type === 'mediaJob') {
    (async () => {
      try {
        let opener = sender.tab;
        if (!opener && message.tabId) opener = await chrome.tabs.get(message.tabId).catch(() => null);
        sendResponse(await openJob(message.job || {}, opener));
      } catch (error) {
        sendResponse({ ok: false, error: String(error.message || error) });
      }
    })();
    return true;
  }
  if (message?.type === 'recentRequests') {
    sendResponse({ requests: (requestsByTab.get(sender.tab?.id) || []).slice(-200) });
    return true;
  }
  if (message?.type === 'resourceMeta') {
    (async () => {
      try {
        sendResponse(await resourceMeta(message.url));
      } catch { sendResponse({ size: null, mime: '' }); }
    })();
    return true;
  }
  if (message?.type === 'fetchResource') {
    (async () => {
      try {
        const { buffer, mime } = await fetchMedia(message.url);
        sendResponse({ base64: toBase64(buffer), mime, size: buffer.byteLength });
      } catch (error) {
        sendResponse({ error: String(error) });
      }
    })();
    return true;
  }
  if (message?.type === 'convertAndDownload') {
    (async () => {
      try {
        let source;
        if (message.code) {
          source = {
            buffer: new TextEncoder().encode(message.code).buffer,
            mime: 'image/svg+xml'
          };
        } else {
          source = await fetchMedia(message.url);
        }
        const converted = await convertBuffer(source.buffer, source.mime, message.mime || 'image/jpeg');
        const result = await downloadBase64(converted.mime, toBase64(converted.buffer), message.filename);
        sendResponse(result.ok ? { ok: true } : result);
      } catch (error) {
        sendResponse({ ok: false, error: String(error) });
      }
    })();
    return true;
  }
  if (message?.type === 'zipDownload') {
    (async () => {
      try {
        const files = [];
        const items = (message.items || []).slice(0, 40);
        for (const item of items) {
          try {
            const name = (item.name || `file-${files.length + 1}`).replace(/[\\/:*?"<>|]+/g, '_');
            if (item.code) {
              files.push({ name, bytes: new TextEncoder().encode(item.code) });
              continue;
            }
            if (!item.url || !/^https?:|^data:/i.test(item.url)) continue;
            const { buffer } = await fetchMedia(item.url);
            files.push({ name, bytes: new Uint8Array(buffer) });
          } catch { /* skip one */ }
        }
        if (!files.length) {
          sendResponse({ ok: false, error: '압축할 파일을 받지 못했습니다. 인스타 CDN은 ZIP이 막혀 있습니다.' });
          return;
        }
        const zip = zipStore(files);
        const b64 = toBase64(zip.buffer);
        if (b64.length < 6_000_000) {
          const result = await downloadBase64('application/zip', b64, message.filename || 'source-lens/media.zip');
          sendResponse({ ok: result.ok, error: result.error, count: files.length });
          return;
        }
        const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
        chrome.downloads.download({
          url,
          filename: await targetName(message.filename || 'source-lens/media.zip'),
          saveAs: false,
          conflictAction: 'uniquify'
        }, () => {
          setTimeout(() => URL.revokeObjectURL(url), 15000);
          sendResponse({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message || '', count: files.length });
        });
      } catch (error) {
        sendResponse({ ok: false, error: String(error) });
      }
    })();
    return true;
  }
  if (message?.type === 'downloadUrl') {
    (async () => {
      const filename = await targetName(message.filename || 'source-lens/media');
      chrome.downloads.download({
        url: message.url,
        filename,
        saveAs: false,
        conflictAction: 'uniquify'
      }, id => {
        if (chrome.runtime.lastError || id == null) {
          const err = chrome.runtime.lastError?.message || 'download failed';
          if (/filename/i.test(err)) {
            const ext = (/\.([a-z0-9]{2,5})$/i.exec(filename) || [0, 'bin'])[1];
            const safe = filename.replace(/[^/]+$/, `media-${Date.now()}.${ext}`);
            chrome.downloads.download({ url: message.url, filename: safe, saveAs: false, conflictAction: 'uniquify' }, id2 => {
              if (chrome.runtime.lastError || id2 == null) sendResponse({ ok: false, error: chrome.runtime.lastError?.message || err });
              else watchDownload(id2, 7000).then(sendResponse);
            });
            return;
          }
          sendResponse({ ok: false, error: err });
          return;
        }
        // Wait until the server actually starts sending (or refuses), so a 403 is reported instead of a fake success.
        watchDownload(id, 7000).then(sendResponse);
      });
    })();
    return true;
  }

  if (message?.type === 'downloadBase64' || message?.type === 'downloadBuffer') {
    (async () => {
      try {
        const mime = message.mime || 'application/octet-stream';
        const base64 = message.base64 || (message.buffer ? toBase64(message.buffer) : '');
        if (!base64) throw new Error('empty file');
        const result = await downloadBase64(mime, base64, message.filename);
        sendResponse(result);
      } catch (error) {
        sendResponse({ ok: false, error: String(error) });
      }
    })();
    return true;
  }
});

function injectContent(tabId, frameIds) {
  const target = frameIds ? { tabId, frameIds } : { tabId };
  return new Promise(resolve => {
    chrome.scripting.executeScript({ target, files: ['inject-main.js', 'shared.js', 'platform-profiles.js', 'extractors.js'], world: 'MAIN' }, () => {
      void chrome.runtime.lastError;
      chrome.scripting.executeScript({ target, files: ['shared.js', 'platform-profiles.js', 'media-tools.js', 'video-finder.js', 'content.js'] }, () => {
        resolve(!chrome.runtime.lastError);
      });
    });
  });
}

// Sends a message to the page; if the content script is missing (tab opened before
// the extension was installed/reloaded), injects it once and retries.
function sendToTab(tabId, payload, frameId) {
  const options = frameId == null ? {} : { frameId };
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, payload, options, response => {
      if (!chrome.runtime.lastError) return resolve(response || { ok: true });
      injectContent(tabId, frameId == null ? undefined : [frameId]).then(ok => {
        if (!ok) return resolve({ ok: false, error: 'inject-failed' });
        chrome.tabs.sendMessage(tabId, payload, options, retry => {
          resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (retry || { ok: true }));
        });
      });
    });
  });
}

// After install/update, tabs that were already open still run the old (disconnected) copy, so Alt(⌥)+click
// silently did nothing until the tab was refreshed. Put the new copy into every open tab right away.
async function injectIntoOpenTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }); } catch { return; }
  for (const tab of tabs) {
    if (tab.discarded || !tab.id) continue;
    const target = { tabId: tab.id, allFrames: true };
    try {
      await chrome.scripting.executeScript({ target, files: ['inject-main.js', 'shared.js', 'platform-profiles.js', 'extractors.js'], world: 'MAIN' });
    } catch { /* restricted page */ }
    try {
      await chrome.scripting.executeScript({ target, files: ['shared.js', 'platform-profiles.js', 'media-tools.js', 'video-finder.js', 'content.js'] });
    } catch { /* restricted page */ }
  }
}

chrome.runtime.onInstalled.addListener(details => {
  if (details?.reason === 'install' || details?.reason === 'update') injectIntoOpenTabs();
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'inspect-source',
      title: 'Source Lens: 이 요소의 원본 주소 분석',
      contexts: ['image', 'video', 'audio', 'link', 'page']
    });
    chrome.contextMenus.create({
      id: 'open-panel',
      title: 'Source Lens: 이 페이지 미디어 모두 보기',
      contexts: ['image', 'video', 'audio', 'link', 'page', 'selection']
    });
  });
});

if (chrome.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab?.id) return;
    if (info.menuItemId === 'open-panel') {
      sendToTab(tab.id, { type: 'openPanel' }, 0);
      return;
    }
    sendToTab(tab.id, { type: 'contextInspect', info }, info.frameId == null ? undefined : info.frameId);
  });
}

if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener((command, tab) => {
    const run = t => {
      if (!t?.id || !/^https?:/i.test(t.url || '')) return;
      if (command === 'inspect-selection') sendToTab(t.id, { type: 'hotkeyInspect' }, 0);
      if (command === 'open-panel') sendToTab(t.id, { type: 'openPanel' }, 0);
    };
    if (tab?.id) run(tab);
    else chrome.tabs.query({ active: true, currentWindow: true }, tabs => run(tabs[0]));
  });
}
