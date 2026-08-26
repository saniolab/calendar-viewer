import "./style.css";
import { parseCalendar } from "./ics.js";
import { CALENDAR_VIEWS, calendarViewKey, createCalendar, formatCalDate, setCalendarRecords } from "./calendar.js";
import {
  $,
  eventDetailHtml,
  exportCsv,
  exportJson,
  renderEventList,
  renderSources,
  renderSpectrum,
  renderStats,
  renderTypeFilters,
  showMessage,
} from "./ui.js";

const state = {
  sources: [],
  records: [],
  metadata: [],
  selectedTypes: new Set(),
  time: "all",
  query: "",
  sort: "start-asc",
  originalTime: false,
  view: "list",
  bucket: null,
};

const calendar = createCalendar($("#calendar"), {
  onEventClick: openRecord,
  onDatesSet: replaceCalendarHistory,
  onNavLink: pushCalendarView,
});
let calendarRendered = false;
let applyingCalendarHistory = false;
let pendingCalendarView = null;

function rebuildRecords() {
  state.records = state.sources
    .flatMap((source) => source.records)
    .map((record, index) => ({ ...record, _index: index }));
  state.metadata = state.sources.flatMap((source) => source.metadata);
  state.selectedTypes = new Set(
    [...state.selectedTypes].filter((type) => state.records.some((record) => record.type === type)),
  );
}

function addSource(name, text, { url = null, replaceIndex = null, replaceAll = true } = {}) {
  const parsed = parseCalendar(text, name);
  const source = {
    name,
    url,
    bytes: new Blob([text]).size,
    count: parsed.records.length,
    ...parsed,
  };
  if (replaceIndex != null) state.sources[replaceIndex] = source;
  else if (replaceAll) state.sources = [source];
  else state.sources.push(source);
  rebuildRecords();
  showMessage(`${name}: ${parsed.records.length} event${parsed.records.length === 1 ? "" : "s"}${replaceIndex != null ? " reloaded" : ""}.`);
  render();
}

function removeSource(index) {
  state.sources.splice(index, 1);
  rebuildRecords();
  render();
}

function filteredRecords() {
  const now = Date.now();
  const query = state.query.toLowerCase();
  const records = state.records.filter((record) => {
    if (state.selectedTypes.size && !state.selectedTypes.has(record.type)) return false;
    if (query) {
      const descriptionProperties = record.props
        .filter((prop) => /^(DESCRIPTION|X-ALT-DESC|ALTDESC|X-ALT-DESCRIPTION)$/.test(prop.name))
        .map((prop) => prop.value)
        .join(" ");
      const haystack = [
        record.summary, record.description, record.location, record.uid, record.organiser,
        record.categories, record.source, descriptionProperties,
      ].join(" ").toLowerCase();
      if (!haystack.includes(query)) return false;
    }

    if (state.time !== "all") {
      if (record.start?.ms == null) return false;
      const end = record.end?.ms ?? record.start.ms;
      if (state.time === "upcoming" && end < now) return false;
      if (state.time === "past" && end >= now) return false;
      if (state.time === "30" && (record.start.ms < now - 86400000 || record.start.ms > now + 30 * 86400000)) return false;
    }
    if (state.bucket && (
      record.start?.ms == null ||
      record.start.ms < state.bucket[0] ||
      record.start.ms >= state.bucket[1]
    )) return false;
    return true;
  });

  const start = (record) => record.start?.ms ?? Number.POSITIVE_INFINITY;
  if (state.sort === "start-asc") records.sort((a, b) => start(a) - start(b) || a.order - b.order);
  else if (state.sort === "start-desc") records.sort((a, b) => start(b) - start(a) || a.order - b.order);
  else if (state.sort === "summary") records.sort((a, b) => a.summary.localeCompare(b.summary, "en"));
  else records.sort((a, b) => a.order - b.order);
  return records;
}

function render() {
  const hasRecords = state.records.length > 0;
  const filtered = filteredRecords();
  $("#sourcesPanel").hidden = !state.sources.length;
  $("#filtersPanel").hidden = !hasRecords;
  $("#mainToolbar").hidden = !hasRecords;
  $("#exportJson").disabled = !hasRecords;
  $("#exportCsv").disabled = !hasRecords;
  $("#stats").hidden = !hasRecords;
  $("#listHeading").hidden = !hasRecords;
  $("#count").textContent = hasRecords
    ? `${state.records.length} event${state.records.length === 1 ? "" : "s"}`
    : "No calendar";
  $("#calendarEmpty").hidden = hasRecords;

  renderSources(state.sources);
  renderTypeFilters(state.records, state.selectedTypes);
  renderStats(state.records, state.metadata, state.sources);
  renderSpectrum(state.records, state.bucket);
  renderEventList(filtered, state.records.length, state.originalTime);
  setCalendarRecords(calendar, filtered);
}

