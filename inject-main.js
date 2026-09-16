(() => {
  if (window.__sourceLensMain) return;
  window.__sourceLensMain = true;

  const videoLike = /(?:\.mp4|\.m4v|\.webm|\.mov|\.m3u8|\.mpd)(?:$|[?#])|videoplayback|googlevideo\.com|vimeocdn|player\.vimeo|vod-progressive|akamaized\.net|\/o1\/v\/|\/t(?:15|16|2|30|35|50|66)\/|playable_url|browser_native|video_versions/i;

  const notImage = /(?:\.jpe?g|\.png|\.webp|\.gif|\.svg)(?:$|[?#])|_n\.(?:jpe?g|png|webp)/i;

  const emit = (url, via) => {
    if (!url || typeof url !== 'string') return;
    const clean = url.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    if (!/^https?:/i.test(clean)) return;
    if (notImage.test(clean) && !/\.mp4/i.test(clean)) return;
    if (!videoLike.test(clean)) return;
    document.documentElement.dispatchEvent(new CustomEvent('sl-media-url', { detail: { url: clean, via } }));
  };

  const sniff = text => {
    if (!text || text.length > 4_000_000) return;
    if (!/video_versions|playable_url|videoplayback|googlevideo|\.mp4/.test(text)) return;
    const decoded = text.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\u002F/gi, '/');
    const re = /https?:\/\/[^\s"'<>\\]+/g;
    let match;
    let n = 0;
    while ((match = re.exec(decoded)) && n < 40) {
      emit(match[0].replace(/[),.;]+$/, ''), 'json');
      n += 1;
    }
  };

  const wrapFetch = orig => function (...args) {
    try {
      const input = args[0];
      emit(typeof input === 'string' ? input : input?.url, 'fetch');
    } catch { /* ignore */ }
    const pending = orig.apply(this, args);
    if (pending && typeof pending.then === 'function') {
      pending.then(res => {
        try {
          const ct = res.headers?.get?.('content-type') || '';
          if (/json/.test(ct)) res.clone().text().then(sniff).catch(() => {});
        } catch { /* ignore */ }
      }).catch(() => {});
    }
    return pending;
  };

  try { window.fetch = wrapFetch(window.fetch.bind(window)); } catch { /* ignore */ }

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try { emit(String(url || ''), 'xhr'); } catch { /* ignore */ }
    this.addEventListener('load', () => {
      try {
        const type = this.getResponseHeader?.('content-type') || '';
        if (/json/.test(type) && typeof this.responseText === 'string') sniff(this.responseText);
      } catch { /* ignore */ }
    });
    return open.call(this, method, url, ...rest);
  };
})();
