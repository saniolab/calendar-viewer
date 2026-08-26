export function splitLines(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function unfold(lines) {
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    if (/^[ \t]/.test(line) && output.length) {
      const previous = output.at(-1);
      previous.value += line.slice(1);
      previous.end = index;
    } else {
      output.push({ value: line, start: index, end: index });
    }
  }
  return output;
}

function parseLine(value) {
  let split = 0;
  let quoted = false;
  for (; split < value.length; split += 1) {
    if (value[split] === '"') quoted = !quoted;
    if (value[split] === ":" && !quoted) break;
  }

  const head = value.slice(0, split);
  const rawValue = value.slice(split + 1);
  const segments = [];
  let current = "";
  quoted = false;
  for (const char of head) {
    if (char === '"') quoted = !quoted;
    if (char === ";" && !quoted) {
      segments.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  segments.push(current);

  const name = (segments.shift() || "").trim().toUpperCase();
  const params = {};
  for (const segment of segments) {
    const equals = segment.indexOf("=");
    if (equals < 0) {
      params[segment.toUpperCase()] = "";
    } else {
      params[segment.slice(0, equals).toUpperCase()] = segment
        .slice(equals + 1)
        .replace(/^"|"$/g, "");
    }
  }
  return { name, params, value: rawValue };
}

function parseTree(text) {
  const lines = splitLines(text);
  const root = { type: "ROOT", props: [], children: [], start: 0, end: lines.length - 1 };
  const stack = [root];

  for (const unfolded of unfold(lines)) {
    const prop = { ...parseLine(unfolded.value), start: unfolded.start, end: unfolded.end };
    if (prop.name === "BEGIN") {
      const component = {
        type: prop.value.trim().toUpperCase(),
        props: [],
        children: [],
        start: unfolded.start,
        end: unfolded.end,
      };
      stack.at(-1).children.push(component);
      stack.push(component);
    } else if (prop.name === "END") {
      if (stack.length > 1) stack.pop().end = unfolded.end;
    } else if (prop.name) {
      stack.at(-1).props.push(prop);
    }
  }
  return { root, lines };
}

export function unescapeIcs(value) {
  return String(value)
    .replace(/\\[nN]/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\([,;:\\])/g, "$1");
}

export function getProp(component, name) {
  return component.props.find((prop) => prop.name === name) || null;
}

export function getValue(component, name) {
  const prop = getProp(component, name);
  return prop ? unescapeIcs(prop.value) : "";
}

function timezoneOffset(utc, timezone) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(utc)).map(({ type, value }) => [type, value]),
  );
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  ) - utc;
}

function wallTimeToUtc(year, month, day, hour, minute, second, timezone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  try {
    let result = guess - timezoneOffset(guess, timezone);
    result = guess - timezoneOffset(result, timezone);
    return result;
  } catch {
    return new Date(year, month - 1, day, hour, minute, second).getTime();
  }
}

export function parseDate(prop) {
  if (!prop) return null;
  const raw = String(prop.value).trim();
  const timezone = prop.params.TZID || null;
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!match) return { raw, ms: null, allDay: false, timezone, kind: "unparsed" };

  const [, year, month, day, hour, minute, second, zulu] = match;
  if (!hour) {
    return {
      raw,
      ms: Date.UTC(Number(year), Number(month) - 1, Number(day)),
      allDay: true,
      timezone: null,
      kind: "date",
    };
  }

  const values = [year, month, day, hour, minute, second].map(Number);
  let ms;
  let kind;
  if (zulu) {
    ms = Date.UTC(values[0], values[1] - 1, ...values.slice(2));
    kind = "utc";
  } else if (timezone) {
    ms = wallTimeToUtc(...values, timezone);
    kind = "zoned";
  } else {
    ms = new Date(values[0], values[1] - 1, ...values.slice(2)).getTime();
    kind = "floating";
  }
  return { raw, ms, allDay: prop.params.VALUE === "DATE", timezone: zulu ? "UTC" : timezone, kind };
}

function parseDuration(value) {
  const match = String(value).match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (
    (Number(match[2]) || 0) * 604800 +
    (Number(match[3]) || 0) * 86400 +
    (Number(match[4]) || 0) * 3600 +
    (Number(match[5]) || 0) * 60 +
    (Number(match[6]) || 0)
  ) * 1000;
}

