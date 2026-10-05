const params = new URLSearchParams(location.search);
const mode = params.get('mode') || 'stable';

async function start() {
  if (mode === 'legacy') {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@azure/msal-browser@2.38.4/lib/msal-browser.min.js';
      script.crossOrigin = 'anonymous';
      script.onload = resolve;
      script.onerror = () => reject(new Error('Não foi possível carregar a biblioteca Microsoft.'));
      document.head.append(script);
    });
    await import('./app.js?v=19');
  } else if (mode === 'full') {
    await import('./next/app-next.js?v=20');
    await import('./next/medical-appointments-quick-v26.js?v=27');
    await import('./next/pwa-install-v24.js?v=24');
  } else {
    await import('./next/app-stable-v1.js?v=1');
    await import('./next/pwa-install-v24.js?v=24');
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch((error) => console.warn('Service worker:', error));
  }
}

start();
