
import { supabase, currentSession } from './supabase.js?v=20';

const browserTimers = new Map();
let alertOverlay = null;

function hashId(value) {
  let hash = 2166136261;
  for (const ch of String(value || '')) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash | 0) || 1;
}

function nativeNotifications() {
  return window.Capacitor?.Plugins?.LocalNotifications || null;
}

function bodyFor(task) {
  const med = task.medications || {};
  const parts = [
    med.dose ? `Dose: ${med.dose}` : '',
    med.route ? `Via: ${med.route}` : '',
    task.instructions || med.guidance || '',
  ].filter(Boolean);
  return parts.join(' · ') || 'Confira as orientações no APP MARIA.';
}

async function browserPermission(interactive = false) {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  if (!interactive) return 'default';
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

async function nativePermission(interactive = false) {
  const plugin = nativeNotifications();
  if (!plugin) return 'unsupported';
  try {
    const current = await plugin.checkPermissions();
    if (current?.display === 'granted') return 'granted';
    if (!interactive) return current?.display || 'prompt';
    const result = await plugin.requestPermissions();
    return result?.display || 'denied';
  } catch (error) {
    console.warn('Permissão de alerta nativo:', error);
    return 'error';
  }
}

async function showBrowserNotification(task) {
  const permission = await browserPermission(false);
  if (permission !== 'granted') return;
  const options = {
    body: bodyFor(task),
    tag: `maria-medication-${task.id}`,
    data: { taskId: task.id, url: location.href },
    renotify: true,
  };
  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(task.title || 'Hora do medicamento', options);
    } else {
      new Notification(task.title || 'Hora do medicamento', options);
    }
  } catch (error) {
    console.warn('Notificação do navegador:', error);
  }
}

function showInAppAlert(task) {
  alertOverlay?.remove();
  alertOverlay = document.createElement('div');
  alertOverlay.className = 'maria-reminder-overlay';
  alertOverlay.innerHTML = `
    <section class="maria-reminder-card" role="alertdialog" aria-modal="true">
      <p>Medicamento</p>
      <h2>${escapeHtml(task.title || 'Hora do medicamento')}</h2>
      <div>${escapeHtml(bodyFor(task))}</div>
      <button type="button" data-reminder-close>Entendi</button>
    </section>`;
  document.body.append(alertOverlay);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[char]));
}

function scheduleActiveBrowserTimer(task) {
  const due = new Date(task.due_at).getTime();
  const delay = due - Date.now();
  if (delay <= 0 || delay > 24 * 60 * 60 * 1000) return;
  if (browserTimers.has(task.id)) clearTimeout(browserTimers.get(task.id));
  const timer = setTimeout(async () => {
    browserTimers.delete(task.id);
    showInAppAlert(task);
    await showBrowserNotification(task);
  }, delay);
  browserTimers.set(task.id, timer);
}

async function scheduleNative(tasks) {
  const plugin = nativeNotifications();
  if (!plugin || !tasks.length) return;
  const granted = await nativePermission(false);
  if (granted !== 'granted') return;
  const notifications = tasks
    .filter((task) => new Date(task.due_at).getTime() > Date.now())
    .slice(0, 120)
    .map((task) => ({
      id: hashId(task.id + '|' + task.due_at),
      title: task.title || 'Hora do medicamento',
      body: bodyFor(task),
      schedule: { at: new Date(task.due_at), allowWhileIdle: true },
      extra: { taskId: task.id, medicationId: task.medication_id || null },
    }));
  if (!notifications.length) return;
  try { await plugin.schedule({ notifications }); }
  catch (error) { console.warn('Agendamento de alertas nativos:', error); }
}

async function upcomingMedicationTasks({ medicationId = '', days = 30 } = {}) {
  const session = await currentSession();
  if (!session) return [];
  const from = new Date().toISOString();
  const toDate = new Date();
  toDate.setDate(toDate.getDate() + days);
  let query = supabase
    .from('care_tasks')
    .select('id,title,due_at,instructions,medication_id,status,medications(name,dose,route,guidance)')
    .eq('task_kind', 'medication')
    .eq('status', 'pending')
    .gte('due_at', from)
    .lte('due_at', toDate.toISOString())
    .order('due_at', { ascending: true });
  if (medicationId) query = query.eq('medication_id', medicationId);
  const result = await query;
  if (result.error) {
    console.warn('Não foi possível carregar lembretes de medicamentos.', result.error);
    return [];
  }
  return result.data || [];
}

export async function enableMedicationAlerts() {
  const native = nativeNotifications();
  const permission = native
    ? await nativePermission(true)
    : await browserPermission(true);
  if (permission !== 'granted') throw new Error('Permissão de notificações não concedida.');
  await refreshMedicationReminders();
  return true;
}

export async function refreshMedicationReminders(options = {}) {
  const tasks = await upcomingMedicationTasks(options);
  tasks.forEach(scheduleActiveBrowserTimer);
  await scheduleNative(tasks);
  return tasks.length;
}

export async function scheduleMedicationRemindersForMedication(medicationId, { requestPermission = false } = {}) {
  if (requestPermission) {
    try { await enableMedicationAlerts(); }
    catch (error) { console.warn(error.message); }
  }
  return refreshMedicationReminders({ medicationId, days: 30 });
}

document.addEventListener('click', (event) => {
  if (!event.target.closest('[data-reminder-close]')) return;
  event.preventDefault();
  alertOverlay?.remove();
  alertOverlay = null;
}, true);

const style = document.createElement('style');
style.textContent = `
.maria-reminder-overlay{position:fixed;inset:0;z-index:20000;background:rgba(10,22,20,.58);display:grid;place-items:center;padding:20px}
.maria-reminder-card{width:min(92vw,460px);background:#fff;color:#17332f;border-radius:20px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.28)}
.maria-reminder-card p{margin:0 0 5px;text-transform:uppercase;letter-spacing:.08em;font-size:.72rem;font-weight:800;color:#2f7d71}
.maria-reminder-card h2{margin:0 0 12px}.maria-reminder-card div{line-height:1.5}
.maria-reminder-card button{margin-top:18px;width:100%;border:0;border-radius:12px;padding:12px;background:#2f7d71;color:#fff;font-weight:800}
`;
document.head.append(style);

setTimeout(() => refreshMedicationReminders().catch(() => {}), 3000);
setInterval(() => refreshMedicationReminders({ days: 1 }).catch(() => {}), 5 * 60 * 1000);