export function recurrenceText(value) {
  const rule = Object.fromEntries(
    String(value).split(";").map((part) => {
      const index = part.indexOf("=");
      return [part.slice(0, index), part.slice(index + 1)];
    }),
  );
  const interval = Number(rule.INTERVAL || 1);
  const units = {
    SECONDLY: "second",
    MINUTELY: "minute",
    HOURLY: "hour",
    DAILY: "day",
    WEEKLY: "week",
    MONTHLY: "month",
    YEARLY: "year",
  };
  const unit = units[rule.FREQ] || String(rule.FREQ || "recurring").toLowerCase();
  let text = interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`;
  if (rule.BYDAY) text += ` · ${rule.BYDAY}`;
  if (rule.COUNT) text += ` · ${rule.COUNT} times`;
  if (rule.UNTIL) text += ` · until ${rule.UNTIL}`;
  return text;
}

function buildRecord(component, lines, source, order) {
  let start = parseDate(getProp(component, "DTSTART"));
  let end = parseDate(getProp(component, "DTEND"));
  const due = parseDate(getProp(component, "DUE"));
  let isDue = false;
  if (!start && due) {
    start = due;
    isDue = true;
  } else if (!end && due) {
    end = due;
  }

  const durationProp = getProp(component, "DURATION");
  let duration = durationProp ? parseDuration(durationProp.value) : null;
  if (!end && start?.ms != null && duration != null) {
    end = { ...start, raw: `(${durationProp.value})`, ms: start.ms + duration, kind: "derived" };
  }
  if (duration == null && start?.ms != null && end?.ms != null) duration = end.ms - start.ms;

  const recurrence = getProp(component, "RRULE");
  const attendeeProps = component.props.filter((prop) => prop.name === "ATTENDEE");
  const alarms = component.children.filter((child) => child.type === "VALARM");

  return {
    order,
    type: component.type,
    source,
    line: [component.start + 1, component.end + 1],
    summary: getValue(component, "SUMMARY") || getValue(component, "TZID") || "(untitled)",
    description: getValue(component, "DESCRIPTION"),
    location: getValue(component, "LOCATION"),
    status: getValue(component, "STATUS"),
    uid: getValue(component, "UID"),
    organiser: getValue(component, "ORGANIZER"),
    categories: getValue(component, "CATEGORIES"),
    url: getValue(component, "URL"),
    recurrenceId: getValue(component, "RECURRENCE-ID"),
    attendees: attendeeProps.map((prop) => ({
      name: prop.params.CN || "",
      role: prop.params.ROLE || "",
      status: prop.params.PARTSTAT || "",
      value: prop.value,
    })),
    alarms: alarms.map((alarm) => ({
      trigger: getValue(alarm, "TRIGGER"),
      action: getValue(alarm, "ACTION"),
    })),
    start,
    end,
    duration,
    isDue,
    recurrence: recurrence ? { raw: recurrence.value, text: recurrenceText(recurrence.value) } : null,
    allDay: Boolean(start?.allDay),
    props: component.props,
    children: component.children,
    raw: lines.slice(component.start, component.end + 1),
    rawFrom: component.start + 1,
  };
}

export function parseCalendar(text, source = "Calendar") {
  if (!/BEGIN\s*:\s*VCALENDAR/i.test(text)) throw new Error("Not an ICS file.");
  const { root, lines } = parseTree(text);
  const calendars = root.children.filter((child) => child.type === "VCALENDAR");
  const scopes = calendars.length ? calendars : [root];
  const wanted = new Set(["VEVENT", "VTODO", "VJOURNAL", "VFREEBUSY", "VTIMEZONE", "VAVAILABILITY"]);
  const records = [];
  const metadata = [];

  for (const calendar of scopes) {
    metadata.push({
      source,
      name: getValue(calendar, "X-WR-CALNAME"),
      prodId: getValue(calendar, "PRODID"),
      version: getValue(calendar, "VERSION"),
      method: getValue(calendar, "METHOD"),
      timezone: getValue(calendar, "X-WR-TIMEZONE"),
    });
    for (const component of calendar.children) {
      if (wanted.has(component.type)) records.push(buildRecord(component, lines, source, records.length));
    }
  }
  return { records, metadata };
}
