let container;

function getContainer() {
  if (container) return container;
  container = document.createElement('div');
  container.className = 'toast-region';
  container.setAttribute('aria-live', 'polite');
  document.body.append(container);
  return container;
}

export function notify(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  getContainer().append(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

export function offlineNotice() {
  return navigator.onLine ? null : 'Você está offline. Os registros ficam neste aparelho até a sincronização.';
}
