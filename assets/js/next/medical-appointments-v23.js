import { supabase, currentSession } from './supabase.js?v=20';

let overlay = null;
let appointments = [];
let context = null;
let saving = false;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const attr = esc;

function localDateTimeValue(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16);
}

function isoOrEmpty(raw) {
  if (!raw) return '';
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function numText(raw) {
  const v = String(raw ?? '').trim().replace(',','.');
  if (!v) return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '';
}

function formatDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Data não informada';
  return new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(d);
}

function toast(message, error=false) {
  let region = document.querySelector('#medical-v23-toast');
  if (!region) {
    region = document.createElement('div');
    region.id = 'medical-v23-toast';
    region.className = 'medical-v23-toast-region';
    document.body.append(region);
  }
  const box = document.createElement('div');
  box.className = `medical-v23-toast${error?' medical-v23-toast--error':''}`;
  box.textContent = message;
  region.append(box);
  setTimeout(()=>box.remove(), error ? 7000 : 3000);
}

async function getContext(force=false) {
  if (context && !force) return context;
  const session = await currentSession();
  if (!session) throw new Error('Sua sessão expirou. Entre novamente no app.');
  const result = await supabase.rpc('my_access_context');
  if (result.error) throw result.error;
  if (!result.data?.active || !result.data?.family_id) throw new Error('Não foi possível identificar sua família ativa.');
  context = {...result.data, session};
  return context;
}

async function loadAppointments() {
  const ctx = await getContext();
  const result = await supabase.from('medical_appointments').select('*').eq('family_id',ctx.family_id).order('appointment_at',{ascending:false});
  if (result.error) throw result.error;
  appointments = result.data || [];
  return appointments;
}

function closeOverlay() {
  overlay?.remove();
  document.querySelectorAll('.medical-v23-overlay').forEach(n=>n.remove());
  overlay = null;
}

function card(row) {
  const done = Boolean(row.diagnosis || row.medical_notes || row.recommendations || row.prescribed_medications || row.ordered_exams || row.vaccines_guidance || row.parent_notes);
  return `<article class="medical-v23-card">
    <div><small>${esc(formatDateTime(row.appointment_at))}</small><h3>${esc([row.specialty,row.doctor_name].filter(Boolean).join(' · ') || 'Consulta médica')}</h3>${row.reason?`<p>${esc(row.reason)}</p>`:''}<span>${done?'Registro preenchido':(new Date(row.appointment_at)<new Date()?'Aguardando registro':'Agendada')}</span></div>
    <button type="button" class="button button--secondary button--small" data-medical-edit="${attr(row.id)}">Editar</button>
  </article>`;
}

async function openList() {
  try {
    await getContext(true);
    await loadAppointments();
    closeOverlay();
    overlay = document.createElement('div');
    overlay.className = 'medical-v23-overlay';
    overlay.innerHTML = `<section class="medical-v23-panel" role="dialog" aria-modal="true">
      <header class="medical-v23-header"><div><p class="medical-v23-eyebrow">Saúde</p><h2>Consultas médicas</h2><p>Cadastre e edite tudo antes, durante e depois da consulta.</p></div><button type="button" class="medical-v23-close" data-medical-close>×</button></header>
      <div class="medical-v23-toolbar"><button type="button" class="button" data-medical-new>＋ Nova consulta</button></div>
      <section class="medical-v23-list">${appointments.length?appointments.map(card).join(''):'<div class="medical-v23-empty"><strong>Nenhuma consulta cadastrada.</strong><p>Toque em Nova consulta para começar.</p></div>'}</section>
    </section>`;
    document.body.append(overlay);
  } catch(e) { console.error(e); toast(e.message || 'Não foi possível abrir as consultas.',true); }
}

function section(title,subtitle,body){return `<section class="medical-v23-section"><div><h3>${esc(title)}</h3>${subtitle?`<p>${esc(subtitle)}</p>`:''}</div>${body}</section>`;}

