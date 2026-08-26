import { Calendar } from "@fullcalendar/core";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin from "@fullcalendar/interaction";

function exclusiveAllDayEnd(record) {
  if (record.end?.ms != null) return new Date(record.end.ms);
  if (record.start?.ms != null) return new Date(record.start.ms + 86400000);
  return null;
}

export function toCalendarEvents(records) {
  return records
    .filter((record) => record.start?.ms != null && ["VEVENT", "VTODO"].includes(record.type))
    .map((record) => ({
      id: `${record.source}:${record.uid || record.order}`,
      title: record.summary,
      start: new Date(record.start.ms),
      end: record.allDay ? exclusiveAllDayEnd(record) : record.end?.ms != null ? new Date(record.end.ms) : null,
      allDay: record.allDay,
      extendedProps: { record },
    }));
}

export const CALENDAR_VIEWS = {
  month: "dayGridMonth",
  week: "timeGridWeek",
  day: "timeGridDay",
  agenda: "listMonth",
};

export function calendarViewKey(view) {
  return Object.entries(CALENDAR_VIEWS).find(([, name]) => name === view)?.[0] || "month";
}

export function formatCalDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function createCalendar(element, { onEventClick, onDatesSet, onNavLink } = {}) {
  const calendar = new Calendar(element, {
    plugins: [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin],
    initialView: "dayGridMonth",
    height: "auto",
    firstDay: 1,
    weekNumbers: true,
    weekNumberCalculation: "ISO",
    navLinks: true,
    navLinkDayClick(date) {
      onNavLink?.("timeGridDay", date);
      calendar.changeView("timeGridDay", date);
    },
    navLinkWeekClick(date) {
      onNavLink?.("timeGridWeek", date);
      calendar.changeView("timeGridWeek", date);
    },
    datesSet() {
      onDatesSet?.();
    },
    nowIndicator: true,
    dayMaxEvents: true,
    headerToolbar: {
      left: "prev,next today",
      center: "title",
      right: "dayGridMonth,timeGridWeek,timeGridDay,listMonth",
    },
    buttonText: {
      today: "Today",
      month: "Month",
      week: "Week",
      day: "Day",
      list: "Agenda",
    },
    eventClick(info) {
      info.jsEvent.preventDefault();
      onEventClick?.(info.event.extendedProps.record);
    },
  });
  return calendar;
}

export function setCalendarRecords(calendar, records) {
  calendar.removeAllEvents();
  calendar.addEventSource(toCalendarEvents(records));
}
