const ERRORS: Record<string, string> = {
  calendar_scope_required: "We need calendar access to book appointments. Please approve that permission.",
  no_refresh_token: "Google didn't return a usable token. Revoke access at myaccount.google.com/permissions and try again.",
  bad_state: "That sign-in link expired. Please try again.",
  missing_code: "Sign-in was cancelled.",
  auth_failed: "Something went wrong signing in. Please try again.",
  access_denied: "Sign-in was cancelled.",
};

export function Landing() {
  const error = new URLSearchParams(window.location.search).get("error");

  return (
    <div className="center">
      <div>
        <div className="brand" style={{ fontSize: 28 }}>
          textbook
        </div>
        <p style={{ color: "var(--muted)", maxWidth: 380, margin: "12px auto 0" }}>
          Give your clients a number to text. We read your Google Calendar, offer them real openings,
          and book the appointment.
        </p>

        {error && <div className="notice" style={{ marginTop: 20 }}>{ERRORS[error] ?? "Sign-in failed."}</div>}

        <a className="google-btn" href="/auth/google">
          Continue with Google
        </a>

        <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 20, maxWidth: 340 }}>
          We ask for calendar access so we can see when you're busy and add appointments.
        </p>
      </div>
    </div>
  );
}