function formMarkup(row=null) {
  return `<form id="medical-v23-form" class="medical-v23-form">
    <input type="hidden" name="id" value="${attr(row?.id||'')}">
    ${section('1. Consulta','Informações do agendamento.',`
      <div class="medical-v23-grid medical-v23-grid--2"><label>Data e horário<input name="appointment_at" type="datetime-local" required value="${attr(localDateTimeValue(row?.appointment_at || new Date()))}"></label><label>Especialidade<input name="specialty" required value="${attr(row?.specialty || 'Pediatria')}"></label></div>
      <div class="medical-v23-grid medical-v23-grid--2"><label>Médico(a) / profissional<input name="doctor_name" value="${attr(row?.doctor_name||'')}"></label><label>Clínica / hospital<input name="clinic_or_hospital" value="${attr(row?.clinic_or_hospital||'')}"></label></div>
      <label>Motivo da consulta<textarea name="reason" rows="2">${esc(row?.reason||'')}</textarea></label>`)}
    ${section('2. Durante a consulta','Registre as informações enquanto conversa com o profissional.',`
      <label>Queixa principal<textarea name="chief_complaint" rows="2">${esc(row?.chief_complaint||'')}</textarea></label>
      <label>Histórico relatado<textarea name="history_reported" rows="3">${esc(row?.history_reported||'')}</textarea></label>
      <div class="medical-v23-grid medical-v23-grid--4"><label>Peso (kg)<input name="weight_kg" inputmode="decimal" value="${attr(row?.weight_kg??'')}"></label><label>Altura (cm)<input name="height_cm" inputmode="decimal" value="${attr(row?.height_cm??'')}"></label><label>Perímetro cefálico (cm)<input name="head_circumference_cm" inputmode="decimal" value="${attr(row?.head_circumference_cm??'')}"></label><label>Temperatura (°C)<input name="temperature_c" inputmode="decimal" value="${attr(row?.temperature_c??'')}"></label></div>`)}
    ${section('3. Como foi a consulta','Tudo que precisa ficar registrado para depois.',`
      <label>Diagnóstico / avaliação<textarea name="diagnosis" rows="2">${esc(row?.diagnosis||'')}</textarea></label>
      <label>Anotações médicas<textarea name="medical_notes" rows="3">${esc(row?.medical_notes||'')}</textarea></label>
      <label>Orientações e recomendações<textarea name="recommendations" rows="3">${esc(row?.recommendations||'')}</textarea></label>
      <label>Medicamentos prescritos<textarea name="prescribed_medications" rows="2">${esc(row?.prescribed_medications||'')}</textarea></label>
      <label>Exames solicitados<textarea name="ordered_exams" rows="2">${esc(row?.ordered_exams||'')}</textarea></label>
      <label>Orientações sobre vacinas<textarea name="vaccines_guidance" rows="2">${esc(row?.vaccines_guidance||'')}</textarea></label>
      <div class="medical-v23-grid medical-v23-grid--2"><label>Próximo retorno<input name="return_at" type="datetime-local" value="${attr(row?.return_at?localDateTimeValue(row.return_at):'')}"></label><label>Observações dos pais<textarea name="parent_notes" rows="2">${esc(row?.parent_notes||'')}</textarea></label></div>`)}
    <div class="medical-v23-footer"><button type="button" class="button button--secondary" data-medical-back>Voltar</button><button type="submit" class="button" data-medical-save>Salvar consulta</button></div>
  </form>`;
}

function openEditor(id='') {
  const row = id ? appointments.find(x=>x.id===id) : null;
  if (id && !row) return toast('Consulta não encontrada.',true);
  closeOverlay();
  overlay = document.createElement('div');
  overlay.className = 'medical-v23-overlay';
  overlay.innerHTML = `<section class="medical-v23-panel medical-v23-panel--form" role="dialog" aria-modal="true"><header class="medical-v23-header"><div><p class="medical-v23-eyebrow">Consultas médicas</p><h2>${row?'Editar consulta':'Nova consulta'}</h2><p>Você poderá alterar qualquer campo depois.</p></div><button type="button" class="medical-v23-close" data-medical-close>×</button></header>${formMarkup(row)}</section>`;
  document.body.append(overlay);
}

