const api = globalThis.chrome;
const $ = s => document.querySelector(s);
$('#ver').textContent = api.runtime.getManifest().version;

api.storage.local.get('slPrefs', data => {
  const p = data.slPrefs || {};
  $('#altClick').checked = p.altClick !== false;
  $('#autoVideo').checked = p.autoVideo !== false;
  $('#dock').value = p.dock === 'left' ? 'left' : 'right';
  $('#folder').value = p.folder || '';
});

$('#save').onclick = () => {
  const folder = $('#folder').value.trim().replace(/[\\:*?"<>|]+/g, '_').replace(/^\/+|\/+$/g, '');
  api.storage.local.get('slPrefs', data => {
    api.storage.local.set({
      slPrefs: {
        ...(data.slPrefs || {}),
        altClick: $('#altClick').checked,
        autoVideo: $('#autoVideo').checked,
        dock: $('#dock').value,
        folder
      }
    }, () => {
      $('#saved').textContent = '저장했습니다';
      setTimeout(() => { $('#saved').textContent = ''; }, 1800);
    });
  });
};

$('#shortcuts').onclick = () => api.tabs.create({ url: 'chrome://extensions/shortcuts' });

if (api.commands?.getAll) {
  api.commands.getAll(cmds => {
    const get = name => cmds.find(c => c.name === name)?.shortcut || '(지정 안 됨)';
    $('#k-panel').textContent = get('open-panel');
    $('#k-inspect').textContent = get('inspect-selection');
  });
}
