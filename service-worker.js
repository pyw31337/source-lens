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
      const response = await fetch(url, { credentials, redirect: 'follow', cache: 'no-store' });
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
