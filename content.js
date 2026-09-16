(() => {
  if (window.__sourceLensLoaded) return;
  window.__sourceLensLoaded = true;

  const SL = globalThis.SourceLens;
  const state = {
    panel: null, selected: null, contextTarget: null, selectedMedia: null,
    candidates: [], activeTab: 'selected', postUrl: '', capture: null, pageNet: [], profile: null
  };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const abs = value => SL.abs(value, location.href);
  const esc = SL.esc;
  const bytes = SL.bytes;
  const fileName = SL.fileName;

  function siteKind() {
    const host = location.hostname.replace(/^www\./, '').toLowerCase();
    if (host.endsWith('youtube.com') || host === 'youtu.be') return 'youtube';
    if (host.endsWith('instagram.com')) return 'instagram';
    if (host.endsWith('facebook.com') || host === 'fb.watch') return 'facebook';
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
      relation: extra.relation || 'target'
    };
  }

  function mediaAtPoint(x, y) {
    const stack = document.elementsFromPoint(x, y);
    for (const node of stack) {
      if (node.closest?.('#sl-root, .sl-lightbox, .sl-slice-editor')) continue;
      const media = node.tagName && /^(IMG|VIDEO|SVG|PICTURE)$/.test(node.tagName)
        ? node
        : node.closest?.('img, video, svg, picture');
      if (!media) continue;
      const r = media.getBoundingClientRect();
      if (r.width < 32 || r.height < 32) continue;
      return media;
    }
    return stack[0] || document.body;
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

  function collectRecentVideos() {
    const cutoff = Date.now() - 20000;
    return state.pageNet
      .filter(item => item.t >= cutoff && SL.isVideoUrl(item.url) && !SL.isImageUrl(item.url))
      .slice(-12)
      .map(item => candidate(item.url, '최근 네트워크 영상', 'video', { confidence: '높음', relation: 'network' }))
      .filter(Boolean);
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
    const perf = performance.getEntriesByType('resource')
      .filter(entry => SL.isVideoUrl(entry.name) && !SL.isImageUrl(entry.name))
      .slice(-40)
      .map(entry => candidate(entry.name, '브라우저 네트워크', 'video', { confidence: '높음', relation: 'network' }))
      .filter(Boolean);
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'recentRequests' }, result => {
          const req = (result?.requests || [])
            .filter(item => SL.isVideoUrl(item.url) && !SL.isImageUrl(item.url))
            .slice(-40)
            .map(item => candidate(item.url, '확장 네트워크', 'video', { confidence: '높음', relation: 'network' }))
            .filter(Boolean);
          resolve([...perf, ...req]);
        });
      } catch {
        resolve(perf);
      }
    });
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
    state.panel?.remove();
    state.panel = null;
    state.selected?.classList?.remove('sl-select');
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
      if (item.temporary || /^blob:/i.test(item.url)) {
        const img = document.createElement('img');
        img.className = className || '';
        img.alt = '세션 영상 미리보기';
        if (poster) img.src = poster;
        return img;
      }
      const node = document.createElement('video');
      node.className = className || '';
      node.controls = true;
      node.muted = true;
      node.playsInline = true;
      if (poster) node.poster = poster;
      node.src = item.url;
      return node;
    }
    const node = document.createElement('img');
    node.className = className || '';
    node.alt = item.source || '';
    node.src = item.url;
    return node;
  }

  function fetchBytes(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'fetchResource', url }, result => {
        if (chrome.runtime.lastError || result?.error) return reject(new Error(result?.error || chrome.runtime.lastError.message));
        if (result?.blob) return resolve(result.blob);
        reject(new Error('empty'));
      });
    });
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function saveItem(item) {
    if (item.type === 'svg' && item.code) {
      downloadBlob(new Blob([item.code], { type: 'image/svg+xml' }), `${fileName(item.url)}.svg`);
      return;
    }
    const fallback = () => {
      if (item.temporary && state.postUrl) window.open(state.postUrl, '_blank', 'noopener');
      else window.open(item.url, '_blank', 'noopener');
    };
    fetchBytes(item.url).then(blob => {
      const ext = item.type === 'video' ? 'mp4' : (fileName(item.url).split('.').pop() || 'jpg');
      downloadBlob(blob, fileName(item.url).includes('.') ? fileName(item.url) : `${fileName(item.url)}.${ext}`);
    }).catch(fallback);
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
    imageBlob(item).then(blob => new Promise((resolve, reject) => {
      const src = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d').drawImage(image, 0, 0);
        canvas.toBlob(out => out ? resolve(out) : reject(), format.mime, 0.92);
      };
      image.onerror = reject;
      image.src = src;
    })).then(blob => {
      downloadBlob(blob, `${fileName(item.url).replace(/\.[^.]+$/, '')}.${format.ext}`);
    }).catch(() => {
      if (button) button.textContent = '변환 실패';
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
    title.textContent = `${fileName(item.url)} · ${item.state || ''}`;
    const page = document.createElement('div');
    page.className = 'sl-lightbox-page';
    page.textContent = `${index + 1} / ${items.length}`;
    const actions = document.createElement('div');
    actions.className = 'sl-lightbox-actions';
    actions.innerHTML = `<button class="sl-btn sl-copy">URL 복사</button><button class="sl-btn sl-save">저장</button>`;
    actions.querySelector('.sl-copy').onclick = ev => copy(item.temporary ? state.postUrl : item.url, ev.currentTarget);
    actions.querySelector('.sl-save').onclick = () => saveItem(item);
    if (item.type === 'image') {
      [['JPG', 'jpg', 'image/jpeg'], ['PNG', 'png', 'image/png'], ['WebP', 'webp', 'image/webp']].forEach(([label, ext, mime]) => {
        const btn = document.createElement('button');
        btn.className = 'sl-btn';
        btn.textContent = `${label} 저장`;
        btn.onclick = () => convertImage(item, { label, ext, mime }, btn);
        actions.append(btn);
      });
      const slice = document.createElement('button');
      slice.className = 'sl-btn';
      slice.textContent = '분할 편집';
      slice.onclick = () => { layer.remove(); openSliceEditor(item); };
      actions.append(slice);
    }
    card.append(title, page, actions);
    layer.append(card);
    layer.onclick = ev => { if (ev.target === layer) layer.remove(); };
    document.documentElement.append(layer);
  }

  async function openSliceEditor(item) {
    let blob;
    try { blob = await imageBlob(item); } catch { alert('이미지를 불러오지 못했습니다.'); return; }
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
      document.documentElement.append(layer);
      renderLines();
    };
    image.src = sourceUrl;
  }

  function render() {
    closePanel();
    const root = document.createElement('div');
    root.id = 'sl-root';
    const panel = document.createElement('section');
    panel.id = 'sl-panel';
    root.append(panel);
    state.panel = root;
    document.documentElement.append(root);
    const brand = (typeof sourceLensProfileFor === 'function' ? sourceLensProfileFor(location.hostname) : null)?.brand
      || { name: siteKind(), color: '#229968' };
    const selected = state.candidates[0];
    panel.innerHTML = `
      <button class="sl-close" type="button" aria-label="닫기">×</button>
      <header class="sl-header">
        <div>
          <h2>Source Lens <small class="sl-ver">0.4.0</small></h2>
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
    const draw = () => {
      main.textContent = '';
      panel.querySelectorAll('.sl-tabs button').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === state.activeTab));
      panel.querySelector('[data-tab="image"] b').textContent = state.candidates.filter(i => i.type === 'image').length;
      panel.querySelector('[data-tab="video"] b').textContent = state.candidates.filter(i => i.type === 'video').length;
      panel.querySelector('[data-tab="svg"] b').textContent = state.candidates.filter(i => i.type === 'svg').length;
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
        card.innerHTML = `<div class="sl-kicker">대표 후보</div><strong>${esc(fileName(item.url))}</strong>
          <div class="sl-file-meta sl-meta">${esc(item.state)} · ${esc(item.mime || item.type)}</div>
          <div class="sl-primary-actions">
            <button class="sl-btn sl-url">URL 보기</button>
            <button class="sl-btn sl-copy">URL 복사</button>
            <button class="sl-btn sl-new">새 탭</button>
            <button class="sl-btn sl-save">저장</button>
          </div>`;
        $('.sl-url', card).onclick = ev => {
          const code = document.createElement('code');
          code.className = 'sl-url-value';
          code.textContent = item.temporary ? (state.postUrl || item.url) : item.url;
          card.append(code);
          ev.currentTarget.textContent = 'URL 숨기기';
        };
        $('.sl-copy', card).onclick = ev => copy(item.temporary ? (state.postUrl || item.url) : item.url, ev.currentTarget);
        $('.sl-new', card).onclick = () => window.open(item.temporary ? (state.postUrl || item.url) : item.url, '_blank', 'noopener');
        $('.sl-save', card).onclick = () => saveItem(item);
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
          tile.insertAdjacentHTML('beforeend', `<strong>${esc(fileName(item.url))}</strong><small>${esc(item.source)}</small><small class="sl-meta">${esc(item.state)}</small>`);
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
    draw();
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
    if (clickedVideo) {
      extras.push(...collectRecentVideos());
      extras.push(...(await collectNetwork()));
    }
    if (siteKind() === 'youtube') extras.push(...collectYouTube(target));
    if (!clickedSvg) extras.push(...collectArticle(target));
    let list = rank(dedupe([...seed, ...collected.candidates, ...extras]), collected.media)
      .filter(item => item && !SL.isUiJunk(item.url));
    if (clickedSvg) list = list.filter(item => item.type === 'svg');
    else if (clickedVideo) {
      const videos = list.filter(item => item.type === 'video' && (item.temporary || SL.isVideoUrl(item.url)));
      const poster = list.filter(item => item.type === 'image' && SL.isImageUrl(item.url));
      list = [...videos, ...poster.slice(0, 4)];
    } else {
      list = list.filter(item => item.type === 'image' && SL.isImageUrl(item.url));
    }
    state.candidates = list;
    if (window !== window.top) {
      try {
        window.top.postMessage({
          sourceLens: true,
          type: 'open',
          data: {
            candidates: state.candidates.map(({ element, ...item }) => item),
            postUrl: state.postUrl
          }
        }, location.origin);
      } catch {
        render();
      }
      return;
    }
    state.activeTab = 'selected';
    render();
  }

  window.addEventListener('mousedown', ev => {
    if (ev.altKey && ev.button === 0 && !ev.target.closest?.('#sl-root, .sl-lightbox, .sl-slice-editor')) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }
  }, true);

  window.addEventListener('click', ev => {
    if (!ev.altKey || ev.button !== 0 || ev.target.closest?.('#sl-root, .sl-lightbox, .sl-slice-editor')) return;
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
    state.postUrl = ev.data.data?.postUrl || '';
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
