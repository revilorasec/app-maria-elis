const params = new URLSearchParams(location.search);
const next = params.get('mode') !== 'legacy';

async function start() {
  if (next) {
    await import('./next/app-next.js?v=19');
  } else {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@azure/msal-browser@2.38.4/lib/msal-browser.min.js';
      script.crossOrigin = 'anonymous';
      script.onload = resolve;
      script.onerror = () => reject(new Error('Não foi possível carregar a biblioteca Microsoft.'));
      document.head.append(script);
    });
    await import('./app.js?v=19');
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch((error) => console.warn('Service worker:', error));
  }
}

start();












