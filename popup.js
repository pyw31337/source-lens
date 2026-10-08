const api = globalThis.chrome;
const SL = globalThis.SourceLens;
const $ = s => document.querySelector(s);
const state = {
  tab: null,
  data: { images: [], videos: [], svgs: [] },
  view: 'images',
  query: '',
  minPx: 0,
  selected: new Set(),
  host: '',
  videoLocked: false
};

function setStatus(text, kind) {
  const el = $('#status');
  el.textContent = text || '';
  el.className = kind === 'error' ? 'error' : '';
}

function savePrefs(patch) {
  api.storage.local.get('slPrefs', data => api.storage.local.set({ slPrefs: { ...(data.slPrefs || {}), ...patch } }));
}

function activeTab() {
  return new Promise(resolve => api.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0])));
}

function exec(tabId, details) {
  return new Promise(resolve => {
    api.scripting.executeScript({ target: { tabId, allFrames: true }, ...details }, results => {
      resolve({ results: results || [], error: api.runtime.lastError?.message || '' });
    });
  });
}

const listInFrame = () => (typeof window.__sourceLensList === 'function' ? window.__sourceLensList() : null);

async function collect(tab) {
  let run = await exec(tab.id, { func: listInFrame });
  if (run.error && !run.results.length) throw new Error(run.error);
  if (!run.results.some(r => r && r.result)) {
    // Tab was opened before the extension was (re)loaded: inject the scripts now.
    await exec(tab.id, { files: ['inject-main.js', 'shared.js', 'platform-profiles.js', 'extractors.js'], world: 'MAIN' });
    await exec(tab.id, { files: ['shared.js', 'platform-profiles.js', 'media-tools.js', 'video-finder.js', 'content.js'] });
    await new Promise(r => setTimeout(r, 250));
    run = await exec(tab.id, { func: listInFrame });
  }
  const merged = { images: [], videos: [], svgs: [] };
  const seen = new Set();
  let videoLocked = false;
  run.results.forEach(r => {
    const res = r && r.result;
    if (!res) return;
    if (res.top) videoLocked = !!res.videoLocked;
    ['images', 'videos', 'svgs'].forEach(kind => (res[kind] || []).forEach(item => {
      if (kind === 'videos') item = { ...item, frameId: r.frameId };
      const key = kind === 'videos'
        ? `v:${item.kind}:${item.url || (item.job && (item.job.url || (item.job.xml || '').slice(0, 300))) || `${r.frameId}:${item.vid}`}`
        : `${kind}:${item.type === 'svg' && item.code ? item.code.slice(0, 400) : item.url}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged[kind].push({ ...item, frame: res.top ? 'top' : 'frame' });
    }));
  });
  merged.images.sort((a, b) => (b.px || 0) - (a.px || 0));
  return { ...merged, videoLocked };
}

function visible() {
  let list = state.data[state.view] || [];
  if (state.view === 'images' && state.minPx) list = list.filter(i => (i.px || 0) >= state.minPx);
  const q = state.query.trim().toLowerCase();
  if (q) {
    const words = q.split(/\s+/);
    list = list.filter(i => {
      const hay = `${i.name || ''} ${/^data:/i.test(i.url || '') ? '' : i.url} ${i.source || ''} ${i.note || ''} ${i.quality || ''}`.toLowerCase();
      return words.every(w => hay.includes(w));
    });
  }
  return list;
}

function keyOf(item) {
  if (item.kind) return `v:${item.kind}:${item.url || item.job?.url || item.quality}:${item.frameId}:${item.vid}`;
  return `${item.type}:${item.type === 'svg' && item.code ? item.code.slice(0, 400) : item.url}`;
}

function targets() {
  const list = visible();
  const chosen = list.filter(i => state.selected.has(keyOf(i)));
  return { list: chosen.length ? chosen : list, chosen: chosen.length };
}

function updateFooter() {
  const list = visible();
  const { chosen } = targets();
  const n = chosen || list.length;
  $('#download').textContent = `저장 (${n})`;
  $('#zip').textContent = `ZIP (${Math.min(n, 40)})`;
  $('#zip').hidden = state.view === 'videos';
  $('#copy').textContent = state.view === 'svgs' ? `코드 복사 (${n})` : `URL 복사 (${n})`;
  ['#download', '#zip', '#copy'].forEach(sel => { $(sel).disabled = !list.length; });
  const all = $('#selectAll');
  all.checked = list.length > 0 && chosen === list.length;
  all.indeterminate = chosen > 0 && chosen < list.length;
  $('#count').textContent = chosen ? `${chosen}개 선택됨 / ${list.length}개` : `${list.length}개 · 고르지 않으면 전체 처리`;
}

function emptyMessage() {
  if (state.query.trim()) return `「${state.query.trim()}」에 맞는 항목이 없습니다.`;
  if (state.view === 'videos') {
    return '찾은 영상이 없습니다. 영상을 한 번 재생한 뒤(인스타·페북은 영상을 화면에 띄운 뒤) ↻ 를 눌러 보세요.';
  }
  if (state.view === 'images' && state.minPx && (state.data.images || []).length) return `${state.minPx}px 이상 이미지가 없습니다. 크기 필터를 「모든 크기」로 바꿔 보세요.`;
  if (state.view === 'svgs') return '찾은 SVG가 없습니다.';
  return '찾은 이미지가 없습니다. 페이지를 아래로 스크롤해 이미지를 불러온 뒤 ↻ 를 눌러 보세요.';
}

function thumb(item) {
  if (item.type === 'video') {
    const box = document.createElement('div');
    box.className = 'thumb video-thumb';
    box.textContent = item.temporary ? '▶ 세션 영상' : item.stream ? '▶ 스트림' : '▶ 영상';
    return box;
  }
  const img = document.createElement('img');
  img.className = `thumb${item.type === 'svg' ? ' svg-thumb' : ''}`;
  img.loading = 'lazy';
  img.alt = '';
  img.referrerPolicy = 'no-referrer-when-downgrade';
  img.src = item.type === 'svg' && item.code
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(item.code)}`
    : item.url;
  img.onerror = () => {
    const box = document.createElement('div');
    box.className = 'thumb broken';
    box.textContent = '미리보기 없음';
    img.replaceWith(box);
  };
  return img;
}

function render() {
  const listEl = $('#list');
  listEl.textContent = '';
  ['images', 'videos', 'svgs'].forEach(kind => {
    $(`#n-${kind}`).textContent = kind === 'videos' ? state.data.videos.filter(v => v.kind !== 'drm').length : state.data[kind].length;
  });
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.view));
  $('#minPx').hidden = state.view !== 'images';
  const list = visible();
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = emptyMessage();
    listEl.append(empty);
    updateFooter();
    return;
  }
  listEl.classList.toggle('vlist', state.view === 'videos');
  if (state.view === 'videos') {
    const help = document.createElement('p');
    help.className = 'vhelp';
    help.textContent = '위에서부터 추천 순서입니다. 원본 파일 → 스트림 합치기(DASH/HLS) → 녹화 순으로 좋아요.';
    listEl.append(help);
    list.forEach(item => listEl.append(videoRow(item)));
    updateFooter();
    return;
  }
  list.forEach(item => {
    const key = keyOf(item);
    const tile = document.createElement('div');
    tile.className = 'tile';
    if (state.selected.has(key)) tile.classList.add('checked');
    tile.title = `${item.name || ''}\n${/^data:/i.test(item.url) ? '(인라인 SVG)' : item.url}\n${item.state || ''}`;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'check';
    box.checked = state.selected.has(key);
    box.setAttribute('aria-label', '선택');
    const toggle = on => {
      if (on) state.selected.add(key); else state.selected.delete(key);
      box.checked = on;
      tile.classList.toggle('checked', on);
      updateFooter();
    };
    box.onclick = ev => { ev.stopPropagation(); toggle(box.checked); };
    tile.onclick = () => toggle(!state.selected.has(key));
    tile.append(box, thumb(item));
    const meta = document.createElement('div');
    meta.className = 'meta';
    const dims = item.width && item.height ? `${item.width}×${item.height}` : item.width ? `폭 ${item.width}px` : '';
    meta.textContent = [dims, item.signed ? '만료 주소' : '', item.frame === 'frame' ? '프레임' : ''].filter(Boolean).join(' · ') || (item.source || '');
    tile.append(meta);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.onclick = ev => { ev.stopPropagation(); fn(b); };
      actions.append(b);
    };
    mk('저장', '이 파일 저장', () => saveItems([item]));
    mk(item.type === 'svg' ? '코드' : '복사', item.type === 'svg' ? 'SVG 코드 복사' : 'URL 복사', b => copyText(item.type === 'svg' && item.code ? item.code : item.url, b));
    if (!/^data:|^blob:/i.test(item.url)) mk('열기', '새 탭에서 열기', () => api.tabs.create({ url: item.url, active: false }));
    tile.append(actions);
    listEl.append(tile);
  });
  updateFooter();
}

const fmtClock = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const BTN = { direct: '저장', dash: 'MP4로 받기', hls: 'MP4로 받기', record: '녹화 저장', drm: '저장 불가' };

function videoRow(item) {
  const key = keyOf(item);
  const row = document.createElement('div');
  row.className = `vrow k-${item.kind}${item.playing ? ' playing' : ''}${state.selected.has(key) ? ' checked' : ''}`;
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'check';
  box.checked = state.selected.has(key);
  box.setAttribute('aria-label', '선택');
  box.onclick = ev => {
    ev.stopPropagation();
    if (box.checked) state.selected.add(key); else state.selected.delete(key);
    row.classList.toggle('checked', box.checked);
    updateFooter();
  };
  const head = document.createElement('div');
  head.className = 'vhead';
  const badge = document.createElement('span');
  badge.className = `vbadge k-${item.kind}`;
  badge.textContent = item.badge || item.kind;
  const facts = document.createElement('b');
  facts.textContent = [item.quality, item.codec, item.audio === true ? '소리 포함' : item.audio === false ? '소리 없음' : '', item.duration ? fmtClock(item.duration) : '', item.playing ? '지금 보는 영상' : '', item.frameId ? '프레임' : ''].filter(Boolean).join(' · ') || item.source || '';
  head.append(box, badge, facts);
  const note = document.createElement('p');
  note.className = 'vnote';
  note.textContent = item.note || '';
  const actions = document.createElement('div');
  actions.className = 'actions';
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'brand';
  main.textContent = BTN[item.kind] || '저장';
  main.disabled = item.kind === 'drm';
  main.onclick = () => saveVideo(item, main);
  actions.append(main);
  if (item.url) {
    const c = document.createElement('button');
    c.type = 'button';
    c.textContent = '주소 복사';
    c.onclick = () => copyText(item.url, c);
    actions.append(c);
  }
  row.append(head, note, actions);
  return row;
}

async function saveVideo(item, button) {
  const tab = state.tab || await activeTab();
  if (item.kind === 'drm') { setStatus(item.note, 'error'); return { ok: false }; }
  if (item.kind === 'direct') {
    if (button) button.textContent = '확인 중…';
    const res = await sendMessage({ type: 'downloadUrl', url: item.url, filename: `source-lens/${item.file || 'video.mp4'}` });
    if (button) button.textContent = res.ok ? '저장됨 ✓' : '실패';
    setStatus(res.ok ? `원본 영상 저장을 시작했습니다 · ${item.file || ''}` : `원본 주소가 거절됐습니다 (${res.error || ''}). 페이지를 새로고침하거나 아래 다른 방법을 써 보세요.`, res.ok ? '' : 'error');
    return res;
  }
  if (item.kind === 'dash' || item.kind === 'hls') {
    const host = state.host.replace(/^www\./, '');
    const res = await sendMessage({ type: 'mediaJob', tabId: tab?.id, job: { ...item.job, file: item.file, title: item.title, host, quality: 0 } });
    setStatus(res.ok ? '새 탭에서 받아 하나의 MP4로 합칩니다.' : `시작하지 못했습니다: ${res.error || ''}`, res.ok ? '' : 'error');
    return res;
  }
  // record: runs inside the page so it keeps going after this popup closes
  return new Promise(resolve => {
    api.tabs.sendMessage(tab.id, { type: 'recordVideo', vid: item.vid }, { frameId: item.frameId || 0 }, result => {
      void api.runtime.lastError;
      result = result || {};
      if (result.ok) {
        setStatus(result.mode === 'live' ? '라이브 녹화 중 · 페이지 아래 「지금 저장」을 누르면 저장됩니다.' : '녹화를 시작했습니다. 영상이 끝나면 자동 저장됩니다. 탭을 열어 두세요.');
        setTimeout(() => window.close(), 1500);
      } else setStatus(result.error || '녹화를 시작하지 못했습니다.', 'error');
      resolve(result);
    });
  });
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const prev = button.textContent;
      button.textContent = '✓';
      setTimeout(() => { button.textContent = prev; }, 1000);
    }
    setStatus('복사했습니다.');
  } catch (e) {
    setStatus(`복사하지 못했습니다: ${e.message || e}`, 'error');
  }
}

