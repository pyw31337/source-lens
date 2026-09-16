(() => {
  if (window.__sourceLensExtractors) return;
  window.__sourceLensExtractors = true;

  const IMAGE = /\.(?:jpe?g|png|webp)(?:$|[?#])|images\.unsplash|images\.pexels|cdn\.pixabay|cdn\.dribbble|behance\.net|pstatic\.net|dcimg|namu\.la|kakaocdn|daumcdn|i\.ytimg|i\.vimeocdn|img\.danawa|humoruniv|ygosu\.com/i;
  const VIDEO = /\.(?:mp4|m4v|webm|mov|m3u8)(?:$|[?#])|videoplayback|googlevideo\.com|player\.vimeo|vod-progressive|tiktokcdn|muscdn|fbcdn\.net\/v\/t[0-9].*mp4|cdninstagram.*mp4|playable_url|bytevod|naver\.net\/.*(?:mp4|hls)|daumcdn.*mp4/i;
  const SKIP = /logo|sprite|favicon|1x1|pixel|tracking|adservice|doubleclick|facebook\.com\/tr|nolmg_|noimg/i;

  const images = new Map();
  const videos = new Map();

  function clean(url) {
    return String(url || '').replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\u002F/gi, '/');
  }

  function push(url, type, source) {
    let value = clean(url).replace(/[),.;]+$/, '');
    if (typeof SourceLens?.unwrapMediaUrl === 'function') value = SourceLens.unwrapMediaUrl(value) || value;
    if (!value || !/^https?:/i.test(value) || SKIP.test(value)) return;
    if (type === 'video') {
      if (IMAGE.test(value) && !/\.mp4/i.test(value)) return;
      if (/i\.ytimg|i\.vimeocdn/i.test(value)) return;
      if (!VIDEO.test(value) && !/\/video\//i.test(value)) return;
      if (!videos.has(value)) videos.set(value, { url: value, type: 'video', source });
      return;
    }
    if (!IMAGE.test(value) && !/scontent|fbcdn|ytimg|pstatic|kakaocdn|daumcdn|coupangcdn|gmarket|danawa|ygosu|humoruniv/i.test(value)) return;
    if (VIDEO.test(value) && /\.mp4/i.test(value)) return;
    if (!images.has(value)) images.set(value, { url: value, type: 'image', source });
  }

  function takeUrl(val) {
    if (typeof val === 'string' && /^https?:/i.test(val)) return val;
    if (!val || typeof val !== 'object') return '';
    if (typeof val.url === 'string') return val.url;
    if (Array.isArray(val.url_list) && val.url_list[0]) return String(val.url_list[0]);
    if (typeof val.src === 'string') return val.src;
    if (typeof val.uri === 'string') return val.uri;
    return '';
  }

  function walk(node, depth) {
    if (!node || depth > 7) return;
    if (typeof node === 'string') {
      if (IMAGE.test(node)) push(node, 'image', '페이지 JSON');
      else if (VIDEO.test(node)) push(node, 'video', '페이지 JSON');
      return;
    }
    if (Array.isArray(node)) {
      node.slice(0, 60).forEach(item => walk(item, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;

    const videoKeys = [
      'video_url', 'videoUrl', 'playable_url', 'playable_url_quality_hd',
      'browser_native_hd_url', 'browser_native_sd_url', 'contentUrl',
      'playAddr', 'downloadAddr', 'playback_url', 'play_url'
    ];
    videoKeys.forEach(key => {
      const url = takeUrl(node[key]);
      if (url) push(url, 'video', key);
    });
    ['play_addr', 'download_addr', 'play_addr_h264', 'play_addr_bytevc1'].forEach(key => {
      const url = takeUrl(node[key]);
      if (url) push(url, 'video', key);
    });
    if (Array.isArray(node.video_versions)) {
      node.video_versions.forEach(v => push(takeUrl(v), 'video', 'video_versions'));
    }
    if (Array.isArray(node.formats)) {
      node.formats.forEach(f => {
        if (!f?.url || f.signatureCipher) return;
        if (/video\/mp4/i.test(f.mimeType || '') && f.width && f.audioQuality) {
          push(f.url, 'video', `YouTube ${f.qualityLabel || f.itag || 'mp4'}`);
        }
      });
    }
    if (Array.isArray(node.progressive)) {
      node.progressive.forEach(f => push(takeUrl(f), 'video', 'Vimeo progressive'));
    }

    const imageKeys = [
      'display_url', 'displayUrl', 'thumbnail_src', 'thumbnail_url', 'thumbnailUrl',
      'image_url', 'imageUrl', 'origin_cover', 'cover', 'poster', 'contentUrl'
    ];
    imageKeys.forEach(key => {
      const url = takeUrl(node[key]);
      if (url && IMAGE.test(url)) push(url, 'image', key);
    });
    node.image_versions2?.candidates?.forEach?.(c => push(takeUrl(c), 'image', 'image_versions2'));
    node.display_resources?.forEach?.(c => push(takeUrl(c) || c.src, 'image', 'display_resources'));
    node.thumbnail?.thumbnails?.forEach?.(c => push(takeUrl(c), 'image', 'thumbnail'));

    const keys = Object.keys(node);
    if (keys.length > 80) return;
    keys.forEach(key => {
      if (key === 'formats' || key === 'adaptiveFormats') return;
      walk(node[key], depth + 1);
    });
  }

  function parseAssigned(name) {
    try {
      if (window[name] && typeof window[name] === 'object') return window[name];
    } catch { /* ignore */ }
    const needle = `${name} = `;
    for (const script of document.scripts) {
      const text = script.textContent || '';
      const at = text.indexOf(needle);
      if (at < 0) continue;
      const start = text.indexOf('{', at);
      if (start < 0) continue;
      let depth = 0;
      for (let i = start; i < Math.min(text.length, start + 1_500_000); i++) {
        const ch = text[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
          }
        }
      }
    }
    return null;
  }

  function youtube() {
    const player = parseAssigned('ytInitialPlayerResponse');
    if (player) {
      const id = player.videoDetails?.videoId;
      (player.videoDetails?.thumbnail?.thumbnails || []).forEach(t => push(takeUrl(t), 'image', 'YouTube 썸네일'));
      if (id) {
        ['maxresdefault', 'sddefault', 'hqdefault'].forEach(name => {
          push(`https://i.ytimg.com/vi/${id}/${name}.jpg`, 'image', 'ytimg');
        });
      }
      walk(player, 0);
    }
    const data = parseAssigned('ytInitialData');
    if (data) walk(data, 0);
  }

  function scriptBlobs() {
    [
      'SIGI_STATE', 'sigi-persisted-data', '__UNIVERSAL_DATA_FOR_REHYDRATION__',
      '__NEXT_DATA__', '__APOLLO_STATE__'
    ].forEach(id => {
      const el = document.getElementById(id);
      if (!el?.textContent) return;
      try { walk(JSON.parse(el.textContent), 0); } catch { /* ignore */ }
    });
    document.querySelectorAll('script[type="application/ld+json"], script[type="application/json"]').forEach(script => {
      const text = script.textContent || '';
      if (text.length < 40 || text.length > 1_500_000) return;
      try { walk(JSON.parse(text), 0); } catch { /* ignore */ }
    });
    document.querySelectorAll('script').forEach(script => {
      const text = script.textContent || '';
      if (text.length < 400 || text.length > 800_000) return;
      if (!/video_url|display_url|playable_url|playAddr|video_versions|thumbnail_src|streamingData/.test(text)) return;
      const clipped = text.slice(0, 400000);
      const re = /https?:\/\/[^"'\\\s<>]+/g;
      let match, n = 0;
      while ((match = re.exec(clipped)) && n < 50) {
        const url = clean(match[0]);
        if (VIDEO.test(url)) push(url, 'video', 'script');
        else if (IMAGE.test(url)) push(url, 'image', 'script');
        n += 1;
      }
    });
  }

  function metas() {
    document.querySelectorAll('meta[property="og:image"], meta[property="og:image:url"], meta[name="twitter:image"], meta[property="og:image:secure_url"]').forEach(node => {
      push(node.content, 'image', 'og:image');
    });
    document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]').forEach(node => {
      push(node.content, 'video', 'og:video');
    });
  }

  function koreanPortals() {
    document.querySelectorAll('.se-image-resource, img._image, .link_thumb img, .thumb_vf img, .article_view img').forEach(img => {
      const url = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
      if (url) push(url.replace(/[?&]type=w\d+/i, '?type=w2000'), 'image', '포털 본문');
    });
    document.querySelectorAll('video').forEach(video => {
      push(video.currentSrc || video.src, 'video', 'video 요소');
      video.querySelectorAll('source[src]').forEach(source => push(source.src, 'video', 'video source'));
    });
  }

  function emit() {
    document.documentElement.dispatchEvent(new CustomEvent('sl-platform-media', {
      bubbles: true,
      detail: {
        images: [...images.values()].slice(0, 80),
        videos: [...videos.values()].slice(0, 20)
      }
    }));
  }

  function run() {
    images.clear();
    videos.clear();
    try { youtube(); } catch { /* ignore */ }
    try { scriptBlobs(); } catch { /* ignore */ }
    try { metas(); } catch { /* ignore */ }
    try { koreanPortals(); } catch { /* ignore */ }
    emit();
  }

  run();
  setTimeout(run, 1200);
  document.documentElement.addEventListener('sl-extract-now', run);
})();
