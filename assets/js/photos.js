export async function resizeImage(file, maxSize = 1280, quality = 0.78) {
  if (!file?.type?.startsWith('image/')) throw new Error('Selecione uma imagem válida.');
  const source = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Não foi possível abrir a imagem.'));
      element.src = source;
    });
    const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Falha ao comprimir a foto.')), 'image/jpeg', quality));
    return { blob, thumbnailUrl: canvas.toDataURL('image/jpeg', 0.65) };
  } finally { URL.revokeObjectURL(source); }
}

export function eventPhotoPath(type, date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  const iso = local.toISOString();
  const day = iso.slice(0, 10);
  const [year, month] = day.split('-');
  const time = iso.slice(11, 19).replaceAll(':', '-');
  return 'Fotos/' + year + '/' + month + '/' + day + '_' + time + '_' + slug(type) + '.jpg';
}

export function queuePendingPhoto(entry) {
  return withStore('readwrite', (store) => store.put(entry));
}

export function listPendingPhotos() {
  return withStore('readonly', (store) => store.getAll());
}

export function removePendingPhoto(id) {
  return withStore('readwrite', (store) => store.delete(id));
}

function slug(value) {
  return String(value || 'evento').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'evento';
}

function withStore(mode, action) {
  return new Promise((resolve, reject) => {
    const requestDb = indexedDB.open('maria-onedrive-pending', 1);
    requestDb.onupgradeneeded = () => {
      if (!requestDb.result.objectStoreNames.contains('photos')) requestDb.result.createObjectStore('photos', { keyPath: 'id' });
    };
    requestDb.onerror = () => reject(requestDb.error);
    requestDb.onsuccess = () => {
      const db = requestDb.result;
      const transaction = db.transaction('photos', mode);
      let operation;
      try { operation = action(transaction.objectStore('photos')); }
      catch (error) { db.close(); reject(error); return; }
      operation.onsuccess = () => resolve(operation.result);
      operation.onerror = () => reject(operation.error);
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  });
}
