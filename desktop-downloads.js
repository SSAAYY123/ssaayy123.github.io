const desktopDownloadLinks = new Map();
const pendingDesktopKeys = new Set();
async function prepareDesktopDownloads(files) {
  if (!getToken()) return;
  const keys = files.map(file => file.key).filter(key => {
    const link = desktopDownloadLinks.get(key);
    return !pendingDesktopKeys.has(key) && (!link || link.expiresAt < Date.now() + 30000);
  }).slice(0, 30);
  if (!keys.length) return;
  keys.forEach(key => pendingDesktopKeys.add(key));
  try {
    const response = await apiFetch('/api/download-links', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys })
    });
    if (!response.ok) return;
    const data = await response.json();
    if (!getToken()) return;
    data.links.forEach(link => desktopDownloadLinks.set(link.key, { url: new URL(link.path, API).href, expiresAt: link.expiresAt }));
  } catch (error) { /* Ordinary and double-click downloads remain available. */ }
  finally { keys.forEach(key => pendingDesktopKeys.delete(key)); }
}
function addDesktopDownloadData(transfer, file) {
  const link = desktopDownloadLinks.get(file.key);
  if (!link || link.expiresAt <= Date.now()) return false;
  const name = file.name.replace(/[\r\n:]/g, '_');
  transfer.setData('DownloadURL', 'application/octet-stream:' + name + ':' + link.url);
  // Keep text/plain as the R2 key for existing in-site folder moves.
  transfer.effectAllowed = 'copyMove';
  return true;
}
document.getElementById('logoutButton').addEventListener('click', () => desktopDownloadLinks.clear());
window.addEventListener('pagehide', () => desktopDownloadLinks.clear());