function setView(view) {
  state.view = view;
  const isCalendar = view === "calendar";
  $("#calendarView").hidden = !isCalendar;
  $("#listView").hidden = isCalendar;
  $("#listControls").classList.toggle("hidden", isCalendar);
  $("#listControls").classList.toggle("flex", !isCalendar);
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  });
  if (isCalendar) {
    requestAnimationFrame(() => {
      if (!calendarRendered) {
        calendarRendered = true;
        calendar.render();
      } else {
        calendar.updateSize();
      }
      if (pendingCalendarView) {
        const next = pendingCalendarView;
        pendingCalendarView = null;
        calendar.changeView(next.view, next.date || undefined);
      }
    });
  }
}

function openRecord(record) {
  if (!record) return;
  $("#dialogTitle").textContent = record.summary;
  $("#dialogBody").innerHTML = eventDetailHtml(record);
  $("#eventDialog").showModal();
}

async function loadUrl({
  url: suppliedUrl = "",
  historyMode = "push",
  replaceIndex = null,
  replaceAll = true,
} = {}) {
  let url = suppliedUrl || $("#urlInput").value.trim();
  if (!url) return;
  url = url.replace(/^webcal:\/\//i, "https://");
  $("#urlInput").value = url;
  showMessage("Loading…");
  try {
    const response = await fetch(`/fetch?url=${encodeURIComponent(url)}`);
    if (!response.ok) throw new Error(await response.text());
    const text = await response.text();
    const parsedUrl = new URL(url);
    addSource(
      parsedUrl.pathname.split("/").filter(Boolean).at(-1) || parsedUrl.hostname,
      text,
      { url, replaceIndex, replaceAll },
    );
    if (historyMode) {
      const pageUrl = new URL(location.href);
      const cal = historyMode === "replace" ? pageUrl.searchParams.get("cal") : null;
      const date = historyMode === "replace" ? pageUrl.searchParams.get("date") : null;
      pageUrl.search = "";
      pageUrl.searchParams.set("url", url);
      if (cal) {
        pageUrl.searchParams.set("cal", cal);
        if (date) pageUrl.searchParams.set("date", date);
      }
      window.history[historyMode === "replace" ? "replaceState" : "pushState"](
        {
          calendarUrl: url,
          calView: CALENDAR_VIEWS[cal] || "dayGridMonth",
          calDate: date || formatCalDate(new Date()),
        },
        "",
        pageUrl,
      );
    }
  } catch {
    showMessage("Couldn’t load that URL.", "error");
  }
}

function loadFiles(files) {
  showMessage();
  const file = [...files][0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      addSource(file.name, reader.result);
    } catch (error) {
      showMessage(error.message || "Not an ICS file.", "error");
    }
  };
  reader.onerror = () => showMessage("Couldn’t read that file.", "error");
  reader.readAsText(file, "utf-8");
}

document.querySelectorAll("[data-source-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll("[data-source-tab]").forEach((item) => {
      item.setAttribute("aria-selected", String(item === tab));
    });
    document.querySelectorAll("[data-source-pane]").forEach((pane) => {
      pane.hidden = pane.dataset.sourcePane !== tab.dataset.sourceTab;
    });
  });
});

$("#dropZone").addEventListener("click", () => $("#fileInput").click());
$("#fileInput").addEventListener("change", (event) => loadFiles(event.target.files));
["dragenter", "dragover"].forEach((name) => $("#dropZone").addEventListener(name, (event) => {
  event.preventDefault();
  $("#dropZone").classList.add("border-indigo-500", "bg-indigo-50");
}));
["dragleave", "drop"].forEach((name) => $("#dropZone").addEventListener(name, (event) => {
  event.preventDefault();
  $("#dropZone").classList.remove("border-indigo-500", "bg-indigo-50");
}));
$("#dropZone").addEventListener("drop", (event) => loadFiles(event.dataTransfer.files));

$("#loadUrl").addEventListener("click", () => loadUrl());
$("#urlInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") loadUrl();
});
$("#loadPaste").addEventListener("click", () => {
  try {
    addSource("Pasted ICS", $("#pasteInput").value);
  } catch (error) {
    showMessage(error.message || "Not an ICS file.", "error");
  }
});

