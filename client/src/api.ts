export type Me = {
  barber: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    shopName: string;
    timezone: string;
    businessHours: string;
    appointmentDurationMinutes: number;
    slotIntervalMinutes: number;
    minLeadTimeMinutes: number;
    bookingWindowDays: number;
    notifyPhone: string | null;
  };
  google: {
    connected: boolean;
    needsReauth: boolean;
    calendar: { summary: string; timeZone: string | null } | null;
  };
  phoneNumber: { e164: string; createdAt: string } | null;
};

export type Appointment = {
  id: string;
  customerName: string;
  customerPhone: string;
  startsAt: string;
  endsAt: string;
};

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(body.error ?? response.statusText, response.status, body.code);
  }

  return (await response.json()) as T;
}

export const api = {
  me: () => request<Me>("/api/me"),
  appointments: () => request<{ appointments: Appointment[] }>("/api/appointments"),
  timezones: () => request<{ timezones: string[] }>("/api/timezones"),
  saveSettings: (settings: Omit<Me["barber"], "id" | "email" | "avatarUrl">) =>
    request<{ ok: true }>("/api/settings", { method: "PUT", body: JSON.stringify(settings) }),
  activateNumber: (areaCode?: string) =>
    request<{ phoneNumber: { e164: string; createdAt: string } }>("/api/phone-number", {
      method: "POST",
      body: JSON.stringify(areaCode ? { areaCode } : {}),
    }),
  releaseNumber: () => request<{ ok: true }>("/api/phone-number", { method: "DELETE" }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
};
