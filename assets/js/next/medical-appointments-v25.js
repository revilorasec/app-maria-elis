import { supabase, currentSession } from './supabase.js?v=20';
import { uploadFile } from './file-picker.js?v=20';
import { enableMedicationAlerts, scheduleMedicationRemindersForMedication } from './medication-reminders.js?v=2';

let overlay = null;
let appointments = [];
let context = null;
let saving = false;
let nextMedicationIndex = 0;
let nextExamIndex = 0;
let medicationCatalog = [];

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const attr = esc;
const pad = (value) => String(value).padStart(2,'0');

function localDateTimeValue(value) {
  if (!value) return '';
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
function localDateOnly(value) {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function nowRounded() {
  const d = new Date();
  d.setSeconds(0,0);
  return localDateTimeValue(d);
}
function formatDateTime(value) {
  if (!value) return 'Data não informada';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Data não informada';
  return new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(d);
}
function toast(message, error=false) {
  let region = document.querySelector('#medical-v25-toast');
  if (!region) {
    region = document.createElement('div');
    region.id = 'medical-v25-toast';
    region.className = 'medical-v25-toast-region';
    document.body.append(region);
  }
  const box = document.createElement('div');
  box.className = 'medical-v25-toast' + (error ? ' medical-v25-toast--error' : '');
  box.textContent = message;
  region.append(box);
  setTimeout(()=>box.remove(), error ? 7000 : 3500);
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
}
async function loadCareItems(appointmentId) {
  if (!appointmentId) return { medications: [], exams: [] };
  const [meds, exams] = await Promise.all([
    supabase.from('medications').select('*,medication_schedules(*)').eq('source_appointment_id',appointmentId).eq('active',true).order('created_at',{ascending:true}),
    supabase.from('medical_appointment_exams').select('*').eq('appointment_id',appointmentId).order('created_at',{ascending:true}),
  ]);
  if (meds.error) throw meds.error;
  if (exams.error) throw exams.error;
  return { medications: meds.data || [], exams: exams.data || [] };
}
async function loadMedicationCatalog() {
  const ctx = await getContext();
  const result = await supabase.from('medications')
    .select('*,medication_schedules(*)')
    .eq('family_id',ctx.family_id)
    .eq('active',true)
    .order('name',{ascending:true});
  if (result.error) throw result.error;
  medicationCatalog = result.data || [];
  return medicationCatalog;
}

function closeOverlay() {
  overlay?.remove();
  document.querySelectorAll('.medical-v25-overlay').forEach((node)=>node.remove());
  overlay = null;
}
function card(row) {
  const details = [row.specialty,row.doctor_name].filter(Boolean).join(' · ') || 'Consulta médica';
  const hasOutcome = Boolean(row.diagnosis || row.medical_notes || row.recommendations || row.prescribed_medications || row.ordered_exams || row.vaccines_guidance || row.parent_notes);
  return `<article class="medical-v25-card">
    <div><small>${esc(formatDateTime(row.appointment_at))}</small><h3>${esc(details)}</h3>
    ${row.reason ? `<p>${esc(row.reason)}</p>` : ''}
    <span>${hasOutcome ? 'Registro preenchido' : (new Date(row.appointment_at)<new Date() ? 'Aguardando registro' : 'Agendada')}</span></div>
    <button type="button" class="button button--secondary button--small" data-medical-edit="${attr(row.id)}">Editar</button>
  </article>`;
}
async function openList() {
  try {
    await getContext(true);
    await loadAppointments();
    closeOverlay();
    overlay = document.createElement('div');
    overlay.className = 'medical-v25-overlay';
    overlay.innerHTML = `<section class="medical-v25-panel">
      <header class="medical-v25-header"><div><p class="medical-v25-eyebrow">Saúde</p><h2>Consultas médicas</h2><p>Histórico completo antes, durante e depois da consulta.</p></div><button type="button" class="medical-v25-close" data-medical-close>×</button></header>
      <div class="medical-v25-toolbar"><button type="button" class="button" data-medical-new>＋ Nova consulta</button></div>
      <section class="medical-v25-list">${appointments.length ? appointments.map(card).join('') : '<div class="medical-v25-empty"><strong>Nenhuma consulta cadastrada.</strong></div>'}</section>
    </section>`;
    document.body.append(overlay);
  } catch(e) { console.error(e); toast(e.message || 'Não foi possível abrir as consultas.',true); }
}
function section(title,subtitle,body) {
  return `<section class="medical-v25-section"><div class="medical-v25-section-head"><h3>${esc(title)}</h3>${subtitle?`<p>${esc(subtitle)}</p>`:''}</div>${body}</section>`;
}
function inferInterval(item) {
  if (Number(item.interval_hours) > 0) return Number(item.interval_hours);
  const times = (item.medication_schedules || []).filter(x=>x.active!==false).map(x=>String(x.time_of_day||'').slice(0,5)).filter(Boolean);
  if (times.length < 2) return times.length ? 24 : 8;
  const mins = times.map(t=>{const [h,m]=t.split(':').map(Number);return h*60+m;}).sort((a,b)=>a-b);
  const diffs = mins.slice(1).map((v,i)=>v-mins[i]);
  diffs.push(1440-mins[mins.length-1]+mins[0]);
  return Math.max(1,Math.round(Math.min(...diffs)/60));
}
function inferDuration(item) {
  if (Number(item.duration_days) > 0) return Number(item.duration_days);
  if (item.starts_on && item.ends_on) {
    const start = new Date(item.starts_on+'T12:00:00');
    const end = new Date(item.ends_on+'T12:00:00');
    return Math.max(1,Math.round((end-start)/86400000)+1);
  }
  return 7;
}
function inferFirstDose(item) {
  if (item.first_dose_at) return localDateTimeValue(item.first_dose_at);
  const firstTime = (item.medication_schedules || []).filter(x=>x.active!==false).map(x=>String(x.time_of_day||'').slice(0,5)).sort()[0];
  if (item.starts_on && firstTime) return localDateTimeValue(new Date(item.starts_on+'T'+firstTime+':00'));
  if (item.starts_on) return localDateTimeValue(new Date(item.starts_on+'T08:00:00'));
  return nowRounded();
}
function doseDates(firstDoseRaw, intervalHours, durationDays) {
  const start = new Date(firstDoseRaw);
  const interval = Number(intervalHours);
  const days = Number(durationDays);
  if (Number.isNaN(start.getTime()) || !Number.isFinite(interval) || interval <= 0 || !Number.isFinite(days) || days <= 0) return [];
  const end = start.getTime() + days * 86400000;
  const step = interval * 3600000;
  const result = [];
  for (let at = start.getTime(), guard=0; at < end && guard < 1500; at += step, guard += 1) result.push(new Date(at));
  return result;
}
function dosePreview(first, interval, days) {
  const doses = doseDates(first,interval,days);
  if (!doses.length) return 'Informe primeira dose, intervalo e quantidade de dias.';
  const perDay = 24 / Number(interval);
  const perDayLabel = Number.isInteger(perDay) ? `${perDay} dose(s) por dia` : `aprox. ${perDay.toFixed(1).replace('.',',')} dose(s) por dia`;
  const firstRows = doses.slice(0,8).map(d=>formatDateTime(d)).join(' · ');
  return `${perDayLabel} · ${doses.length} dose(s) no tratamento. ${firstRows}${doses.length>8 ? ` · +${doses.length-8}` : ''}`;
}
function photoSlots(item) {
  const ids = Array.isArray(item.photo_file_ids) ? item.photo_file_ids.slice(0,4) : [];
  return Array.from({length:4},(_,index)=>{
    const existing = ids[index] || '';
    return `<div class="medical-v25-photo-slot">
      <input type="hidden" data-med-photo-existing value="${attr(existing)}">
      <strong>Foto ${index+1}</strong>
      ${existing ? `<button type="button" class="button button--secondary button--small" data-file-open="${attr(existing)}">Ver atual</button><button type="button" class="medical-v25-remove-photo" data-med-photo-clear>Remover</button>` : '<small>Sem foto</small>'}
      <label>Selecionar<input type="file" data-med-photo accept="image/*"></label>
    </div>`;
  }).join('');
}
function medicationCatalogOptions(selected='') {
  const options = medicationCatalog.map((row)=>`<option value="${attr(row.id)}" ${selected===row.id?'selected':''}>${esc(row.name)}${row.dose ? ' · '+esc(row.dose) : ''}</option>`).join('');
  return `<option value="">Cadastrar novo / manter este</option>${options}`;
}
function medicationItemMarkup(item={}, index=nextMedicationIndex++) {
  const first = inferFirstDose(item);
  const interval = inferInterval(item);
  const days = inferDuration(item);
  return `<article class="medical-v25-item" data-med-item data-index="${index}">
    <input type="hidden" data-med-id value="${attr(item.id||'')}">
    <input type="hidden" data-med-leaflet-existing value="${attr(item.leaflet_file_id||'')}">
    <div class="medical-v25-item-head"><strong>Medicamento</strong><button type="button" class="medical-v25-remove" data-med-remove>Remover</button></div>
    <label>Escolher medicamento já cadastrado
      <select data-med-catalog>${medicationCatalogOptions(item.catalog_source_id||'')}</select>
      <small>Ao escolher, os dados cadastrados são usados como base desta prescrição.</small>
    </label>
    <div class="medical-v25-grid medical-v25-grid--2">
      <label>Nome do medicamento<input data-med-name value="${attr(item.name||'')}" placeholder="Ex.: Amoxicilina"></label>
      <label>Dose<input data-med-dose value="${attr(item.dose||'')}" placeholder="Ex.: 5 ml"></label>
    </div>
    <div class="medical-v25-grid medical-v25-grid--2">
      <label>Via<input data-med-route value="${attr(item.route||'')}" placeholder="Ex.: Oral"></label>
      <label>Primeira dose<input type="datetime-local" data-med-first value="${attr(first)}"></label>
    </div>
    <div class="medical-v25-grid medical-v25-grid--2">
      <label>Tomar a cada quantas horas?<input type="number" min="1" max="168" step="1" data-med-interval value="${attr(interval)}"></label>
      <label>Por quantos dias?<input type="number" min="1" max="365" step="1" data-med-days value="${attr(days)}"></label>
    </div>
    <label>Instruções de uso<textarea data-med-guidance rows="2" placeholder="Ex.: após alimentação, agitar antes de usar...">${esc(item.guidance||'')}</textarea></label>
    <div class="medical-v25-dose-preview" data-med-preview>${esc(dosePreview(first,interval,days))}</div>
    <div><span class="medical-v25-field-label">Fotos do remédio — até 4</span><div class="medical-v25-photo-grid">${photoSlots(item)}</div></div>
    <label class="medical-v25-file">Bula <small>${item.leaflet_file_id ? 'Bula já anexada' : 'PDF ou imagem'}</small>${item.leaflet_file_id ? `<button type="button" class="button button--secondary button--small" data-file-open="${attr(item.leaflet_file_id)}">Abrir bula</button>` : ''}<input type="file" data-med-leaflet accept="application/pdf,image/*"></label>
    <p class="medical-v25-helper">As doses calculadas entram automaticamente na Agenda do dia da babá. Se a primeira dose já foi dada, ela fica registrada como concluída.</p>
  </article>`;
}
function examItemMarkup(item={}, index=nextExamIndex++) {
  const existingPhotos = Array.isArray(item.request_file_ids) ? item.request_file_ids.slice(0,4) : [];
  return `<article class="medical-v25-item" data-exam-item data-index="${index}">
    <input type="hidden" data-exam-id value="${attr(item.id||'')}">
    <input type="hidden" data-exam-task-id value="${attr(item.task_id||'')}">
    ${existingPhotos.map((id)=>`<input type="hidden" data-exam-photo-existing value="${attr(id)}">`).join('')}
    <div class="medical-v25-item-head"><strong>Exame solicitado</strong><button type="button" class="medical-v25-remove" data-exam-remove>Remover</button></div>
    <label>Exame<input data-exam-name value="${attr(item.name||'')}" placeholder="Ex.: Hemograma"></label>
    <label>Orientações<textarea data-exam-instructions rows="2" placeholder="Jejum, laboratório, preparo...">${esc(item.instructions||'')}</textarea></label>
    <label>Lembrar em / prazo <span class="medical-v25-optional">opcional</span><input type="datetime-local" data-exam-due value="${attr(item.due_at ? localDateTimeValue(item.due_at) : '')}"></label>
    <div class="medical-v25-exam-photos">
      <span class="medical-v25-field-label">Fotos do pedido do exame — até 4</span>
      ${existingPhotos.length ? `<div class="medical-v25-existing-files">${existingPhotos.map((id,i)=>`<button type="button" class="button button--secondary button--small" data-file-open="${attr(id)}">Foto ${i+1}</button>`).join('')}</div>` : ''}
      <div class="medical-v25-grid medical-v25-grid--2">
        <label class="medical-v25-file">Tirar foto<small>Abre a câmera no celular</small><input type="file" data-exam-camera accept="image/*" capture="environment"></label>
        <label class="medical-v25-file">Escolher da galeria<small>Você pode selecionar várias</small><input type="file" data-exam-gallery accept="image/*" multiple></label>
      </div>
      <small data-exam-photo-count>${existingPhotos.length} de 4 foto(s)</small>
    </div>
    <p class="medical-v25-helper">O exame entra na mesma Agenda do dia como tarefa pendente.</p>
  </article>`;
}
function formMarkup(row, care) {
  nextMedicationIndex = 0; nextExamIndex = 0;
  const meds = care.medications || [];
  const exams = care.exams || [];
  return `<form id="medical-v25-form" class="medical-v25-form">
    <input type="hidden" name="id" value="${attr(row?.id||'')}">
    <input type="hidden" name="legacy_prescribed_medications" value="${attr(row?.prescribed_medications||'')}">
    <input type="hidden" name="legacy_ordered_exams" value="${attr(row?.ordered_exams||'')}">
    <input type="hidden" name="had_structured_medications" value="${meds.length ? '1' : '0'}">
    <input type="hidden" name="had_structured_exams" value="${exams.length ? '1' : '0'}">

    ${section('1. Consulta','Informações do agendamento. Se houver data e horário, a consulta também entra na Agenda do dia.',`
      <div class="medical-v25-grid medical-v25-grid--2">
        <label>Data e horário <span class="medical-v25-optional">opcional</span><input name="appointment_at" type="datetime-local" value="${attr(row?.appointment_at ? localDateTimeValue(row.appointment_at) : '')}"></label>
        <label>Especialidade <span class="medical-v25-required">obrigatório</span><input name="specialty" required value="${attr(row?.specialty||'')}" placeholder="Ex.: Pediatria"></label>
      </div>
      <div class="medical-v25-grid medical-v25-grid--2">
        <label>Médico(a) / profissional<input name="doctor_name" value="${attr(row?.doctor_name||'')}"></label>
        <label>Clínica / hospital<input name="clinic_or_hospital" value="${attr(row?.clinic_or_hospital||'')}"></label>
      </div>
      <label>Motivo da consulta<textarea name="reason" rows="2">${esc(row?.reason||'')}</textarea></label>`)}

    ${section('2. Durante a consulta','As medidas são formatadas automaticamente.',`
      <label>Queixa principal<textarea name="chief_complaint" rows="2">${esc(row?.chief_complaint||'')}</textarea></label>
      <label>Histórico relatado<textarea name="history_reported" rows="3">${esc(row?.history_reported||'')}</textarea></label>
      <div class="medical-v25-grid medical-v25-grid--4">
        <label>Peso (kg)<input name="weight_kg" data-format="measure-3" inputmode="decimal" value="${attr(row?.weight_kg??'')}"></label>
        <label>Altura (cm)<input name="height_cm" data-format="measure-1" inputmode="decimal" value="${attr(row?.height_cm??'')}"></label>
        <label>Perímetro cefálico (cm)<input name="head_circumference_cm" data-format="measure-1" inputmode="decimal" value="${attr(row?.head_circumference_cm??'')}"></label>
        <label>Temperatura (°C)<input name="temperature_c" data-format="measure-1" inputmode="decimal" value="${attr(row?.temperature_c??'')}"></label>
      </div>`)}

    ${section('3. Como foi a consulta','Medicamentos, exames e retorno alimentam automaticamente a Agenda do dia.',`
      <label>Diagnóstico / avaliação<textarea name="diagnosis" rows="2">${esc(row?.diagnosis||'')}</textarea></label>
      <label>Anotações médicas<textarea name="medical_notes" rows="3">${esc(row?.medical_notes||'')}</textarea></label>
      <label>Orientações e recomendações<textarea name="recommendations" rows="3">${esc(row?.recommendations||'')}</textarea></label>

      <div class="medical-v25-subsection">
        <div class="medical-v25-subsection-head"><div><h4>Medicamentos prescritos</h4><p>Informe a primeira dose, o intervalo em horas e a duração do tratamento.</p></div><button type="button" class="button button--secondary button--small" data-med-add>＋ Medicamento</button></div>
        ${(!meds.length && row?.prescribed_medications) ? `<div class="medical-v25-legacy"><strong>Registro anterior:</strong> ${esc(row.prescribed_medications)}</div>` : ''}
        <div data-med-list>${meds.map((m)=>medicationItemMarkup(m)).join('')}</div>
      </div>

      <div class="medical-v25-subsection">
        <div class="medical-v25-subsection-head"><div><h4>Exames solicitados</h4><p>Cada exame entra como tarefa na Agenda do dia.</p></div><button type="button" class="button button--secondary button--small" data-exam-add>＋ Exame</button></div>
        ${(!exams.length && row?.ordered_exams) ? `<div class="medical-v25-legacy"><strong>Registro anterior:</strong> ${esc(row.ordered_exams)}</div>` : ''}
        <div data-exam-list>${exams.map((x)=>examItemMarkup(x)).join('')}</div>
      </div>

      <label>Orientações sobre vacinas<textarea name="vaccines_guidance" rows="2">${esc(row?.vaccines_guidance||'')}</textarea></label>
      <div class="medical-v25-grid medical-v25-grid--2">
        <label>Próximo retorno <span class="medical-v25-optional">vai para a Agenda do dia</span><input name="return_at" type="datetime-local" value="${attr(row?.return_at?localDateTimeValue(row.return_at):'')}"></label>
        <label>Observações dos pais<textarea name="parent_notes" rows="2">${esc(row?.parent_notes||'')}</textarea></label>
      </div>`)}

    <div class="medical-v25-footer"><button type="button" class="button button--secondary" data-medical-back>Voltar</button><button type="submit" class="button" data-medical-save>Salvar consulta</button></div>
  </form>`;
}
async function openEditor(id='') {
  const row = id ? appointments.find(x=>x.id===id) : null;
  if (id && !row) return toast('Consulta não encontrada.',true);
  try {
    const [care] = await Promise.all([loadCareItems(id), loadMedicationCatalog()]);
    closeOverlay();
    overlay = document.createElement('div');
    overlay.className = 'medical-v25-overlay';
    overlay.innerHTML = `<section class="medical-v25-panel medical-v25-panel--form"><header class="medical-v25-header"><div><p class="medical-v25-eyebrow">Consultas médicas</p><h2>${row?'Editar consulta':'Nova consulta'}</h2><p>Você pode salvar rápido e completar os dados depois.</p></div><button type="button" class="medical-v25-close" data-medical-close>×</button></header>${formMarkup(row,care)}</section>`;
    document.body.append(overlay);
  } catch(e) { console.error(e); toast(e.message || 'Não foi possível abrir a consulta.',true); }
}
function readMedicationItems(form) {
  return [...form.querySelectorAll('[data-med-item]')].map((node)=>({
    node,
    id: node.querySelector('[data-med-id]')?.value || '',
    name: node.querySelector('[data-med-name]')?.value.trim() || '',
    dose: node.querySelector('[data-med-dose]')?.value.trim() || '',
    route: node.querySelector('[data-med-route]')?.value.trim() || '',
    guidance: node.querySelector('[data-med-guidance]')?.value.trim() || '',
    first_dose_at: isoOrEmpty(node.querySelector('[data-med-first]')?.value || ''),
    interval_hours: Number(node.querySelector('[data-med-interval]')?.value || 0),
    duration_days: Number(node.querySelector('[data-med-days]')?.value || 0),
    leafletExistingId: node.querySelector('[data-med-leaflet-existing]')?.value || '',
    photoSlots: [...node.querySelectorAll('.medical-v25-photo-slot')].map(slot=>({
      existingId: slot.querySelector('[data-med-photo-existing]')?.value || '',
      file: slot.querySelector('[data-med-photo]')?.files?.[0] || null,
    })),
    leafletInput: node.querySelector('[data-med-leaflet]'),
  })).filter(x=>x.name || x.dose || x.guidance || x.first_dose_at);
}
function readExamItems(form) {
  return [...form.querySelectorAll('[data-exam-item]')].map((node)=>({
    node,
    id: node.querySelector('[data-exam-id]')?.value || '',
    task_id: node.querySelector('[data-exam-task-id]')?.value || '',
    name: node.querySelector('[data-exam-name]')?.value.trim() || '',
    instructions: node.querySelector('[data-exam-instructions]')?.value.trim() || '',
    due_at: isoOrEmpty(node.querySelector('[data-exam-due]')?.value || ''),
    existingPhotoIds: [...node.querySelectorAll('[data-exam-photo-existing]')].map(x=>x.value).filter(Boolean),
    cameraFile: node.querySelector('[data-exam-camera]')?.files?.[0] || null,
    galleryFiles: [...(node.querySelector('[data-exam-gallery]')?.files || [])],
  })).filter(x=>x.name || x.instructions || x.cameraFile || x.galleryFiles.length);
}
async function uploadMedicationAttachments(item, medication, session) {
  const photoIds = [];
  for (let index=0; index<4; index+=1) {
    const slot = item.photoSlots[index] || {};
    if (slot.file) {
      const uploaded = await uploadFile(slot.file,{fileType:'medication-photo',category:'medication',relatedRecordType:'medication',relatedRecordId:medication.id});
      if (uploaded?.id) photoIds.push(uploaded.id);
    } else if (slot.existingId) photoIds.push(slot.existingId);
  }
  const updates = {
    photo_file_ids: photoIds.slice(0,4),
    leaflet_file_id: item.leafletExistingId || null,
    updated_by: session.user.id
  };
  const leaflet = item.leafletInput?.files?.[0];
  if (leaflet) {
    const uploaded = await uploadFile(leaflet,{fileType:'medication-leaflet',category:'medication',relatedRecordType:'medication',relatedRecordId:medication.id});
    if (uploaded?.id) updates.leaflet_file_id = uploaded.id;
  }
  const result = await supabase.from('medications').update(updates).eq('id',medication.id).select('*').single();
  if (result.error) throw result.error;
  return result.data;
}
function instructionsForMedication(item) {
  return [
    item.dose ? 'Dose: '+item.dose : '',
    item.route ? 'Via: '+item.route : '',
    item.guidance || '',
  ].filter(Boolean).join(' · ');
}
async function syncMedicationTasks(medication, item, ctx) {
  const doses = doseDates(item.first_dose_at,item.interval_hours,item.duration_days);
  if (!doses.length) throw new Error('Não foi possível calcular as doses de '+item.name+'.');
  if (doses.length >= 1500) throw new Error('O esquema de '+item.name+' gera doses demais. Revise intervalo e quantidade de dias.');

  const existingTasks = await supabase.from('care_tasks').select('id,due_at,status').eq('medication_id',medication.id);
  if (existingTasks.error) throw existingTasks.error;
  const terminal = new Map((existingTasks.data||[])
    .filter(row=>['completed','refused','unable','cancelled'].includes(row.status))
    .map(row=>[new Date(row.due_at).getTime(),row]));
  const remove = await supabase.from('care_tasks').delete().eq('medication_id',medication.id).in('status',['pending','in_progress','late']);
  if (remove.error) throw remove.error;

  const scheduleDelete = await supabase.from('medication_schedules').delete().eq('medication_id',medication.id);
  if (scheduleDelete.error) throw scheduleDelete.error;
  const timeKeys = [...new Set(doses.map(d=>`${pad(d.getHours())}:${pad(d.getMinutes())}`))];
  const scheduleResult = await supabase.from('medication_schedules').insert(timeKeys.map(time=>({medication_id:medication.id,time_of_day:time,active:true}))).select('*');
  if (scheduleResult.error) throw scheduleResult.error;
  const scheduleByTime = new Map((scheduleResult.data||[]).map(row=>[String(row.time_of_day).slice(0,5),row.id]));

  const now = Date.now();
  const rows = [];
  doses.forEach((due,index)=>{
    const key = due.getTime();
    if (terminal.has(key)) return;
    const time = `${pad(due.getHours())}:${pad(due.getMinutes())}`;
    const firstAlreadyGiven = index===0 && key <= now;
    rows.push({
      family_id: ctx.family_id,
      medication_id: medication.id,
      schedule_id: scheduleByTime.get(time) || null,
      title: 'Administrar '+medication.name,
      due_at: due.toISOString(),
      status: firstAlreadyGiven ? 'completed' : 'pending',
      completed_at: firstAlreadyGiven ? due.toISOString() : null,
      completed_by: firstAlreadyGiven ? ctx.session.user.id : null,
      note: firstAlreadyGiven ? 'Primeira dose informada como já administrada no cadastro da consulta.' : '',
      task_kind: 'medication',
      instructions: instructionsForMedication(item),
      assigned_role: 'caregiver',
      requires_photo: false,
      requires_note: false,
      priority: 2,
    });
  });
  if (rows.length) {
    const insert = await supabase.from('care_tasks').insert(rows);
    if (insert.error) throw insert.error;
  }
}
async function syncMedications(appointment, items, ctx) {
  const existingResult = await supabase.from('medications').select('*').eq('source_appointment_id',appointment.id);
  if (existingResult.error) throw existingResult.error;
  const existing = existingResult.data || [];
  const kept = new Set();
  for (const item of items) {
    if (!item.name) throw new Error('Informe o nome de cada medicamento adicionado.');
    if (!item.first_dose_at) throw new Error('Informe a primeira dose de '+item.name+'.');
    if (!Number.isInteger(item.interval_hours) || item.interval_hours < 1 || item.interval_hours > 168) throw new Error('Informe de quantas em quantas horas '+item.name+' deve ser administrado.');
    if (!Number.isInteger(item.duration_days) || item.duration_days < 1 || item.duration_days > 365) throw new Error('Informe por quantos dias '+item.name+' será administrado.');
    const doses = doseDates(item.first_dose_at,item.interval_hours,item.duration_days);
    if (!doses.length) throw new Error('Revise os dados de '+item.name+'.');
    const first = doses[0];
    const last = doses[doses.length-1];
    const payload = {
      family_id: ctx.family_id,
      name: item.name,
      kind: 'temporary',
      dose: item.dose,
      route: item.route,
      guidance: item.guidance,
      starts_on: localDateOnly(first),
      ends_on: localDateOnly(last),
      frequency: 'scheduled',
      frequency_description: `A cada ${item.interval_hours} hora(s) por ${item.duration_days} dia(s)`,
      first_dose_at: first.toISOString(),
      interval_hours: item.interval_hours,
      duration_days: item.duration_days,
      active: true,
      source_appointment_id: appointment.id,
      updated_by: ctx.session.user.id,
    };
    let medication;
    if (item.id) {
      const result = await supabase.from('medications').update(payload).eq('id',item.id).eq('family_id',ctx.family_id).select('*').single();
      if (result.error) throw result.error;
      medication = result.data;
    } else {
      const result = await supabase.from('medications').insert({...payload,created_by:ctx.session.user.id}).select('*').single();
      if (result.error) throw result.error;
      medication = result.data;
    }
    kept.add(medication.id);
    medication = await uploadMedicationAttachments(item,medication,ctx.session);
    await syncMedicationTasks(medication,item,ctx);
    await scheduleMedicationRemindersForMedication(medication.id).catch(()=>{});
  }
  for (const old of existing) {
    if (kept.has(old.id)) continue;
    await supabase.from('care_tasks').delete().eq('medication_id',old.id).in('status',['pending','in_progress','late']);
    await supabase.from('medication_schedules').delete().eq('medication_id',old.id);
    await supabase.from('medications').update({active:false,updated_by:ctx.session.user.id}).eq('id',old.id);
  }
}
async function syncExams(appointment, items, ctx) {
  const existingResult = await supabase.from('medical_appointment_exams').select('*').eq('appointment_id',appointment.id);
  if (existingResult.error) throw existingResult.error;
  const existing = existingResult.data || [];
  const kept = new Set();
  for (const item of items) {
    if (!item.name) throw new Error('Informe o nome de cada exame adicionado.');
    const incomingPhotos = [item.cameraFile, ...item.galleryFiles].filter(Boolean);
    if (item.existingPhotoIds.length + incomingPhotos.length > 4) throw new Error('Cada exame pode ter no máximo 4 fotos do pedido.');
    const dueAt = item.due_at || (()=>{const d=new Date();d.setHours(23,59,0,0);return d.toISOString();})();
    let taskId = item.task_id || null;
    const taskPayload = {
      family_id: ctx.family_id,
      title: 'Realizar exame: ' + item.name,
      due_at: dueAt,
      note: '',
      task_kind: 'other',
      instructions: item.instructions,
      assigned_role: 'all',
      requires_photo: false,
      requires_note: false,
      priority: 2,
    };
    if (taskId) {
      const taskUpdate = await supabase.from('care_tasks').update(taskPayload).eq('id',taskId).select('id').maybeSingle();
      if (taskUpdate.error) throw taskUpdate.error;
      if (!taskUpdate.data?.id) taskId = null;
    }
    if (!taskId) {
      const taskInsert = await supabase.from('care_tasks').insert({...taskPayload,status:'pending'}).select('id').single();
      if (taskInsert.error) throw taskInsert.error;
      taskId = taskInsert.data.id;
    }
    const examPayload = {
      family_id: ctx.family_id,
      appointment_id: appointment.id,
      name: item.name,
      instructions: item.instructions,
      due_at: dueAt,
      task_id: taskId,
      updated_by: ctx.session.user.id,
    };
    let exam;
    if (item.id) {
      const result = await supabase.from('medical_appointment_exams').update(examPayload).eq('id',item.id).select('*').single();
      if (result.error) throw result.error;
      exam = result.data;
    } else {
      const result = await supabase.from('medical_appointment_exams').insert({...examPayload,created_by:ctx.session.user.id}).select('*').single();
      if (result.error) throw result.error;
      exam = result.data;
    }
    const requestIds = [...item.existingPhotoIds];
    for (const file of incomingPhotos) {
      const uploaded = await uploadFile(file,{fileType:'exam-request-photo',category:'health',relatedRecordType:'medical_appointment_exam',relatedRecordId:exam.id});
      if (uploaded?.id) requestIds.push(uploaded.id);
    }
    if (incomingPhotos.length) {
      const photoUpdate = await supabase.from('medical_appointment_exams')
        .update({request_file_ids:requestIds.slice(0,4),updated_by:ctx.session.user.id})
        .eq('id',exam.id).select('*').single();
      if (photoUpdate.error) throw photoUpdate.error;
      exam = photoUpdate.data;
    }
    kept.add(exam.id);
  }
  for (const old of existing) {
    if (kept.has(old.id)) continue;
    if (old.task_id) await supabase.from('care_tasks').delete().eq('id',old.task_id);
    await supabase.from('medical_appointment_exams').delete().eq('id',old.id);
  }
}
async function syncOneCalendarEvent({appointment,ctx,relatedType,date,title,location,notes,eventType}) {
  const existingResult = await supabase.from('calendar_events')
    .select('id')
    .eq('family_id',ctx.family_id)
    .eq('related_record_type',relatedType)
    .eq('related_record_id',appointment.id)
    .order('created_at',{ascending:true});
  if (existingResult.error) throw existingResult.error;
  const ids = (existingResult.data||[]).map(row=>row.id);
  if (!date) {
    if (ids.length) {
      const off = await supabase.from('calendar_events').update({active:false,updated_by:ctx.session.user.id,updated_at:new Date().toISOString()}).in('id',ids);
      if (off.error) throw off.error;
    }
    return;
  }
  const payload = {
    family_id: ctx.family_id,
    event_type: eventType,
    title,
    starts_at: date,
    ends_at: null,
    location: location || '',
    notes: notes || '',
    related_record_type: relatedType,
    related_record_id: appointment.id,
    active: true,
    all_day: false,
    audience_role: 'all',
    requires_acknowledgement: true,
    updated_by: ctx.session.user.id,
  };
  if (ids[0]) {
    const update = await supabase.from('calendar_events').update(payload).eq('id',ids[0]);
    if (update.error) throw update.error;
    if (ids.length>1) await supabase.from('calendar_events').update({active:false,updated_by:ctx.session.user.id}).in('id',ids.slice(1));
  } else {
    const insert = await supabase.from('calendar_events').insert({...payload,created_by:ctx.session.user.id});
    if (insert.error) throw insert.error;
  }
}
async function syncAppointmentEvents(appointment, rawAppointmentAt, rawReturnAt, ctx) {
  const specialty = appointment.specialty || 'Consulta';
  const doctor = appointment.doctor_name || '';
  const title = [specialty,doctor].filter(Boolean).join(' · ');
  await syncOneCalendarEvent({
    appointment,ctx,relatedType:'medical_appointment',
    date:rawAppointmentAt ? appointment.appointment_at : '',
    title:'Consulta: '+title,
    location:appointment.clinic_or_hospital,
    notes:appointment.reason || 'Consulta médica.',
    eventType:'appointment',
  });
  await syncOneCalendarEvent({
    appointment,ctx,relatedType:'medical_appointment_return',
    date:rawReturnAt ? appointment.return_at : '',
    title:'Retorno: '+title,
    location:appointment.clinic_or_hospital,
    notes:'Retorno da consulta'+(appointment.recommendations ? ' · '+appointment.recommendations : ''),
    eventType:'return',
  });
}
async function save(form) {
  if (saving) return;
  saving = true;
  const button = form.querySelector('[data-medical-save]');
  if (button) { button.disabled=true; button.textContent='Salvando…'; }
  const medicationItems = readMedicationItems(form);
  const examItems = readExamItems(form);
  const alertsPromise = medicationItems.length ? enableMedicationAlerts().catch(()=>false) : Promise.resolve(false);
  try {
    const ctx = await getContext(true);
    const f = new FormData(form);
    const specialty = String(f.get('specialty')||'').trim();
    if (!specialty) throw new Error('Informe pelo menos a especialidade.');
    const rawAppointmentAt = String(f.get('appointment_at')||'').trim();
    const rawReturnAt = String(f.get('return_at')||'').trim();
    const hadStructuredMeds = String(f.get('had_structured_medications')||'') === '1';
    const hadStructuredExams = String(f.get('had_structured_exams')||'') === '1';
    const medSummary = medicationItems.length
      ? medicationItems.map(x=>`${x.name} — ${x.dose || 'dose não informada'} — a cada ${x.interval_hours}h por ${x.duration_days} dia(s)`).join('\n')
      : (hadStructuredMeds ? '' : String(f.get('legacy_prescribed_medications')||'').trim());
    const examSummary = examItems.length ? examItems.map(x=>x.name).join('\n') : (hadStructuredExams ? '' : String(f.get('legacy_ordered_exams')||'').trim());
    const payload = {
      id: String(f.get('id')||'').trim() || null,
      family_id: ctx.family_id,
      doctor_name: String(f.get('doctor_name')||'').trim(),
      specialty,
      clinic_or_hospital: String(f.get('clinic_or_hospital')||'').trim(),
      appointment_at: isoOrEmpty(rawAppointmentAt) || new Date().toISOString(),
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
      prescribed_medications: medSummary,
      ordered_exams: examSummary,
      vaccines_guidance: String(f.get('vaccines_guidance')||'').trim(),
      return_at: isoOrEmpty(rawReturnAt),
      parent_notes: String(f.get('parent_notes')||'').trim(),
    };
    const result = await supabase.rpc('save_medical_appointment',{payload});
    if (result.error) throw result.error;
    const appointment = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!appointment?.id) throw new Error('A consulta foi salva, mas não retornou o identificador do registro.');
    await syncMedications(appointment,medicationItems,ctx);
    await syncExams(appointment,examItems,ctx);
    let agendaOk = true;
    try { await syncAppointmentEvents(appointment,rawAppointmentAt,rawReturnAt,ctx); }
    catch (agendaError) { agendaOk=false; console.warn('Falha ao sincronizar agenda',agendaError); }
    await alertsPromise;
    toast(agendaOk ? 'Consulta salva e Agenda do dia atualizada.' : 'Consulta salva. Não foi possível atualizar a Agenda do dia.');
    await openList();
  } catch(e) {
    console.error('Falha ao salvar consulta',e);
    toast('Erro ao salvar: ' + (e?.message || 'falha desconhecida'),true);
    if (button) { button.disabled=false; button.textContent='Salvar consulta'; }
  } finally { saving=false; }
}
function updateMedicationPreview(node) {
  const first = node.querySelector('[data-med-first]')?.value || '';
  const interval = Number(node.querySelector('[data-med-interval]')?.value || 0);
  const days = Number(node.querySelector('[data-med-days]')?.value || 0);
  const preview = node.querySelector('[data-med-preview]');
  if (preview) preview.textContent = dosePreview(first,interval,days);
}
function enhance() {
  const main = document.querySelector('#main-content');
  const heading = main?.querySelector('.page-heading h1,.next-page-heading h1');
  const title = heading?.textContent?.trim();
  if (title==='Mais') {
    const grid = main.querySelector('.next-feature-grid');
    if (grid && !grid.querySelector('[data-medical-open]')) {
      const b=document.createElement('button'); b.type='button'; b.className='medical-v25-feature'; b.dataset.medicalOpen='1';
      b.innerHTML='<span>✚</span><div><strong>Consultas médicas</strong><small>Agendar, registrar, medicamentos e exames</small></div>';
      grid.prepend(b);
    }
  }
  if (title==='Agenda do dia' || title==='Agenda') {
    const ph=heading.closest('.page-heading,.next-page-heading');
    if (ph && !ph.querySelector('[data-medical-open]')) {
      const b=document.createElement('button'); b.type='button'; b.className='button button--secondary button--small'; b.dataset.medicalOpen='1'; b.textContent='Consultas médicas'; ph.append(b);
    }
  }
}
function consume(e){e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();}
document.addEventListener('click',async(e)=>{
  if(e.target.closest('[data-medical-open]')){consume(e);return openList();}
  if(e.target.closest('[data-medical-close]')){consume(e);return closeOverlay();}
  if(e.target.closest('[data-medical-new]')){consume(e);return openEditor();}
  const edit=e.target.closest('[data-medical-edit]'); if(edit){consume(e);return openEditor(edit.dataset.medicalEdit||'');}
  if(e.target.closest('[data-medical-back]')){consume(e);return openList();}
  if(e.target.closest('[data-med-add]')){consume(e);const list=overlay?.querySelector('[data-med-list]');if(list)list.insertAdjacentHTML('beforeend',medicationItemMarkup());return;}
  if(e.target.closest('[data-exam-add]')){consume(e);const list=overlay?.querySelector('[data-exam-list]');if(list)list.insertAdjacentHTML('beforeend',examItemMarkup());return;}
  const medRemove=e.target.closest('[data-med-remove]'); if(medRemove){consume(e);medRemove.closest('[data-med-item]')?.remove();return;}
  const examRemove=e.target.closest('[data-exam-remove]'); if(examRemove){consume(e);examRemove.closest('[data-exam-item]')?.remove();return;}
  const clearPhoto=e.target.closest('[data-med-photo-clear]'); if(clearPhoto){consume(e);const slot=clearPhoto.closest('.medical-v25-photo-slot');const hidden=slot?.querySelector('[data-med-photo-existing]');if(hidden)hidden.value='';clearPhoto.remove();slot?.querySelector('[data-file-open]')?.remove();return;}
},true);
document.addEventListener('input',(e)=>{
  const item=e.target.closest?.('[data-med-item]');
  if (item && (e.target.matches('[data-med-first]') || e.target.matches('[data-med-interval]') || e.target.matches('[data-med-days]'))) updateMedicationPreview(item);
},true);
document.addEventListener('change',(e)=>{
  const catalogSelect = e.target.closest?.('[data-med-catalog]');
  if (catalogSelect) {
    const node = catalogSelect.closest('[data-med-item]');
    const selected = medicationCatalog.find((row)=>row.id===catalogSelect.value);
    if (node && selected) {
      const index = Number(node.dataset.index || 0);
      node.outerHTML = medicationItemMarkup({
        ...selected,
        id:'',
        catalog_source_id:selected.id,
        first_dose_at:null,
        starts_on:null,
        ends_on:null,
      }, index);
      return;
    }
  }
  const examNode = e.target.closest?.('[data-exam-item]');
  if (examNode && (e.target.matches('[data-exam-camera]') || e.target.matches('[data-exam-gallery]'))) {
    const existing = examNode.querySelectorAll('[data-exam-photo-existing]').length;
    const camera = examNode.querySelector('[data-exam-camera]')?.files?.length || 0;
    const gallery = examNode.querySelector('[data-exam-gallery]')?.files?.length || 0;
    const total = existing + camera + gallery;
    const count = examNode.querySelector('[data-exam-photo-count]');
    if (count) count.textContent = total + ' de 4 foto(s)';
    if (total > 4) {
      toast('Cada exame pode ter no máximo 4 fotos do pedido.',true);
      e.target.value = '';
      const newCamera = examNode.querySelector('[data-exam-camera]')?.files?.length || 0;
      const newGallery = examNode.querySelector('[data-exam-gallery]')?.files?.length || 0;
      if (count) count.textContent = (existing + newCamera + newGallery) + ' de 4 foto(s)';
    }
    return;
  }
  const input=e.target;
  if (!(input instanceof HTMLInputElement) || input.type!=='file') return;
  const label=input.closest('label');
  const small=label?.querySelector('small');
  if (small && input.files?.length) small.textContent=input.files.length>1 ? input.files.length+' arquivos selecionados' : input.files[0].name;
},true);
document.addEventListener('submit',async(e)=>{
  if(e.target?.id!=='medical-v25-form') return;
  consume(e);
  await save(e.target);
},true);

function styles(){
  if(document.querySelector('#medical-v25-styles'))return;
  const s=document.createElement('style');s.id='medical-v25-styles';s.textContent=`
.medical-v25-feature{appearance:none;border:1px solid var(--border,rgba(58,87,82,.18));background:var(--surface,#fff);border-radius:18px;padding:1rem;text-align:left;display:flex;align-items:center;gap:.8rem;min-height:92px;color:inherit;font:inherit;cursor:pointer;width:100%;box-shadow:0 8px 24px rgba(41,62,58,.06)}.medical-v25-feature>span{width:42px;height:42px;border-radius:14px;display:grid;place-items:center;background:rgba(47,111,102,.12);font-size:1.25rem;color:#2f6f66}.medical-v25-feature strong,.medical-v25-feature small{display:block}.medical-v25-feature small{margin-top:.28rem;opacity:.72}
.medical-v25-overlay{position:fixed;inset:0;z-index:10000;background:var(--surface,#fff);overflow:auto}.medical-v25-panel{width:min(1160px,100%);min-height:100dvh;margin:0 auto;padding:clamp(1rem,3vw,2rem) clamp(1rem,4vw,2.5rem) max(2rem,env(safe-area-inset-bottom));color:var(--text,#20302d)}.medical-v25-panel--form{width:min(1040px,100%)}.medical-v25-header{display:flex;justify-content:space-between;gap:1rem;position:sticky;top:0;background:var(--surface,#fff);z-index:4;padding:.75rem 0;border-bottom:1px solid var(--border,rgba(58,87,82,.12))}.medical-v25-header h2{margin:.1rem 0 .25rem}.medical-v25-header p{margin:0;opacity:.7}.medical-v25-eyebrow{text-transform:uppercase;letter-spacing:.09em;font-size:.72rem;font-weight:800;color:#2f6f66!important;opacity:1!important}.medical-v25-close{border:0;background:transparent;font-size:2rem;color:inherit}.medical-v25-toolbar{display:flex;justify-content:flex-end;padding:1rem 0}.medical-v25-list{display:grid;gap:.75rem}.medical-v25-card{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:1rem;border:1px solid var(--border,rgba(58,87,82,.15));border-radius:16px}.medical-v25-card small{font-weight:700;color:#2f6f66}.medical-v25-card h3{margin:.25rem 0}.medical-v25-card p{margin:.2rem 0 .5rem}.medical-v25-card span{font-size:.76rem;font-weight:700;color:#2f6f66}.medical-v25-empty{text-align:center;padding:2rem;border:1px dashed var(--border,rgba(58,87,82,.25));border-radius:16px}
.medical-v25-form{display:grid;gap:1rem;padding-top:1rem}.medical-v25-section{display:grid;gap:1rem;border:1px solid var(--border,rgba(58,87,82,.15));border-radius:18px;padding:1rem}.medical-v25-section-head h3{margin:0}.medical-v25-section-head p{margin:.2rem 0 0;opacity:.68}.medical-v25-form label{display:grid;gap:.38rem;font-weight:650;font-size:.88rem}.medical-v25-form input,.medical-v25-form textarea,.medical-v25-form select{width:100%;box-sizing:border-box;border:1px solid var(--border,rgba(58,87,82,.2));border-radius:12px;padding:.78rem .85rem;background:var(--surface,#fff);color:inherit;font:inherit}.medical-v25-required,.medical-v25-optional{font-size:.72rem;font-weight:600}.medical-v25-required{color:#2f6f66}.medical-v25-optional{opacity:.6}.medical-v25-grid{display:grid;gap:.75rem}.medical-v25-grid--2{grid-template-columns:repeat(2,minmax(0,1fr))}.medical-v25-grid--4{grid-template-columns:repeat(4,minmax(0,1fr))}
.medical-v25-subsection{display:grid;gap:.75rem;padding:1rem;border-radius:16px;background:rgba(47,111,102,.045)}.medical-v25-subsection-head{display:flex;align-items:center;justify-content:space-between;gap:1rem}.medical-v25-subsection-head h4{margin:0}.medical-v25-subsection-head p{margin:.15rem 0 0;font-size:.85rem;opacity:.7}.medical-v25-item{display:grid;gap:.75rem;padding:1rem;border:1px solid var(--border,rgba(58,87,82,.15));border-radius:14px;background:var(--surface,#fff)}.medical-v25-item-head{display:flex;justify-content:space-between;align-items:center}.medical-v25-remove,.medical-v25-remove-photo{border:0;background:transparent;color:#9b2c2c;font-weight:700}.medical-v25-field-label{display:block;font-weight:650;font-size:.88rem;margin-bottom:.38rem}.medical-v25-dose-preview{padding:.75rem;border-radius:12px;background:#eef7f4;color:#285f56;font-size:.85rem;line-height:1.45}.medical-v25-photo-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.6rem}.medical-v25-photo-slot{display:grid;gap:.45rem;padding:.7rem;border:1px dashed var(--border,rgba(58,87,82,.25));border-radius:12px}.medical-v25-photo-slot small{opacity:.6}.medical-v25-file{border:1px dashed var(--border,rgba(58,87,82,.25));border-radius:12px;padding:.8rem}.medical-v25-file small{font-weight:400;opacity:.65}.medical-v25-existing-files{display:flex;flex-wrap:wrap;gap:.45rem}.medical-v25-exam-photos{display:grid;gap:.6rem}.medical-v25-helper{margin:0;font-size:.8rem;opacity:.65}.medical-v25-legacy{padding:.75rem;border-radius:10px;background:#fff8df;font-size:.85rem}
.medical-v25-footer{display:flex;justify-content:flex-end;gap:.75rem;position:sticky;bottom:0;background:var(--surface,#fff);padding:1rem 0 calc(1rem + env(safe-area-inset-bottom));border-top:1px solid var(--border,rgba(58,87,82,.12))}.medical-v25-toast-region{position:fixed;z-index:12000;top:calc(.8rem + env(safe-area-inset-top));left:50%;transform:translateX(-50%);width:min(92vw,560px);display:grid;gap:.5rem}.medical-v25-toast{background:#225d54;color:#fff;padding:.9rem 1rem;border-radius:12px;font-weight:700;box-shadow:0 12px 32px rgba(0,0,0,.25)}.medical-v25-toast--error{background:#8b2f2f}
@media(max-width:700px){.medical-v25-panel{padding-top:max(1rem,env(safe-area-inset-top))}.medical-v25-grid--2,.medical-v25-grid--4,.medical-v25-photo-grid{grid-template-columns:1fr}.medical-v25-card{align-items:flex-start}.medical-v25-subsection-head{align-items:flex-start;flex-direction:column}.medical-v25-subsection-head .button{width:100%}.medical-v25-footer .button{flex:1}}
`;document.head.append(s);
}
styles();
new MutationObserver(()=>requestAnimationFrame(enhance)).observe(document.querySelector('#app'),{childList:true,subtree:true});
enhance();
console.info('APP MARIA consultas v25 ativa');
