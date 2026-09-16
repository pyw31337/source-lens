const requestsByTab = new Map();
const MAX = 400;

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
        let response = await fetch(message.url, { method: 'HEAD', credentials: 'include' });
        if (!response.ok) response = await fetch(message.url, { method: 'GET', credentials: 'include' });
        const length = response.headers.get('content-length');
        sendResponse({ size: length ? Number(length) : null, mime: response.headers.get('content-type') || '' });
      } catch { sendResponse({ size: null, mime: '' }); }
    })();
    return true;
  }
  if (message?.type === 'fetchResource') {
    (async () => {
      try {
        const response = await fetch(message.url, { credentials: 'include' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const mime = response.headers.get('content-type') || 'application/octet-stream';
        const buffer = await response.arrayBuffer();
        sendResponse({ buffer, mime, size: buffer.byteLength });
      } catch (error) {
        sendResponse({ error: String(error) });
      }
    })();
    return true;
  }
  if (message?.type === 'downloadUrl') {
    chrome.downloads.download({
      url: message.url,
      filename: message.filename || 'source-lens/media',
      saveAs: false
    }, () => sendResponse({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message || '' }));
    return true;
  }
  if (message?.type === 'downloadBuffer') {
    (async () => {
      try {
        const mime = message.mime || 'application/octet-stream';
        const bytes = new Uint8Array(message.buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        const url = `data:${mime};base64,${btoa(binary)}`;
        chrome.downloads.download({
          url,
          filename: message.filename || 'source-lens/media',
          saveAs: false
        }, () => sendResponse({ ok: !chrome.runtime.lastError }));
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
    const message = { type: 'contextInspect', info };
    const options = info.frameId == null ? {} : { frameId: info.frameId };
    chrome.tabs.sendMessage(tab.id, message, options, () => {
      if (!chrome.runtime.lastError) return;
      chrome.scripting?.executeScript({
        target: { tabId: tab.id, frameIds: info.frameId == null ? undefined : [info.frameId] },
        files: ['shared.js', 'platform-profiles.js', 'content.js']
      }, () => chrome.tabs.sendMessage(tab.id, message, options, () => void chrome.runtime.lastError));
    });
  });
}
