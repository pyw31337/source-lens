(() => {
  if (window.__sourceLensLoaded) return;
  window.__sourceLensLoaded = true;

  const SL = globalThis.SourceLens;
  const state = {
    panel: null, selected: null, contextTarget: null, selectedMedia: null, picked: null,
    candidates: [], activeTab: 'selected', postUrl: '', capture: null, pageNet: [],
    profile: null, observer: null, scanTimer: 0, redraw: null, platformMedia: [],
    recorder: null, captureTimer: 0,
    query: '', minPx: 0, sort: 'big', selectedKeys: new Set(), dock: 'right', altClick: true,
    lastPoint: null, lightboxItem: null, toastTimer: 0, autoVideo: true
  };
  const VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch { return ''; } })();
  const SAVE_MAX = 100;
  const ZIP_MAX = 40;

  function loadPrefs() {
    try {
      chrome.storage.local.get('slPrefs', data => {
        const p = data?.slPrefs || {};
        if (p.dock === 'left' || p.dock === 'right') state.dock = p.dock;
        if (Number.isFinite(p.minPx)) state.minPx = p.minPx;
        if (p.sort === 'big' || p.sort === 'page') state.sort = p.sort;
        state.altClick = p.altClick !== false;
        state.autoVideo = p.autoVideo !== false;
      });
      chrome.storage.onChanged?.addListener((changes, area) => {
        if (area !== 'local' || !changes.slPrefs) return;
        const p = changes.slPrefs.newValue || {};
        state.altClick = p.altClick !== false;
        state.autoVideo = p.autoVideo !== false;
        if (p.dock === 'left' || p.dock === 'right') {
          state.dock = p.dock;
          state.panel?.querySelector('#sl-panel')?.classList.toggle('is-left', state.dock === 'left');
        }
      });
    } catch { /* ignore */ }
  }

  function savePrefs(patch) {
    try {
      chrome.storage.local.get('slPrefs', data => {
        chrome.storage.local.set({ slPrefs: { ...(data?.slPrefs || {}), ...patch } });
      });
    } catch { /* ignore */ }
  }
  loadPrefs();

  let shadowCache = { t: 0, roots: [] };
  function shadowRoots() {
    const now = Date.now();
    if (now - shadowCache.t < 1500) return shadowCache.roots;
    const roots = [];
    const walk = (root, depth) => {
      if (!root || depth > 6) return;
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node, n = 0;
      while ((node = tw.nextNode()) && n < 40000) {
        n += 1;
        const sr = node.shadowRoot;
        if (sr && node !== state.host && node.id !== 'sl-host') {
          roots.push(sr);
          walk(sr, depth + 1);
        }
      }
    };
    try { walk(document.documentElement, 0); } catch { /* ignore */ }
    shadowCache = { t: now, roots };
    return roots;
  }

  function deepAll(selector) {
    const out = [...document.querySelectorAll(selector)];
    shadowRoots().forEach(root => {
      try { out.push(...root.querySelectorAll(selector)); } catch { /* ignore */ }
    });
    return out.filter(node => !node.closest?.('#sl-host'));
  }

  let bgCache = { t: 0, items: [] };
  function collectBackgrounds() {
    const now = Date.now();
    if (now - bgCache.t < 3000) return bgCache.items;
    const out = [];
    const seen = new Set();
    const start = performance.now();
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    const n = Math.min(all.length, 8000);
    for (let i = 0; i < n; i++) {
      if ((i & 63) === 0 && performance.now() - start > 50) break;
      const el = all[i];
      if (el.id === 'sl-host' || /^(?:IMG|VIDEO|PICTURE|SOURCE|SCRIPT|STYLE|LINK|META|NOSCRIPT|BR)$/i.test(el.tagName) || el instanceof SVGElement) continue;
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none' || bg.indexOf('url(') < 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 96 || r.height < 96) continue;
      const re = /url\(\s*["']?([^"')]+?)["']?\s*\)/g;
      let m;
      while ((m = re.exec(bg))) {
        const u = abs(m[1]);
        if (!u || seen.has(u) || /^data:/i.test(u) || /\.svg(?:$|[?#])/i.test(u)) continue;
        seen.add(u);
        if (isChromeImage(el, u)) continue;
        const item = candidate(u, '배경 이미지(CSS)', 'image', {
          confidence: '중간', relation: 'page', width: Math.round(r.width), height: Math.round(r.height)
        });
        if (item) out.push(item);
      }
      if (out.length >= 80) break;
    }
    bgCache = { t: now, items: out };
    return out;
  }

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


  function siteProfile() {
    return (typeof sourceLensSite === 'function' ? sourceLensSite(location.hostname) : { kind: siteKind(), svgMin: 12, skipChrome: true });
  }

  function siteKind() {
    const host = location.hostname.replace(/^www\./, '').toLowerCase();
    const mapped = (typeof sourceLensSite === 'function' && sourceLensSite(host).kind) || '';
    if (mapped && mapped !== 'generic') return mapped;
    if (host.endsWith('youtube.com') || host === 'youtu.be') return 'youtube';
    if (host.endsWith('instagram.com')) return 'instagram';
    if (host.endsWith('facebook.com') || host === 'fb.watch') return 'facebook';
    if (host.endsWith('vimeo.com') || host.endsWith('vimeocdn.com')) return 'vimeo';
    if (host.endsWith('tiktok.com')) return 'tiktok';
    if (host.endsWith('naver.com')) return 'naver';
    if (host.endsWith('kakao.com') || host.endsWith('kakaocdn.net')) return 'kakao';
    if (host.endsWith('daum.net') || host.endsWith('daumcdn.net')) return 'daum';
    if (/gmarket\.co\.kr|auction\.co\.kr|coupang\.com|11st\.co\.kr|smartstore\.naver|shopping\.naver|brand\.naver|tmon\.co\.kr|wemakeprice|ssg\.com|lotteon\.com/.test(host)) return 'commerce';
    return host;
  }

  function isCommerce() {
    return ['commerce', 'stock'].includes(siteKind()) || /item\.|product|goods|shop|store|mall/i.test(location.hostname + location.pathname);
  }

  function upgradeCommerceUrl(url) {
    return SL.upgradeMediaUrl(url);
  }

  function isTallItem(item) {
    const w = item?.width || 0, h = item?.height || 0;
    return h >= 1200 && w > 0 && h > w * 2.2;
  }

  function videoEmptyMessage() {
    const k = siteKind();
    if (k === 'commerce') return '이 페이지에는 재생할 영상 파일이 없습니다. LIVE 표기는 SVG 배지입니다.';
    if (k === 'instagram' || k === 'facebook' || k === 'tiktok') {
      return '이 사이트 영상은 브라우저 확장으로 원본 저장이 불가합니다. 주소가 만료되고 로그인이 묶여 있습니다.';
    }
    if (k === 'youtube') return '유튜브 원본 mp4는 확장에서 받을 수 없습니다. 로컬 yt-dlp가 필요합니다.';
    if (k === 'vimeo') return '프로그레시브 mp4가 있으면 저장됩니다. 없으면 받을 수 없습니다.';
    if (k === 'naver' || k === 'kakao' || k === 'daum') return '플레이어 파일 주소가 공개된 경우에만 저장됩니다.';
    return '파일 주소가 없으면 이 탭에서 영상을 저장할 수 없습니다.';
  }

  function videoLocked() {
    return ['instagram', 'facebook', 'tiktok'].includes(siteKind());
  }

  function itemPixel(item) {
    const url = item?.url || '';
    const sized = /s(\d{3,4})x(\d{3,4})/i.exec(url);
    if (sized) return Math.max(Number(sized[1]), Number(sized[2]));
    if (/_(?:n|o)\.(?:jpe?g|png|webp)/i.test(url)) return 1080;
    return Math.max(item?.width || 0, item?.height || 0);
  }

  function candidate(url, source, hint, extra = {}) {
    let value = abs(url);
    if (!value) return null;
    if (typeof SL.unwrapMediaUrl === 'function') value = abs(SL.unwrapMediaUrl(value)) || value;
    if (SL.isUiJunk(value) && hint !== 'svg' && !extra.allowJunk) return null;
    let rewritten = false;
    if (hint !== 'svg' && hint !== 'video' && typeof SL.upgradeMediaUrl === 'function') {
      const upgraded = SL.upgradeMediaUrl(value);
      if (upgraded && upgraded !== value && (SL.isImageUrl(upgraded) || SL.PHOTO_EXT.test(upgraded) || /pstatic\.net|unsplash|pexels|coupangcdn|danawa/i.test(upgraded))) {
        value = upgraded;
        rewritten = true;
      }
    }
    const info = SL.classifyUrl(value, hint);
    if (SL.PHOTO_EXT.test(value) || SL.isImageUrl(value)) info.type = 'image';
    if (info.type === 'video' && SL.isImageUrl(value)) info.type = 'image';
    if (info.type === 'video' && /i\.ytimg|maxresdefault|hqdefault|mqdefault/i.test(value)) info.type = 'image';
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
      fp: extra.fp || '',
      relation: extra.relation || 'target',
      rewritten
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
        --sl-brand-hover: #65d9a5;
        --sl-ink: #ededed;
        font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
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

  function isChromeImage(node, url) {
    if (siteProfile().skipChrome === false) return false;
    const src = url || node?.currentSrc || node?.src || '';
    if (/logo|favicon|image__logo|\/ci\/|brand[_-]?mark|sprite\.(?:png|gif|svg)/i.test(src)) return true;
    if (/\/(?:emoticon|emoji|nickcon)\//i.test(src)) return true;
    if (node?.closest?.('header, nav, [role="banner"], .header, #header, .gds-header, footer')) return true;
    return false;
  }

  function mediaAtPoint(x, y) {
    const stack = document.elementsFromPoint(x, y).filter(node => node !== state.host && !node.closest?.('#sl-host'));
    const hitRect = (node, pad = 0) => {
      const r = node.getBoundingClientRect();
      return r.width >= 24 && r.height >= 24
        && x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
    };
    const imgsUnder = $$('img').filter(img => !img.closest?.('#sl-host') && !isChromeImage(img) && hitRect(img, 4))
      .sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (ra.width * ra.height) - (rb.width * rb.height);
      });
    if (imgsUnder.length) {
      const small = imgsUnder[0];
      const sr = small.getBoundingClientRect();
      if (sr.width < 80 || sr.height < 80) {
        const large = imgsUnder.find(img => {
          const r = img.getBoundingClientRect();
          return r.width >= 120 && r.height >= 120;
        });
        if (large) return large;
      }
      return small;
    }
    const videosUnder = $$('video').filter(v => !v.closest?.('#sl-host') && hitRect(v));
    if (videosUnder[0]) return videosUnder[0];
    const svgsUnder = $$('svg').filter(s => !s.closest?.('#sl-host') && hitRect(s, 2));
    if (svgsUnder[0] && !imgsUnder.length) return svgsUnder[0];
    const found = [];
    for (const node of stack) {
      const media = node.tagName && /^(IMG|VIDEO|SVG|PICTURE)$/.test(node.tagName)
        ? node
        : node.closest?.('img, video, svg, picture');
      if (!media || found.includes(media) || isChromeImage(media)) continue;
      const r = media.getBoundingClientRect();
      if (media.tagName !== 'SVG' && (r.width < 24 || r.height < 24)) continue;
      found.push(media);
    }
    if (found[0]) return found[0];
    const nearby = $$('img').filter(img => {
      if (img.closest?.('#sl-host') || isChromeImage(img)) return false;
      const r = img.getBoundingClientRect();
      if (r.width < 48 || r.height < 48) return false;
      return Math.hypot(r.left + r.width / 2 - x, r.top + r.height / 2 - y) < 220;
    }).sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const da = Math.hypot(ra.left + ra.width / 2 - x, ra.top + ra.height / 2 - y);
      const db = Math.hypot(rb.left + rb.width / 2 - x, rb.top + rb.height / 2 - y);
      return da - db;
    });
    return nearby[0] || stack[0] || null;
  }

  function pathKey(url) {
    try {
      return new URL(url, location.href).pathname.replace(/\/+$/, '').split('/').pop() || url;
    } catch {
      return url;
    }
  }

  function canonicalImageKey(url) {
    try {
      const u = new URL(url, location.href);
      ['w', 'h', 'width', 'height', 'q', 'quality', 'dpr', 'fit', 'crop', 'auto', 'cs', 's', 'size', 'type', 't', 'w2', 'rs'].forEach(k => u.searchParams.delete(k));
      const path = u.pathname
        .replace(/\/thumbnails\/remote\/\d+x\d+(?:ex)?\//ig, '/')
        .replace(/\/(?:small|medium|large|thumb|original)\//ig, '/')
        .replace(/\/\d{2,4}x\d{2,4}\//g, '/')
        .replace(/_(?:small|medium|large|thumb|teaser|n|o)\b/ig, '')
        .replace(/_\d{2,4}(?=\.(?:jpe?g|png|webp))/i, '');
      return `${u.hostname.replace(/^www\./, '')}${path}`;
    } catch {
      return url;
    }
  }

  function largestSrcset(srcset) {
    return SL.largestSrcset(srcset);
  }

  function srcsetWidth(srcset, url) {
    const hit = SL.parseSrcset(srcset).find(c => c.url === url);
    return hit && hit.unit === 'w' ? Math.round(hit.value) : 0;
  }

  function isLightPaint(value) {
    const v = String(value || '').trim().toLowerCase();
    if (!v || v === 'currentcolor' || v === 'inherit' || v === 'white' || v === '#fff' || v === '#ffffff' || v === '#fefefe' || v === 'rgb(255,255,255)') return true;
    if (v === 'none' || /^url\(/i.test(v)) return false;
    const hex = v.match(/^#([0-9a-f]{3,8})$/i);
    if (hex) {
      let h = hex[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('').slice(0, 6);
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      return (r + g + b) / 3 > 186;
    }
    const rgb = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rgb) return (Number(rgb[1]) + Number(rgb[2]) + Number(rgb[3])) / 3 > 186;
    return false;
  }

  function previewSvg(code) {
    const sanitized = sanitizeSvg(code);
    try {
      const doc = new DOMParser().parseFromString(sanitized, 'image/svg+xml');
      const root = doc.documentElement;
      if (!root || root.tagName.toLowerCase() !== 'svg') return sanitized;
      root.setAttribute('color', '#111111');
      const w = parseFloat(root.getAttribute('width')) || 24;
      const h = parseFloat(root.getAttribute('height')) || 24;
      if (!root.getAttribute('viewBox')) root.setAttribute('viewBox', `0 0 ${w} ${h}`);
      root.removeAttribute('width');
      root.removeAttribute('height');
      root.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      const paint = (el) => {
        if (!el.getAttribute) return;
        ['fill', 'stroke'].forEach(attr => {
          const v = (el.getAttribute(attr) || '').trim();
          if (!v || v === 'currentColor' || isLightPaint(v)) el.setAttribute(attr, v === 'none' ? 'none' : '#111111');
        });
        const style = el.getAttribute('style');
        if (style) {
          el.setAttribute('style', style
            .replace(/fill\s*:\s*(currentColor|[^;]+)/ig, (m, v) => /none/i.test(v) ? m : 'fill:#111111')
            .replace(/stroke\s*:\s*(currentColor|[^;]+)/ig, (m, v) => /none/i.test(v) ? m : 'stroke:#111111')
            .replace(/color\s*:\s*[^;]+/ig, 'color:#111111'));
        }
      };
      paint(root);
      root.querySelectorAll('*').forEach(paint);
      if (!root.getAttribute('fill') && !root.getAttribute('stroke')) root.setAttribute('fill', '#111111');
      return new XMLSerializer().serializeToString(root);
    } catch {
      return sanitized;
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
    const display = node.currentSrc || node.src || '';
    const best = largestSrcset(node.srcset || node.getAttribute('srcset') || '');
    const bestW = best ? srcsetWidth(node.srcset || node.getAttribute('srcset') || '', best) : 0;
    const displayPx = Math.max(node.naturalWidth || 0, node.naturalHeight || 0, itemPixel({ url: abs(display) }));
    const pick = best && (bestW > displayPx || itemPixel({ url: abs(best) }) > displayPx || !display) ? best : display;
    if (pick) {
      out.push(candidate(pick, pick === best ? 'srcset 최대' : 'img.currentSrc', 'image', {
        element: media, confidence: '최상', allowJunk: true,
        width: pick === best && bestW ? bestW : 0,
        height: pick === best && bestW && node.naturalWidth ? Math.round(bestW * node.naturalHeight / node.naturalWidth) : 0
      }));
    }
    const lazySet = largestSrcset(node.getAttribute('data-srcset') || '');
    if (lazySet) out.push(candidate(lazySet, '속성:data-srcset', 'image', { element: media, confidence: '높음' }));
    ['data-src', 'data-original', 'data-full', 'data-full-url', 'data-lazy-src', 'data-zoom-image',
      'data-origin', 'data-url', 'data-image', 'data-img', 'data-orig-file', 'data-lazy', 'org_src'].forEach(attr => {
      out.push(candidate(node.getAttribute(attr), `속성:${attr}`, 'image', { element: media, confidence: '중간' }));
    });
  }

  function collectTarget(target) {
    if (!target) return { media: null, candidates: [] };
    const media = target?.matches?.('img,video,svg,picture')
      ? target
      : target?.closest?.('img,video,svg,picture');
    const out = [];
    if (!media) {
      let cur = target;
      for (let i = 0; i < 6 && cur; i++) {
        const bg = getComputedStyle(cur).backgroundImage || '';
        const re = /url\(\s*["']?([^"')]+?)["']?\s*\)/g;
        let match;
        while ((match = re.exec(bg))) {
          const u = abs(match[1]);
          if (!u || (/^data:/i.test(u) && !/^data:image\/svg/i.test(u)) || isChromeImage(cur, u)) continue;
          out.push(candidate(u, '배경 이미지', /\.svg(?:$|[?#])|^data:image\/svg/i.test(u) ? 'svg' : 'image', { confidence: '최상', element: cur }));
        }
        if (out.filter(Boolean).length) return { media: cur, candidates: out.filter(Boolean) };
        cur = cur.parentElement;
      }
      return { media: null, candidates: out };
    }
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

  document.documentElement.addEventListener('sl-platform-media', event => {
    const detail = event.detail || {};
    const items = [];
    (detail.videos || []).forEach(row => {
      const item = candidate(row.url, row.source || '플랫폼 영상', 'video', { confidence: '높음', relation: 'platform' });
      if (item) items.push(item);
    });
    (detail.images || []).forEach(row => {
      const item = candidate(row.url, row.source || '플랫폼 이미지', 'image', { confidence: '중간', relation: 'platform' });
      if (item && SL.isImageUrl(item.url)) items.push(item);
    });
    state.platformMedia = dedupe([...(state.platformMedia || []), ...items]);
    if (state.panel && items.length) {
      const have = new Set(state.candidates.map(itemKey));
      state.platformMedia.forEach(item => {
        const key = itemKey(item);
        if (!have.has(key)) {
          have.add(key);
          state.candidates.push(item);
        }
      });
      state.redraw?.();
    }
  });

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

  function svgFingerprint(svg, code) {
    const shapes = [...(svg?.querySelectorAll?.('path, circle, rect, polygon, polyline, line, ellipse') || [])]
      .map(el => [
        el.tagName.toLowerCase(),
        (el.getAttribute('d') || '').replace(/\s+/g, ' ').slice(0, 160),
        el.getAttribute('points') || '',
        el.getAttribute('r') || '',
        Math.round(Number(el.getAttribute('cx')) || 0),
        Math.round(Number(el.getAttribute('cy')) || 0)
      ].join(':'));
    if (shapes.length) return shapes.join('|');
    return String(code || '').replace(/id="[^"]*"/g, '').replace(/\s+/g, ' ').slice(0, 240);
  }

  function isUiSvg(svg, url, name) {
    if (siteKind() === 'icons') return false;
    if (svg?.closest?.('header, nav, footer, [role="banner"], [role="navigation"], .header, #header')) return true;
    const blob = `${url || ''} ${name || ''}`;
    if (/header|gnb_|mypage|cart|recent|favicon/i.test(blob)) return true;
    if (isCommerce() && /live/i.test(`${svg?.textContent || ''} ${name || ''}`)) return true;
    const r = svg?.getBoundingClientRect?.();
    if (isCommerce() && r && r.width <= 48 && r.height <= 48) {
      const circles = svg.querySelectorAll?.('circle')?.length || 0;
      if (circles >= 3) return true;
    }
    return false;
  }

  function expandSvgUses(svg) {
    try {
      const clone = svg.cloneNode(true);
      clone.querySelectorAll('use').forEach(use => {
        const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
        if (!href.startsWith('#')) return;
        const src = document.getElementById(href.slice(1));
        if (!src) return;
        const inner = src.cloneNode(true);
        if (inner.tagName.toLowerCase() === 'symbol' || inner.tagName.toLowerCase() === 'svg') {
          use.replaceWith(...[...inner.childNodes].map(n => n.cloneNode(true)));
        } else use.replaceWith(inner);
      });
      return clone;
    } catch {
      return svg;
    }
  }

  const svgCache = new WeakMap();
  function cachedSvgCandidate(svg, source, confidence, extra) {
    const hit = svgCache.get(svg);
    const sig = `${svg.childElementCount}:${svg.attributes.length}`;
    if (hit && hit.sig === sig && Date.now() - hit.t < 15000) return hit.item;
    const item = svgCandidate(svg, source, confidence, extra);
    svgCache.set(svg, { t: Date.now(), sig, item });
    return item;
  }

  function svgCandidate(svg, source, confidence, extra = {}) {
    if (!svg || svg.closest?.('#sl-host')) return null;
    const r = svg.getBoundingClientRect();
    const w = Math.max(r.width, svg.clientWidth || 0, Number(svg.getAttribute('width')) || 0);
    const h = Math.max(r.height, svg.clientHeight || 0, Number(svg.getAttribute('height')) || 0);
    if (!extra.allowTiny && w < 8 && h < 8 && !svg.querySelector('path, circle, polygon, rect')) return null;
    if (!extra.keepUi && isUiSvg(svg, extra.url, svgName(svg))) return null;
    const expanded = expandSvgUses(svg);
    const code = sanitizeSvg(new XMLSerializer().serializeToString(expanded));
    const name = svgName(svg);
    const fp = svgFingerprint(expanded, code);
    return candidate(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`, source, 'svg', {
      element: svg, code, confidence, relation: extra.relation || 'page', name,
      width: Math.round(w || r.width), height: Math.round(h || r.height), fp
    });
  }

  function collectInlineSvg(target) {
    const clicked = target?.tagName === 'SVG' ? target : target?.closest?.('svg') || target?.querySelector?.('svg');
    const out = [];
    if (clicked) {
      const item = svgCandidate(clicked, 'inline SVG', '최상', { keepUi: true, allowTiny: true, relation: 'target' });
      if (item) out.push(item);
    }
    return out.filter(Boolean);
  }

  function collectPageSvgs() {
    const out = [];
    const seen = new Set();
    deepAll('svg').forEach(svg => {
      if (svg.parentElement?.closest?.('svg')) return;
      const item = cachedSvgCandidate(svg, svg.getAttribute('aria-label') || '페이지 SVG', '중간', { keepUi: true, allowTiny: true });
      if (!item) return;
      const key = item.fp || item.name || item.url;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(item);
    });
    deepAll('img, object, embed').forEach(node => {
      const url = abs(node.currentSrc || node.src || node.getAttribute?.('src') || node.getAttribute?.('data') || '');
      if (!url || !/\.svg(?:$|[?#])/i.test(url) || node.closest?.('#sl-host')) return;
      if (isUiSvg(node, url, fileName(url))) return;
      let path = url;
      try { path = new URL(url).pathname; } catch { /* keep */ }
      if (seen.has(path)) return;
      seen.add(path);
      out.push(candidate(url, '페이지 SVG', 'svg', {
        element: node, confidence: '높음', relation: 'page', name: fileName(url), fp: path
      }));
    });
    return out.slice(0, 80);
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

  function plainItem(item) {
    if (!item?.url) return null;
    const code = item.type === 'svg' ? (item.code || svgSource(item) || '') : '';
    if (item.type === 'svg' && /^data:/i.test(item.url) && item.url.length > 200000) return null;
    const url = item.temporary ? item.url : liveUrl(item);
    return {
      url,
      type: item.type,
      source: item.source || '',
      name: labelOf(item),
      file: SL.downloadName({ ...item, url }, location.hostname),
      width: item.width || 0,
      height: item.height || 0,
      px: itemPixel(item),
      state: item.state || '',
      temporary: !!item.temporary,
      stream: !!item.stream,
      signed: (item.flags || []).includes('signed'),
      code: code.length < 120000 ? code : ''
    };
  }

  function listPageMedia() {
    try { document.documentElement.dispatchEvent(new CustomEvent('sl-extract-now')); } catch { /* ignore */ }
    const all = dedupe([...collectPageMedia(), ...(state.platformMedia || [])])
      .filter(item => item && !(item.type === 'video' && SL.isImageUrl(item.url)))
      .map(plainItem).filter(Boolean);
    return {
      images: all.filter(i => i.type === 'image'),
      videos: all.filter(i => i.type === 'video'),
      svgs: all.filter(i => i.type === 'svg'),
      host: location.hostname,
      title: document.title,
      top: window === window.top,
      videoLocked: videoLocked()
    };
  }
  window.__sourceLensList = listPageMedia;

  function itemKey(item) {
    if (item.type === 'svg') return `svg:${item.fp || item.name || item.url}`;
    if (item.type === 'image') return `img:${canonicalImageKey(item.url)}`;
    return item.url;
  }

  function dedupe(items) {
    const map = new Map();
    items.filter(Boolean).forEach(item => {
      const key = itemKey(item);
      const old = map.get(key);
      if (!old) {
        map.set(key, item);
        return;
      }
      const oldPx = item.type === 'image' ? itemPixel(old) : 0;
      const newPx = item.type === 'image' ? itemPixel(item) : 0;
      if (newPx > oldPx) { map.set(key, item); return; }
      if (newPx && newPx < oldPx) return;
      if (SL.confidenceScore(item.confidence) > SL.confidenceScore(old.confidence)) map.set(key, item);

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
    if (state.onScroll) window.removeEventListener('scroll', state.onScroll, true);
    state.onScroll = null;
    if (state.onMediaLoad) document.removeEventListener('load', state.onMediaLoad, true);
    state.onMediaLoad = null;
    state.redraw = null;
    state.shadow?.querySelectorAll?.('#sl-root, .sl-lightbox, .sl-slice-editor')?.forEach(n => n.remove());
    state.panel = null;
    state.lightboxItem = null;
    state.selected?.classList?.remove('sl-select');
  }

  function pageImageItem(img) {
    if (!img || img.closest?.('#sl-host')) return null;
    const url = abs(img.currentSrc || img.src);
    if (!url || /\.svg(?:$|[?#])|^data:image\/svg/i.test(url)) return null;
    const loaded = img.complete && img.naturalWidth > 0;
    const gif = /\.gif(?:$|[?#])/i.test(url);
    if (SL.isUiJunk(gif && loaded ? url.replace(/\.gif(?=$|[?#])/i, '.png') : url)) return null;
    if (!SL.isImageUrl(url) && !loaded) return null;
    const r = img.getBoundingClientRect();
    const w = img.naturalWidth || img.width || r.width || 0;
    const h = img.naturalHeight || img.height || r.height || 0;
    if (Math.min(w, h) < 96) return null;
    if (isChromeImage(img, url)) return null;
    if (/s150x150|s320x320|_s\.(?:jpe?g|png|webp)/i.test(url) && Math.min(w, h) < 400) return null;
    return candidate(url, '페이지 이미지', 'image', {
      element: img, confidence: '중간', width: img.naturalWidth || 0, height: img.naturalHeight || 0, relation: 'page', allowJunk: gif
    });
  }

  function collectPageMedia() {
    const images = deepAll('img').map(pageImageItem).filter(Boolean);
    const videos = deepAll('video').map(video => {
      if (video.closest?.('#sl-host')) return null;
      const r = video.getBoundingClientRect();
      if (Math.min(r.width || 0, r.height || 0, video.videoWidth || r.width || 0) < 96) return null;
      const url = abs(video.currentSrc || video.src);
      if (url && SL.isImageUrl(url)) return null;
      return candidate(url || 'blob:session-video', '페이지 영상', 'video', {
        element: video, confidence: '중간', width: video.videoWidth || 0, height: video.videoHeight || 0, relation: 'page'
      });
    }).filter(Boolean);
    const sources = deepAll('video source[src]').map(source => {
      const url = abs(source.src);
      if (!url || SL.isImageUrl(url)) return null;
      const video = source.closest('video');
      return candidate(url, 'video.source', 'video', {
        element: video, confidence: '높음', width: video?.videoWidth || 0, height: video?.videoHeight || 0, relation: 'page'
      });
    }).filter(Boolean);
    const posters = deepAll('video[poster]').map(video => candidate(video.getAttribute('poster'), '영상 포스터', 'image', {
      confidence: '중간', relation: 'page'
    })).filter(Boolean);
    const svgs = collectPageSvgs();
    let backgrounds = [];
    try { backgrounds = collectBackgrounds(); } catch { /* ignore */ }
    return [...images, ...videos, ...sources, ...posters, ...svgs, ...collectCatalogMedia(), ...backgrounds, ...collectSiteExtras()];
  }

  function collectSiteExtras() {
    const kind = siteKind();
    const out = [];
    const push = (url, source, extra = {}) => {
      const item = candidate(url, source, extra.hint || 'image', extra);
      if (item) out.push(item);
    };
    if (kind === 'community' || /dcinside|ygosu|humoruniv|etoland|arca\.live|ppomppu|aagag/i.test(location.hostname)) {
      $$('.writing_view_box img, .usertxt img, .gallview_contents img, .se-main-container img, #writeDiv img, .article-board img, .board-contents img, .view_content img, .td_article img').forEach(img => {
        const url = img.currentSrc || img.src || img.getAttribute('data-original') || img.getAttribute('data-src');
        if (url) push(url, '본문 이미지', { element: img, confidence: '높음' });
      });
      $$('img[src*="viewimage.php"], img[src*="dcimg"], img[src*="namu.la"], img[src*="ygosu.com"], img[src*="humoruniv"]').forEach(img => {
        push(img.currentSrc || img.src, '커뮤니티 CDN', { element: img, confidence: '높음' });
      });
    }
    if (kind === 'naver' || /blog\.naver|post\.naver|news\.naver|cafe\.naver/i.test(location.hostname + location.pathname)) {
      $$('.se-image-resource, .se-module-image img, img._image, .se-component img, #postViewArea img').forEach(img => {
        const url = img.getAttribute('data-lazy-src') || img.currentSrc || img.src;
        if (url) push(url, '네이버 본문', { element: img, confidence: '최상' });
      });
    }
    if (kind === 'instagram' || kind === 'facebook') {
      $$('article img, article video, [role="dialog"] img, [role="dialog"] video').forEach(node => {
        const url = node.currentSrc || node.src;
        if (url) push(url, '게시물 미디어', { element: node, hint: node.tagName === 'VIDEO' ? 'video' : 'image', confidence: '최상' });
      });
    }
    if (kind === 'design' || kind === 'stock') {
      $$('img[srcset], source[srcset]').forEach(node => {
        const last = largestSrcset(node.srcset || node.getAttribute('srcset') || '');
        if (last) push(last, 'srcset 최대', { confidence: '최상' });
      });
    }
    return out;
  }

  function collectCatalogMedia() {
    const profile = siteProfile();
    if (!profile.extra) return [];
    const out = [];
    const push = (url, source, extra = {}) => {
      const value = abs(url);
      if (!value || SL.isUiJunk(value) || !SL.isImageUrl(value)) return;
      out.push(candidate(value, source, 'image', extra));
      if (profile.upgrade) {
        const upgraded = SL.upgradeMediaUrl(value);
        if (upgraded && upgraded !== value) out.push(candidate(upgraded, `${source} 원본`, 'image', { ...extra, confidence: '높음' }));
      }
    };
    document.querySelector('meta[property="og:image"]')?.content && push(document.querySelector('meta[property="og:image"]').content, 'og:image', { confidence: '높음' });
    document.querySelector('meta[name="twitter:image"]')?.content && push(document.querySelector('meta[name="twitter:image"]').content, 'twitter:image', { confidence: '높음' });
    deepAll('img, source').forEach(node => {
      if (node.tagName === 'SOURCE' && node.parentElement?.tagName === 'VIDEO') return;
      ['src', 'currentSrc', 'data-src', 'data-original', 'data-origin', 'data-zoom', 'data-zoom-image', 'data-lazy-src', 'data-url', 'data-image', 'data-img', 'data-orig-file', 'org_src'].forEach(attr => {
        const v = node[attr] || node.getAttribute?.(attr);
        if (!v) return;
        // Only trust the element's pixel size when this attribute is what is actually displayed
        // (a lazy data-src next to a 1×1 placeholder must not be reported as 1×1).
        const shown = node.tagName === 'IMG' && abs(v) === abs(node.currentSrc || node.src || '');
        push(v, attr, {
          element: shown ? node : null,
          confidence: '중간', width: shown ? node.naturalWidth || 0 : 0, height: shown ? node.naturalHeight || 0 : 0
        });
      });
      ['srcset', 'data-srcset'].forEach(attr => {
        const srcset = (attr === 'srcset' ? node.srcset : '') || node.getAttribute?.(attr) || '';
        const best = largestSrcset(srcset);
        const w = srcsetWidth(srcset, best);
        const h = w && node.naturalWidth ? Math.round(w * node.naturalHeight / node.naturalWidth) : 0;
        if (best) push(best, attr === 'srcset' ? 'srcset 최대' : 'data-srcset 최대', { confidence: '높음', width: w, height: h });
      });
    });
    $$('[style*="background"]').slice(0, 80).forEach(node => {
      const bg = getComputedStyle(node).backgroundImage || '';
      const re = /url\(["']?(https?:[^"')]+)["']?\)/g;
      let match;
      while ((match = re.exec(bg))) push(match[1], '배경 이미지', { confidence: '중간' });
    });
    return out.slice(0, 120);
  }

  function collectCommerce() {
    const out = [];
    const push = (url, source, extra = {}) => {
      const value = abs(url);
      if (!value || SL.isUiJunk(value) || !SL.isImageUrl(value)) return;
      out.push(candidate(value, source, 'image', extra));
      const upgraded = upgradeCommerceUrl(value);
      if (upgraded && upgraded !== value) out.push(candidate(upgraded, `${source} 원본`, 'image', { ...extra, confidence: '높음' }));
    };
    document.querySelector('meta[property="og:image"]')?.content && push(document.querySelector('meta[property="og:image"]').content, 'og:image', { confidence: '높음' });
    document.querySelector('meta[name="twitter:image"]')?.content && push(document.querySelector('meta[name="twitter:image"]').content, 'twitter:image', { confidence: '높음' });
    $$('img, source').forEach(node => {
      ['src', 'currentSrc', 'data-src', 'data-original', 'data-origin', 'data-zoom', 'data-zoom-image', 'data-lazy-src', 'data-url', 'data-image', 'data-img'].forEach(attr => {
        const v = node[attr] || node.getAttribute?.(attr);
        if (v) push(v, `상품 ${attr}`, { element: node.tagName === 'IMG' ? node : null, confidence: '중간' });
      });
      const srcset = node.srcset || node.getAttribute?.('srcset') || '';
      const best = largestSrcset(srcset);
      if (best) push(best, '상품 srcset', { confidence: '높음' });
    });
    $$('[style*="background"]').slice(0, 50).forEach(node => {
      const bg = getComputedStyle(node).backgroundImage || '';
      const re = /url\(["']?(https?:[^"')]+)["']?\)/g;
      let match;
      while ((match = re.exec(bg))) push(match[1], '배경 이미지', { confidence: '중간' });
    });
    $$('script').forEach(script => {
      const text = script.textContent || '';
      if (text.length > 250000 || !/\.(?:jpe?g|png|webp)/i.test(text)) return;
      const re = /https?:\/\/[^"'\\\s>]+\.(?:jpe?g|png|webp)[^"'\\\s>]*/gi;
      let match, n = 0;
      while ((match = re.exec(text)) && n < 30) {
        push(match[0].replace(/\\u0026/g, '&').replace(/\\\//g, '/'), '상품 JSON', { confidence: '중간' });
        n += 1;
      }
    });
    return out.filter(Boolean);
  }

  function requestFrameMedia() {
    const ping = { sourceLens: true, type: 'requestMedia' };
    $$('iframe').forEach(frame => {
      try { frame.contentWindow?.postMessage(ping, '*'); } catch { /* ignore */ }
    });
    for (let i = 0; i < window.frames.length; i++) {
      try { window.frames[i].postMessage(ping, '*'); } catch { /* ignore */ }
    }
  }

  function mergePageMedia() {
    const incoming = collectPageMedia();
    const have = new Set(state.candidates.map(itemKey));
    let added = 0;
    incoming.forEach(item => {
      if (!item?.url) return;
      const key = itemKey(item);
      if (have.has(key)) return;
      have.add(key);
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
      if (state._loadSoon) return;
      state._loadSoon = setTimeout(() => {
        state._loadSoon = 0;
        if (state.panel && mergePageMedia()) state.redraw?.();
      }, 400);
    };
    document.addEventListener('load', state.onMediaLoad, true);
    state.observer = new MutationObserver(() => {
      if (!state.panel || state._scanSoon) return;
      state._scanSoon = setTimeout(() => {
        state._scanSoon = 0;
        if (state.panel && mergePageMedia()) state.redraw?.();
      }, 700);
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
    // Lazy-loading pages swap image URLs while scrolling; rescan only after the user scrolled
    // (DOM insertions are already handled by the MutationObserver above).
    state.scrolled = false;
    if (!state.onScroll) {
      state.onScroll = () => { state.scrolled = true; };
      window.addEventListener('scroll', state.onScroll, { capture: true, passive: true });
    }
    state.scanTimer = setInterval(() => {
      if (!state.panel || document.hidden || !state.scrolled) return;
      state.scrolled = false;
      if (mergePageMedia()) state.redraw?.();
    }, 2000);
  }

  function mediaNode(item, className) {
    if (item.type === 'svg' || /\.svg(?:$|[?#])/i.test(item.url || '') || /^data:image\/svg/i.test(item.url || '')) {
      const holder = document.createElement('div');
      holder.className = `sl-svg-media ${className || ''}`;
      const code = item.code || svgSource(item);
      if (code) holder.innerHTML = previewSvg(code);
      else if (item.url) {
        const img = document.createElement('img');
        img.alt = item.name || 'svg';
        img.src = item.url;
        holder.append(img);
      }
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
    node.referrerPolicy = 'no-referrer-when-downgrade';
    const live = item.element?.tagName === 'IMG' && item.element.currentSrc;
    node.src = live || item.url;
    node.onerror = () => {
      if (live && node.src !== item.url) node.src = item.url;
    };
    if (isTallItem(item) && /sl-preview|sl-lightbox-media/.test(className || '')) {
      const wrap = document.createElement('div');
      wrap.className = 'sl-tall-wrap';
      wrap.append(node);
      return wrap;
    }
    return node;
  }

  function actionButton(kind, label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = kind === 'primary' ? 'sl-btn sl-btn-brand' : 'sl-btn';
    btn.textContent = label;
    btn.onclick = onClick;
    return btn;
  }

  function liveUrl(item) {
    if (!item) return '';
    if (item.temporary) return state.postUrl || item.url || '';
    // Rewritten (guessed "original") URLs can 404 on some CDNs, so fall back to what the page really loaded.
    const src = item.element?.currentSrc;
    if (item.rewritten && src && /^https?:/i.test(src)) return src;
    return item.url || src || '';
  }

  function fillItemActions(actions, item, extra = {}) {
    actions.append(actionButton('primary', 'URL 복사', ev => copy(liveUrl(item), ev.currentTarget)));
    actions.append(actionButton('primary', '저장', () => saveItem(item)));
    if (extra.onUrl) actions.append(actionButton('normal', extra.urlLabel || 'URL 보기', extra.onUrl));
    actions.append(actionButton('normal', '새 탭', () => window.open(liveUrl(item), '_blank', 'noopener')));
    if (item.type === 'svg') {
      actions.append(actionButton('primary', '코드 복사', ev => copySvg(item, ev.currentTarget)));
      if (extra.onCodeView) actions.append(actionButton('normal', '코드 보기', extra.onCodeView));
    }
    if (item.type === 'image' || item.type === 'svg') {
      [['JPG', 'jpg', 'image/jpeg'], ['PNG', 'png', 'image/png'], ['WebP', 'webp', 'image/webp']].forEach(([label, ext, mime]) => {
        actions.append(actionButton('normal', `${label} 저장`, ev => convertImage(item, { label, ext, mime }, ev.currentTarget)));
      });
      actions.append(actionButton('normal', '분할 편집', () => { extra.onSlice?.(); openSliceEditor(item); }));
    }
    if (item.type === 'video' && !videoLocked()) {
      actions.append(actionButton('primary', state.recorder ? '지금 저장' : '원클릭 저장', ev => oneClickSaveVideo(item, ev.currentTarget)));
      actions.append(actionButton('normal', 'yt-dlp 복사', ev => copy(ytdlpCommand(), ev.currentTarget)));
    }
  }

  function pageVideos() {
    return $$('video').filter(v => !v.closest('#sl-host') && Math.max(v.videoWidth || 0, v.offsetWidth || 0) >= 80);
  }

  function pickCaptureVideo(item) {
    if (item?.element?.tagName === 'VIDEO') return item.element;
    return pageVideos().find(v => !v.paused && v.readyState >= 2)
      || pageVideos().sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0]
      || null;
  }

  function ytdlpCommand() {
    const url = state.postUrl || location.href;
    return `yt-dlp --cookies-from-browser chrome -f "bv*+ba/b" --no-mtime "${url}"`;
  }

  function fmtClock(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function captureHud(text) {
    let hud = uiRoot().querySelector('.sl-capture-hud');
    if (!text) { hud?.remove(); return; }
    if (!hud) {
      hud = document.createElement('div');
      hud.className = 'sl-capture-hud';
      hud.onclick = () => { try { state.recorder?.stop(); } catch { /* ignore */ } };
      uiRoot().append(hud);
    }
    hud.textContent = text;
  }

  function directVideoItem() {
    const pool = [...(state.candidates || []), ...(state.platformMedia || []), ...collectPageMedia()];
    return pool.find(i => i?.type === 'video' && /^https?:/i.test(i.url) && !i.temporary && !SL.isManifest(i.url) && !SL.isImageUrl(i.url));
  }

  async function oneClickSaveVideo(item, button) {
    const setLabel = text => { if (button) button.textContent = text; };
    if (item && (item.type === 'image' || item.type === 'svg' || SL.isImageUrl(item.url) || SL.PHOTO_EXT.test(item.url || ''))) {
      saveItem(item);
      setLabel('이미지 저장');
      captureHud('이미지로 저장했습니다');
      setTimeout(() => { captureHud(''); setLabel('저장'); }, 1600);
      return { ok: true, mode: 'image' };
    }
    if (state.recorder) {
      try { state.recorder.stop(); } catch { /* ignore */ }
      setLabel('저장 중…');
      return { ok: true, mode: 'stop' };
    }
    document.documentElement.dispatchEvent(new CustomEvent('sl-extract-now'));
    await new Promise(r => setTimeout(r, 400));
    const file = (item?.type === 'video' && /^https?:/i.test(item.url) && !item.temporary && !SL.isManifest(item.url) && !SL.isImageUrl(item.url))
      ? item
      : directVideoItem();
    if (file) {
      saveItem(file);
      setLabel('파일 저장 시작');
      captureHud('원본 주소로 저장했습니다');
      setTimeout(() => { captureHud(''); setLabel('원클릭 저장'); }, 1800);
      return { ok: true, mode: 'file' };
    }
    const blocked = ['instagram', 'facebook', 'tiktok'].includes(siteKind());
    if (blocked) {
      setLabel('녹화 불가');
      captureHud('이 사이트는 브라우저 녹화가 막혀 있습니다. 이미지는 「저장」을 누르세요.');
      setTimeout(() => captureHud(''), 2800);
      return { ok: false, error: '인스타/페북/틱톡은 원본 주소가 있을 때만 저장됩니다. 사진이면 저장 버튼을 쓰세요.' };
    }
    const video = item?.element?.tagName === 'VIDEO' ? item.element : pickCaptureVideo(item);
    if (!video || !video.videoWidth) {
      setLabel('영상 없음');
      captureHud('재생할 영상을 먼저 열어 주세요');
      setTimeout(() => { captureHud(''); setLabel('원클릭 저장'); }, 2000);
      return { ok: false, error: '페이지에 영상이 없습니다. 영상을 연 다음 다시 눌러 주세요.' };
    }
    const src = video.currentSrc || video.src || '';
    if (/^blob:/i.test(src)) {
      try {
        const blob = await fetch(src).then(r => r.blob());
        if (blob && blob.size > 80_000) {
          downloadBlob(blob, `video-${Date.now()}.webm`);
          setLabel('저장됨');
          return { ok: true, mode: 'blob' };
        }
      } catch { /* MSE — record */ }
    }
    const stream = video.captureStream?.() || video.mozCaptureStream?.();
    if (!stream || !stream.getVideoTracks().length) {
      setLabel('녹화 불가');
      return { ok: false, error: '이 플레이어는 브라우저 녹화가 막혀 있습니다.' };
    }
    const live = !Number.isFinite(video.duration) || video.duration > 4 * 3600;
    if (!live && video.currentTime > 1) {
      try { video.currentTime = 0; } catch { /* ignore */ }
    }
    try { await video.play(); } catch { /* ignore */ }
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(type => MediaRecorder.isTypeSupported(type)) || '';
    const chunks = [];
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
    const onEnded = () => { try { rec.stop(); } catch { /* ignore */ } };
    rec.ondataavailable = ev => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    rec.onstop = () => {
      video.removeEventListener('ended', onEnded);
      clearInterval(state.captureTimer);
      state.recorder = null;
      const blob = new Blob(chunks, { type: rec.mimeType || 'video/webm' });
      const tooSmall = blob.size < 80_000;
      captureHud(tooSmall ? '녹화 파일이 비어 있습니다. 이 사이트는 녹화가 막혀 있습니다.' : '저장했습니다');
      setLabel('원클릭 저장');
      setTimeout(() => captureHud(''), 2800);
      if (tooSmall) return;
      downloadBlob(blob, `capture-${Date.now()}.webm`);
    };
    video.addEventListener('ended', onEnded);
    rec.start(500);
    state.recorder = rec;
    state.captureTimer = setInterval(() => {
      const d = video.duration;
      const t = video.currentTime;
      const pct = Number.isFinite(d) && d > 0 ? Math.round((t / d) * 100) : 0;
      captureHud(live ? `녹화 중 ${fmtClock(t)} · 클릭하면 저장` : `자동 저장 ${fmtClock(t)} / ${fmtClock(d)} (${pct}%)`);
      setLabel(live ? '지금 저장' : `${pct}%`);
    }, 400);
    return { ok: true, mode: live ? 'live' : 'record' };
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

  function downloadBlob(blob, name, done) {
    blob.arrayBuffer().then(buffer => {
      chrome.runtime.sendMessage({
        type: 'downloadBase64',
        base64: bytesToBase64(buffer),
        mime: blob.type || 'application/octet-stream',
        filename: `source-lens/${name}`
      }, result => {
        const err = chrome.runtime.lastError?.message;
        done?.(!err && result?.ok !== false, err || result?.error);
      });
    }).catch(() => {
      done?.(true);
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

  function downloadName(item) {
    return SL.downloadName(item, location.hostname);
  }

  function toast(text, kind) {
    const root = uiRoot();
    let el = root.querySelector('.sl-toast');
    if (!el) {
      el = document.createElement('div');
      el.setAttribute('role', 'status');
      root.append(el);
    }
    el.className = `sl-toast${kind === 'error' ? ' is-error' : ''}`;
    el.textContent = text;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.remove(), kind === 'error' ? 4200 : 2200);
  }

  function rememberCapture(items) {
    const rec = {
      page: location.href,
      title: (document.title || '').slice(0, 80),
      host: location.hostname.replace(/^www\./, ''),
      ts: Date.now(),
      items: (items || []).slice(0, 12).map(item => ({
        url: item.url, type: item.type, name: item.name || fileName(item.url)
      }))
    };
    try {
      chrome.storage.local.get('slHistory', data => {
        const list = [rec, ...(data.slHistory || []).filter(row => row.page !== rec.page)].slice(0, 20);
        chrome.storage.local.set({ slHistory: list });
      });
    } catch { /* ignore */ }
  }

  function zipItems(items, button) {
    const payload = items.slice(0, 40).map((item, i) => ({
      url: item.url,
      code: item.type === 'svg' ? (item.code || '') : '',
      name: `${String(i + 1).padStart(2, '0')}-${downloadName(item)}`
    }));
    if (button) { button.disabled = true; button.textContent = 'ZIP 만드는 중…'; }
    chrome.runtime.sendMessage({
      type: 'zipDownload',
      items: payload,
      filename: `source-lens/${location.hostname.replace(/^www\./, '')}-media.zip`
    }, result => {
      if (result?.ok) {
        if (button) {
          button.disabled = false;
          button.textContent = `ZIP ${result.count || payload.length}개`;
          setTimeout(() => { button.textContent = 'ZIP 저장'; }, 1800);
        }
        return;
      }
      if (button) button.textContent = 'ZIP 불가 · 개별 저장';
      payload.forEach((item, i) => {
        const src = items[i];
        if (src) setTimeout(() => saveItem(src), i * 320);
      });
      if (button) setTimeout(() => { button.disabled = false; button.textContent = 'ZIP 저장'; }, 2400);
    });
  }

  function saveItem(item, done) {
    const name = downloadName(item);
    const finish = (ok, err) => {
      if (done) return done(ok, err);
      if (ok) toast(`저장을 시작했습니다 · ${name}`);
      else toast(err || '저장하지 못했습니다. 「새 탭」으로 연 뒤 직접 저장해 보세요.', 'error');
    };
    if (item.type === 'svg' && (item.code || svgSource(item))) {
      downloadBlob(new Blob([item.code || svgSource(item)], { type: 'image/svg+xml' }), name, finish);
      return;
    }
    if (item.type === 'video' && (item.temporary || /^blob:/i.test(item.url || ''))) {
      oneClickSaveVideo(item).then(r => finish(!!r?.ok, r?.error));
      return;
    }
    const url = liveUrl(item);
    const locked = u => SL.SIGNED.test(u || '') || /cdninstagram|fbcdn\.net|scontent/i.test(u || '');
    if (/^https?:/i.test(url) && !item.temporary) {
      chrome.runtime.sendMessage({ type: 'downloadUrl', url, filename: `source-lens/${name}` }, result => {
        void chrome.runtime.lastError;
        if (result?.ok) return finish(true);
        if (locked(url)) return finish(false, '서명·만료가 걸린 주소라 저장되지 않았습니다. 페이지를 새로고침한 뒤 다시 시도해 보세요.');
        fetchBytes(url).then(blob => downloadBlob(blob, name, finish)).catch(e => finish(false, `저장 실패: ${e.message || e}`));
      });
      return;
    }
    if (locked(url)) return finish(false, '서명·만료가 걸린 주소라 저장되지 않았습니다.');
    fetchBytes(item.url).then(blob => downloadBlob(blob, name, finish)).catch(() => {
      if (state.postUrl) window.open(state.postUrl, '_blank', 'noopener');
      finish(false, '이 항목은 바로 저장할 수 없습니다.');
    });
  }

  function copy(value, button) {
    const done = () => {
      if (!button) { toast(String(value).includes('\n') ? `${String(value).split('\n').length}개 URL을 복사했습니다` : '복사했습니다'); return; }
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

  const metaCache = new Map();
  const metaQueue = [];
  let metaActive = 0;
  let metaObserver = null;

  function pumpMeta() {
    while (metaActive < 4 && metaQueue.length) {
      const job = metaQueue.shift();
      metaActive += 1;
      const finish = result => { metaActive -= 1; job.resolve(result || {}); pumpMeta(); };
      try {
        chrome.runtime.sendMessage({ type: 'resourceMeta', url: job.url }, result => {
          void chrome.runtime.lastError;
          finish(result);
        });
      } catch { finish({}); }
    }
  }

  function fetchMeta(url) {
    if (metaCache.has(url)) return metaCache.get(url);
    const pending = new Promise(resolve => { metaQueue.push({ url, resolve }); pumpMeta(); });
    metaCache.set(url, pending);
    if (metaCache.size > 600) metaCache.delete(metaCache.keys().next().value);
    return pending;
  }

  function hydrateMeta(item, node) {
    const apply = () => {
      const meta = node?.querySelector?.('.sl-meta');
      if (meta) {
        const dim = item.width && item.height ? `${item.width}×${item.height}` : '';
        const size = item.size ? bytes(item.size) : '';
        meta.textContent = [dim, item.mime || item.type, size, item.state].filter(Boolean).join(' · ');
      }
      const badge = node?.querySelector?.('.sl-dim');
      if (badge) {
        const px = item.width && item.height ? `${item.width}×${item.height}` : item.width ? `폭 ${item.width}px` : '';
        badge.textContent = [px, item.size ? bytes(item.size) : ''].filter(Boolean).join(' · ');
        badge.hidden = !badge.textContent;
      }
    };
    apply();
    if (!/^https?:/i.test(item.url || '') || (item.size && item.mime)) return;
    const run = () => fetchMeta(item.url).then(result => {
      if (result?.size) item.size = result.size;
      if (result?.mime) {
        item.mime = result.mime.split(';')[0];
        if (/^image\//i.test(item.mime) && !/^image\/svg/i.test(item.mime)) item.type = 'image';
        if (/^video\//i.test(item.mime)) item.type = 'video';
      }
      apply();
    });
    if (!node || typeof IntersectionObserver !== 'function') { run(); return; }
    if (!metaObserver) {
      metaObserver = new IntersectionObserver(entries => entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        metaObserver.unobserve(entry.target);
        entry.target.__slMeta?.();
        entry.target.__slMeta = null;
      }), { rootMargin: '200px' });
    }
    node.__slMeta = run;
    metaObserver.observe(node);
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
    close.onclick = () => { layer.remove(); state.lightboxItem = null; };
    close.title = '닫기 (Esc)';
    state.lightboxItem = item;
    const prev = document.createElement('button');
    prev.className = 'sl-lightbox-nav sl-lightbox-prev';
    prev.textContent = '‹';
    const next = document.createElement('button');
    next.className = 'sl-lightbox-nav sl-lightbox-next';
    next.textContent = '›';
    prev.title = '이전 (←)';
    next.title = '다음 (→)';
    if (items.length < 2) { prev.hidden = true; next.hidden = true; }
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
    page.textContent = `${index + 1} / ${items.length} · ← → 로 넘기기`;
    const actions = document.createElement('div');
    actions.className = 'sl-lightbox-actions';
    fillItemActions(actions, item, { onSlice: () => layer.remove() });
    card.append(title, page, actions);
    layer.append(card);
    layer.onclick = ev => { if (ev.target === layer) { layer.remove(); state.lightboxItem = null; } };
    uiRoot().querySelectorAll('.sl-lightbox').forEach(n => n.remove());
    uiRoot().activeElement?.blur?.();
    uiRoot().append(layer);
    layer.tabIndex = -1;
    try { layer.focus({ preventScroll: true }); } catch { /* ignore */ }
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
        <header class="sl-slice-header"><div><h3>이미지 분할 편집</h3><small>가로선은 지금 보는 화면 가운데에 추가됩니다. 선을 드래그하거나 ×로 삭제하세요.</small></div>
        <div class="sl-slice-tools">
          <button class="sl-btn sl-slice-add" type="button">+ 가로선</button>
          <button class="sl-btn sl-slice-del" type="button">선 삭제</button>
          <button class="sl-btn sl-slice-clear" type="button">모두 지우기</button>
          <button class="sl-btn sl-zoom-out" type="button">−</button>
          <span class="sl-zoom-label">100%</span>
          <button class="sl-btn sl-zoom-in" type="button">+</button>
          <button class="sl-btn sl-zoom-fit" type="button">맞춤</button>
          <select class="sl-slice-format"><option value="jpg">JPG</option><option value="png">PNG</option><option value="webp">WebP</option></select>
          <button class="sl-btn sl-slice-export" type="button">분할 저장</button>
        </div></header>
        <div class="sl-slice-viewport"><div class="sl-slice-stage"><img class="sl-slice-image" alt=""><div class="sl-slice-lines"></div></div></div>
        <footer class="sl-slice-footer"><span class="sl-slice-count"></span><span>${image.naturalWidth}×${image.naturalHeight}px</span></footer></div>`;
      const viewport = layer.querySelector('.sl-slice-viewport');
      const preview = layer.querySelector('.sl-slice-image');
      const linesEl = layer.querySelector('.sl-slice-lines');
      const countEl = layer.querySelector('.sl-slice-count');
      const zoomLabel = layer.querySelector('.sl-zoom-label');
      const positions = [];
      let selected = -1;
      let zoom = 1;
      preview.src = sourceUrl;
      const applyZoom = () => {
        preview.style.maxWidth = 'none';
        preview.style.width = `${Math.round(zoom * 100)}%`;
        zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      };
      applyZoom();
      const close = () => { URL.revokeObjectURL(sourceUrl); layer.remove(); };
      layer.querySelector('.sl-slice-close').onclick = close;
      layer.onclick = ev => { if (ev.target === layer) close(); };
      const renderLines = () => {
        linesEl.textContent = '';
        positions.sort((a, b) => a - b);
        if (selected >= positions.length) selected = positions.length - 1;
        positions.forEach((position, lineIndex) => {
          const line = document.createElement('div');
          line.className = `sl-slice-line${selected === lineIndex ? ' is-selected' : ''}`;
          line.style.top = `${position * 100}%`;
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'sl-slice-line-x';
          del.textContent = '×';
          del.title = '이 선 삭제';
          del.onclick = ev => {
            ev.stopPropagation();
            positions.splice(lineIndex, 1);
            selected = -1;
            renderLines();
          };
          let dragging = false;
          const move = ev => {
            if (!dragging) return;
            const rect = preview.getBoundingClientRect();
            positions[lineIndex] = Math.max(0.01, Math.min(0.99, (ev.clientY - rect.top) / rect.height));
            line.style.top = `${positions[lineIndex] * 100}%`;
          };
          line.onpointerdown = ev => {
            if (ev.target === del) return;
            selected = lineIndex;
            dragging = true;
            line.classList.add('is-selected');
            line.setPointerCapture?.(ev.pointerId);
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', () => {
              dragging = false;
              window.removeEventListener('pointermove', move);
              renderLines();
            }, { once: true });
          };
          line.append(del);
          linesEl.append(line);
        });
        countEl.textContent = positions.length ? `${positions.length + 1}개 이미지로 분할` : '가로선을 추가하세요';
      };
      layer.querySelector('.sl-slice-add').onclick = () => {
        const view = viewport.getBoundingClientRect();
        const stage = preview.getBoundingClientRect();
        const visibleTop = Math.max(view.top, stage.top);
        const visibleBottom = Math.min(view.bottom, stage.bottom);
        const y = (visibleTop + visibleBottom) / 2;
        const pos = (y - stage.top) / Math.max(1, stage.height);
        if (positions.length < 40) {
          positions.push(Math.max(0.01, Math.min(0.99, pos)));
          selected = positions.length - 1;
        }
        renderLines();
      };
      layer.querySelector('.sl-slice-del').onclick = () => {
        if (selected < 0 && positions.length) selected = positions.length - 1;
        if (selected < 0) return;
        positions.splice(selected, 1);
        selected = Math.min(selected, positions.length - 1);
        renderLines();
      };
      layer.querySelector('.sl-slice-clear').onclick = () => {
        positions.splice(0, positions.length);
        selected = -1;
        renderLines();
      };
      const setZoom = next => {
        zoom = Math.min(4, Math.max(0.25, Math.round(next * 20) / 20));
        applyZoom();
      };
      layer.querySelector('.sl-zoom-in').onclick = () => setZoom(zoom + 0.25);
      layer.querySelector('.sl-zoom-out').onclick = () => setZoom(zoom - 0.25);
      layer.querySelector('.sl-zoom-fit').onclick = () => setZoom(1);
      viewport.addEventListener('wheel', ev => {
        if (!ev.ctrlKey && !ev.metaKey) return;
        ev.preventDefault();
        setZoom(zoom + (ev.deltaY > 0 ? -0.1 : 0.1));
      }, { passive: false });
      layer.addEventListener('keydown', ev => {
        if (ev.key === 'Delete' || ev.key === 'Backspace') {
          ev.preventDefault();
          layer.querySelector('.sl-slice-del').click();
        }
      });
      layer.tabIndex = 0;
      layer.focus();
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

  function visibleList() {
    const tab = state.activeTab;
    if (tab === 'selected') {
      const picked = state.picked || state.candidates[0];
      return picked ? [picked] : [];
    }
    if (tab === 'video' && videoLocked()) return [];
    let list = state.candidates.filter(item => item.type === tab);
    if (tab === 'image' && state.minPx) list = list.filter(item => itemPixel(item) >= state.minPx);
    const q = state.query.trim().toLowerCase();
    if (q) {
      const words = q.split(/\s+/);
      list = list.filter(item => {
        const hay = `${labelOf(item)} ${/^data:/i.test(item.url || '') ? '' : item.url} ${item.source || ''}`.toLowerCase();
        return words.every(word => hay.includes(word));
      });
    }
    if (state.sort === 'big' && tab !== 'svg') {
      list = list.map((item, i) => ({ item, i, px: itemPixel(item) }))
        .sort((a, b) => (b.px - a.px) || (a.i - b.i))
        .map(row => row.item);
    }
    return list;
  }

  function bulkTargets(list) {
    const chosen = list.filter(item => state.selectedKeys.has(itemKey(item)));
    return chosen.length ? chosen : list;
  }

  function render() {
    closePanel();
    const shadow = uiRoot();
    const root = document.createElement('div');
    root.id = 'sl-root';
    const panel = document.createElement('section');
    panel.id = 'sl-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Source Lens');
    if (state.dock === 'left') panel.classList.add('is-left');
    root.append(panel);
    state.panel = root;
    shadow.append(root);
    const brand = (typeof sourceLensProfileFor === 'function' ? sourceLensProfileFor(location.hostname) : null)?.brand
      || { name: siteKind(), color: '#229968' };
    panel.innerHTML = `
      <header class="sl-topbar">
        <h2>Source Lens <small class="sl-ver">${esc(VERSION)}</small></h2>
        <span class="sl-platform" style="border-color:${esc(brand.color)};color:${esc(brand.color)}">${esc(brand.name)}</span>
        <span class="sl-spacer"></span>
        <button class="sl-icon-btn sl-dock" type="button" title="패널을 반대쪽으로 옮기기">⇆</button>
        <button class="sl-icon-btn sl-close" type="button" title="닫기 (Esc)" aria-label="닫기">×</button>
      </header>
      <nav class="sl-tabs" role="tablist">
        <button data-tab="selected" title="단축키 1">선택</button>
        <button data-tab="image" title="단축키 2">이미지 <b>0</b></button>
        <button data-tab="video" title="단축키 3">영상 <b>0</b></button>
        <button data-tab="svg" title="단축키 4">SVG <b>0</b></button>
      </nav>
      <div class="sl-tools"></div>
      <main class="sl-main"></main>
      <footer class="sl-foot">Alt(⌥)+클릭: 다른 요소 분석 · <kbd>1</kbd>–<kbd>4</kbd> 탭 · <kbd>/</kbd> 검색 · <kbd>S</kbd> 저장 · <kbd>C</kbd> 복사 · <kbd>Esc</kbd> 닫기</footer>`;
    $('.sl-close', panel).onclick = closePanel;
    $('.sl-dock', panel).onclick = () => {
      state.dock = state.dock === 'left' ? 'right' : 'left';
      panel.classList.toggle('is-left', state.dock === 'left');
      savePrefs({ dock: state.dock });
    };
    const tools = $('.sl-tools', panel);
    const main = $('.sl-main', panel);
    let rendered = new Set();
    let grid = null;

    const updateCounts = () => {
      panel.querySelector('[data-tab="image"] b').textContent = state.candidates.filter(i => i.type === 'image').length;
      const videoBtn = panel.querySelector('[data-tab="video"]');
      if (videoLocked()) videoBtn.innerHTML = '영상 <b>불가</b>';
      else videoBtn.innerHTML = `영상 <b>${state.candidates.filter(i => i.type === 'video').length}</b>`;
      panel.querySelector('[data-tab="svg"] b').textContent = state.candidates.filter(i => i.type === 'svg').length;
    };

    const updateBulk = () => {
      const list = visibleList();
      const chosen = list.filter(item => state.selectedKeys.has(itemKey(item))).length;
      const set = (sel, text) => { const el = tools.querySelector(sel); if (el && !el.disabled) el.textContent = text; };
      const n = chosen || list.length;
      set('.sl-act-save', `저장 (${n})`);
      set('.sl-act-zip', `ZIP (${Math.min(n, ZIP_MAX)})`);
      set('.sl-act-copy', `URL 복사 (${n})`);
      const all = tools.querySelector('.sl-select-all');
      if (all) {
        all.checked = list.length > 0 && chosen === list.length;
        all.indeterminate = chosen > 0 && chosen < list.length;
      }
      const note = tools.querySelector('.sl-select-note');
      if (note) note.textContent = chosen ? `${chosen}개 선택됨 — 아래 버튼은 선택한 것만 처리` : `${list.length}개 · 체크해서 고르면 선택한 것만 처리`;
      tools.querySelectorAll('.sl-bulk .sl-btn').forEach(btn => { if (!btn.dataset.busy) btn.disabled = !list.length; });
    };

    const makeTile = item => {
      const tile = document.createElement('article');
      tile.className = 'sl-tile';
      const key = itemKey(item);
      if (state.selectedKeys.has(key)) tile.classList.add('is-checked');
      const check = document.createElement('label');
      check.className = 'sl-check';
      check.title = '선택';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state.selectedKeys.has(key);
      box.onchange = () => {
        if (box.checked) state.selectedKeys.add(key); else state.selectedKeys.delete(key);
        tile.classList.toggle('is-checked', box.checked);
        updateBulk();
      };
      check.onclick = ev => ev.stopPropagation();
      check.append(box);
      tile.append(check);
      const preview = mediaNode(item, 'sl-tile-preview');
      if (preview) tile.append(preview);
      const dim = document.createElement('span');
      dim.className = 'sl-dim';
      dim.hidden = true;
      tile.append(dim);
      tile.insertAdjacentHTML('beforeend', `<strong title="${esc(labelOf(item))}">${esc(labelOf(item))}</strong><small>${esc(item.source)}</small><small class="sl-meta">${esc(item.state)}</small>`);
      const quick = document.createElement('div');
      quick.className = 'sl-quick';
      const qb = (label, title, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.title = title;
        b.onclick = ev => { ev.stopPropagation(); fn(ev.currentTarget); };
        quick.append(b);
      };
      qb('저장', '이 파일 저장', () => saveItem(item));
      qb('복사', 'URL 복사', btn => (item.type === 'svg' ? copySvg(item, btn) : copy(liveUrl(item), btn)));
      tile.append(quick);
      hydrateMeta(item, tile);
      tile.onclick = () => {
        const list = visibleList();
        const index = Math.max(0, list.indexOf(item));
        openLightbox(item, list, index);
      };
      rendered.add(key);
      return tile;
    };

    const emptyText = () => {
      if (state.activeTab === 'video') return videoEmptyMessage();
      if (state.query.trim()) return `「${state.query.trim()}」에 맞는 항목이 없습니다. 검색어를 지워 보세요.`;
      if (state.activeTab === 'svg') return '표시할 SVG가 없습니다. 아이콘을 직접 Alt(⌥)+클릭해 보세요.';
      if (state.activeTab === 'image' && state.minPx) return `${state.minPx}px 이상 이미지가 없습니다. 크기 필터를 「모든 크기」로 바꿔 보세요.`;
      if (state.activeTab === 'selected') return '분석한 요소가 없습니다. 이미지·영상을 Alt(⌥)+클릭하거나 「이미지」 탭을 보세요.';
      return '표시할 미디어가 없습니다. 페이지를 스크롤해 이미지를 불러온 뒤 다시 확인하세요.';
    };

    const renderGrid = () => {
      main.textContent = '';
      rendered = new Set();
      grid = null;
      const list = visibleList();
      if (!list.length) {
        const box = document.createElement('div');
        box.className = 'sl-empty';
        box.textContent = emptyText();
        main.append(box);
        updateBulk();
        return;
      }
      grid = document.createElement('div');
      grid.className = 'sl-grid';
      list.forEach(item => grid.append(makeTile(item)));
      main.append(grid);
      updateBulk();
    };

    const drawTools = () => {
      tools.textContent = '';
      if (state.activeTab === 'selected') { tools.hidden = true; return; }
      tools.hidden = false;
      const row = document.createElement('div');
      row.className = 'sl-filter-row';
      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'sl-search';
      search.placeholder = '검색: 파일명·주소 ( / )';
      search.value = state.query;
      search.oninput = () => { state.query = search.value; renderGrid(); };
      row.append(search);
      if (state.activeTab === 'image') {
        const size = document.createElement('select');
        size.className = 'sl-select';
        size.title = '작은 썸네일·아이콘 숨기기';
        [[0, '모든 크기'], [200, '200px 이상'], [400, '400px 이상'], [800, '800px 이상']].forEach(([v, label]) => {
          const o = document.createElement('option');
          o.value = String(v);
          o.textContent = label;
          size.append(o);
        });
        size.value = String(state.minPx || 0);
        size.onchange = () => { state.minPx = Number(size.value) || 0; savePrefs({ minPx: state.minPx }); renderGrid(); };
        row.append(size);
      }
      if (state.activeTab !== 'svg') {
        const sort = document.createElement('select');
        sort.className = 'sl-select';
        sort.title = '정렬';
        [['big', '큰 것부터'], ['page', '페이지 순서']].forEach(([v, label]) => {
          const o = document.createElement('option');
          o.value = v;
          o.textContent = label;
          sort.append(o);
        });
        sort.value = state.sort;
        sort.onchange = () => { state.sort = sort.value; savePrefs({ sort: state.sort }); renderGrid(); };
        row.append(sort);
      }
      tools.append(row);

      const pick = document.createElement('div');
      pick.className = 'sl-pick-row';
      pick.innerHTML = '<label><input type="checkbox" class="sl-select-all"> 전체 선택</label><span class="sl-select-note"></span>';
      pick.querySelector('.sl-select-all').onchange = ev => {
        const list = visibleList();
        if (ev.target.checked) list.forEach(item => state.selectedKeys.add(itemKey(item)));
        else list.forEach(item => state.selectedKeys.delete(itemKey(item)));
        renderGrid();
      };
      tools.append(pick);

      const bar = document.createElement('div');
      bar.className = 'sl-bulk';
      const mk = (cls, brandBtn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `sl-btn ${cls}${brandBtn ? ' sl-btn-brand' : ''}`;
        bar.append(b);
        return b;
      };
      const saveBtn = mk('sl-act-save', true);
      saveBtn.onclick = async () => {
        const targets = bulkTargets(visibleList()).slice(0, SAVE_MAX);
        if (!targets.length) return;
        saveBtn.disabled = true;
        saveBtn.dataset.busy = '1';
        let ok = 0, fail = 0;
        for (let i = 0; i < targets.length; i++) {
          saveBtn.textContent = `저장 ${i + 1}/${targets.length}`;
          await new Promise(resolve => saveItem(targets[i], good => { if (good) ok += 1; else fail += 1; resolve(); }));
          await new Promise(r => setTimeout(r, 250));
        }
        toast(fail ? `${ok}개 저장 시작 · ${fail}개 실패` : `${ok}개 저장을 시작했습니다`, fail && !ok ? 'error' : '');
        delete saveBtn.dataset.busy;
        saveBtn.disabled = false;
        updateBulk();
      };
      const zipBtn = mk('sl-act-zip', false);
      zipBtn.title = `한 파일로 묶어 저장 (최대 ${ZIP_MAX}개)`;
      zipBtn.onclick = () => {
        const targets = bulkTargets(visibleList());
        if (targets.length > ZIP_MAX) toast(`ZIP은 최대 ${ZIP_MAX}개까지 묶습니다. 앞쪽 ${ZIP_MAX}개만 담습니다.`);
        zipItems(targets, zipBtn);
      };
      const copyBtn = mk('sl-act-copy', false);
      copyBtn.onclick = () => {
        const urls = bulkTargets(visibleList()).map(item => liveUrl(item)).filter(u => u && !/^data:/i.test(u));
        if (!urls.length) { toast('복사할 URL이 없습니다 (SVG 코드는 「코드 복사」를 쓰세요)', 'error'); return; }
        copy(urls.join('\n'));
      };
      if (state.activeTab === 'svg') {
        const codeBtn = mk('sl-act-code', false);
        codeBtn.textContent = '코드 복사';
        codeBtn.onclick = () => {
          const codes = bulkTargets(visibleList()).map(item => svgSource(item)).filter(Boolean);
          if (!codes.length) { toast('복사할 SVG 코드가 없습니다', 'error'); return; }
          copy(codes.join('\n\n'));
        };
      }
      tools.append(bar);
    };

    const drawSelected = () => {
      main.textContent = '';
      const item = (state.picked || state.candidates[0]);
      if (!item) {
        const box = document.createElement('div');
        box.className = 'sl-empty';
        box.textContent = emptyText();
        main.append(box);
        return;
      }
      const preview = mediaNode(item, 'sl-preview');
      if (preview) main.append(preview);
      const card = document.createElement('article');
      card.className = 'sl-primary';
      card.innerHTML = `<div class="sl-kicker">대표 후보 · ${esc(item.source || '')}</div><strong>${esc(labelOf(item))}</strong>
        <div class="sl-file-meta sl-meta">${esc(item.state)} · ${esc(item.mime || item.type)}</div>
        <div class="sl-primary-actions"></div>`;
      if (isTallItem(item)) {
        const hint = document.createElement('p');
        hint.className = 'sl-hint';
        hint.textContent = '긴 상세 이미지입니다. 분할 편집으로 구간을 자를 수 있습니다.';
        card.querySelector('.sl-file-meta').after(hint);
      }
      if (state.candidates.length > 1) {
        const more = document.createElement('p');
        more.className = 'sl-hint sl-hint-muted';
        const n = state.candidates.filter(i => i.type === 'image').length;
        more.textContent = `이 페이지에서 이미지 ${n}개를 더 찾았습니다. 「이미지」 탭(단축키 2)에서 한꺼번에 저장할 수 있어요.`;
        card.append(more);
      }
      const actions = card.querySelector('.sl-primary-actions');
      fillItemActions(actions, item, {
        onUrl: ev => {
          const existing = card.querySelector('.sl-url-value');
          if (existing) {
            existing.remove();
            ev.currentTarget.textContent = 'URL 보기';
            return;
          }
          const code = document.createElement('code');
          code.className = 'sl-url-value';
          code.textContent = liveUrl(item);
          card.append(code);
          ev.currentTarget.textContent = 'URL 숨기기';
        },
        onCodeView: ev => {
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
        }
      });
      hydrateMeta(item, card);
      main.append(card);
    };

    const draw = () => {
      try {
        panel.querySelectorAll('.sl-tabs button').forEach(btn => {
          const on = btn.dataset.tab === state.activeTab;
          btn.classList.toggle('active', on);
          btn.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        updateCounts();
        drawTools();
        if (state.activeTab === 'selected') drawSelected();
        else renderGrid();
      } catch (error) {
        const box = document.createElement('div');
        box.className = 'sl-empty';
        box.textContent = `화면을 그리지 못했습니다. ${error.message || error}`;
        main.append(box);
      }
    };

    state.switchTab = tab => {
      if (state.activeTab !== tab) state.selectedKeys.clear();
      state.activeTab = tab;
      draw();
    };
    panel.querySelectorAll('.sl-tabs button').forEach(btn => {
      btn.onclick = () => state.switchTab(btn.dataset.tab);
    });
    state.focusSearch = () => {
      const input = tools.querySelector('.sl-search');
      if (input) { input.focus(); input.select(); }
    };
    // Called when new media shows up on the page: append new tiles instead of
    // rebuilding everything, so scroll position and selections stay put.
    state.redraw = () => {
      updateCounts();
      if (state.activeTab === 'selected') return;
      if (!grid) { renderGrid(); return; }
      visibleList().forEach(item => {
        if (!rendered.has(itemKey(item))) grid.append(makeTile(item));
      });
      updateBulk();
    };
    draw();
    startPageWatch();
  }

  function openPagePanel(preferTab) {
    try { document.documentElement.dispatchEvent(new CustomEvent('sl-extract-now')); } catch { /* ignore */ }
    state.selected = null;
    state.selectedMedia = null;
    state.postUrl = postUrl(document.body);
    state.candidates = dedupe([...collectPageMedia(), ...(state.platformMedia || [])])
      .filter(item => item && !(item.type === 'video' && SL.isImageUrl(item.url)));
    const images = state.candidates.filter(i => i.type === 'image');
    state.picked = images.slice().sort((a, b) => itemPixel(b) - itemPixel(a))[0] || state.candidates[0] || null;
    const count = type => state.candidates.filter(i => i.type === type).length;
    state.activeTab = preferTab || (count('image') ? 'image' : count('video') ? 'video' : count('svg') ? 'svg' : 'image');
    state.selectedKeys.clear();
    render();
    requestFrameMedia();
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
    if (!target) return;
    document.documentElement.dispatchEvent(new CustomEvent('sl-extract-now', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 80));

    const collected = collectTarget(target);
    state.selected = target;
    const tag = (collected.media?.tagName || target?.tagName || '').toUpperCase();
    const clickedVideo = tag === 'VIDEO';
    const clickedSvg = tag === 'SVG';
    state.selectedMedia = clickedVideo ? collected.media : null;
    state.postUrl = postUrl(target);
    const extras = [];
    if (clickedVideo || ['youtube', 'vimeo', 'instagram', 'facebook', 'tiktok', 'naver', 'kakao', 'daum', 'video'].includes(siteKind())) {
      extras.push(...collectRecentVideos(collected.media));
    }
    extras.push(...(state.platformMedia || []));
    if (isCommerce()) extras.push(...collectCommerce());
    extras.push(...collectSiteExtras());
    extras.push(...collectInlineSvg(target));
    if (siteKind() === 'youtube') extras.push(...collectYouTube(target));
    if (!clickedSvg) extras.push(...collectArticle(target));
    const seenVideo = new Set();
    let list = rank(dedupe([...seed, ...collected.candidates, ...extras]), collected.media)
      .filter(item => item && !(SL.isUiJunk(item.url) && item.type !== 'svg' && item.relation !== 'target'));
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
      list = list.filter(item => (item.type === 'image' && (SL.isImageUrl(item.url) || item.relation === 'target' || item.element?.tagName === 'IMG')) || item.type === 'svg');
    }
    state.picked = list.find(item => !isChromeImage(item.element, item.url)) || list[0] || null;

    state.candidates = dedupe([...list, ...collectPageMedia(), ...(state.platformMedia || [])]);
    rememberCapture(state.candidates);
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
    requestFrameMedia();
    if (clickedVideo && state.picked?.type === 'video' && state.autoVideo) oneClickSaveVideo(state.picked);
  }

  const fromOurUi = ev => ev.target === state.host || !!ev.target?.closest?.('#sl-host');

  window.addEventListener('mousedown', ev => {
    if (!state.altClick) return;
    if (ev.altKey && ev.button === 0 && !fromOurUi(ev)) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }
  }, true);

  function clickTarget(ev) {
    // Media inside open shadow DOM is invisible to elementsFromPoint; use the real event path.
    const deep = ev.composedPath?.()[0];
    if (deep && deep.nodeType === 1 && deep.getRootNode?.() !== document) {
      const media = deep.closest?.('img,video,svg,picture');
      if (media) return media;
    }
    return mediaAtPoint(ev.clientX, ev.clientY);
  }

  window.addEventListener('click', ev => {
    if (!state.altClick) return;
    if (!ev.altKey || ev.button !== 0 || fromOurUi(ev)) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    inspect(clickTarget(ev));
  }, true);

  window.addEventListener('mousemove', ev => {
    state.lastPoint = { x: ev.clientX, y: ev.clientY, t: Date.now() };
  }, { capture: true, passive: true });

  document.addEventListener('contextmenu', ev => {
    const deep = ev.composedPath?.()[0];
    const base = deep && deep.nodeType === 1 ? deep : ev.target;
    state.contextTarget = base?.closest?.('img,video,svg,a') || base;
  }, true);

  function hotkeyInspect() {
    if (state.panel) { closePanel(); return; }
    const p = state.lastPoint;
    if (p && Date.now() - p.t < 120000) {
      const target = mediaAtPoint(p.x, p.y);
      const isMedia = target?.matches?.('img,video,svg,picture') || target?.closest?.('img,video,svg,picture');
      if (target && (isMedia || collectTarget(target).candidates.length)) { inspect(target); return; }
    }
    openPagePanel();
  }

  window.addEventListener('message', ev => {
    if (!ev.data?.sourceLens) return;
    if (ev.data.type === 'requestMedia' && window !== window.top) {
      try {
        window.top.postMessage({
          sourceLens: true,
          type: 'pageMedia',
          data: collectPageMedia().map(({ element, ...item }) => item)
        }, '*');
      } catch { /* ignore */ }
      return;
    }
    if (window !== window.top) return;
    if (ev.data.type === 'pageMedia' && Array.isArray(ev.data.data)) {
      if (!state.panel) return;
      const have = new Set(state.candidates.map(itemKey));
      ev.data.data.forEach(item => {
        if (!item?.url || typeof item.url !== 'string') return;
        const key = itemKey(item);
        if (have.has(key)) return;
        have.add(key);
        state.candidates.push(item);
      });
      state.redraw?.();
      return;
    }
    if (ev.data.type !== 'open' || ev.origin !== location.origin) return;
    state.candidates = ev.data.data?.candidates || [];
    state.picked = ev.data.data?.picked || state.candidates[0] || null;
    state.postUrl = ev.data.data?.postUrl || '';
    state.activeTab = ev.data.data?.activeTab || 'selected';
    render();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'listImages' || message?.type === 'listPageMedia') {
      sendResponse(listPageMedia());
      return true;
    }
    if (message?.type === 'ping') {
      sendResponse({ ok: true, version: VERSION });
      return true;
    }
    if (message?.type === 'openPanel') {
      if (window !== window.top) return;
      openPagePanel(message.tab);
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === 'hotkeyInspect') {
      if (window !== window.top) return;
      hotkeyInspect();
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === 'oneClickVideo') {
      if (window !== window.top) return;
      oneClickSaveVideo(null, null).then(sendResponse);
      return true;
    }
    if (message?.type !== 'contextInspect') return;
    const target = state.contextTarget || mediaAtPoint(innerWidth / 2, innerHeight / 2);
    const seed = message.info?.srcUrl
      ? [candidate(message.info.srcUrl, '우클릭 URL', message.info.mediaType === 'video' ? 'video' : 'image', { confidence: '최상', allowJunk: true })]
      : [];
    inspect(target, seed);
  });

  window.addEventListener('keydown', ev => {
    const root = state.shadow;
    const slice = root?.querySelector('.sl-slice-editor');
    const box = root?.querySelector('.sl-lightbox');
    if (!state.panel && !slice && !box) return;
    const target = ev.composedPath?.()[0] || ev.target;
    const inOurUi = target?.getRootNode?.() === root;
    if (SL.isTypingTarget(target)) {
      if (inOurUi && ev.key === 'Escape') {
        if (target.value) { target.value = ''; target.dispatchEvent(new Event('input')); }
        else target.blur();
        ev.preventDefault();
        ev.stopPropagation();
      }
      return;
    }
    if (ev.key === 'Escape') {
      if (slice) slice.querySelector('.sl-slice-close')?.click();
      else if (box) { box.remove(); state.lightboxItem = null; }
      else closePanel();
      ev.stopPropagation();
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey || slice) return;
    if (box && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      box.querySelector(ev.key === 'ArrowLeft' ? '.sl-lightbox-prev' : '.sl-lightbox-next')?.click();
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (!state.panel) return;
    const tabs = { 1: 'selected', 2: 'image', 3: 'video', 4: 'svg' };
    if (!box && tabs[ev.key]) { state.switchTab?.(tabs[ev.key]); ev.stopPropagation(); return; }
    if (!box && ev.key === '/') { ev.preventDefault(); ev.stopPropagation(); state.focusSearch?.(); return; }
    const current = state.lightboxItem || state.picked;
    if ((ev.key === 's' || ev.key === 'S') && current) { saveItem(current); ev.stopPropagation(); }
    if ((ev.key === 'c' || ev.key === 'C') && current) {
      if (current.type === 'svg') copySvg(current); else copy(liveUrl(current));
      ev.stopPropagation();
    }
  }, true);
})();