async function save(form) {
  if (saving) return;
  saving = true;
  const button = form.querySelector('[data-medical-save]');
  if (button) { button.disabled=true; button.textContent='Salvando…'; }
  try {
    const ctx = await getContext(true);
    const f = new FormData(form);
    const appointmentAt = isoOrEmpty(f.get('appointment_at'));
    if (!appointmentAt) throw new Error('Informe a data e o horário da consulta.');
    const payload = {
      id: String(f.get('id')||'').trim() || null,
      family_id: ctx.family_id,
      doctor_name: String(f.get('doctor_name')||'').trim(),
      specialty: String(f.get('specialty')||'Pediatria').trim() || 'Pediatria',
      clinic_or_hospital: String(f.get('clinic_or_hospital')||'').trim(),
      appointment_at: appointmentAt,
      reason: String(f.get('reason')||'').trim(),
      chief_complaint: String(f.get('chief_complaint')||'').trim(),
      history_reported: String(f.get('history_reported')||'').trim(),
      weight_kg: numText(f.get('weight_kg')),
      height_cm: numText(f.get('height_cm')),
      head_circumference_cm: numText(f.get('head_circumference_cm')),
      temperature_c: numText(f.get('temperature_c')),
      diagnosis: String(f.get('diagnosis')||'').trim(),
      medical_notes: String(f.get('medical_notes')||'').trim(),
      recommendations: String(f.get('recommendations')||'').trim(),
      prescribed_medications: String(f.get('prescribed_medications')||'').trim(),
      ordered_exams: String(f.get('ordered_exams')||'').trim(),
      vaccines_guidance: String(f.get('vaccines_guidance')||'').trim(),
      return_at: isoOrEmpty(f.get('return_at')),
      parent_notes: String(f.get('parent_notes')||'').trim(),
    };
    const result = await supabase.rpc('save_medical_appointment',{payload});
    if (result.error) throw result.error;
    toast(payload.id ? 'Consulta atualizada com sucesso.' : 'Consulta salva com sucesso.');
    await openList();
  } catch(e) {
    console.error('Falha ao salvar consulta',e);
    toast(`Erro ao salvar: ${e?.message || 'falha desconhecida'}`,true);
    if (button) { button.disabled=false; button.textContent='Salvar consulta'; }
  } finally { saving=false; }
}

function enhance() {
  const main = document.querySelector('#main-content');
  const heading = main?.querySelector('.page-heading h1,.next-page-heading h1');
  const title = heading?.textContent?.trim();
  if (title==='Mais') {
    const grid = main.querySelector('.next-feature-grid');
    if (grid && !grid.querySelector('[data-medical-open]')) {
      const b=document.createElement('button'); b.type='button'; b.className='medical-v23-feature'; b.dataset.medicalOpen='1';
      b.innerHTML='<span>✚</span><div><strong>Consultas médicas</strong><small>Agendar, editar e registrar como foi</small></div>';
      grid.prepend(b);
    }
  }
  if (title==='Agenda') {
    const ph=heading.closest('.page-heading,.next-page-heading');
    if (ph && !ph.querySelector('[data-medical-open]')) { const b=document.createElement('button'); b.type='button'; b.className='button button--secondary button--small'; b.dataset.medicalOpen='1'; b.textContent='Consultas médicas'; ph.append(b); }
  }
}

document.addEventListener('click',async(e)=>{
  if(e.target.closest('[data-medical-open]')){e.preventDefault();e.stopPropagation();return openList();}
  if(e.target.closest('[data-medical-close]')){e.preventDefault();return closeOverlay();}
  if(e.target.closest('[data-medical-new]')){e.preventDefault();return openEditor();}
  const edit=e.target.closest('[data-medical-edit]'); if(edit){e.preventDefault();return openEditor(edit.dataset.medicalEdit||'');}
  if(e.target.closest('[data-medical-back]')){e.preventDefault();return openList();}
},true);

document.addEventListener('submit',async(e)=>{
  if(e.target?.id!=='medical-v23-form') return;
  e.preventDefault(); e.stopImmediatePropagation(); await save(e.target);
},true);

