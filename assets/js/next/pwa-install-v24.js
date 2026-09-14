let deferredInstallPrompt = null;
let installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

function toast(message) {
  let box = document.querySelector('#pwa-install-toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'pwa-install-toast';
    box.style.cssText = 'position:fixed;z-index:14000;left:50%;top:16px;transform:translateX(-50%);max-width:92vw;padding:12px 16px;border-radius:12px;background:#225d54;color:#fff;font-weight:700;box-shadow:0 12px 32px rgba(0,0,0,.25)';
    document.body.append(box);
  }
  box.textContent = message;
  setTimeout(() => box?.remove(), 6000);
}

function text() {
  return installed ? 'App instalado' : 'Instalar app';
}

function subtext() {
  return installed ? 'O APP MARIA já está instalado neste dispositivo' : 'Adicionar o APP MARIA à tela inicial do celular';
}

function updateButtons() {
  document.querySelectorAll('[data-install-maria]').forEach((button) => {
    const strong = button.querySelector('strong');
    const small = button.querySelector('small');
    if (strong) strong.textContent = text();
    if (small) small.textContent = subtext();
  });
}

function morePageGrid() {
  const mains = [...document.querySelectorAll('#main-content, main')];
  for (const main of mains) {
    const heading = main.querySelector('.page-heading h1, .next-page-heading h1, h1');
    if (heading?.textContent?.trim() === 'Mais') {
      return main.querySelector('.next-feature-grid') || main.querySelector('section');
    }
  }
  return null;
}

function ensureMoreCard() {
  const grid = morePageGrid();
  if (!grid || grid.querySelector('[data-install-maria="card"]')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pwa-install-card';
  button.dataset.installMaria = 'card';
  button.innerHTML = `<span class="pwa-install-card__icon">↓</span><span><strong>${text()}</strong><small>${subtext()}</small></span>`;
  grid.append(button);
}

function ensurePersistentButton() {
  if (installed) {
    document.querySelector('[data-install-maria="floating"]')?.remove();
    return;
  }
  if (document.querySelector('[data-install-maria="floating"]')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pwa-install-floating';
  button.dataset.installMaria = 'floating';
  button.innerHTML = '<span>↓</span><strong>Instalar app</strong>';
  document.body.append(button);
}

function enhance() {
  ensureMoreCard();
  ensurePersistentButton();
  updateButtons();
}

async function install() {
  if (installed) {
    toast('O APP MARIA já está instalado neste dispositivo.');
    return;
  }
  if (deferredInstallPrompt) {
    const prompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    await prompt.prompt();
    const choice = await prompt.userChoice.catch(() => null);
    if (choice?.outcome === 'accepted') toast('Instalação iniciada.');
    else toast('A instalação foi cancelada. Você pode tentar novamente depois.');
    return;
  }
  toast('O navegador ainda não liberou a instalação automática. No Chrome, toque em ⋮ e escolha “Instalar app” ou “Adicionar à tela inicial”.');
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  enhance();
});

window.addEventListener('appinstalled', () => {
  installed = true;
  deferredInstallPrompt = null;
  enhance();
  toast('APP MARIA instalado com sucesso.');
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-install-maria]');
  if (!button) return;
  event.preventDefault();
  install();
}, true);

const style = document.createElement('style');
style.textContent = `
.pwa-install-card{appearance:none;border:1px solid var(--border,rgba(58,87,82,.18));background:var(--surface,#fff);border-radius:18px;padding:1rem;text-align:left;display:flex;align-items:center;gap:.8rem;min-height:92px;color:inherit;font:inherit;cursor:pointer;width:100%;box-shadow:0 8px 24px rgba(41,62,58,.06)}
.pwa-install-card__icon{width:42px;height:42px;border-radius:14px;display:grid;place-items:center;background:rgba(47,111,102,.12);font-size:1.25rem;color:#2f6f66;flex:0 0 auto}
.pwa-install-card strong,.pwa-install-card small{display:block}
.pwa-install-card small{margin-top:.28rem;opacity:.72;line-height:1.25}
.pwa-install-floating{position:fixed;right:14px;bottom:86px;z-index:10050;border:0;border-radius:999px;background:#2f6f66;color:#fff;padding:11px 15px;display:flex;align-items:center;gap:8px;font:inherit;box-shadow:0 10px 28px rgba(0,0,0,.22);cursor:pointer}
.pwa-install-floating span{font-size:1.15rem}.pwa-install-floating strong{font-size:.92rem}
@media (min-width:900px){.pwa-install-floating{right:24px;bottom:24px}}
`;
document.head.append(style);

const app = document.querySelector('#app');
if (app) new MutationObserver(() => requestAnimationFrame(enhance)).observe(app, { childList: true, subtree: true });
window.addEventListener('load', enhance);
document.addEventListener('visibilitychange', () => { if (!document.hidden) enhance(); });
setTimeout(enhance, 0);
setTimeout(enhance, 800);
setTimeout(enhance, 2000);
