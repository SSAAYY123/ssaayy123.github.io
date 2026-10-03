// Original images stay in FILES; resized downloads are generated in the browser.
function isPhotoName(name) {
  return /\.(jpe?g|png|gif|webp|bmp|svg|heic|heif|avif|tiff?)$/i.test(name);
}
function photoDimensions(width, height, maxWidth = 500) {
  if (!(width > 0 && height > 0)) throw new Error('사진 크기를 확인할 수 없습니다.');
  const targetWidth = Math.min(width, maxWidth);
  return { width: targetWidth, height: Math.max(1, Math.round(height * targetWidth / width)) };
}
async function resizePhotoBlob(blob, maxWidth = 500) {
  let image, sourceUrl;
  try {
    if (typeof createImageBitmap === 'function') {
      try { image = await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (error) { /* Try browser image decoding below. */ }
    }
    if (!image) {
      sourceUrl = URL.createObjectURL(blob);
      image = new Image();
      image.src = sourceUrl;
      await image.decode();
    }
    const size = photoDimensions(image.naturalWidth || image.width, image.naturalHeight || image.height, maxWidth);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('사진 변환을 지원하지 않는 브라우저입니다.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(image, 0, 0, size.width, size.height);
    const result = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!result) throw new Error('사진 변환에 실패했습니다.');
    return result;
  } catch (error) {
    throw new Error('이 사진을 변환할 수 없습니다. HEIC 등 지원되지 않는 형식은 JPG/PNG로 변환 후 올리거나 일반 다운로드를 이용해주세요.');
  } finally {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    if (image && typeof image.close === 'function') image.close();
  }
}
function savePhotoBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function fetchPhotoBlob(key) {
  const response = await apiFetch('/api/download?key=' + encodeURIComponent(key));
  if (!response.ok) throw new Error('사진을 불러오지 못했습니다.');
  return response.blob();
}
async function downloadSmallPhoto(key, name, button) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    const original = await fetchPhotoBlob(key);
    const resized = await resizePhotoBlob(original, 500);
    savePhotoBlob(resized, name.replace(/\.[^.]+$/, '') + '_500px.jpg');
  } catch (error) { alert(error.message); }
  finally { if (button) button.disabled = false; }
}
let photoCursor = null;
let photoLoading = false;
let photoGeneration = 0;
let photoObserver = null;
let photoPreviewUrls = [];
let photoPreviewQueue = [];
let photoPreviewActive = 0;

