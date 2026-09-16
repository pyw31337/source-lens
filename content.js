(() => {
  if (window.__sourceLensLoaded) return;
  window.__sourceLensLoaded = true;

  const SL = globalThis.SourceLens;
  const state = {
    panel: null, selected: null, contextTarget: null, selectedMedia: null, picked: null,
    candidates: [], activeTab: 'selected', postUrl: '', capture: null, pageNet: [],
    profile: null, observer: null, scanTimer: 0, redraw: null
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const abs = value => SL.abs(value, location.href);
  const esc = SL.esc;
  const bytes = SL.bytes;
  const fileName = SL.fileName;
  const labelOf = item => item?.name || fileName(item?.url || '') || 'media';

  function svgSource(item) {
    if (item?.code) return item.code;
    if (/^data:image\/svg/i.test(item?.url || '')) {
      try { return decodeURIComponent((item.url.split(',')[1] || '').replace(/\+/g, ' ')); }
      catch { return item.url; }
    }
    return '';
  }

  function copySvg(item, button) {
    const run = text => {
      if (!text) return;
      copy(text, button);
    };
    const local = svgSource(item);
    if (local) return run(local);
    if (/\.svg(?:$|[?#])/i.test(item.url || '')) {
      fetchBytes(item.url).then(blob => blob.text()).then(text => {
        item.code = sanitizeSvg(text);
        run(item.code);
      }).catch(() => copy(item.url, button));
      return;
    }
    copy(item.url, button);
  }


  function siteKind() {
    const host = location.hostname.replace(/^www\./, '').toLowerCase();
    if (host.endsWith('youtube.com') || host === 'youtu.be') return 'youtube';
    if (host.endsWith('instagram.com')) return 'instagram';
    if (host.endsWith('facebook.com') || host === 'fb.watch') return 'facebook';
    if (host.endsWith('vimeo.com') || host.endsWith('vimeocdn.com')) return 'vimeo';
    return host;
  }

  function candidate(url, source, hint, extra = {}) {
    const value = abs(url);
    if (!value) return null;
    if (SL.isUiJunk(value) && hint !== 'svg') return null;
    const info = SL.classifyUrl(value, hint);
    if (SL.PHOTO_EXT.test(value) || SL.isImageUrl(value)) info.type = 'image';
    if (info.type === 'video' && SL.isImageUrl(value)) info.type = 'image';
    return {
      url: value, source, ...info,
      confidence: extra.confidence || '중간',
      code: extra.code,
      element: extra.element || null,
      width: extra.width || extra.element?.naturalWidth || extra.element?.videoWidth || 0,
      height: extra.height || extra.element?.naturalHeight || extra.element?.videoHeight || 0,
      size: extra.size || 0,
      mime: extra.mime || '',
      name: extra.name || '',
      relation: extra.relation || 'target'
    };
  }

  function uiRoot() {
    if (state.shadow) return state.shadow;
    const host = document.createElement('div');
    host.id = 'sl-host';
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('content.css');
    const extra = document.createElement('style');
    extra.textContent = `
      :host {
        --sl-brand: #3ecf8e;
        --sl-brand-strong: #229968;
        --sl-ink: #1c1c1c;
        font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      }
      #sl-root { pointer-events: none; position: fixed; inset: 0; }
      #sl-panel, .sl-lightbox, .sl-slice-editor { pointer-events: auto; }
    `;
    shadow.append(link, extra);
    document.documentElement.append(host);
    state.host = host;
    state.shadow = shadow;
    return shadow;
  }

  function mediaAtPoint(x, y) {
    const stack = document.elementsFromPoint(x, y).filter(node => node !== state.host && !node.closest?.('#sl-host'));
    const found = [];
    for (const node of stack) {
      const media = node.tagName && /^(IMG|VIDEO|SVG|PICTURE)$/.test(node.tagName)
        ? node
        : node.closest?.('img, video, svg, picture');
      if (!media || found.includes(media)) continue;
      const r = media.getBoundingClientRect();
      if (media.tagName !== 'SVG' && (r.width < 40 || r.height < 40)) continue;
      found.push(media);
    }
    const img = found.find(n => n.tagName === 'IMG' || n.tagName === 'PICTURE');
    const video = found.find(n => n.tagName === 'VIDEO');
    const svg = found.find(n => n.tagName === 'SVG');
    if (svg && !img && !video) return svg;
    if (img && video) {
      if (!video.paused && video.readyState >= 2 && video.videoWidth > 0) return video;
      return img;
    }
    return found[0] || stack[0] || document.body;
  }

  function pathKey(url) {
    try {
      return new URL(url, location.href).pathname.replace(/\/+$/, '').split('/').pop() || url;
    } catch {
      return url;
    }
  }

  function sanitizeSvg(code) {
    try {
      const doc = new DOMParser().parseFromString(code, 'image/svg+xml');
      doc.querySelectorAll('script, foreignObject').forEach(n => n.remove());
      doc.querySelectorAll('*').forEach(el => {
        [...el.attributes].forEach(attr => {
          if (/^on/i.test(attr.name) || /javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
        });
      });
      return new XMLSerializer().serializeToString(doc.documentElement);
    } catch {
      return String(code || '').replace(/<script[\s\S]*?<\/script>/gi, '');
    }
  }

  function collectImgLike(node, out, media) {
    out.push(candidate(node.currentSrc || node.src, 'img.currentSrc', 'image', { element: media, confidence: '최상' }));
    (node.srcset || node.getAttribute('srcset') || '').split(',').map(p => p.trim().split(/\s+/)[0]).filter(Boolean)
      .forEach(url => out.push(candidate(url, 'srcset', 'image', { element: media, confidence: '높음' })));
    ['data-src', 'data-original', 'data-full', 'data-full-url', 'data-lazy-src', 'data-zoom-image'].forEach(attr => {
      out.push(candidate(node.getAttribute(attr), `속성:${attr}`, 'image', { element: media, confidence: '중간' }));
    });
  }

  function collectTarget(target) {
    const media = target?.matches?.('img,video,svg,picture')
      ? target
      : target?.closest?.('img,video,svg,picture') || target?.querySelector?.('img,video,svg');
    const out = [];
    if (!media) return { media: null, candidates: out };
    const tag = media.tagName.toLowerCase();
    if (tag === 'svg') {
      const code = sanitizeSvg(new XMLSerializer().serializeToString(media));
      out.push(candidate(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`, 'inline SVG', 'svg', {
        element: media, code, confidence: '최상'
      }));
    }
    if (tag === 'picture') $$('source[srcset], img', media).forEach(node => collectImgLike(node, out, media));
    if (tag === 'img') collectImgLike(media, out, media);
    if (tag === 'video') {
      out.push(candidate(media.currentSrc || media.src, 'video.currentSrc', 'video', { element: media, confidence: '최상' }));
      $$('source[src]', media).forEach(s => out.push(candidate(s.src, 'video.source', 'video', { element: media, confidence: '높음' })));
      if (media.poster) out.push(candidate(media.poster, 'video.poster', 'image', { element: media, confidence: '중간' }));
    }
    return { media, candidates: out.filter(Boolean) };
  }

  document.documentElement.addEventListener('sl-media-url', event => {
    const url = event.detail?.url;
    if (!url || SL.isUiJunk(url) || !SL.isVideoUrl(url)) return;
    state.pageNet.push({ url, via: event.detail.via || 'page', t: Date.now(), hint: 'video' });
    if (state.pageNet.length > 80) state.pageNet.splice(0, state.pageNet.length - 80);
  });

  function collectRecentVideos(clicked) {
    const clickedSrc = abs(clicked?.currentSrc || clicked?.src || '');
    const cutoff = Date.now() - 12000;
    const map = new Map();
    const add = (url, source, size) => {
      if (!url || !SL.isVideoUrl(url) || SL.isImageUrl(url)) return;
      const item = candidate(url, source, 'video', { confidence: '높음', relation: 'network', size: size || 0 });
      if (!item) return;
      const key = pathKey(item.url);
      const prev = map.get(key);
      if (!prev || (item.size || 0) > (prev.size || 0) || item.url.length > prev.url.length) map.set(key, item);
    };
    state.pageNet.forEach(item => { if (item.t >= cutoff) add(item.url, '캡처된 영상'); });
    performance.getEntriesByType('resource').forEach(entry => {
      if (/mp4|m4v|webm|m3u8|videoplayback|googlevideo|vimeocdn|akamaized|scontent|fbcdn|cdninstagram/i.test(entry.name)) {
        add(entry.name, '브라우저 네트워크', entry.encodedBodySize || entry.transferSize || 0);
      }
    });
    let out = [...map.values()];
    if (clickedSrc && !/^blob:/i.test(clickedSrc)) {
      const key = pathKey(clickedSrc);
      out = out.filter(item => pathKey(item.url) === key || item.url === clickedSrc);
    }
    out.sort((a, b) => (b.size || 0) - (a.size || 0) || b.url.length - a.url.length);
    return out.slice(0, 2);
  }

  function svgName(svg) {
    const titled = svg.querySelector?.('title')?.textContent?.trim();
    if (titled) return titled;
    const lucide = [...(svg.classList || [])].find(c => c.startsWith('lucide-') && c !== 'lucide');
    if (lucide) return lucide.replace(/^lucide-/, '');
    const labeled = svg.getAttribute('aria-label')
      || svg.closest?.('[aria-label], [data-name], [title]')?.getAttribute('aria-label')
      || svg.closest?.('[data-name]')?.getAttribute('data-name')
      || svg.closest?.('[title]')?.getAttribute('title');
    if (labeled) return labeled.trim().slice(0, 60);
    const sibling = svg.parentElement?.querySelector?.('span, p, figcaption, [class*="name"]')?.textContent?.trim();
    return (sibling || '').slice(0, 60) || 'icon';
  }

  function svgCandidate(svg, source, confidence) {
    if (!svg || svg.closest?.('#sl-host')) return null;
    const r = svg.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return null;
    const social = ['instagram', 'facebook', 'youtube'].includes(siteKind());
    if (social && svg.closest('nav, header, footer, [role="navigation"], [role="banner"]')) return null;
    if (social && Math.max(r.width, r.height) < 36) return null;
    const code = sanitizeSvg(new XMLSerializer().serializeToString(svg));
    const name = svgName(svg);
    return candidate(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`, source, 'svg', {
      element: svg, code, confidence, relation: 'page', name, width: Math.round(r.width), height: Math.round(r.height)
    });
  }

  function collectInlineSvg(target) {
    const clicked = target?.tagName === 'SVG' ? target : target?.closest?.('svg');
    const out = [];
    if (clicked) {
      const item = svgCandidate(clicked, 'inline SVG', '최상');
      if (item) out.push(item);
    }
    return out.filter(Boolean);
  }

  function collectPageSvgs() {
    const social = ['instagram', 'facebook', 'youtube'].includes(siteKind());
    const min = social ? 36 : 12;
    const out = [];
    const seen = new Set();
    $$('svg').forEach(svg => {
      const r = svg.getBoundingClientRect();
      if (Math.min(r.width, r.height) < min) return;
      const item = svgCandidate(svg, '페이지 SVG', svg === document.activeElement ? '최상' : '중간');
      if (!item || seen.has(item.url)) return;
      seen.add(item.url);
      out.push(item);
    });
    $$('img, object, embed, image').forEach(node => {
      const url = abs(node.currentSrc || node.src || node.getAttribute?.('src') || node.getAttribute?.('data') || '');
      if (!url || !/\.svg(?:$|[?#])/i.test(url) || node.closest?.('#sl-host')) return;
      if (seen.has(url)) return;
      seen.add(url);
      out.push(candidate(url, '페이지 SVG', 'svg', {
        element: node, confidence: '높음', relation: 'page', name: fileName(url)
      }));
    });
    return out.slice(0, 500);
  }

  function collectYouTube(target) {
    const out = [];
    const nearby = target?.closest?.('a[href], ytd-rich-item-renderer, ytd-video-renderer, ytd-player') || target;
    const href = nearby?.href || nearby?.querySelector?.('a[href*="watch"], a[href*="shorts"]')?.href || location.href;
    const id = SL.youtubeIdFromUrl(href) || SL.youtubeIdFromUrl(location.href);
    if (id) {
      SL.youtubeThumbs(id).forEach(t => out.push(candidate(t.url, t.source, 'image', { confidence: t.confidence, relation: 'platform' })));
    }
    return out.filter(Boolean);
  }

  function postUrl(target) {
    const canonical = $('link[rel="canonical"]')?.href || $('meta[property="og:url"]')?.content || location.href;
    const root = target?.closest?.('article,[role="article"]');
    const links = [...(root?.querySelectorAll?.('a[href]') || [])].map(a => abs(a.href));
    const pattern = /(?:youtube\.com\/(?:watch|shorts)|youtu\.be\/|instagram\.com\/(?:reel|p|tv)|facebook\.com\/(?:reel|reels|watch))/i;
    return [canonical, ...links, location.href].map(abs).find(u => pattern.test(u)) || abs(canonical);
  }

  function collectNetwork() {
    return Promise.resolve([]);
  }

  function listPageMedia() {
    const images = $$('img').slice(0, 200).map(img => {
      const url = abs(img.currentSrc || img.src);
      if (!url || SL.isUiJunk(url) || !SL.isImageUrl(url)) return null;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w && h && w < 80 && h < 80) return null;
      return { url, source: '페이지 이미지', type: 'image', width: w, height: h, name: fileName(url), state: SL.classifyUrl(url).state };
    }).filter(Boolean);
    const videos = $$('video').slice(0, 40).map(video => {
      const url = abs(video.currentSrc || video.src);
      if (url && SL.isImageUrl(url)) return null;
      return {
        url: url || location.href,
        source: '페이지 영상',
        type: 'video',
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        name: fileName(url || 'video'),
        state: url ? SL.classifyUrl(url).state : '세션 종속 (blob)',
        temporary: !url || /^blob:/i.test(url)
      };
    }).filter(Boolean);
    return { images, videos };
  }

  function dedupe(items) {
    const map = new Map();
    items.filter(Boolean).forEach(item => {
      const key = item.url;
      const old = map.get(key);
      if (!old || SL.confidenceScore(item.confidence) > SL.confidenceScore(old.confidence)) map.set(key, item);
    });
    return [...map.values()];
  }

  function score(item, selected) {
    let n = SL.confidenceScore(item.confidence);
    if (item.element && item.element === selected) n += 80;
    if (item.relation === 'target') n += 24;
    if (/^https?:/i.test(item.url || '') && item.type === 'video' && !item.temporary && SL.isVideoUrl(item.url)) n += 70;
    if (item.temporary) n -= 50;
    if (item.stream) n -= 6;
    return n;
  }

  function rank(items, selected) {
    return items.sort((a, b) => score(b, selected) - score(a, selected));
  }

  function closePanel() {
    state.observer?.disconnect();
    state.observer = null;
    if (state.scanTimer) clearInterval(state.scanTimer);
    state.scanTimer = 0;
    if (state.onMediaLoad) document.removeEventListener('load', state.onMediaLoad, true);
    state.onMediaLoad = null;
    state.redraw = null;
    state.shadow?.querySelectorAll?.('#sl-root, .sl-lightbox, .sl-slice-editor')?.forEach(n => n.remove());
    state.panel = null;
    state.selected?.classList?.remove('sl-select');
  }

  function pageImageItem(img) {
    if (!img || img.closest?.('#sl-host')) return null;
    const url = abs(img.currentSrc || img.src);
    if (!url || SL.isUiJunk(url) || !SL.isImageUrl(url)) return null;
    const r = img.getBoundingClientRect();
    const w = img.naturalWidth || img.width || r.width || 0;
    const h = img.naturalHeight || img.height || r.height || 0;
    if (Math.min(w, h) < 96) return null;
    if (/s150x150|s320x320|_s\.(?:jpe?g|png|webp)/i.test(url) && Math.min(w, h) < 400) return null;
    return candidate(url, '페이지 이미지', 'image', {
      element: img, confidence: '중간', width: img.naturalWidth || 0, height: img.naturalHeight || 0, relation: 'page'
    });
  }

  function collectPageMedia() {
    const images = $$('img').map(pageImageItem).filter(Boolean);
    const videos = $$('video').map(video => {
      if (video.closest?.('#sl-host')) return null;
      const r = video.getBoundingClientRect();
      if (Math.min(r.width || 0, r.height || 0, video.videoWidth || r.width || 0) < 96) return null;
      const url = abs(video.currentSrc || video.src);
      if (url && SL.isImageUrl(url)) return null;
      return candidate(url || 'blob:session-video', '페이지 영상', 'video', {
        element: video, confidence: '중간', width: video.videoWidth || 0, height: video.videoHeight || 0, relation: 'page'
      });
    }).filter(Boolean);
    const svgs = collectPageSvgs();
    return [...images, ...videos, ...svgs];
  }

  function mergePageMedia() {
    const incoming = collectPageMedia();
    const have = new Set(state.candidates.map(item => item.url));
    let added = 0;
    incoming.forEach(item => {
      if (!item?.url || have.has(item.url)) return;
      have.add(item.url);
      state.candidates.push(item);
      added += 1;
    });
    return added;
  }

  function startPageWatch() {
    state.observer?.disconnect();
    if (state.scanTimer) clearInterval(state.scanTimer);
    if (state.onMediaLoad) document.removeEventListener('load', state.onMediaLoad, true);
    state.onMediaLoad = ev => {
      const node = ev.target;
      if (!state.panel || !node?.tagName) return;
      if (node.tagName !== 'IMG' && node.tagName !== 'VIDEO' && node.tagName !== 'SVG') return;
      if (mergePageMedia()) state.redraw?.();
    };
    document.addEventListener('load', state.onMediaLoad, true);
    state.observer = new MutationObserver(() => {
      if (!state.panel || state._scanSoon) return;
      state._scanSoon = setTimeout(() => {
        state._scanSoon = 0;
        if (state.panel && mergePageMedia()) state.redraw?.();
      }, 280);
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
    state.scanTimer = setInterval(() => {
      if (!state.panel) return;
      if (mergePageMedia()) state.redraw?.();
    }, 900);
  }

  function mediaNode(item, className) {
    if (item.type === 'svg' && item.code) {
      const holder = document.createElement('div');
      holder.className = `sl-svg-media ${className || ''}`;
      holder.innerHTML = sanitizeSvg(item.code);
      return holder;
    }
    if (!item.url || (/^data:/i.test(item.url) && item.type !== 'svg')) return null;
    const urlLooksImage = SL.isImageUrl(item.url) || SL.PHOTO_EXT.test(item.url) || /^image\//i.test(item.mime || '');
    if (item.type === 'video' && !urlLooksImage) {
      const poster = state.selectedMedia?.poster
        || state.selected?.closest?.('article')?.querySelector?.('img')?.currentSrc
        || '';
      const node = document.createElement('video');
      node.className = className || '';
      node.controls = true;
      node.muted = true;
      node.playsInline = true;
      node.preload = 'metadata';
      if (poster) node.poster = poster;
      if (!(item.temporary || /^blob:/i.test(item.url))) node.src = item.url;
      else if (item.url) node.src = item.url;
      return node;
    }
    const node = document.createElement('img');
    node.className = className || '';
    node.alt = item.source || '';
    node.src = item.url;
    return node;
  }

  function bytesToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  function blobFromBase64(base64, mime) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'application/octet-stream' });
  }

  function fetchBytes(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'fetchResource', url }, result => {
        if (chrome.runtime.lastError || result?.error) return reject(new Error(result?.error || chrome.runtime.lastError.message));
        if (result?.base64) return resolve(blobFromBase64(result.base64, result.mime));
        if (result?.buffer) return resolve(new Blob([result.buffer], { type: result.mime || 'application/octet-stream' }));
        reject(new Error('empty'));
      });
    });
  }

  function downloadBlob(blob, name) {
    blob.arrayBuffer().then(buffer => {
      chrome.runtime.sendMessage({
        type: 'downloadBase64',
        base64: bytesToBase64(buffer),
        mime: blob.type || 'application/octet-stream',
        filename: `source-lens/${name}`
      }, () => void chrome.runtime.lastError);
    }).catch(() => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      (state.shadow || document.documentElement).append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
  }

  function saveItem(item) {
    if (item.type === 'svg' && item.code) {
      downloadBlob(new Blob([item.code], { type: 'image/svg+xml' }), `${fileName(item.url) || 'image'}.svg`);
      return;
    }
    const name = fileName(item.url) || (item.type === 'video' ? 'video.mp4' : 'image.jpg');
    if (/^https?:/i.test(item.url) && !item.temporary) {
      chrome.runtime.sendMessage({ type: 'downloadUrl', url: item.url, filename: `source-lens/${name}` }, result => {
        if (!result?.ok) fetchBytes(item.url).then(blob => downloadBlob(blob, name));
      });
      return;
    }
    fetchBytes(item.url).then(blob => downloadBlob(blob, name)).catch(() => {
      if (state.postUrl) window.open(state.postUrl, '_blank', 'noopener');
    });
  }

  function copy(value, button) {
    const done = () => {
      if (!button) return;
      const prev = button.textContent;
      button.textContent = '복사됨';
      setTimeout(() => { button.textContent = prev; }, 1200);
    };
    navigator.clipboard?.writeText(value).then(done).catch(() => {
      const area = document.createElement('textarea');
      area.value = value;
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      done();
    });
  }

  function hydrateMeta(item, node) {
    const apply = () => {
      const meta = node?.querySelector?.('.sl-meta');
      if (!meta) return;
      const dim = item.width && item.height ? `${item.width}×${item.height}` : '';
      const size = item.size ? bytes(item.size) : '';
      meta.textContent = [dim, item.mime || item.type, size, item.state].filter(Boolean).join(' · ');
    };
    apply();
    if (!/^https?:/i.test(item.url || '')) return;
    chrome.runtime.sendMessage({ type: 'resourceMeta', url: item.url }, result => {
      if (result?.size) item.size = result.size;
      if (result?.mime) {
        item.mime = result.mime.split(';')[0];
        if (/^image\//i.test(item.mime) && !/^image\/svg/i.test(item.mime)) item.type = 'image';
        if (/^video\//i.test(item.mime)) item.type = 'video';
      }
      apply();
    });
  }

  function imageBlob(item) {
    return fetchBytes(item.url).catch(() => fetch(item.url, { credentials: 'include' }).then(r => {
      if (!r.ok) throw new Error('fetch');
      return r.blob();
    }));
  }

  function convertImage(item, format, button) {
    const prev = button?.textContent;
    if (button) button.textContent = '변환 중…';
    const name = `${(fileName(item.url) || 'image').replace(/\.[^.]+$/, '')}.${format.ext}`;
    const done = (ok, err) => {
      if (button) button.textContent = ok ? '저장됨' : '변환 실패';
      if (!ok) console.warn('[Source Lens] convert', err);
      setTimeout(() => { if (button) button.textContent = prev; }, 1800);
    };
    if (item.type === 'svg' && item.code) {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, image.naturalWidth);
        canvas.height = Math.max(1, image.naturalHeight);
        const ctx = canvas.getContext('2d');
        if (format.mime === 'image/jpeg') {
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(image, 0, 0);
        canvas.toBlob(blob => {
          if (!blob) return done(false, 'toBlob');
          downloadBlob(blob, name);
          done(true);
        }, format.mime, 0.92);
      };
      image.onerror = () => done(false, 'svg decode');
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(item.code)}`;
      return;
    }
    chrome.runtime.sendMessage({
      type: 'convertAndDownload',
      url: item.url,
      mime: format.mime,
      filename: `source-lens/${name}`
    }, result => {
      if (chrome.runtime.lastError) return done(false, chrome.runtime.lastError.message);
      done(!!result?.ok, result?.error);
    });
  }

  function openLightbox(item, items, index) {
    const layer = document.createElement('div');
    layer.className = 'sl-lightbox';
    const card = document.createElement('div');
    card.className = 'sl-lightbox-card';
    const close = document.createElement('button');
    close.className = 'sl-lightbox-close';
    close.textContent = '×';
    close.onclick = () => layer.remove();
    const prev = document.createElement('button');
    prev.className = 'sl-lightbox-nav sl-lightbox-prev';
    prev.textContent = '‹';
    const next = document.createElement('button');
    next.className = 'sl-lightbox-nav sl-lightbox-next';
    next.textContent = '›';
    prev.onclick = () => { layer.remove(); openLightbox(items[(index - 1 + items.length) % items.length], items, (index - 1 + items.length) % items.length); };
    next.onclick = () => { layer.remove(); openLightbox(items[(index + 1) % items.length], items, (index + 1) % items.length); };
    const preview = mediaNode(item, 'sl-lightbox-media');
    card.append(close, prev, next);
    if (preview) card.append(preview);
    const title = document.createElement('div');
    title.className = 'sl-file-meta';
    title.textContent = `${labelOf(item)} · ${item.state || ''}`;
    const page = document.createElement('div');
    page.className = 'sl-lightbox-page';
    page.textContent = `${index + 1} / ${items.length}`;
    const actions = document.createElement('div');
    actions.className = 'sl-lightbox-actions';
    const addBtn = (label, kind, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = kind === 'primary' ? 'sl-btn sl-copy' : 'sl-btn';
      btn.textContent = label;
      btn.style.cssText = kind === 'primary'
        ? 'display:flex;align-items:center;justify-content:center;min-height:44px;background:#229968;border:1px solid #187d54;color:#fff;border-radius:7px;cursor:pointer;font:650 13px/1.2 Inter,sans-serif'
        : 'display:flex;align-items:center;justify-content:center;min-height:44px;background:#fff;border:1px solid #d1d5db;color:#1c1c1c;border-radius:7px;cursor:pointer;font:550 13px/1.2 Inter,sans-serif';
      btn.onclick = onClick;
      actions.append(btn);
      return btn;
    };
    addBtn('URL 복사', 'primary', ev => copy(item.temporary ? (state.postUrl || item.url) : item.url, ev.currentTarget));
    addBtn('저장', 'primary', () => saveItem(item));
    addBtn('새 탭', 'normal', () => window.open(item.temporary ? (state.postUrl || item.url) : item.url, '_blank', 'noopener'));
    if (item.type === 'svg') addBtn('코드 복사', 'primary', ev => copySvg(item, ev.currentTarget));
    if (item.type === 'image' || item.type === 'svg') {
      [['JPG', 'jpg', 'image/jpeg'], ['PNG', 'png', 'image/png'], ['WebP', 'webp', 'image/webp']].forEach(([label, ext, mime]) => {
        addBtn(`${label} 저장`, 'normal', ev => convertImage(item, { label, ext, mime }, ev.currentTarget));
      });
      addBtn('분할 편집', 'normal', () => { layer.remove(); openSliceEditor(item); });
    }
    card.append(title, page, actions);
    layer.append(card);
    layer.onclick = ev => { if (ev.target === layer) layer.remove(); };
    uiRoot().append(layer);
  }

  async function openSliceEditor(item) {
    let blob;
    try {
      blob = item.type === 'svg' && item.code
        ? new Blob([item.code], { type: 'image/svg+xml' })
        : await imageBlob(item);
    } catch (error) {
      const note = document.createElement('div');
      note.className = 'sl-lightbox';
      note.innerHTML = `<div class="sl-lightbox-card"><p class="sl-session-note">이미지를 불러오지 못해 분할할 수 없습니다. ${esc(String(error.message || error))}</p><button class="sl-btn" type="button">닫기</button></div>`;
      note.querySelector('button').onclick = () => note.remove();
      uiRoot().append(note);
      return;
    }

    const sourceUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      const layer = document.createElement('div');
      layer.className = 'sl-slice-editor';
      layer.innerHTML = `<div class="sl-slice-card"><button class="sl-slice-close" type="button">×</button>
        <header class="sl-slice-header"><div><h3>이미지 분할 편집</h3><small>가로선을 추가하고 드래그하세요. 더블클릭하면 삭제됩니다.</small></div>
        <div class="sl-slice-tools"><button class="sl-btn sl-slice-add" type="button">+ 가로선</button>
        <select class="sl-slice-format"><option value="png">PNG</option><option value="jpg">JPG</option><option value="webp">WebP</option></select>
        <button class="sl-btn sl-slice-export" type="button">분할 저장</button></div></header>
        <div class="sl-slice-viewport"><img class="sl-slice-image" alt=""><div class="sl-slice-lines"></div></div>
        <footer class="sl-slice-footer"><span class="sl-slice-count"></span><span>${image.naturalWidth}×${image.naturalHeight}px</span></footer></div>`;
      const viewport = layer.querySelector('.sl-slice-viewport');
      const preview = layer.querySelector('.sl-slice-image');
      const linesEl = layer.querySelector('.sl-slice-lines');
      const countEl = layer.querySelector('.sl-slice-count');
      const positions = [];
      preview.src = sourceUrl;
      const close = () => { URL.revokeObjectURL(sourceUrl); layer.remove(); };
      layer.querySelector('.sl-slice-close').onclick = close;
      layer.onclick = ev => { if (ev.target === layer) close(); };
      const renderLines = () => {
        linesEl.textContent = '';
        positions.sort((a, b) => a - b);
        positions.forEach((position, lineIndex) => {
          const line = document.createElement('button');
          line.type = 'button';
          line.className = 'sl-slice-line';
          line.style.top = `${position * 100}%`;
          line.ondblclick = ev => { ev.preventDefault(); positions.splice(lineIndex, 1); renderLines(); };
          let dragging = false;
          const move = ev => {
            if (!dragging) return;
            const rect = viewport.getBoundingClientRect();
            positions[lineIndex] = Math.max(0.01, Math.min(0.99, (ev.clientY - rect.top) / rect.height));
            renderLines();
          };
          line.onpointerdown = ev => {
            dragging = true;
            line.setPointerCapture?.(ev.pointerId);
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', () => { dragging = false; window.removeEventListener('pointermove', move); }, { once: true });
          };
          linesEl.append(line);
        });
        countEl.textContent = `${positions.length + 1}개 이미지로 분할`;
      };
      layer.querySelector('.sl-slice-add').onclick = () => {
        const sorted = [0, ...positions, 1].sort((a, b) => a - b);
        let largest = 0, midpoint = 0.5;
        for (let i = 0; i < sorted.length - 1; i++) {
          const gap = sorted[i + 1] - sorted[i];
          if (gap > largest) { largest = gap; midpoint = sorted[i] + gap / 2; }
        }
        if (positions.length < 30) positions.push(midpoint);
        renderLines();
      };
      layer.querySelector('.sl-slice-export').onclick = async ev => {
        const button = ev.currentTarget;
        button.disabled = true;
        const value = layer.querySelector('.sl-slice-format').value;
        const chosen = value === 'jpg' ? { ext: 'jpg', mime: 'image/jpeg' } : value === 'webp' ? { ext: 'webp', mime: 'image/webp' } : { ext: 'png', mime: 'image/png' };
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const cuts = [0, ...positions.slice().sort((a, b) => a - b), 1];
        const base = fileName(item.url).replace(/\.[^.]+$/, '') || 'image';
        for (let i = 0; i < cuts.length - 1; i++) {
          const top = Math.round(cuts[i] * image.naturalHeight);
          const bottom = Math.round(cuts[i + 1] * image.naturalHeight);
          canvas.width = image.naturalWidth;
          canvas.height = Math.max(1, bottom - top);
          ctx.drawImage(image, 0, top, image.naturalWidth, canvas.height, 0, 0, canvas.width, canvas.height);
          const output = await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(), chosen.mime, 0.92));
          downloadBlob(output, `${base}-slice-${String(i + 1).padStart(2, '0')}.${chosen.ext}`);
        }
        button.textContent = '저장 완료';
        button.disabled = false;
      };
      uiRoot().append(layer);
      renderLines();
    };
    image.onerror = () => {
      URL.revokeObjectURL(sourceUrl);
      const note = document.createElement('div');
      note.className = 'sl-session-note';
      note.textContent = '이미지를 불러오지 못해 분할할 수 없습니다.';
      uiRoot().querySelector('#sl-panel')?.append(note);
      setTimeout(() => note.remove(), 2500);
    };
    image.src = sourceUrl;
  }

  function render() {
    closePanel();
    const shadow = uiRoot();
    const root = document.createElement('div');
    root.id = 'sl-root';
    const panel = document.createElement('section');
    panel.id = 'sl-panel';
    root.append(panel);
    state.panel = root;
    shadow.append(root);
    const brand = (typeof sourceLensProfileFor === 'function' ? sourceLensProfileFor(location.hostname) : null)?.brand
      || { name: siteKind(), color: '#229968' };
    const selected = state.picked || state.candidates[0];
    panel.innerHTML = `
      <button class="sl-close" type="button" aria-label="닫기">×</button>
      <header class="sl-header">
        <div>
          <h2>Source Lens <small class="sl-ver">0.4.5</small></h2>




          <span class="sl-platform" style="border-color:${esc(brand.color)};color:${esc(brand.color)}">${esc(brand.name)}</span>
        </div>
      </header>
      <nav class="sl-tabs">
        <button data-tab="selected" class="active">선택</button>
        <button data-tab="image">이미지 <b>0</b></button>
        <button data-tab="video">영상 <b>0</b></button>
        <button data-tab="svg">SVG <b>0</b></button>
      </nav>
      <main class="sl-main"></main>`;
    $('.sl-close', panel).onclick = closePanel;
    const main = $('.sl-main', panel);
    const updateCounts = () => {
      panel.querySelector('[data-tab="image"] b').textContent = state.candidates.filter(i => i.type === 'image').length;
      panel.querySelector('[data-tab="video"] b').textContent = state.candidates.filter(i => i.type === 'video').length;
      panel.querySelector('[data-tab="svg"] b').textContent = state.candidates.filter(i => i.type === 'svg').length;
    };
    const draw = () => {
      main.textContent = '';
      const selected = state.picked || state.candidates[0];
      panel.querySelectorAll('.sl-tabs button').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === state.activeTab));
      updateCounts();
      const list = state.activeTab === 'selected' ? (selected ? [selected] : []) : state.candidates.filter(i => i.type === state.activeTab);
      if (!list.length) {
        main.innerHTML = '<div class="sl-empty">표시할 미디어가 없습니다.</div>';
        return;
      }
      if (state.activeTab === 'selected') {
        const item = list[0];
        const preview = mediaNode(item, 'sl-preview');
        if (preview) main.append(preview);
        const card = document.createElement('article');
        card.className = 'sl-primary';
        card.innerHTML = `<div class="sl-kicker">대표 후보</div><strong>${esc(labelOf(item))}</strong>
          <div class="sl-file-meta sl-meta">${esc(item.state)} · ${esc(item.mime || item.type)}</div>
          <div class="sl-primary-actions">
            <button class="sl-btn sl-url" style="background:#fff;color:#1c1c1c;border:1px solid #d1d5db">URL 보기</button>
            <button class="sl-btn sl-copy" style="background:#229968;color:#fff;border:1px solid #187d54">URL 복사</button>
            <button class="sl-btn sl-new" style="background:#fff;color:#1c1c1c;border:1px solid #d1d5db">새 탭</button>
            <button class="sl-btn sl-save" style="background:#229968;color:#fff;border:1px solid #187d54">저장</button>
            ${item.type === 'svg' ? '<button class="sl-btn sl-code" style="background:#fff;color:#1c1c1c;border:1px solid #d1d5db">코드 복사</button><button class="sl-btn sl-codeview" style="background:#fff;color:#1c1c1c;border:1px solid #d1d5db">코드 보기</button>' : ''}
          </div>`;
        $('.sl-url', card).onclick = ev => {
          const existing = card.querySelector('.sl-url-value');
          if (existing) {
            existing.remove();
            ev.currentTarget.textContent = 'URL 보기';
            return;
          }
          const code = document.createElement('code');
          code.className = 'sl-url-value';
          code.textContent = item.temporary ? (state.postUrl || item.url) : item.url;
          card.append(code);
          ev.currentTarget.textContent = 'URL 숨기기';
        };
        $('.sl-copy', card).onclick = ev => copy(item.temporary ? (state.postUrl || item.url) : item.url, ev.currentTarget);
        $('.sl-new', card).onclick = () => window.open(item.temporary ? (state.postUrl || item.url) : item.url, '_blank', 'noopener');
        $('.sl-save', card).onclick = () => saveItem(item);
        $('.sl-code', card)?.addEventListener('click', ev => copySvg(item, ev.currentTarget));
        $('.sl-codeview', card)?.addEventListener('click', ev => {
          const existing = card.querySelector('.sl-svg-code');
          if (existing) { existing.remove(); ev.currentTarget.textContent = '코드 보기'; return; }
          const pre = document.createElement('pre');
          pre.className = 'sl-url-value sl-svg-code';
          pre.textContent = svgSource(item) || '코드를 불러오는 중…';
          card.append(pre);
          ev.currentTarget.textContent = '코드 숨기기';
          if (!svgSource(item) && /\.svg(?:$|[?#])/i.test(item.url || '')) {
            fetchBytes(item.url).then(blob => blob.text()).then(text => {
              item.code = sanitizeSvg(text);
              pre.textContent = item.code;
            }).catch(() => { pre.textContent = item.url; });
          }
        });
        hydrateMeta(item, card);
        main.append(card);
      } else {
        const grid = document.createElement('div');
        grid.className = 'sl-grid';
        list.forEach((item, index) => {
          const tile = document.createElement('article');
          tile.className = 'sl-tile';
          const preview = mediaNode(item, 'sl-tile-preview');
          if (preview) tile.append(preview);
          tile.insertAdjacentHTML('beforeend', `<strong>${esc(labelOf(item))}</strong><small>${esc(item.source)}</small><small class="sl-meta">${esc(item.state)}</small>`);
          hydrateMeta(item, tile);
          tile.onclick = () => openLightbox(item, list, index);
          grid.append(tile);
        });
        main.append(grid);
      }
    };
    panel.querySelectorAll('.sl-tabs button').forEach(btn => {
      btn.onclick = () => { state.activeTab = btn.dataset.tab; draw(); };
    });
    state.redraw = () => {
      if (state.activeTab === 'selected') { updateCounts(); return; }
      draw();
    };
    draw();
    startPageWatch();
  }

  function collectArticle(target) {
    const root = target?.closest?.('article') || target;
    if (!root?.querySelectorAll) return [];
    const out = [];
    root.querySelectorAll('img, video').forEach(node => {
      const r = node.getBoundingClientRect();
      if (Math.min(r.width, node.naturalWidth || node.videoWidth || r.width) < 80) return;
      out.push(...(collectTarget(node).candidates || []));
    });
    return out.filter(item => item && !SL.isUiJunk(item.url) && item.type !== 'svg');
  }

  async function inspect(target, seed = []) {
    const collected = collectTarget(target);
    state.selected = target;
    const tag = (collected.media?.tagName || target?.tagName || '').toUpperCase();
    const clickedVideo = tag === 'VIDEO';
    const clickedSvg = tag === 'SVG';
    state.selectedMedia = clickedVideo ? collected.media : null;
    state.postUrl = postUrl(target);
    const extras = [];
    if (clickedVideo || siteKind() === 'youtube' || siteKind() === 'vimeo') extras.push(...collectRecentVideos(collected.media));
    extras.push(...collectInlineSvg(target));
    if (siteKind() === 'youtube') extras.push(...collectYouTube(target));
    if (!clickedSvg) extras.push(...collectArticle(target));
    const seenVideo = new Set();
    let list = rank(dedupe([...seed, ...collected.candidates, ...extras]), collected.media)
      .filter(item => item && !(SL.isUiJunk(item.url) && item.type !== 'svg'));
    if (clickedSvg) list = list.filter(item => item.type === 'svg');
    else if (clickedVideo) {
      const videos = list.filter(item => {
        if (item.type !== 'video' || !(item.temporary || SL.isVideoUrl(item.url))) return false;
        const key = pathKey(item.url);
        if (seenVideo.has(key)) return false;
        seenVideo.add(key);
        return true;
      });
      const https = videos.filter(item => /^https?:/i.test(item.url) && !item.temporary)
        .sort((a, b) => (b.size || 0) - (a.size || 0) || b.url.length - a.url.length);
      const blobs = videos.filter(item => item.temporary).slice(0, 1);
      const poster = list.filter(item => item.type === 'image' && SL.isImageUrl(item.url)).slice(0, 2);
      const svgs = list.filter(item => item.type === 'svg');
      list = [...https.slice(0, 2), ...blobs, ...poster, ...svgs];
    } else {
      list = list.filter(item => (item.type === 'image' && SL.isImageUrl(item.url)) || item.type === 'svg');
    }
    state.picked = list[0] || null;
    state.candidates = dedupe([...list, ...collectPageMedia()]);
    state.activeTab = clickedSvg ? 'svg' : clickedVideo ? 'video' : 'selected';
    if (window !== window.top) {
      try {
        window.top.postMessage({
          sourceLens: true,
          type: 'open',
          data: {
            candidates: state.candidates.map(({ element, ...item }) => item),
            picked: state.picked ? (({ element, ...item }) => item)(state.picked) : null,
            postUrl: state.postUrl,
            activeTab: state.activeTab
          }
        }, location.origin);
      } catch {
        render();
      }
      return;
    }
    render();
  }

  window.addEventListener('mousedown', ev => {
    if (ev.altKey && ev.button === 0 && ev.target !== state.host && !ev.target.closest?.('#sl-host')) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }
  }, true);

  window.addEventListener('click', ev => {
    if (!ev.altKey || ev.button !== 0 || ev.target === state.host || ev.target.closest?.('#sl-host')) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    inspect(mediaAtPoint(ev.clientX, ev.clientY));
  }, true);

  document.addEventListener('contextmenu', ev => {
    state.contextTarget = ev.target?.closest?.('img,video,svg,a') || ev.target;
  }, true);

  window.addEventListener('message', ev => {
    if (window !== window.top || !ev.data?.sourceLens || ev.data.type !== 'open') return;
    state.candidates = ev.data.data?.candidates || [];
    state.picked = ev.data.data?.picked || state.candidates[0] || null;
    state.postUrl = ev.data.data?.postUrl || '';
    state.activeTab = ev.data.data?.activeTab || 'selected';
    state.activeTab = 'selected';
    render();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'listImages' || message?.type === 'listPageMedia') {
      sendResponse(listPageMedia());
      return true;
    }
    if (message?.type !== 'contextInspect') return;
    const target = state.contextTarget || mediaAtPoint(innerWidth / 2, innerHeight / 2);
    const seed = message.info?.srcUrl
      ? [candidate(message.info.srcUrl, '우클릭 URL', message.info.mediaType === 'video' ? 'video' : 'image', { confidence: '최상' })]
      : [];
    inspect(target, seed);
  });

  window.addEventListener('keydown', ev => { if (ev.key === 'Escape') closePanel(); });
})();
