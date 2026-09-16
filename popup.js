const api = globalThis.browser || globalThis.chrome;
let images = [];
const $ = s => document.querySelector(s);
function esc(v) {
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;' }[c]));
}
function tabsQuery(q) { return new Promise(resolve => api.tabs.query(q, resolve)); }
function send(tabId, msg) {
  return new Promise(resolve => api.tabs.sendMessage(tabId, msg, r => { void api.runtime.lastError; resolve(r || {}); }));
}
function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
}
function junk(url) {
  return /rsrc\.php|static\.cdninstagram|static\.xx\.fbcdn|\.gif(?:$|[?#])/i.test(url || '');
}
function render() {
  const list = $('#list');
  list.textContent = '';
  $('#count').textContent = `이미지 ${images.length}개`;
  images.forEach((im, i) => {
    const row = document.createElement('label');
    row.className = 'item';
    row.innerHTML = `<input type="checkbox" data-i="${i}"><img class="thumb" src="${esc(im.url)}"><span class="item-body"><b>${esc(im.name || '이미지')}</b><span class="item-url" title="${esc(im.url)}">${esc(im.url)}</span><span class="item-meta">${im.width && im.height ? `${im.width}×${im.height}` : ''}</span></span>`;
    list.append(row);
  });
}
function selected() {
  return [...document.querySelectorAll('.item input:checked')].map(x => images[Number(x.dataset.i)]).filter(Boolean);
}
async function load() {
  const tabs = await tabsQuery({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) return;
  $('#pageHost').textContent = tab.url ? new URL(tab.url).hostname : '현재 페이지';
  const result = await send(tab.id, { type: 'listImages' });
  images = (result.images || []).filter(im => im.url && !junk(im.url));
  render();
}
$('#refresh').onclick = load;
$('#selectAll').onchange = e => document.querySelectorAll('.item input').forEach(x => { x.checked = e.target.checked; });
$('#copy').onclick = async () => {
  const urls = selected().map(x => x.url);
  if (!urls.length) { $('#status').textContent = '이미지를 선택하세요.'; return; }
  await navigator.clipboard.writeText(urls.join('\n'));
  $('#status').textContent = `${urls.length}개 URL을 복사했습니다.`;
};
$('#download').onclick = () => {
  const items = selected();
  if (!items.length) { $('#status').textContent = '이미지를 선택하세요.'; return; }
  items.forEach((x, i) => api.downloads.download({
    url: x.url,
    saveAs: false,
    filename: `source-lens/${String(i + 1).padStart(2, '0')}-${x.name || 'image'}`
  }, () => void api.runtime.lastError));
  $('#status').textContent = `${items.length}개 다운로드를 시작했습니다.`;
};
$('#oneClickVideo').onclick = async () => {
  const tabs = await tabsQuery({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) return;
  $('#status').textContent = '저장 준비 중…';
  const result = await send(tab.id, { type: 'oneClickVideo' });
  if (result.ok && result.mode === 'file') $('#status').textContent = '원본 파일 저장을 시작했습니다.';
  else if (result.ok && result.mode === 'blob') $('#status').textContent = '영상을 저장했습니다.';
  else if (result.ok && result.mode === 'live') $('#status').textContent = '라이브 녹화 중. 페이지의 검은 바를 누르면 저장됩니다.';
  else if (result.ok) $('#status').textContent = '재생이 끝나면 자동 저장됩니다. 탭을 유지하세요.';
  else $('#status').textContent = result.error || '영상을 찾지 못했습니다. 영상을 재생한 뒤 다시 눌러 주세요.';
};
$('#zip').onclick = () => {
  const items = selected();
  if (!items.length) { $('#status').textContent = '이미지를 선택하세요.'; return; }
  $('#status').textContent = 'ZIP 만드는 중…';
  api.runtime.sendMessage({
    type: 'zipDownload',
    items: items.map((x, i) => ({ url: x.url, name: `${String(i + 1).padStart(2, '0')}-${x.name || 'image'}` })),
    filename: 'source-lens/selected.zip'
  }, result => {
    $('#status').textContent = result?.ok ? `ZIP ${result.count}개 저장` : (result?.error || 'ZIP 실패');
  });
};

function loadHistory() {
  api.storage.local.get('slHistory', data => {
    const box = $('#history');
    box.textContent = '';
    (data.slHistory || []).slice(0, 8).forEach(row => {
      const a = document.createElement('a');
      a.className = 'hist';
      a.href = row.page;
      a.target = '_blank';
      a.rel = 'noopener';
      a.innerHTML = `<b>${esc(row.title || row.host)}</b><span>${esc(row.host)} · ${(row.items || []).length}개 · ${new Date(row.ts).toLocaleString()}</span>`;
      box.append(a);
    });
  });
}

load();
loadHistory();
