import { useEffect, useState } from "react";
import { ApiError, api, type Me } from "../api";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type DayHours = { open: boolean; start: string; end: string };

/** "1:09:00-17:00,2:09:00-17:00" <-> per-day form rows. */
function parseHours(spec: string): DayHours[] {
  const days: DayHours[] = DAYS.map(() => ({ open: false, start: "09:00", end: "17:00" }));

  for (const entry of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const match = /^(\d):(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(entry);
    if (!match) continue;
    const day = Number(match[1]);
    if (day < 0 || day > 6) continue;
    days[day] = { open: true, start: match[2]!, end: match[3]! };
  }

  return days;
}

function serializeHours(days: DayHours[]): string {
  return days
    .map((day, index) => (day.open ? `${index}:${day.start}-${day.end}` : null))
    .filter(Boolean)
    .join(",");
}

export function Settings({ me, onRefresh }: { me: Me; onRefresh: () => void }) {
  const [form, setForm] = useState({
    shopName: me.barber.shopName,
    displayName: me.barber.displayName,
    timezone: me.barber.timezone,
    appointmentDurationMinutes: me.barber.appointmentDurationMinutes,
    slotIntervalMinutes: me.barber.slotIntervalMinutes,
    minLeadTimeMinutes: me.barber.minLeadTimeMinutes,
    bookingWindowDays: me.barber.bookingWindowDays,
    notifyPhone: me.barber.notifyPhone ?? "",
  });
  const [days, setDays] = useState(() => parseHours(me.barber.businessHours));
  const [timezones, setTimezones] = useState<string[]>([me.barber.timezone]);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .timezones()
      .then((data) => setTimezones(data.timezones))
      .catch(() => undefined);
  }, []);

  function setDay(index: number, patch: Partial<DayHours>) {
    setDays((current) => current.map((day, i) => (i === index ? { ...day, ...patch } : day)));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setStatus(null);

    try {
      await api.saveSettings({
        ...form,
        businessHours: serializeHours(days),
        notifyPhone: form.notifyPhone.trim() || null,
      });
      setStatus({ kind: "ok", text: "Saved." });
      onRefresh();
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof ApiError ? error.message : "Could not save." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save}>
      <div className="card">
        <h2>Shop</h2>
        <div className="grid">
          <label>
            <span>Shop name</span>
            <input
              value={form.shopName}
              onChange={(e) => setForm({ ...form, shopName: e.target.value })}
              required
            />
          </label>
          <label>
            <span>Your name</span>
            <input
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              required
            />
          </label>
          <label>
            <span>Timezone</span>
            <select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {timezones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Text me when a booking comes in</span>
            <input
              placeholder="+15555550123"
              value={form.notifyPhone}
              onChange={(e) => setForm({ ...form, notifyPhone: e.target.value })}
            />
          </label>
        </div>
      </div>

      <div className="card">
        <h2>Hours</h2>
        <p className="hint">Anything already on your Google Calendar blocks these hours automatically.</p>
        {days.map((day, index) => (
          <div className="row" key={DAYS[index]} style={{ marginBottom: 8 }}>
            <label style={{ width: 120, margin: 0, display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={day.open}
                onChange={(e) => setDay(index, { open: e.target.checked })}
              />
              <span style={{ margin: 0 }}>{DAYS[index]}</span>
            </label>
            <input
              type="time"
              style={{ width: 130 }}
              value={day.start}
              disabled={!day.open}
              onChange={(e) => setDay(index, { start: e.target.value })}
            />
            <span style={{ color: "var(--muted)" }}>to</span>
            <input
              type="time"
              style={{ width: 130 }}
              value={day.end}
              disabled={!day.open}
              onChange={(e) => setDay(index, { end: e.target.value })}
            />
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Booking rules</h2>
        <div className="grid">
          <label>
            <span>Appointment length (minutes)</span>
            <input
              type="number"
              min={5}
              max={480}
              value={form.appointmentDurationMinutes}
              onChange={(e) => setForm({ ...form, appointmentDurationMinutes: Number(e.target.value) })}
            />
          </label>
          <label>
            <span>Offer start times every (minutes)</span>
            <input
              type="number"
              min={5}
              max={240}
              value={form.slotIntervalMinutes}
              onChange={(e) => setForm({ ...form, slotIntervalMinutes: Number(e.target.value) })}
            />
          </label>
          <label>
            <span>Minimum notice (minutes)</span>
            <input
              type="number"
              min={0}
              max={10080}
              value={form.minLeadTimeMinutes}
              onChange={(e) => setForm({ ...form, minLeadTimeMinutes: Number(e.target.value) })}
            />
          </label>
          <label>
            <span>Book up to (days ahead)</span>
            <input
              type="number"
              min={1}
              max={90}
              value={form.bookingWindowDays}
              onChange={(e) => setForm({ ...form, bookingWindowDays: Number(e.target.value) })}
            />
          </label>
        </div>
      </div>

      <div className="row">
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
        {status && (
          <span style={{ color: status.kind === "ok" ? "var(--ok)" : "var(--danger)", fontSize: 14 }}>
            {status.text}
          </span>
        )}
      </div>
    </form>
  );
}