function clearPhotoPreviews() {
  photoGeneration++;
  photoObserver?.disconnect();
  photoPreviewQueue = [];
  photoPreviewUrls.forEach(url => URL.revokeObjectURL(url));
  photoPreviewUrls = [];
}
async function runPhotoPreviews() {
  while (photoPreviewActive < 3 && photoPreviewQueue.length) {
    const item = photoPreviewQueue.shift();
    photoPreviewActive++;
    (async () => {
      try {
        const blob = await fetchPhotoBlob(item.key);
        if (item.generation !== photoGeneration) return;
        const thumbnail = await resizePhotoBlob(blob, 300);
        if (item.generation !== photoGeneration) return;
        const url = URL.createObjectURL(thumbnail);
        photoPreviewUrls.push(url);
        const image = document.createElement('img'); image.src = url; image.alt = item.name;
        item.element.replaceChildren(image);
      } catch (error) {
        if (item.generation === photoGeneration) item.element.textContent = '미리보기 불가 · 일반 다운로드 가능';
      } finally { photoPreviewActive--; runPhotoPreviews(); }
    })();
  }
}
function renderPhotoCard(photo) {
  const card = document.createElement('article'); card.className = 'photoCard';
  const preview = document.createElement('div'); preview.className = 'photoPreview'; preview.textContent = '사진 불러오는 중…';
  preview.dataset.key = photo.key; preview.dataset.name = photo.name;
  const info = document.createElement('div'); info.className = 'photoInfo';
  const name = document.createElement('div'); name.className = 'photoName'; name.textContent = photo.name;
  const path = document.createElement('div'); path.className = 'photoPath';
  const folder = photo.key.includes('/') ? photo.key.slice(0, photo.key.lastIndexOf('/')) : '최상위 폴더';
  path.textContent = folder + ' · ' + formatSize(photo.size);
  const actions = document.createElement('div'); actions.className = 'photoActions';
  const original = document.createElement('button'); original.textContent = '일반 다운로드';
  original.onclick = () => downloadFile(photo.key);
  const small = document.createElement('button'); small.textContent = '저용량 · 500px';
  small.onclick = () => downloadSmallPhoto(photo.key, photo.name, small);
  actions.append(original, small); info.append(name, path, actions); card.append(preview, info);
  document.getElementById('photoGrid').appendChild(card);
  if (photoObserver) photoObserver.observe(preview);
  else { photoPreviewQueue.push({ key: photo.key, name: photo.name, element: preview, generation: photoGeneration }); runPhotoPreviews(); }
}
async function loadPhotos(reset = true) {
  if (photoLoading) return;
  photoLoading = true;
  const status = document.getElementById('photoStatus');
  const more = document.getElementById('photoMoreButton'); more.disabled = true;
  if (reset) {
    clearPhotoPreviews(); photoCursor = null;
    document.getElementById('photoGrid').replaceChildren();
    if (typeof IntersectionObserver === 'function') {
      photoObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          photoObserver.unobserve(entry.target);
          photoPreviewQueue.push({ key: entry.target.dataset.key, name: entry.target.dataset.name, element: entry.target, generation: photoGeneration });
        }
        runPhotoPreviews();
      }, { rootMargin: '100px' });
    }
  }
  const generation = photoGeneration;
  status.textContent = '사진 불러오는 중…';
  try {
    const response = await apiFetch('/api/photos' + (photoCursor ? '?cursor=' + encodeURIComponent(photoCursor) : ''));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '사진 목록을 불러오지 못했습니다.');
    if (generation !== photoGeneration) return;
    photoCursor = data.cursor;
    data.photos.forEach(renderPhotoCard);
    const count = document.getElementById('photoGrid').children.length;
    status.textContent = count ? count + '장의 사진' : '아직 표시할 사진이 없습니다.';
    more.classList.toggle('hidden', !photoCursor);
  } catch (error) { if (generation === photoGeneration) status.textContent = error.message; }
  finally { photoLoading = false; more.disabled = false; }
}
document.getElementById('photosTab').onclick = async function() {
  for (const tab of ['files','notes','calendar']) {
    document.getElementById(tab + 'Tab').classList.remove('active');
    document.getElementById(tab + 'Section').classList.add('hidden');
  }
  this.classList.add('active');
  document.getElementById('photosSection').classList.remove('hidden');
  await loadPhotos();
};
document.getElementById('photoUploadButton').onclick = () => document.getElementById('photoInput').click();
async function uploadPhotoItems(items) {
  if (!items.length) return;
  const button = document.getElementById('photoUploadButton');
  if (button.disabled) return;
  button.disabled = true;
  try {
    const images = items.filter(item => {
      const file = item.file || item;
      return file.type.startsWith('image/') || isPhotoName(file.name);
    });
    if (images.length !== items.length) alert('사진 파일만 업로드할 수 있습니다. 사진 이외의 파일은 제외했어요.');
    if (!images.length) return;
    await uploadFiles(images, '사진');
    await loadPhotos();
  } finally { button.disabled = false; }
}
document.getElementById('photoInput').onchange = async function() {
  const files = Array.from(this.files || []); this.value = '';
  await uploadPhotoItems(files);
};
const photoDropzone = document.getElementById('photoDropzone');
photoDropzone.addEventListener('dragover', function(event) {
  if (!Array.from(event.dataTransfer.types || []).includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  this.classList.add('dragover');
});
photoDropzone.addEventListener('dragleave', function() { this.classList.remove('dragover'); });
photoDropzone.addEventListener('drop', async function(event) {
  event.preventDefault(); event.stopPropagation(); this.classList.remove('dragover');
  // Capture handles synchronously; the browser clears drag data after this event.
  const handles = Array.from(event.dataTransfer.items || []).filter(item => item.kind === 'file').map(item => {
    const getEntry = item.webkitGetAsEntry || item.getAsEntry;
    return { entry: getEntry ? getEntry.call(item) : null, file: item.getAsFile() };
  });
  const fallbackFiles = Array.from(event.dataTransfer.files || []);
  const files = [];
  try {
    for (const handle of handles) {
      if (handle.entry) await collectDroppedEntry(handle.entry, '', files);
      else if (handle.file) files.push(handle.file);
    }
    await uploadPhotoItems(handles.length ? files : fallbackFiles);
  } catch (error) { alert('사진을 읽지 못했습니다. 다시 끌어놓거나 사진 업로드 버튼을 이용해주세요.'); }
});
document.getElementById('photoRefreshButton').onclick = () => loadPhotos();
document.getElementById('photoMoreButton').onclick = () => loadPhotos(false);
document.getElementById('logoutButton').addEventListener('click', clearPhotoPreviews);
window.addEventListener('pagehide', clearPhotoPreviews);
