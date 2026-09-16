/* Domain profiles are deliberately data-driven. They add hints; they never bypass access controls. */
globalThis.SOURCE_LENS_PROFILES = [
  ['youtube.com','video','video,playlist,thumbnail'], ['youtu.be','video','video'], ['instagram.com','social','image,video,og'], ['facebook.com','social','image,video,og'], ['fb.watch','video','video'], ['tiktok.com','video','video,og'], ['x.com','social','image,video,og'], ['twitter.com','social','image,video,og'], ['reddit.com','social','image,video,og'], ['pinterest.com','image','image,og'], ['pinimg.com','image','image,cdn'], ['twitch.tv','video','video,stream'], ['vimeo.com','video','video,og'], ['dailymotion.com','video','video,og'], ['netflix.com','drm','manifest,drm'], ['disneyplus.com','drm','manifest,drm'], ['primevideo.com','drm','manifest,drm'], ['hulu.com','drm','manifest,drm'], ['linkedin.com','social','image,video,og'], ['threads.net','social','image,og'], ['snapchat.com','social','image,video'], ['tumblr.com','social','image,video,og'], ['flickr.com','image','image,original'], ['imgur.com','image','image,original'], ['unsplash.com','image','image,original'], ['pexels.com','image','image,original'], ['pixabay.com','image','image,original'], ['deviantart.com','image','image,original'], ['behance.net','image','image,original'], ['dribbble.com','image','image,original'], ['medium.com','news','image,og'], ['nytimes.com','news','image,og'], ['theguardian.com','news','image,og'], ['bbc.com','news','image,og'], ['naver.com','portal','image,video,og'], ['blog.naver.com','news','image,original'], ['cafe.naver.com','social','image,og'], ['daum.net','portal','image,video,og'], ['kakao.com','social','image,video'], ['google.com','portal','image,og'], ['drive.google.com','cloud','download,resource'], ['dropbox.com','cloud','download,resource'], ['onedrive.live.com','cloud','download,resource'], ['github.com','code','raw,download'], ['gitlab.com','code','raw,download'], ['gmarket.co.kr','commerce','image,original'], ['auction.co.kr','commerce','image,original'], ['amazon.com','commerce','image,original'], ['coupang.com','commerce','image,original'], ['11st.co.kr','commerce','image,original'], ['smartstore.naver.com','commerce','image,original'], ['shopping.naver.com','commerce','image,original'], ['brand.naver.com','commerce','image,original'], ['tmon.co.kr','commerce','image,original'], ['wemakeprice.com','commerce','image,original'], ['ssg.com','commerce','image,original'], ['lotteon.com','commerce','image,original'], ['ebay.com','commerce','image,original'], ['aliexpress.com','commerce','image,original'], ['shopify.com','commerce','image,original']
].map(([domain, kind, hints]) => ({ domain, kind, hints: hints.split(',') }));

globalThis.SOURCE_LENS_BRANDS = [
  ['youtube.com','YouTube','#ff0000'],['youtu.be','YouTube','#ff0000'],['instagram.com','Instagram','#d62976'],['facebook.com','Facebook','#1877f2'],['tiktok.com','TikTok','#111827'],['x.com','X','#111827'],['twitter.com','Twitter','#1d9bf0'],['reddit.com','Reddit','#ff4500'],['pinterest.com','Pinterest','#e60023'],['twitch.tv','Twitch','#9146ff'],['vimeo.com','Vimeo','#1ab7ea'],['dailymotion.com','Dailymotion','#00aaff'],['netflix.com','Netflix','#e50914'],['linkedin.com','LinkedIn','#0a66c2'],['unsplash.com','Unsplash','#111827'],['pexels.com','Pexels','#05a081'],['pixabay.com','Pixabay','#2ec66d'],['behance.net','Behance','#1769ff'],['dribbble.com','Dribbble','#ea4c89'],['naver.com','네이버','#03c75a'],['blog.naver.com','네이버 블로그','#03c75a'],['daum.net','다음','#00a88f'],['kakao.com','카카오','#fee500'],['gmarket.co.kr','Gmarket','#00d094'],['auction.co.kr','옥션','#ff5000'],['coupang.com','쿠팡','#e31837'],['danawa.com','다나와','#1d4ed8'],['enuri.com','에누리','#00a0e9'],['lucide.dev','Lucide','#f56565'],['tabler.io','Tabler','#066fd1']
].map(([domain, name, color]) => ({ domain, name, color }));

globalThis.sourceLensProfileFor = function(host) {
  host = (host || '').toLowerCase().replace(/^www\./, '');
  const profile = SOURCE_LENS_PROFILES.find(p => host === p.domain || host.endsWith('.' + p.domain)) || { domain: host, kind: 'generic', hints: [] };
  const brand = SOURCE_LENS_BRANDS.find(b => host === b.domain || host.endsWith('.' + b.domain));
  return { ...profile, brand: brand || { name: host || '웹사이트', color: '#64748b' } };
};