function styles(){if(document.querySelector('#medical-v23-styles'))return;const s=document.createElement('style');s.id='medical-v23-styles';s.textContent=`
.medical-v23-feature{appearance:none;border:1px solid var(--border,rgba(58,87,82,.18));background:var(--surface,#fff);border-radius:18px;padding:1rem;text-align:left;display:flex;align-items:center;gap:.8rem;min-height:92px;color:inherit;font:inherit;cursor:pointer;width:100%;box-shadow:0 8px 24px rgba(41,62,58,.06)}.medical-v23-feature>span{width:42px;height:42px;border-radius:14px;display:grid;place-items:center;background:rgba(47,111,102,.12);font-size:1.25rem;color:#2f6f66}.medical-v23-feature strong,.medical-v23-feature small{display:block}.medical-v23-feature small{margin-top:.28rem;opacity:.72}.medical-v23-overlay{position:fixed;inset:0;z-index:10000;background:rgba(17,28,26,.6);display:flex;align-items:flex-end;justify-content:center}.medical-v23-panel{width:min(850px,100%);max-height:95dvh;overflow:auto;background:var(--surface,#fff);color:var(--text,#20302d);border-radius:24px 24px 0 0;padding:1rem 1rem max(1rem,env(safe-area-inset-bottom))}.medical-v23-panel--form{width:min(930px,100%)}.medical-v23-header{display:flex;justify-content:space-between;gap:1rem;position:sticky;top:-1rem;background:var(--surface,#fff);z-index:2;padding:1rem 0 .8rem;border-bottom:1px solid var(--border,rgba(58,87,82,.12))}.medical-v23-header h2{margin:.1rem 0 .25rem}.medical-v23-header p{margin:0;opacity:.72}.medical-v23-eyebrow{text-transform:uppercase;letter-spacing:.09em;font-size:.72rem;font-weight:700;color:#2f6f66!important;opacity:1!important}.medical-v23-close{border:0;background:transparent;font-size:2rem;color:inherit}.medical-v23-toolbar{display:flex;justify-content:flex-end;padding:1rem 0}.medical-v23-list{display:grid;gap:.75rem}.medical-v23-card{display:flex;justify-content:space-between;gap:1rem;align-items:center;padding:1rem;border:1px solid var(--border,rgba(58,87,82,.15));border-radius:16px}.medical-v23-card small{font-weight:700;color:#2f6f66}.medical-v23-card h3{margin:.25rem 0}.medical-v23-card p{margin:.2rem 0 .5rem}.medical-v23-card span{font-size:.76rem;font-weight:700;color:#2f6f66}.medical-v23-empty{text-align:center;padding:2rem;border:1px dashed var(--border,rgba(58,87,82,.25));border-radius:16px}.medical-v23-form{display:grid;gap:1rem;padding-top:1rem}.medical-v23-section{display:grid;gap:.8rem;border:1px solid var(--border,rgba(58,87,82,.15));border-radius:18px;padding:1rem}.medical-v23-section h3{margin:0}.medical-v23-section>div>p{margin:.2rem 0 0;opacity:.68}.medical-v23-form label{display:grid;gap:.38rem;font-weight:650;font-size:.88rem}.medical-v23-form input,.medical-v23-form textarea{width:100%;box-sizing:border-box;border:1px solid var(--border,rgba(58,87,82,.2));border-radius:12px;padding:.78rem .85rem;background:var(--surface,#fff);color:inherit;font:inherit}.medical-v23-grid{display:grid;gap:.75rem}.medical-v23-grid--2{grid-template-columns:repeat(2,minmax(0,1fr))}.medical-v23-grid--4{grid-template-columns:repeat(4,minmax(0,1fr))}.medical-v23-footer{display:flex;justify-content:flex-end;gap:.75rem;position:sticky;bottom:-1rem;background:var(--surface,#fff);padding:1rem 0 calc(1rem + env(safe-area-inset-bottom));border-top:1px solid var(--border,rgba(58,87,82,.12))}.medical-v23-toast-region{position:fixed;z-index:12000;top:calc(.8rem + env(safe-area-inset-top));left:50%;transform:translateX(-50%);width:min(92vw,540px)}.medical-v23-toast{background:#225d54;color:#fff;padding:.9rem 1rem;border-radius:12px;font-weight:700;box-shadow:0 12px 32px rgba(0,0,0,.25)}.medical-v23-toast--error{background:#8b2f2f}@media(max-width:680px){.medical-v23-overlay{align-items:stretch}.medical-v23-panel{height:100dvh;max-height:none;border-radius:0;padding-top:max(1rem,env(safe-area-inset-top))}.medical-v23-grid--2,.medical-v23-grid--4{grid-template-columns:1fr}.medical-v23-card{align-items:flex-start}.medical-v23-footer{bottom:calc(-1rem - env(safe-area-inset-bottom))}}
`;document.head.append(s);}
styles();
new MutationObserver(()=>requestAnimationFrame(enhance)).observe(document.querySelector('#app'),{childList:true,subtree:true});
enhance();
console.info('APP MARIA consultas v23 ativa');