$("#sources").addEventListener("click", (event) => {
  const reload = event.target.closest("[data-reload-source]");
  if (reload) {
    const index = Number(reload.dataset.reloadSource);
    loadUrl({
      url: state.sources[index].url,
      historyMode: null,
      replaceIndex: index,
      replaceAll: false,
    });
    return;
  }
  const button = event.target.closest("[data-remove-source]");
  if (button) removeSource(Number(button.dataset.removeSource));
});
$("#typeFilters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-type]");
  if (!button) return;
  const { type } = button.dataset;
  state.selectedTypes.has(type) ? state.selectedTypes.delete(type) : state.selectedTypes.add(type);
  render();
});
$("#timeFilters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-time]");
  if (!button) return;
  state.time = button.dataset.time;
  document.querySelectorAll("[data-time]").forEach((item) => {
    item.setAttribute("aria-pressed", String(item === button));
  });
  render();
});
$("#search").addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});
$("#resetFilters").addEventListener("click", () => {
  state.query = "";
  state.time = "all";
  state.selectedTypes.clear();
  state.bucket = null;
  $("#search").value = "";
  document.querySelectorAll("[data-time]").forEach((item) => {
    item.setAttribute("aria-pressed", String(item.dataset.time === "all"));
  });
  render();
});

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});
$("#sort").addEventListener("change", (event) => {
  state.sort = event.target.value;
  render();
});
$("#timezone").addEventListener("change", (event) => {
  state.originalTime = event.target.value === "original";
  render();
});
$("#eventList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-toggle-record]");
  if (!button) return;
  const article = button.closest("[data-record]");
  const detail = article.querySelector(".record-detail");
  const opening = detail.hidden;
  if (opening && !detail.innerHTML) {
    detail.innerHTML = eventDetailHtml(state.records[Number(button.dataset.toggleRecord)]);
  }
  detail.hidden = !opening;
  button.setAttribute("aria-expanded", String(opening));
  button.querySelector(".record-caret").textContent = opening ? "▴" : "▾";
});
$("#spectrumBars").addEventListener("click", (event) => {
  const button = event.target.closest("[data-bucket-from]");
  if (!button) return;
  const bucket = [Number(button.dataset.bucketFrom), Number(button.dataset.bucketTo)];
  state.bucket = state.bucket && Math.abs(state.bucket[0] - bucket[0]) < 1 ? null : bucket;
  render();
});
$("#resetSpectrum").addEventListener("click", () => {
  state.bucket = null;
  render();
});
$("#closeDialog").addEventListener("click", () => $("#eventDialog").close());
$("#eventDialog").addEventListener("click", (event) => {
  if (event.target === $("#eventDialog")) $("#eventDialog").close();
});
$("#exportJson").addEventListener("click", () => exportJson(filteredRecords(), state.metadata));
$("#exportCsv").addEventListener("click", () => exportCsv(filteredRecords()));

function loadedCalendarUrl() {
  return state.sources.find((source) => source.url)?.url || null;
}

function calendarSnapshot(view, date) {
  return {
    calendarUrl: new URLSearchParams(location.search).get("url") || loadedCalendarUrl(),
    calView: view || calendar.view?.type || "dayGridMonth",
    calDate: formatCalDate(date || calendar.getDate?.() || new Date()),
  };
}

function calendarPageUrl(snapshot, { includeView = snapshot.calView !== "dayGridMonth" } = {}) {
  const pageUrl = new URL(location.href);
  pageUrl.search = "";
  if (snapshot.calendarUrl) pageUrl.searchParams.set("url", snapshot.calendarUrl);
  if (includeView) {
    pageUrl.searchParams.set("cal", calendarViewKey(snapshot.calView));
    if (snapshot.calDate) pageUrl.searchParams.set("date", snapshot.calDate);
  }
  return pageUrl;
}

function pushCalendarView(view, date) {
  const snapshot = calendarSnapshot(view, date);
  history.pushState(snapshot, "", calendarPageUrl(snapshot));
}

function replaceCalendarHistory() {
  if (applyingCalendarHistory || !calendarRendered) return;
  const snapshot = calendarSnapshot();
  const pageUrl = new URL(location.href);
  const hasCal = pageUrl.searchParams.has("cal");
  history.replaceState(snapshot, "", hasCal ? calendarPageUrl(snapshot) : pageUrl);
}

function restoreCalendar(hist) {
  const params = new URLSearchParams(location.search);
  const view = hist?.calView || CALENDAR_VIEWS[params.get("cal")] || "dayGridMonth";
  const date = hist?.calDate || params.get("date") || "";
  applyingCalendarHistory = true;
  if (state.view === "calendar" || params.get("cal") || (hist?.calView && hist.calView !== "dayGridMonth")) {
    if (calendarRendered) calendar.changeView(view, date || undefined);
    else pendingCalendarView = { view, date };
    setView("calendar");
  } else if (calendarRendered) {
    calendar.changeView(view, date || undefined);
  }
  requestAnimationFrame(() => {
    applyingCalendarHistory = false;
  });
}

const initialParams = new URLSearchParams(location.search);
const initialUrl = initialParams.get("url");
if (initialUrl) {
  $("#urlInput").value = initialUrl;
  document.querySelector('[data-source-tab="url"]').click();
  loadUrl({ url: initialUrl, historyMode: "replace", replaceAll: true }).then(() => {
    if (initialParams.get("cal")) {
      restoreCalendar({
        calView: CALENDAR_VIEWS[initialParams.get("cal")],
        calDate: initialParams.get("date"),
      });
    }
  });
}

window.addEventListener("popstate", (event) => {
  const url = new URLSearchParams(location.search).get("url");
  if (url && url !== loadedCalendarUrl()) {
    document.querySelector('[data-source-tab="url"]').click();
    loadUrl({ url, historyMode: null, replaceAll: true }).then(() => restoreCalendar(event.state));
  } else if (!url && loadedCalendarUrl()) {
    state.sources = [];
    $("#urlInput").value = "";
    rebuildRecords();
    render();
  } else {
    restoreCalendar(event.state);
  }
});

render();
