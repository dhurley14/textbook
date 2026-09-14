import { useEffect, useState } from "react";
import { ApiError, api, type Appointment, type Me } from "../api";

function formatPhone(e164: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : e164;
}

function formatWhen(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  });
}

export function Dashboard({ me, onRefresh }: { me: Me; onRefresh: () => void }) {
  const [appointments, setAppointments] = useState<Appointment[] | null>(null);
  const [areaCode, setAreaCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .appointments()
      .then((data) => setAppointments(data.appointments))
      .catch(() => setAppointments([]));
  }, []);

  async function activate() {
    setBusy(true);
    setError(null);
    try {
      await api.activateNumber(areaCode.trim() || undefined);
      onRefresh();
    } catch (activateError) {
      setError(activateError instanceof ApiError ? activateError.message : "Could not get a number.");
    } finally {
      setBusy(false);
    }
  }

  async function release() {
    if (!confirm("Release this number? Customers texting it will no longer reach you.")) return;
    setBusy(true);
    try {
      await api.releaseNumber();
      onRefresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {me.google.needsReauth && (
        <div className="notice">
          Your Google Calendar connection expired, so we can't book appointments right now.{" "}
          <a href="/auth/google">Reconnect Google</a>
        </div>
      )}

      <div className="card">
        <h2>Your booking number</h2>
        <p className="hint">This is the number you give out to clients.</p>

        {me.phoneNumber ? (
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="phone">{formatPhone(me.phoneNumber.e164)}</div>
            <button className="danger" onClick={release} disabled={busy}>
              Release
            </button>
          </div>
        ) : (
          <>
            <div className="row">
              <input
                style={{ maxWidth: 160 }}
                placeholder="Area code (optional)"
                value={areaCode}
                inputMode="numeric"
                maxLength={3}
                onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, ""))}
              />
              <button onClick={activate} disabled={busy || !me.google.connected}>
                {busy ? "Getting a number…" : "Activate my number"}
              </button>
            </div>
            {!me.google.connected && (
              <p className="hint" style={{ marginTop: 12, marginBottom: 0 }}>
                Connect Google Calendar first — a booking number is no use without a calendar to book into.
              </p>
            )}
            {error && <p className="hint" style={{ color: "var(--danger)", marginTop: 12, marginBottom: 0 }}>{error}</p>}
          </>
        )}
      </div>

      <div className="card">
        <h2>Google Calendar</h2>
        <div className="row">
          {me.google.needsReauth ? (
            <span className="badge warn">Needs reconnecting</span>
          ) : me.google.connected ? (
            <span className="badge ok">Connected</span>
          ) : (
            <span className="badge warn">Not connected</span>
          )}
          {me.google.calendar && <span className="badge">{me.google.calendar.summary}</span>}
          {me.google.calendar?.timeZone && me.google.calendar.timeZone !== me.barber.timezone && (
            <span className="badge warn">Calendar is {me.google.calendar.timeZone}</span>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Upcoming appointments</h2>
        {appointments === null ? (
          <p className="empty">Loading…</p>
        ) : appointments.length === 0 ? (
          <p className="empty">
            Nothing booked yet. {me.phoneNumber ? "Text your number to try it out." : "Activate a number to start taking bookings."}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Client</th>
                <th>Phone</th>
              </tr>
            </thead>
            <tbody>
              {appointments.map((appointment) => (
                <tr key={appointment.id}>
                  <td>{formatWhen(appointment.startsAt, me.barber.timezone)}</td>
                  <td>{appointment.customerName}</td>
                  <td>{formatPhone(appointment.customerPhone)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
