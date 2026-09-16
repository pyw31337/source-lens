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

function downloadBase64(mime, base64, filename) {
  return new Promise(resolve => {
    chrome.downloads.download({
      url: `data:${mime};base64,${base64}`,
      filename: filename || 'source-lens/media',
      saveAs: false,
      conflictAction: 'uniquify'
    }, () => resolve({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message || '' }));
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

chrome.tabs.onRemoved.addListener(tabId => requestsByTab.delete(tabId));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'recentRequests') {
    sendResponse({ requests: (requestsByTab.get(sender.tab?.id) || []).slice(-200) });
    return true;
  }
  if (message?.type === 'resourceMeta') {
    (async () => {
      try {
        const { buffer, mime } = await fetchMedia(message.url);
        sendResponse({ size: buffer.byteLength, mime });
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
          filename: message.filename || 'source-lens/media.zip',
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

    chrome.downloads.download({
      url: message.url,
      filename: message.filename || 'source-lens/media',
      saveAs: false,
      conflictAction: 'uniquify'
    }, () => sendResponse({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message || '' }));
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

chrome.runtime.onInstalled.addListener(() => {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'inspect-source',
      title: 'Source Lens: 소스 URL 분석',
      contexts: ['image', 'video', 'audio', 'link', 'page']
    });
  });
});

if (chrome.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab?.id) return;
    const payload = { type: 'contextInspect', info };
    const options = info.frameId == null ? {} : { frameId: info.frameId };
    chrome.tabs.sendMessage(tab.id, payload, options, () => {
      if (!chrome.runtime.lastError) return;
      chrome.scripting?.executeScript({
        target: { tabId: tab.id, frameIds: info.frameId == null ? undefined : [info.frameId] },
        files: ['shared.js', 'platform-profiles.js', 'content.js']
      }, () => chrome.tabs.sendMessage(tab.id, payload, options, () => void chrome.runtime.lastError));
    });
  });
}