function sendMessage(msg) {
  return new Promise(resolve => api.runtime.sendMessage(msg, r => { void api.runtime.lastError; resolve(r || {}); }));
}

async function saveItems(items) {
  let ok = 0, fail = 0, skipped = 0;
  if (items.some(i => i.kind)) {
    const runnable = items.filter(i => i.kind === 'direct' || i.kind === 'dash' || i.kind === 'hls');
    for (const item of runnable.slice(0, 10)) {
      const r = await saveVideo(item);
      if (r && r.ok) ok += 1; else fail += 1;
    }
    skipped = items.length - runnable.length;
    const parts = [`${ok}개 영상 저장을 시작했습니다`];
    if (fail) parts.push(`${fail}개 실패`);
    if (skipped) parts.push(`녹화·DRM 항목 ${skipped}개는 각 줄의 버튼을 쓰세요`);
    setStatus(parts.join(' · '), fail && !ok ? 'error' : '');
    return;
  }
  for (const item of items) {
    if (item.type === 'video' && (item.temporary || /^blob:/i.test(item.url))) { skipped += 1; continue; }
    if (item.stream) { skipped += 1; continue; }
    let res;
    if (item.type === 'svg' && item.code) {
      res = await sendMessage({ type: 'downloadUrl', url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(item.code)}`, filename: `source-lens/${item.file}` });
    } else {
      res = await sendMessage({ type: 'downloadUrl', url: item.url, filename: `source-lens/${item.file}` });
    }
    if (res.ok) ok += 1; else fail += 1;
    setStatus(`저장 중… ${ok + fail}/${items.length}`);
  }
  const parts = [`${ok}개 저장을 시작했습니다`];
  if (fail) parts.push(`${fail}개 실패`);
  if (skipped) parts.push(`${skipped}개는 세션/스트림 영상이라 「영상 저장」 버튼을 쓰세요`);
  setStatus(parts.join(' · '), fail && !ok ? 'error' : '');
}

async function load() {
  setStatus('');
  $('#count').textContent = '찾는 중…';
  const tab = await activeTab();
  state.tab = tab;
  if (!tab) return;
  let host = '';
  try { host = new URL(tab.url).hostname; } catch { /* ignore */ }
  state.host = host;
  $('#pageHost').textContent = host || '현재 페이지';
  if (!/^https?:/i.test(tab.url || '')) {
    state.data = { images: [], videos: [], svgs: [] };
    render();
    $('#list').innerHTML = '<p class="empty">이 페이지(브라우저 설정·새 탭·웹스토어 등)는 보안상 확장 프로그램이 분석할 수 없습니다. 일반 웹사이트에서 열어 주세요.</p>';
    ['#openPanel', '#oneClickVideo'].forEach(sel => { $(sel).disabled = true; });
    $('#count').textContent = '';
    return;
  }
  ['#openPanel', '#oneClickVideo'].forEach(sel => { $(sel).disabled = false; });
  try {
    const data = await collect(tab);
    state.data = data;
    state.videoLocked = data.videoLocked;
    const known = new Set(['images', 'videos', 'svgs'].flatMap(k => data[k].map(keyOf)));
    state.selected.forEach(k => { if (!known.has(k)) state.selected.delete(k); });
    if (!state.data[state.view].length) {
      state.view = ['images', 'videos', 'svgs'].find(k => state.data[k].length) || state.view;
    }
    render();
  } catch (error) {
    state.data = { images: [], videos: [], svgs: [] };
    render();
    setStatus(`이 페이지를 읽지 못했습니다. 페이지를 새로고침(⌘R / F5)한 뒤 다시 열어 주세요. (${error.message || error})`, 'error');
  }
}

$('#refresh').onclick = load;
$('#settings').onclick = () => api.runtime.openOptionsPage();
document.querySelectorAll('.tabs button').forEach(btn => {
  btn.onclick = () => {
    state.view = btn.dataset.tab;
    state.selected.clear();
    render();
  };
});
$('#search').oninput = e => { state.query = e.target.value; render(); };
$('#minPx').onchange = e => { state.minPx = Number(e.target.value) || 0; savePrefs({ minPx: state.minPx }); render(); };
$('#selectAll').onchange = e => {
  visible().forEach(i => (e.target.checked ? state.selected.add(keyOf(i)) : state.selected.delete(keyOf(i))));
  render();
};
$('#copy').onclick = () => {
  const { list } = targets();
  if (state.view === 'svgs') {
    const codes = list.map(i => i.code).filter(Boolean);
    if (!codes.length) return setStatus('복사할 SVG 코드가 없습니다.', 'error');
    return copyText(codes.join('\n\n'));
  }
  const urls = list.map(i => i.url).filter(u => u && !/^data:/i.test(u));
  if (!urls.length) return setStatus('복사할 URL이 없습니다.', 'error');
  copyText(urls.join('\n')).then(() => setStatus(`${urls.length}개 URL을 복사했습니다.`));
};
$('#download').onclick = () => {
  const { list } = targets();
  if (!list.length) return;
  saveItems(list);
};
$('#zip').onclick = () => {
  const { list } = targets();
  if (!list.length) return;
  const items = list.slice(0, 40);
  setStatus(`ZIP 만드는 중… (${items.length}개)`);
  $('#zip').disabled = true;
  api.runtime.sendMessage({
    type: 'zipDownload',
    items: items.map((x, i) => ({
      url: x.type === 'svg' && x.code ? '' : x.url,
      code: x.type === 'svg' ? (x.code || '') : '',
      name: `${String(i + 1).padStart(2, '0')}-${x.file || 'media'}`
    })),
    filename: `source-lens/${(state.host || 'page').replace(/^www\./, '')}-media.zip`
  }, result => {
    void api.runtime.lastError;
    $('#zip').disabled = false;
    if (result?.ok) setStatus(`ZIP에 ${result.count}개를 담아 저장했습니다${list.length > 40 ? ' (최대 40개)' : ''}.`);
    else setStatus(result?.error || 'ZIP을 만들지 못했습니다. 「저장」으로 하나씩 받아 보세요.', 'error');
  });
};
$('#openPanel').onclick = async () => {
  const tab = state.tab || await activeTab();
  if (!tab) return;
  const tabName = { images: 'image', videos: 'video', svgs: 'svg' }[state.view];
  api.tabs.sendMessage(tab.id, { type: 'openPanel', tab: tabName }, { frameId: 0 }, () => {
    if (api.runtime.lastError) {
      setStatus('페이지에 연결하지 못했습니다. 페이지를 새로고침한 뒤 다시 눌러 주세요.', 'error');
      return;
    }
    window.close();
  });
};
$('#oneClickVideo').onclick = async () => {
  const tab = state.tab || await activeTab();
  if (!tab) return;
  setStatus('영상 저장 준비 중…');
  api.tabs.sendMessage(tab.id, { type: 'oneClickVideo' }, { frameId: 0 }, result => {
    void api.runtime.lastError;
    result = result || {};
    if (result.ok && result.mode === 'file') setStatus('원본 영상 파일 저장을 시작했습니다.');
    else if (result.ok && result.mode === 'stream') setStatus('새 탭에서 영상을 받아 하나의 MP4로 합칩니다.');
    else if (result.mode === 'drm') setStatus(result.error || 'DRM 보호 영상이라 저장할 수 없습니다.', 'error');
    else if (result.ok && result.mode === 'stop') setStatus('녹화를 멈추고 저장합니다.');
    else if (result.ok && result.mode === 'blob') setStatus('영상을 저장했습니다.');
    else if (result.ok && result.mode === 'live') setStatus('라이브 녹화 중입니다. 페이지 아래 초록 바를 누르면 저장됩니다.');
    else if (result.ok && result.mode === 'image') setStatus('영상이 아니라 이미지라서 이미지로 저장했습니다.');
    else if (result.ok) setStatus('재생이 끝나면 자동으로 저장됩니다. 이 탭을 닫지 마세요.');
    else setStatus(result.error || '영상을 찾지 못했습니다. 영상을 재생한 뒤 다시 눌러 주세요.', 'error');
  });
};

document.addEventListener('keydown', ev => {
  if (ev.key === '/' && document.activeElement !== $('#search')) {
    ev.preventDefault();
    $('#search').focus();
  }
});

function loadHistory() {
  api.storage.local.get('slHistory', data => {
    const box = $('#history');
    box.textContent = '';
    const rows = (data.slHistory || []).slice(0, 8);
    if (!rows.length) {
      box.innerHTML = '<p class="empty small">아직 기록이 없습니다.</p>';
      return;
    }
    rows.forEach(row => {
      if (!/^https?:/i.test(row.page || '')) return;
      const a = document.createElement('a');
      a.className = 'hist';
      a.href = row.page;
      a.target = '_blank';
      a.rel = 'noopener';
      const b = document.createElement('b');
      b.textContent = row.title || row.host;
      const span = document.createElement('span');
      span.textContent = `${row.host} · ${(row.items || []).length}개 · ${new Date(row.ts).toLocaleString()}`;
      a.append(b, span);
      box.append(a);
    });
  });
}

function loadShortcutLabel() {
  if (!api.commands?.getAll) return;
  api.commands.getAll(cmds => {
    const panel = cmds.find(c => c.name === 'open-panel');
    $('#panelKey').textContent = panel?.shortcut || '';
    $('#panelKey').hidden = !panel?.shortcut;
  });
}

$('#ver').textContent = api.runtime.getManifest().version;
api.storage.local.get('slPrefs', data => {
  state.minPx = Number(data.slPrefs?.minPx) || 0;
  $('#minPx').value = String(state.minPx);
  load();
});
loadHistory();
loadShortcutLabel();