globalThis.SOURCE_LENS_KIND = {
  icons: { svgMin: 8, skipChrome: false, wantSvg: true, extra: true },
  stock: { svgMin: 64, skipChrome: true, wantSvg: false, extra: true, upgrade: true },
  design: { svgMin: 24, skipChrome: true, wantSvg: true, extra: true, upgrade: true },
  community: { svgMin: 48, skipChrome: true, wantSvg: false, extra: true, upgrade: true },
  commerce: { svgMin: 40, skipChrome: true, wantSvg: false, extra: true, upgrade: true },
  video: { svgMin: 48, skipChrome: true, wantSvg: false, extra: true },
  portal: { svgMin: 24, skipChrome: true, wantSvg: false, extra: true, upgrade: true },
  social: { svgMin: 36, skipChrome: true, wantSvg: false, extra: true },
  youtube: { svgMin: 48, skipChrome: true, wantSvg: false, extra: true },
  instagram: { svgMin: 36, skipChrome: true, wantSvg: false, extra: true },
  facebook: { svgMin: 36, skipChrome: true, wantSvg: false, extra: true },
  tiktok: { svgMin: 36, skipChrome: true, wantSvg: false, extra: true },
  vimeo: { svgMin: 48, skipChrome: true, wantSvg: false, extra: true },
  naver: { svgMin: 24, skipChrome: true, wantSvg: false, extra: true, upgrade: true },
  kakao: { svgMin: 24, skipChrome: true, wantSvg: false, extra: true, upgrade: true },
  daum: { svgMin: 24, skipChrome: true, wantSvg: false, extra: true, upgrade: true },
  ai: { svgMin: 24, skipChrome: true, wantSvg: true, extra: true },
  generic: { svgMin: 12, skipChrome: true, wantSvg: true, extra: true }
};

globalThis.SOURCE_LENS_SITES = [
  ['lucide.dev','icons'],['tabler.io','icons'],['icon-sets.iconify.design','icons'],['icones.js.org','icons'],
  ['thenounproject.com','icons'],['iconfinder.com','icons'],['icons8.com','icons'],['flaticon.com','icons'],
  ['iconbuddy.app','icons'],['lordicon.com','icons'],['streamlinehq.com','icons'],['app.iconsax.io','icons'],
  ['atlasicons.vectopus.com','icons'],
  ['unsplash.com','stock'],['pixabay.com','stock'],['pexels.com','stock'],['stocksnap.io','stock'],
  ['freeimages.com','stock'],['lifeofpix.com','stock'],['kaboompics.com','stock'],['picjumbo.com','stock'],
  ['freestocktextures.com','stock'],['foodiesfeed.com','stock'],['mockupworld.co','stock'],['mockupfree.co','stock'],
  ['mockup.ceacle.com','stock'],['thestocks.im','stock'],['videezy.com','stock'],['videos.pexels.com','video'],
  ['dribbble.com','design'],['behance.net','design'],['notefolio.net','design'],['loud.kr','design'],
  ['awwwards.com','design'],['siteinspire.com','design'],['thefwa.com','design'],['layers.to','design'],
  ['cofolios.com','design'],['refero.design','design'],['ui.aceternity.com','design'],['magicui.design','design'],
  ['uiverse.io','design'],['figcomponents.com','design'],['designsystems.surf','design'],['uibowl.io','design'],
  ['gdweb.co.kr','design'],['logopia.co.kr','design'],['logopolly.com','design'],['logopond.com','design'],
  ['logosystem.co','design'],['pentree.net','design'],['hi-d.kr','design'],['wwit.design','design'],
  ['uxarchive.com','design'],['themeforest.net','design'],
  ['dcinside.com','community'],['ygosu.com','community'],['humoruniv.com','community'],['etoland.co.kr','community'],
  ['arca.live','community'],['ppomppu.co.kr','community'],['aagag.com','community'],['bamgosu.co.kr','community'],
  ['hotdeal.zip','community'],['fmkorea.com','community'],
  ['danawa.com','commerce'],['enuri.com','commerce'],['gmarket.co.kr','commerce'],['auction.co.kr','commerce'],
  ['coupang.com','commerce'],['11st.co.kr','commerce'],['smartstore.naver.com','commerce'],
  ['shopping.naver.com','commerce'],['brand.naver.com','commerce'],['tmon.co.kr','commerce'],['ssg.com','commerce'],
  ['lotteon.com','commerce'],['yqien.shop','commerce'],['amazon.com','commerce'],
  ['youtube.com','youtube'],['youtu.be','youtube'],['vimeo.com','vimeo'],['tiktok.com','tiktok'],
  ['tv.garden','video'],['capcut.com','video'],['jitter.video','video'],['instagram.com','instagram'],
  ['facebook.com','facebook'],['fb.watch','facebook'],['x.com','social'],['twitter.com','social'],
  ['naver.com','naver'],['blog.naver.com','naver'],['daum.net','daum'],['kakao.com','kakao'],
  ['tistory.com','portal'],['datalab.naver.com','portal'],
  ['openai.com','ai'],['chatgpt.com','ai'],['gemini.google.com','ai'],['wrtn.ai','ai'],
  ['craiyon.com','ai'],['getimg.ai','ai'],['photoroom.com','ai'],['clipdrop.co','ai'],
  ['build.nvidia.com','ai'],['lmarena.ai','ai'],['creatie.ai','ai'],['vrew.ai','ai']
].map(([host, kind]) => ({ host, kind }));

globalThis.sourceLensSite = function (host) {
  host = (host || '').toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  const hit = SOURCE_LENS_SITES.find(s => host === s.host || host.endsWith('.' + s.host));
  const profile = typeof sourceLensProfileFor === 'function'
    ? sourceLensProfileFor(host)
    : { kind: 'generic', brand: { name: host || '웹사이트', color: '#64748b' } };
  const kind = hit?.kind || (profile.kind === 'commerce' ? 'commerce' : profile.kind === 'image' ? 'stock' : profile.kind) || 'generic';
  const defaults = SOURCE_LENS_KIND[kind] || SOURCE_LENS_KIND.generic;
  return { host, kind, ...defaults, brand: profile.brand };
};
