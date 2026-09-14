import { supabase } from './supabase.js?v=20';

function value(form, name) {
  return String(new FormData(form).get(name) || '').trim();
}

function isoOrEmpty(raw) {
  if (!raw) return '';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function numericText(raw) {
  const normalized = String(raw || '').trim().replace(',', '.');
  if (!normalized) return '';
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? String(parsed) : '';
}

function show(message, error = false) {
  let box = document.querySelector('#appointment-hotfix-message');
  if (!box) {
    box = document.createElement('div');
    box.id = 'appointment-hotfix-message';
    box.style.cssText = 'position:fixed;z-index:12000;left:50%;top:16px;transform:translateX(-50%);max-width:92vw;padding:12px 16px;border-radius:12px;color:white;font-weight:700;box-shadow:0 12px 32px rgba(0,0,0,.25)';
    document.body.append(box);
  }
  box.style.background = error ? '#8b2f2f' : '#225d54';
  box.textContent = message;
  setTimeout(() => box?.remove(), error ? 7000 : 2500);
}

document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.id !== 'appointment-next-form') return;

  event.preventDefault();
  event.stopImmediatePropagation();

  const submit = form.querySelector('[data-appointment-save]');
  if (submit) {
    submit.disabled = true;
    submit.textContent = 'Salvando…';
  }

  try {
    const contextResult = await supabase.rpc('my_access_context');
    if (contextResult.error || !contextResult.data?.family_id) {
      throw new Error(contextResult.error?.message || 'Não foi possível identificar a família.');
    }

    const appointmentAt = isoOrEmpty(value(form, 'appointment_at'));
    if (!appointmentAt) throw new Error('Informe a data e o horário da consulta.');

    const payload = {
      id: value(form, 'id') || null,
      family_id: contextResult.data.family_id,
      doctor_name: value(form, 'doctor_name'),
      specialty: value(form, 'specialty') || 'Pediatria',
      clinic_or_hospital: value(form, 'clinic_or_hospital'),
      appointment_at: appointmentAt,
      reason: value(form, 'reason'),
      chief_complaint: value(form, 'chief_complaint'),
      history_reported: value(form, 'history_reported'),
      weight_kg: numericText(value(form, 'weight_kg')),
      height_cm: numericText(value(form, 'height_cm')),
      head_circumference_cm: numericText(value(form, 'head_circumference_cm')),
      temperature_c: numericText(value(form, 'temperature_c')),
      diagnosis: value(form, 'diagnosis'),
      medical_notes: value(form, 'medical_notes'),
      recommendations: value(form, 'recommendations'),
      prescribed_medications: value(form, 'prescribed_medications'),
      ordered_exams: value(form, 'ordered_exams'),
      vaccines_guidance: value(form, 'vaccines_guidance'),
      return_at: isoOrEmpty(value(form, 'return_at')),
      parent_notes: value(form, 'parent_notes'),
    };

    const result = await supabase.rpc('save_medical_appointment', { payload });
    if (result.error) throw result.error;

    show(payload.id ? 'Consulta atualizada.' : 'Consulta salva.');
    setTimeout(() => window.location.reload(), 700);
  } catch (error) {
    console.error('Erro ao salvar consulta:', error);
    show(error?.message || 'Não foi possível salvar a consulta.', true);
    if (submit) {
      submit.disabled = false;
      submit.textContent = 'Salvar consulta';
    }
  }
}, true);
