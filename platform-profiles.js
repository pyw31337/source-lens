
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
  const profile = sourceLensProfileFor(host);
  const kind = hit?.kind || (profile.kind === 'commerce' ? 'commerce' : profile.kind === 'image' ? 'stock' : profile.kind) || 'generic';
  const defaults = SOURCE_LENS_KIND[kind] || SOURCE_LENS_KIND.generic;
  return { host, kind, ...defaults, brand: profile.brand };
};
