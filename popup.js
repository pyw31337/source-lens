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
load();
