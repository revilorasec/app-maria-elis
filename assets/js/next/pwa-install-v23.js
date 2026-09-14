let deferredInstallPrompt = null;
let installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

function toast(message) {
  let box = document.querySelector('#pwa-install-toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'pwa-install-toast';
    box.style.cssText = 'position:fixed;z-index:13000;left:50%;top:16px;transform:translateX(-50%);max-width:92vw;padding:12px 16px;border-radius:12px;background:#225d54;color:#fff;font-weight:700;box-shadow:0 12px 32px rgba(0,0,0,.25)';
    document.body.append(box);
  }
  box.textContent = message;
  setTimeout(()=>box?.remove(),5000);
}

function label() {
  return installed ? 'App instalado' : 'Instalar app';
}

function subtitle() {
  return installed ? 'O APP MARIA já está instalado neste dispositivo' : 'Adicionar o APP MARIA à tela inicial do celular';
}

function enhance() {
  const main = document.querySelector('#main-content');
  const heading = main?.querySelector('.page-heading h1,.next-page-heading h1');
  if (heading?.textContent?.trim() !== 'Mais') return;
  const grid = main.querySelector('.next-feature-grid');
  if (!grid || grid.querySelector('[data-install-maria]')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pwa-install-card';
  button.dataset.installMaria = '1';
  button.innerHTML = `<span class="pwa-install-card__icon">↓</span><span><strong>${label()}</strong><small>${subtitle()}</small></span>`;
  grid.append(button);
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
    const choice = await prompt.userChoice.catch(()=>null);
    if (choice?.outcome === 'accepted') toast('Instalação iniciada.');
    else toast('A instalação foi cancelada. Você pode tentar novamente depois.');
    return;
  }
  toast('No Chrome, toque no menu ⋮ e escolha “Instalar app” ou “Adicionar à tela inicial”.');
}

window.addEventListener('beforeinstallprompt',(event)=>{
  event.preventDefault();
  deferredInstallPrompt = event;
  enhance();
});

window.addEventListener('appinstalled',()=>{
  installed = true;
  deferredInstallPrompt = null;
  document.querySelectorAll('[data-install-maria]').forEach((button)=>{
    button.querySelector('strong').textContent = label();
    button.querySelector('small').textContent = subtitle();
  });
  toast('APP MARIA instalado com sucesso.');
});

document.addEventListener('click',(event)=>{
  const button = event.target.closest('[data-install-maria]');
  if (!button) return;
  event.preventDefault();
  install();
},true);

const style = document.createElement('style');
style.textContent = `.pwa-install-card{appearance:none;border:1px solid var(--border,rgba(58,87,82,.18));background:var(--surface,#fff);border-radius:18px;padding:1rem;text-align:left;display:flex;align-items:center;gap:.8rem;min-height:92px;color:inherit;font:inherit;cursor:pointer;width:100%;box-shadow:0 8px 24px rgba(41,62,58,.06)}.pwa-install-card__icon{width:42px;height:42px;border-radius:14px;display:grid;place-items:center;background:rgba(47,111,102,.12);font-size:1.25rem;color:#2f6f66;flex:0 0 auto}.pwa-install-card strong,.pwa-install-card small{display:block}.pwa-install-card small{margin-top:.28rem;opacity:.72;line-height:1.25}`;
document.head.append(style);
new MutationObserver(()=>requestAnimationFrame(enhance)).observe(document.querySelector('#app'),{childList:true,subtree:true});
enhance();
