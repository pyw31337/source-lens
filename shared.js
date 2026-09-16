(function (root) {
  const SL = root.SourceLens = root.SourceLens || {};

  SL.MEDIA_EXT = /\.(?:mp4|m4v|mov|webm|mkv|ogv|avi|3gp|m3u8|mpd|ts|m4s)(?:$|[?#])/i;
  SL.IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|avif|bmp|svg|ico|jfif|heic)(?:$|[?#])/i;
  SL.PHOTO_EXT = /\.(?:jpe?g|png|webp|avif|bmp|jfif|heic)(?:$|[?#])/i;
  SL.SIGNED = /(?:X-Amz-Signature|X-Amz-Expires|Expires=|Signature=|oh=|oe=|expire=|exp=|Policy=)/i;

  SL.abs = function abs(value, base) {
    if (!value || typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed || trimmed === '#') return '';
    if (/^(?:javascript|vbscript|file|chrome|about):/i.test(trimmed)) return '';
    if (/^data:/i.test(trimmed) && !/^data:image\/svg/i.test(trimmed)) return '';
    try {
      const url = new URL(trimmed, base || (typeof location !== 'undefined' ? location.href : 'https://example.com/'));
      if (/^(javascript|vbscript|file|chrome|about):/i.test(url.protocol)) return '';
      return url.href;
    } catch {
      return '';
    }
  };

  SL.unique = function unique(values) {
    return [...new Set((values || []).filter(Boolean))];
  };

  SL.esc = function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;'
    }[ch]));
  };

  SL.bytes = function bytes(value) {
    if (!Number.isFinite(value) || value <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = value, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
  };

  SL.fileName = function fileName(url) {
    try {
      if (/^blob:/i.test(url || '')) return 'session-video';
      const raw = decodeURIComponent(new URL(url, 'https://x.invalid').pathname.split('/').pop() || 'media');
      const cleaned = raw.replace(/[\\/:*?"<>|]+/g, '_').replace(/[^a-z0-9._-]+/gi, '_').slice(-80);
      return cleaned || 'media';
    } catch {
      return 'media';
    }
  };

  SL.isManifest = function isManifest(url) {
    return /(?:\.m3u8|\.mpd)(?:$|[?#])/i.test(url || '');
  };

  SL.isUiJunk = function isUiJunk(url) {
    if (!url) return true;
    if (/^data:image\/svg/i.test(url)) return false;
    if (/rsrc\.php|static\.(?:xx\.)?fbcdn|static\.cdninstagram|instagram\.com\/static|facebook\.com\/rsrc/i.test(url)) return true;
    if (/\.(?:gif|ico)(?:$|[?#])/i.test(url)) return true;
    if (/\.svg(?:$|[?#])/i.test(url) && /(?:cdninstagram|fbcdn|instagram\.com|facebook\.com)/i.test(url)) return true;
    return false;
  };

  SL.isImageUrl = function isImageUrl(url, mime) {
    if (mime && /^image\//i.test(mime) && !/^image\/(svg|gif)/i.test(mime)) return true;
    if (!url || SL.isUiJunk(url)) return false;
    if (/\.svg(?:$|[?#])/i.test(url)) return false;
    if (SL.PHOTO_EXT.test(url)) return true;
    if (/_(?:n|o)\.(?:jpe?g|png|webp)/i.test(url)) return true;
    if (/[?&]stp=/i.test(url) && !SL.MEDIA_EXT.test(url)) return true;
    if (/i\.ytimg\.com|ggpht\.com/i.test(url)) return true;
    return false;
  };

  SL.isVideoUrl = function isVideoUrl(url, mime) {
    if (mime && /^video\//i.test(mime)) return true;
    if (!url) return false;
    if (SL.isImageUrl(url, mime) || SL.PHOTO_EXT.test(url) || /_n\.(?:jpe?g|png|webp)/i.test(url)) return false;
    if (SL.MEDIA_EXT.test(url)) return true;
    if (/googlevideo\.com|videoplayback/i.test(url)) return true;
    if (/vimeocdn\.com|player\.vimeo\.com|vod-progressive|akamaized\.net\/.*\.(?:mp4|m3u8)/i.test(url)) return true;
    if (/tiktokcdn|muscdn\.com|bytevod|tiktok\.com\/aweme/i.test(url)) return true;
    if (/\.pstatic\.net\/.*(mp4|hls)|tvnaver|kakaocdn\.net.*(?:mp4|m3u8)|daumcdn\.net.*(?:mp4|m3u8)/i.test(url)) return true;
    if (/\/o1\/v\//i.test(url)) return true;
    if (/(?:cdninstagram|fbcdn|scontent).*(?:\/t(?:15|16|2|30|35|50|66)\/|\/t2\/f2\/|\/v\/t(?:15|16|2|30|35|50|66)\/)/i.test(url) && !SL.PHOTO_EXT.test(url)) return true;
    if (/\.mp4(?:$|[?#])/i.test(url)) return true;
    return false;
  };

  SL.looksLikeMediaRequest = function looksLikeMediaRequest(url, type, mime) {
    if (SL.isUiJunk(url)) return false;
    return SL.isVideoUrl(url, mime) || SL.isImageUrl(url, mime) || SL.isManifest(url);
  };

  SL.classifyUrl = function classifyUrl(url, hint) {
    url = url || '';
    if (hint === 'svg' || /^data:image\/svg/i.test(url)) {
      return { type: 'svg', flags: [], state: 'SVG', temporary: false, stream: false };
    }
    if (SL.PHOTO_EXT.test(url) || SL.isImageUrl(url) || hint === 'image') {
      if (!SL.isVideoUrl(url) || SL.PHOTO_EXT.test(url)) {
        const signed = SL.SIGNED.test(url);
        return { type: 'image', flags: signed ? ['signed'] : [], state: signed ? '서명·만료 가능 URL' : '직접 열 수 있음', temporary: false, stream: false };
      }
    }
    const type = SL.isVideoUrl(url) || SL.isManifest(url) || (hint === 'video' && !SL.PHOTO_EXT.test(url) && !SL.isImageUrl(url)) ? 'video' : 'image';
    const flags = [];
    if (/^blob:/i.test(url)) flags.push('blob');
    if (SL.isManifest(url)) flags.push('stream');
    if (SL.SIGNED.test(url)) flags.push('signed');
    let state = '직접 열 수 있음';
    if (flags.includes('blob')) state = '세션 종속 (blob)';
    else if (flags.includes('stream')) state = '스트리밍 매니페스트';
    else if (flags.includes('signed')) state = '서명·만료 가능 URL';
    else if (type === 'video') state = '영상 주소';
    return { type, flags, state, temporary: flags.includes('blob'), stream: flags.includes('stream') };
  };

  SL.confidenceScore = function confidenceScore(value) {
    return ({ '최상': 4, '높음': 3, '중간': 2, '낮음': 1 }[value] || 0);
  };

  SL.youtubeIdFromUrl = function youtubeIdFromUrl(value) {
    try {
      const parsed = new URL(value, 'https://youtube.com');
      const host = parsed.hostname.replace(/^www\./, '');
      if (host === 'youtu.be') return parsed.pathname.slice(1).split('/')[0].slice(0, 11);
      const fromPath = parsed.pathname.match(/\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      if (fromPath) return fromPath[1];
      const v = parsed.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
    } catch { /* ignore */ }
    return '';
  };

  SL.youtubeThumbs = function youtubeThumbs(id) {
    if (!id) return [];
    return ['maxresdefault', 'sddefault', 'hqdefault', 'mqdefault'].map((size, i) => ({
      url: `https://i.ytimg.com/vi/${id}/${size}.jpg`,
      source: `YouTube ${size}`,
      type: 'image',
      confidence: i === 0 ? '최상' : '높음'
    }));
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
