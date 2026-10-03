// Both tabs drag authenticated, locally loaded originals rather than remote links.
const desktopOriginals = new Map();
const pendingDesktopOriginals = new Map();
let desktopGeneration = 0;
function forgetDesktopOriginal(key) {
  const original = desktopOriginals.get(key);
  if (original) URL.revokeObjectURL(original.url);
  desktopOriginals.delete(key);
}
function clearDesktopOriginals() {
  desktopGeneration++;
  desktopOriginals.forEach(original => URL.revokeObjectURL(original.url));
  desktopOriginals.clear();
  pendingDesktopOriginals.clear();
}
async function getDesktopOriginal(file) {
  if (!getToken()) throw new Error('로그인이 필요합니다.');
  if (desktopOriginals.has(file.key)) return desktopOriginals.get(file.key);
  if (pendingDesktopOriginals.has(file.key)) return pendingDesktopOriginals.get(file.key);
  const generation = desktopGeneration;
  const task = (async () => {
    const blob = await fetchPhotoBlob(file.key);
    if (generation !== desktopGeneration || !getToken()) throw new Error('로그인이 필요합니다.');
    const original = { url: URL.createObjectURL(blob), type: blob.type || 'application/octet-stream', size: blob.size };
    desktopOriginals.set(file.key, original);
    return original;
  })();
  pendingDesktopOriginals.set(file.key, task);
  try { return await task; }
  finally { if (pendingDesktopOriginals.get(file.key) === task) pendingDesktopOriginals.delete(file.key); }
}
async function prepareDesktopDownloads(files, onHover = false) {
  if (!getToken()) return;
  let budget = 16 * 1024 * 1024;
  const selected = files.filter(file => {
    if (onHover) return true;
    if ((file.size || 0) > budget) return false;
    budget -= file.size || 0;
    return true;
  });
  // Keep downloads sequential so listing a folder does not saturate the connection.
  for (const file of selected) {
    try { await getDesktopOriginal(file); } catch (error) { /* Button downloads still work. */ }
  }
}
function addDesktopDownloadData(transfer, file) {
  const original = desktopOriginals.get(file.key);
  if (!original) return false;
  const name = file.name.replace(/[\r\n:]/g, '_');
  transfer.setData('DownloadURL', original.type + ':' + name + ':' + original.url);
  transfer.setData('text/uri-list', original.url);
  transfer.effectAllowed = 'copyMove';
  return true;
}
function bindDesktopPhotoImage(image, file) {
  image.draggable = true;
  image.title = '바탕화면으로 끌어 원본 다운로드';
  image.addEventListener('dragstart', event => {
    event.dataTransfer.setData('text/plain', file.key);
    addDesktopDownloadData(event.dataTransfer, file);
    event.stopPropagation();
  });
}
async function showFilePhotoPreview(file, icon) {
  try {
    const original = await getDesktopOriginal(file);
    if (!icon.isConnected) return;
    const image = document.createElement('img');
    image.src = original.url; image.alt = file.name;
    image.onerror = () => { icon.innerHTML = getFileIconHtml(file.name); };
    bindDesktopPhotoImage(image, file);
    icon.replaceChildren(image);
  } catch (error) { /* Keep the ordinary image icon on decode/download failure. */ }
}
document.getElementById('logoutButton').addEventListener('click', clearDesktopOriginals);
window.addEventListener('pagehide', clearDesktopOriginals);
