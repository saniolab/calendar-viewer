import { recurrenceText, unescapeIcs } from "./ics.js";

export const $ = (selector) => document.querySelector(selector);

export function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[char]);
}

export function showMessage(text = "", type = "success") {
  const classes = type === "error"
    ? "mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
    : "mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800";
  $("#message").innerHTML = text ? `<div class="${classes}">${escapeHtml(text)}</div>` : "";
}

function isHtmlProperty(prop, value) {
  const type = String(prop.params?.FMTTYPE || prop.params?.VALUE || "").toLowerCase();
  return type.includes("text/html") ||
    type === "html" ||
    (/^(DESCRIPTION|X-ALT-DESC|ALTDESC|X-ALT-DESCRIPTION)$/.test(prop.name) &&
      /<(?:p|div|br|a|ul|ol|li|table|strong|em|b|i|h[1-6]|img)[\s/>]/i.test(value));
}

function cleanUrl(value) {
  let url = String(value || "")
    .trim()
    .replace(/&quot;/gi, '"')
    .replace(/^['"\\]+|['"\\]+$/g, "")
    .trim();
  if (/^(https?:|mailto:|webcal:)/i.test(url)) return url;
  if (/^data:image\//i.test(url)) return url;
  return "";
}

export function sanitizeHtml(value) {
  const parsed = new DOMParser().parseFromString(String(value), "text/html");
  const banned = new Set([
    "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "BASE",
    "FORM", "INPUT", "TEXTAREA", "BUTTON",
  ]);
  parsed.querySelectorAll("*").forEach((node) => {
    if (banned.has(node.tagName)) {
      node.remove();
      return;
    }
    const allowed = new Set(["href", "src", "alt", "title", "width", "height", "colspan", "rowspan"]);
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      const content = attribute.value || "";
      if (!allowed.has(name)) {
        node.removeAttribute(attribute.name);
        continue;
      }
      if (["href", "src", "xlink:href"].includes(name)) {
        const cleaned = cleanUrl(content);
        if (cleaned) node.setAttribute(attribute.name, cleaned);
        else node.removeAttribute(attribute.name);
      }
    }
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  return parsed.body.innerHTML;
}

function htmlDescription(record) {
  const preferred = ["X-ALT-DESC", "ALTDESC", "X-ALT-DESCRIPTION", "DESCRIPTION"];
  for (const name of preferred) {
    const prop = record.props.find((item) => item.name === name);
    if (!prop) continue;
    const value = unescapeIcs(prop.value);
    if (isHtmlProperty(prop, value)) return sanitizeHtml(value);
  }
  return "";
}

export function formatDate(date, original = false, reference = null) {
  if (!date) return "—";
  if (original || date.ms == null) return date.raw;
  const value = new Date(date.ms);
  if (date.allDay) {
    return value.toLocaleDateString("en-GB", {
      timeZone: "UTC",
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }
  const sameDay = reference?.ms != null &&
    new Date(reference.ms).toDateString() === value.toDateString();
  return value.toLocaleString("en-GB", sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : {
        weekday: "short",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function durationText(milliseconds) {
  if (milliseconds == null) return "";
  const days = Math.floor(milliseconds / 86400000);
  const hours = Math.floor((milliseconds % 86400000) / 3600000);
  const minutes = Math.round((milliseconds % 3600000) / 60000);
  return [
    days ? `${days}d` : "",
    hours ? `${hours}h` : "",
    minutes ? `${minutes}m` : "",
  ].filter(Boolean).join(" ") || "0m";
}

function badge(text, classes = "") {
  return `<span class="badge ${classes}">${escapeHtml(text)}</span>`;
}

function badges(record) {
  return [
    record.allDay ? badge("all-day", "border-indigo-200 bg-indigo-50 text-indigo-800") : "",
    record.isDue ? badge("due", "border-amber-200 bg-amber-50 text-amber-800") : "",
    record.recurrence ? badge(`↻ ${record.recurrence.text}`, "border-amber-200 bg-amber-50 text-amber-800") : "",
    record.status ? badge(record.status, record.status === "CANCELLED" ? "line-through text-rose-700" : "") : "",
    record.recurrenceId ? badge("exception") : "",
    record.alarms.length ? badge(`${record.alarms.length} alarm${record.alarms.length === 1 ? "" : "s"}`) : "",
    record.attendees.length ? badge(`${record.attendees.length} attendee${record.attendees.length === 1 ? "" : "s"}`) : "",
  ].join("");
}

function descriptionPreview(record) {
  const html = htmlDescription(record);
  if (html) return `<div class="html-description mt-2 line-clamp-3 text-xs text-slate-700">${html}</div>`;
  if (record.description) {
    return `<div class="mt-2 line-clamp-3 whitespace-pre-wrap text-xs text-slate-500">${escapeHtml(record.description)}</div>`;
  }
  return "";
}

export function renderSources(sources) {
  $("#sources").innerHTML = sources.map((source, index) => `
    <div class="flex items-center gap-2 py-2 text-xs">
      <span class="min-w-0 flex-1 truncate" title="${escapeHtml(source.name)}">${escapeHtml(source.name)}</span>
      <span class="text-slate-500">${source.count} · ${Math.max(1, Math.round(source.bytes / 1024))} KB</span>
      ${source.url ? `<button class="px-1 text-slate-400 hover:text-indigo-700" data-reload-source="${index}" title="Reload">↻</button>` : ""}
      <button class="px-1 text-slate-400 hover:text-rose-700" data-remove-source="${index}" title="Remove">×</button>
    </div>
  `).join("");
}

export function renderTypeFilters(records, selected) {
  const counts = {};
  records.forEach((record) => { counts[record.type] = (counts[record.type] || 0) + 1; });
  $("#typeFilters").innerHTML = Object.keys(counts).sort().map((type) => `
    <button class="chip" data-type="${type}" aria-pressed="${selected.has(type)}">
      ${type} <span class="text-slate-500">${counts[type]}</span>
    </button>
  `).join("");
}

export function renderStats(records, metadata, sources) {
  const dated = records.filter((record) => record.start?.ms != null);
  const dates = dated.map((record) => record.start.ms);
  const first = metadata[0] || {};
  const cells = [
    ["Calendar", first.name || sources.map((source) => source.name).join(", ") || "—"],
    ["Events", String(records.length)],
    ["Range", dates.length
      ? `${new Date(Math.min(...dates)).toLocaleDateString("en-GB")} – ${new Date(Math.max(...dates)).toLocaleDateString("en-GB")}`
      : "—"],
    ["Recurring", String(records.filter((record) => record.recurrence).length)],
    ["ProdID", first.prodId || "—"],
    ["Version", [first.version, first.method].filter(Boolean).join(" / ") || "—"],
  ];
  $("#stats").innerHTML = cells.map(([label, value]) => `
    <div class="bg-white p-3">
      <div class="text-[10px] uppercase tracking-wider text-slate-500">${label}</div>
      <div class="mt-1 wrap-break-word text-sm font-semibold">${escapeHtml(value)}</div>
    </div>
  `).join("");
}

export function renderSpectrum(records, selectedBucket) {
  const values = records
    .filter((record) => record.start?.ms != null)
    .map((record) => record.start.ms);
  const panel = $("#spectrum");
  if (values.length < 2) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;
  const low = Math.min(...values);
  const high = Math.max(...values) + 1;
  const count = 48;
  const step = (high - low) / count;
  const buckets = new Array(count).fill(0);
  values.forEach((value) => {
    buckets[Math.min(count - 1, Math.floor((value - low) / step))] += 1;
  });
  const maximum = Math.max(...buckets);
  $("#spectrumBars").innerHTML = buckets.map((value, index) => {
    const from = low + index * step;
    const to = from + step;
    const selected = selectedBucket && Math.abs(selectedBucket[0] - from) < 1;
    const colour = selected ? "bg-amber-600" : value ? "bg-indigo-600 hover:bg-amber-600" : "bg-slate-200 hover:bg-amber-600";
    const height = value ? Math.max(6, (value / maximum) * 56) : 2;
    return `<button class="min-w-0 flex-1 rounded-t-sm ${colour}" style="height:${height}px" data-bucket-from="${from}" data-bucket-to="${to}" title="${new Date(from).toLocaleDateString("en-GB")} – ${new Date(to).toLocaleDateString("en-GB")}: ${value}"></button>`;
  }).join("");
  $("#spectrumStart").textContent = new Date(low).toLocaleDateString("en-GB");
  $("#spectrumEnd").textContent = new Date(high).toLocaleDateString("en-GB");
  $("#resetSpectrum").hidden = !selectedBucket;
}

export function renderEventList(records, total, originalTime = false) {
  $("#listTitle").textContent = `${records.length} of ${total} events`;
  $("#eventList").innerHTML = records.length ? records.map((record) => {
    const when = record.start
      ? `${formatDate(record.start, originalTime)}${record.end ? ` – ${formatDate(record.end, originalTime, record.start)}` : ""}`
      : "No date";
    const metadata = [
      record.location ? `📍 ${record.location}` : "",
      record.duration != null && !record.allDay ? durationText(record.duration) : "",
      record.categories ? `# ${record.categories}` : "",
    ].filter(Boolean).join(" · ");
    return `
      <article class="mb-2 grid grid-cols-[58px_minmax(0,1fr)] overflow-hidden rounded-xl border border-slate-200 bg-white" data-record="${record._index}">
        <div class="border-r border-slate-200 bg-slate-50 p-2 text-center text-[9px] text-slate-400">
          <strong class="mb-1 block text-slate-700">${escapeHtml(record.type.replace(/^V/, ""))}</strong>
          ${record.line[0]}–${record.line[1]}
        </div>
        <div class="min-w-0 p-3">
          <button class="flex w-full items-start gap-3 text-left" data-toggle-record="${record._index}" aria-expanded="false">
            <span class="min-w-0 flex-1">
              <strong class="block truncate text-sm">${escapeHtml(record.summary)}</strong>
              <span class="mt-0.5 block text-xs text-slate-700">${escapeHtml(when)}</span>
              ${metadata ? `<span class="mt-1 block text-xs text-slate-500">${escapeHtml(metadata)}</span>` : ""}
              <span class="mt-1.5 flex flex-wrap gap-1">${badges(record)}</span>
            </span>
            <span class="record-caret shrink-0 text-xs text-slate-400">▾</span>
          </button>
          ${descriptionPreview(record)}
          <div class="record-detail mt-3 border-t border-slate-200 pt-3" hidden></div>
        </div>
      </article>
    `;
  }).join("") : `<div class="${total ? "empty-state" : "py-16 text-center text-slate-400"}">${total ? "No matching events." : "No calendar loaded."}</div>`;
}

function propertyRow(prop) {
  const params = Object.entries(prop.params).map(([key, value]) => `${key}=${value}`).join(";");
  let value = unescapeIcs(prop.value);
  if (prop.name === "RRULE") value += `\n→ ${recurrenceText(prop.value)}`;
  const rendered = isHtmlProperty(prop, value)
    ? `<div class="html-description">${sanitizeHtml(value)}</div>`
    : escapeHtml(value.length > 5000 ? `${value.slice(0, 5000)} …` : value);
  return `
    <tr class="border-b border-slate-100">
      <td class="w-px whitespace-nowrap py-1.5 pr-3 align-top font-medium text-indigo-700">${escapeHtml(prop.name)}</td>
      <td class="w-px whitespace-nowrap py-1.5 pr-3 align-top text-[10px] text-amber-700">${escapeHtml(params)}</td>
      <td class="whitespace-pre-wrap py-1.5 align-top wrap-anywhere">${rendered}</td>
    </tr>
  `;
}

export function eventDetailHtml(record) {
  const html = htmlDescription(record);
  const description = html
    ? `<section class="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3"><h3 class="label">Description</h3><div class="html-description text-sm">${html}</div></section>`
    : record.description
      ? `<section class="mb-4 whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">${escapeHtml(record.description)}</section>`
      : "";
  return `
    ${description}
    <details open>
      <summary class="mb-2 cursor-pointer text-xs font-medium">Fields</summary>
      <div class="overflow-x-auto"><table class="w-full border-collapse text-xs"><tbody>${record.props.map(propertyRow).join("")}</tbody></table></div>
    </details>
    <details class="mt-4">
      <summary class="mb-2 cursor-pointer text-xs font-medium">Raw</summary>
      <pre class="overflow-x-auto rounded-lg bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-200">${record.raw.map((line, index) =>
        `<span class="text-slate-500">${String(record.rawFrom + index).padStart(4, " ")}</span>  ${escapeHtml(line)}`
      ).join("\n")}</pre>
    </details>
  `;
}

function download(name, type, data) {
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([data], { type }));
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
}

export function exportJson(records, metadata) {
  download("calendar.json", "application/json", JSON.stringify({ calendar: metadata, records }, null, 2));
}

export function exportCsv(records) {
  const columns = ["TYPE", "SOURCE", "UID", "TITLE", "START", "END", "ALL_DAY", "LOCATION", "STATUS", "RRULE", "ORGANISER", "ATTENDEES", "CATEGORIES", "DESCRIPTION"];
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const rows = records.map((record) => [
    record.type, record.source, record.uid, record.summary,
    record.start?.ms != null ? new Date(record.start.ms).toISOString() : record.start?.raw,
    record.end?.ms != null ? new Date(record.end.ms).toISOString() : record.end?.raw,
    record.allDay ? "yes" : "no", record.location, record.status, record.recurrence?.raw,
    record.organiser, record.attendees.map((attendee) => attendee.name || attendee.value).join(", "),
    record.categories, record.description,
  ].map(quote).join(","));
  download("calendar.csv", "text/csv;charset=utf-8", `\uFEFF${[columns.join(","), ...rows].join("\r\n")}`);
}
