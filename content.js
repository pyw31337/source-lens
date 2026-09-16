(() => {
  if (window.__sourceLensLoaded) return;
  window.__sourceLensLoaded = true;

  const SL = globalThis.SourceLens;
  const state = {
    panel: null, selected: null, contextTarget: null, selectedMedia: null, picked: null,
    candidates: [], activeTab: 'selected', postUrl: '', capture: null, pageNet: [],
    profile: null, observer: null, scanTimer: 0, redraw: null, platformMedia: [],
    filterLarge: false, recorder: null, captureTimer: 0
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
    if (k === 'youtube') return '원클릭 저장: 원본 mp4가 없으면 처음부터 끝까지 자동 녹화합니다.';
    if (k === 'instagram' || k === 'facebook') return '원클릭 저장: mp4 주소가 있으면 바로 받고, 없으면 재생이 끝날 때 저장합니다.';
    if (k === 'vimeo') return '원클릭 저장: progressive mp4가 있으면 바로, 없으면 자동 녹화합니다.';
    if (k === 'tiktok') return '원클릭 저장: playAddr가 있으면 바로 받습니다.';
    if (k === 'naver' || k === 'kakao' || k === 'daum') return '원클릭 저장: 플레이어 주소 또는 자동 녹화.';
    return '원클릭 저장을 누르면 파일 주소가 있을 때 바로 받고, 없으면 재생이 끝날 때까지 녹화합니다.';
  }

  function candidate(url, source, hint, extra = {}) {
    let value = abs(url);
    if (!value) return null;
    if (typeof SL.unwrapMediaUrl === 'function') value = abs(SL.unwrapMediaUrl(value)) || value;
    if (SL.isUiJunk(value) && hint !== 'svg') return null;
    if (hint !== 'svg' && hint !== 'video' && typeof SL.upgradeMediaUrl === 'function') {
      const upgraded = SL.upgradeMediaUrl(value);
      if (upgraded && upgraded !== value && (SL.isImageUrl(upgraded) || SL.PHOTO_EXT.test(upgraded))) value = upgraded;
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
    let best = '', score = -1;
    String(srcset || '').split(',').forEach(part => {
      const bits = part.trim().split(/\s+/);
      const url = bits[0];
      if (!url) return;
      const desc = bits[1] || '';
      const n = parseFloat(desc) || 1;
      if (n >= score) { score = n; best = url; }
    });
    return best;
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
      root.setAttribute('color', '#111111');
      if (!root.getAttribute('stroke') && !root.getAttribute('fill')) {
        root.setAttribute('fill', 'none');
        root.setAttribute('stroke', '#111111');
        if (!root.getAttribute('stroke-width')) root.setAttribute('stroke-width', '1.8');
        root.setAttribute('stroke-linecap', 'round');
        root.setAttribute('stroke-linejoin', 'round');
      }
      root.querySelectorAll('*').forEach(el => {
        ['fill', 'stroke'].forEach(attr => {
          const v = el.getAttribute(attr);
          if (v && v !== 'none' && !/^url\(/i.test(v) && isLightPaint(v)) el.setAttribute(attr, '#111111');
        });
        const style = el.getAttribute('style');
        if (style) {
          el.setAttribute('style', style
            .replace(/fill\s*:\s*(?!none)(?!url)[^;]+/ig, m => /none/i.test(m) ? m : 'fill:#111111')
            .replace(/stroke\s*:\s*(?!none)(?!url)[^;]+/ig, m => /none/i.test(m) ? m : 'stroke:#111111')
            .replace(/color\s*:\s*[^;]+/ig, 'color:#111111'));
        }
      });
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
    out.push(candidate(node.currentSrc || node.src, 'img.currentSrc', 'image', { element: media, confidence: '최상' }));
    const best = largestSrcset(node.srcset || node.getAttribute('srcset') || '');
    if (best) out.push(candidate(best, 'srcset 최대', 'image', { element: media, confidence: '높음' }));
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
        const match = /url\(["']?(https?:[^"')]+)["']?\)/.exec(bg);
        if (match && SL.isImageUrl(match[1]) && !isChromeImage(cur, match[1])) {
          out.push(candidate(match[1], '배경 이미지', 'image', { confidence: '최상' }));
          return { media: cur, candidates: out.filter(Boolean) };
        }
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

  function svgCandidate(svg, source, confidence, extra = {}) {
    if (!svg || svg.closest?.('#sl-host')) return null;
    const r = svg.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return null;
    const social = ['instagram', 'facebook', 'youtube'].includes(siteKind());
    if (social && Math.max(r.width, r.height) < 36) return null;
    if (!extra.keepUi && isUiSvg(svg, extra.url, svgName(svg))) return null;
    const code = sanitizeSvg(new XMLSerializer().serializeToString(svg));
    const name = svgName(svg);
    const fp = svgFingerprint(svg, code);
    return candidate(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`, source, 'svg', {
      element: svg, code, confidence, relation: extra.relation || 'page', name,
      width: Math.round(r.width), height: Math.round(r.height), fp
    });
  }

  function collectInlineSvg(target) {
    const clicked = target?.tagName === 'SVG' ? target : target?.closest?.('svg');
    const out = [];
    if (clicked) {
      const item = svgCandidate(clicked, 'inline SVG', '최상', { keepUi: true, relation: 'target' });
      if (item) out.push(item);
    }
    return out.filter(Boolean);
  }

  function collectPageSvgs() {
    if (['youtube', 'vimeo', 'instagram', 'facebook', 'tiktok', 'video'].includes(siteKind())) return [];
    const social = ['instagram', 'facebook', 'youtube', 'social', 'video'].includes(siteKind());
    const min = siteProfile().svgMin || (social ? 36 : 12);
    const out = [];
    const seen = new Set();
    $$('svg').forEach(svg => {
      const r = svg.getBoundingClientRect();
      if (Math.min(r.width, r.height) < min) return;
      const item = svgCandidate(svg, '페이지 SVG', '중간');
      if (!item) return;
      const key = item.fp || item.url;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(item);
    });
    $$('img, object, embed').forEach(node => {
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
      const oldArea = (old.width || 0) * (old.height || 0);
      const newArea = (item.width || 0) * (item.height || 0);
      if (newArea > oldArea || SL.confidenceScore(item.confidence) > SL.confidenceScore(old.confidence)) map.set(key, item);
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
    if (isChromeImage(img, url)) return null;
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
    return [...images, ...videos, ...svgs, ...collectCatalogMedia(), ...collectSiteExtras()];
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
    $$('img, source').forEach(node => {
      ['src', 'currentSrc', 'data-src', 'data-original', 'data-origin', 'data-zoom', 'data-zoom-image', 'data-lazy-src', 'data-url', 'data-image', 'data-img', 'data-orig-file', 'org_src'].forEach(attr => {
        const v = node[attr] || node.getAttribute?.(attr);
        if (v) push(v, attr, { element: node.tagName === 'IMG' ? node : null, confidence: '중간' });
      });
      const srcset = node.srcset || node.getAttribute?.('srcset') || '';
      const best = largestSrcset(srcset);
      if (best) push(best, 'srcset 최대', { confidence: '높음' });
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
      holder.innerHTML = previewSvg(item.code);

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

  function fillItemActions(actions, item, extra = {}) {
    actions.append(actionButton('primary', 'URL 복사', ev => copy(item.temporary ? (state.postUrl || item.url) : item.url, ev.currentTarget)));
    actions.append(actionButton('primary', '저장', () => saveItem(item)));
    if (extra.onUrl) actions.append(actionButton('normal', extra.urlLabel || 'URL 보기', extra.onUrl));
    actions.append(actionButton('normal', '새 탭', () => window.open(item.temporary ? (state.postUrl || item.url) : item.url, '_blank', 'noopener')));
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
    if (item.type === 'video' || ['youtube', 'vimeo', 'instagram', 'facebook', 'tiktok', 'naver'].includes(siteKind())) {
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
    const video = pickCaptureVideo(item);
    if (!video) {
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
    if (!stream || !stream.getTracks().length) {
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
      captureHud(chunks.length ? '저장했습니다' : '녹화 데이터가 없습니다');
      setLabel('원클릭 저장');
      setTimeout(() => captureHud(''), 1800);
      if (!chunks.length) return;
      downloadBlob(new Blob(chunks, { type: rec.mimeType || 'video/webm' }), `capture-${Date.now()}.webm`);
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

  function downloadName(item) {
    const host = (location.hostname || 'web').replace(/^www\./, '');
    const raw = fileName(item?.url) || item?.type || 'media';
    const base = raw.replace(/\.[^.]+$/, '') || 'media';
    const ext = (/\.([a-z0-9]{2,5})$/i.exec(raw) || [])[1]
      || (item?.type === 'svg' ? 'svg' : item?.type === 'video' ? 'webm' : 'jpg');
    return `${host}-${base}`.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 70) + `.${ext}`;
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
      if (button) {
        button.disabled = false;
        button.textContent = result?.ok ? `ZIP ${result.count || payload.length}개` : (result?.error || 'ZIP 실패');
        setTimeout(() => { button.textContent = 'ZIP 저장'; }, 1800);
      }
    });
  }

  function saveItem(item) {

    if (item.type === 'svg' && item.code) {
      downloadBlob(new Blob([item.code], { type: 'image/svg+xml' }), downloadName(item));
      return;
    }
    const name = downloadName(item);
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
    fillItemActions(actions, item, { onSlice: () => layer.remove() });
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
          <h2>Source Lens <small class="sl-ver">0.8.0</small></h2>
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
        const empty = state.activeTab === 'video'
          ? videoEmptyMessage()
          : state.activeTab === 'svg'
            ? '중복을 제외한 SVG가 없습니다. 아이콘을 직접 Alt+클릭하면 선택됩니다.'
            : '표시할 미디어가 없습니다.';
        const box = document.createElement('div');
        box.className = 'sl-empty';
        box.textContent = empty;
        main.append(box);
        if (state.activeTab === 'video') {
          const bar = document.createElement('div');
          bar.className = 'sl-bulk';
          bar.append(actionButton('primary', '원클릭 저장', ev => oneClickSaveVideo(null, ev.currentTarget)));
          bar.append(actionButton('normal', 'yt-dlp 복사', ev => copy(ytdlpCommand(), ev.currentTarget)));
          main.append(bar);
        }
        return;
      }
      if (state.activeTab !== 'selected') {
        list.sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)) || String(b.confidence).length - String(a.confidence).length);
      }
      if (state.activeTab === 'image' && state.filterLarge) {
        list = list.filter(item => !item.width || Math.max(item.width, item.height || 0) >= 400);
      }
      if (state.activeTab === 'selected') {
        const item = list[0];
        const preview = mediaNode(item, 'sl-preview');
        if (preview) main.append(preview);
        const card = document.createElement('article');
        card.className = 'sl-primary';
        card.innerHTML = `<div class="sl-kicker">대표 후보</div><strong>${esc(labelOf(item))}</strong>
          <div class="sl-file-meta sl-meta">${esc(item.state)} · ${esc(item.mime || item.type)}</div>
          <div class="sl-primary-actions"></div>`;
        if (isTallItem(item)) {
          const hint = document.createElement('p');
          hint.className = 'sl-hint';
          hint.textContent = '긴 상세 이미지입니다. 분할 편집으로 구간을 자를 수 있습니다.';
          card.querySelector('.sl-file-meta').after(hint);
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
            code.textContent = item.temporary ? (state.postUrl || item.url) : item.url;
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
      } else {
        const bar = document.createElement('div');
        bar.className = 'sl-bulk';
        const saveAll = document.createElement('button');
        saveAll.type = 'button';
        saveAll.className = 'sl-btn sl-btn-brand';
        saveAll.textContent = `모두 저장 (${Math.min(list.length, 40)})`;
        saveAll.onclick = async () => {
          saveAll.disabled = true;
          for (const item of list.slice(0, 40)) {
            saveItem(item);
            await new Promise(r => setTimeout(r, 280));
          }
          saveAll.textContent = '저장 요청 완료';
          saveAll.disabled = false;
        };
        const copyAll = document.createElement('button');
        copyAll.type = 'button';
        copyAll.className = 'sl-btn';
        copyAll.textContent = 'URL 모두 복사';
        copyAll.onclick = () => copy(list.map(item => item.url).filter(Boolean).join('\n'), copyAll);
        bar.append(saveAll, copyAll);
        const zipBtn = document.createElement('button');
        zipBtn.type = 'button';
        zipBtn.className = 'sl-btn sl-btn-brand';
        zipBtn.textContent = 'ZIP 저장';
        zipBtn.onclick = () => zipItems(list, zipBtn);
        bar.append(zipBtn);
        if (state.activeTab === 'image') {
          const large = document.createElement('button');
          large.type = 'button';
          large.className = 'sl-btn' + (state.filterLarge ? ' is-on' : '');
          large.textContent = '큰 것만';
          large.onclick = () => { state.filterLarge = !state.filterLarge; draw(); };
          bar.append(large);
        }
        if (state.activeTab === 'svg') {
          const copyCodes = document.createElement('button');
          copyCodes.type = 'button';
          copyCodes.className = 'sl-btn';
          copyCodes.textContent = '코드 모두 복사';
          copyCodes.onclick = async () => {
            const codes = list.map(item => svgSource(item)).filter(Boolean);
            if (!codes.length) return;
            await navigator.clipboard.writeText(codes.join('\n\n'));
            copyCodes.textContent = `${codes.length}개 복사됨`;
          };
          bar.append(copyCodes);
        }
        main.append(bar);
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
    if (clickedVideo) oneClickSaveVideo(state.picked);
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
      const have = new Set(state.candidates.map(itemKey));
      ev.data.data.forEach(item => {
        if (!item?.url) return;
        const key = itemKey(item);
        if (have.has(key)) return;
        have.add(key);
        state.candidates.push(item);
      });
      state.redraw?.();
      return;
    }
    if (ev.data.type !== 'open') return;
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
    if (message?.type === 'oneClickVideo') {
      oneClickSaveVideo(null, null).then(sendResponse);
      return true;
    }
    if (message?.type !== 'contextInspect') return;
    const target = state.contextTarget || mediaAtPoint(innerWidth / 2, innerHeight / 2);
    const seed = message.info?.srcUrl
      ? [candidate(message.info.srcUrl, '우클릭 URL', message.info.mediaType === 'video' ? 'video' : 'image', { confidence: '최상' })]
      : [];
    inspect(target, seed);
  });

  window.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { closePanel(); return; }
    if (!state.panel) return;
    if (ev.target && /INPUT|TEXTAREA|SELECT/.test(ev.target.tagName)) return;
    const tabs = { 1: 'selected', 2: 'image', 3: 'video', 4: 'svg' };
    if (tabs[ev.key]) { state.activeTab = tabs[ev.key]; state.redraw?.(); }
    if ((ev.key === 's' || ev.key === 'S') && state.picked) saveItem(state.picked);
    if ((ev.key === 'c' || ev.key === 'C') && state.picked) copy(state.picked.url);
  });
})();
