const esc = (value = '') => String(value)
  .replace(/\\/g, '\\\\')
  .replace(/\r?\n/g, '\\n')
  .replace(/,/g, '\\,')
  .replace(/;/g, '\\;');

const utcStamp = (value) => new Date(value)
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d{3}Z$/, 'Z');

const localDateStamp = (value) => {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
};

const nextLocalDateStamp = (value) => {
  const date = new Date(value);
  date.setDate(date.getDate() + 1);
  return localDateStamp(date);
};

function normalizedDates(event) {
  const start = new Date(event.startsAt);
  if (Number.isNaN(start.getTime())) {
    throw new Error('A data inicial do evento é inválida.');
  }

  let end = event.endsAt ? new Date(event.endsAt) : null;
  if (!end || Number.isNaN(end.getTime()) || end <= start) {
    end = new Date(start.getTime() + 60 * 60 * 1000);
  }

  return { start, end };
}

export function eventToIcs(event) {
  if (!event?.title || !event?.startsAt) {
    throw new Error('Evento inválido.');
  }

  const { start, end } = normalizedDates(event);
  const dateLines = event.allDay
    ? [
        `DTSTART;VALUE=DATE:${localDateStamp(start)}`,
        `DTEND;VALUE=DATE:${event.endsAt ? nextLocalDateStamp(end) : nextLocalDateStamp(start)}`,
      ]
    : [
        `DTSTART:${utcStamp(start)}`,
        `DTEND:${utcStamp(end)}`,
      ];

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'PRODID:-//Maria Elis//Agenda//PT-BR',
    'BEGIN:VEVENT',
    `UID:${esc(event.id || crypto.randomUUID())}@app-maria-elis`,
    `DTSTAMP:${utcStamp(new Date())}`,
    ...dateLines,
    `SUMMARY:${esc(event.title)}`,
    `LOCATION:${esc(event.location)}`,
    `DESCRIPTION:${esc(event.notes)}`,
    event.recurrenceRule ? `RRULE:${event.recurrenceRule}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

function googleCalendarDates(event) {
  const { start, end } = normalizedDates(event);

  if (event.allDay) {
    return `${localDateStamp(start)}/${event.endsAt ? nextLocalDateStamp(end) : nextLocalDateStamp(start)}`;
  }

  return `${utcStamp(start)}/${utcStamp(end)}`;
}

function googleCalendarUrl(event) {
  if (!event?.title || !event?.startsAt) {
    throw new Error('Evento inválido.');
  }

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo';
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: String(event.title || ''),
    dates: googleCalendarDates(event),
    details: String(event.notes || ''),
    location: String(event.location || ''),
    ctz: timeZone,
  });

  return `https://calendar.google.com/calendar/r/eventedit?${params.toString()}`;
}

export async function addIcsToCalendar(event) {
  const url = googleCalendarUrl(event);
  const opened = window.open(url, '_blank', 'noopener');

  if (!opened) {
    window.location.assign(url);
  }

  return 'google';
}

export function downloadIcs(event) {
  const content = eventToIcs(event);
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'evento-maria-elis.ics';
  link.type = 'text/calendar';
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}
