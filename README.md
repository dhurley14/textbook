# textbook

Multi-tenant SMS appointment booking. A barber signs in with Google, gets their own phone number,
and hands it to clients. Clients text that number in plain English; an OpenAI model reads the
message, checks that barber's Google Calendar, offers real openings, and books the appointment.

```
barber ──▶ Sign in with Google ──▶ tenant created ──▶ Activate number (Twilio)
                                        │
client SMS ──▶ Twilio ──▶ POST /sms ────┘  routed to the tenant by the `To` number
                              │
                              ├── check_availability ──▶ that barber's free/busy
                              ├── book_appointment  ──▶ that barber's events.insert
                              └── cancel_appointment
              reply SMS ◀── sent from the barber's own number
```

## Multi-tenancy in one paragraph

The tenant key is the **`To` number** on the inbound webhook. Every barber owns exactly one Twilio
number (`phone_numbers.e164`, unique), so a text addressed to it resolves to one barber, and every
query downstream is scoped by `barber_id`. Shop hours, timezone, appointment length, and calendar
all live on the barber's row rather than in environment variables — env now only holds
platform-level config.

## What's where

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Express wiring; serves the built React app |
| `src/routes/sms.ts` | Twilio webhook: signature check, tenant routing, opt-out, retries |
| `src/routes/auth.ts` | Google OAuth sign-in/sign-up |
| `src/routes/api.ts` | Dashboard JSON API |
| `src/agent.ts` | Per-barber system prompt, tool definitions, tool-calling loop |
| `src/calendar/client.ts` | Per-tenant Google client, token refresh, `invalid_grant` handling |
| `src/calendar/booking.ts` | Free/busy reads and event creation for one barber |
| `src/availability.ts` | Pure slot math: business hours, candidate slots, busy subtraction |
| `src/provisioning.ts` | Buying and releasing a barber's Twilio number |
| `src/auth/` | Refresh-token encryption, sessions, Google OAuth client |
| `src/db/` | SQLite schema and per-table queries |
| `client/` | React dashboard (Vite) |

## Setup

Requires Node 20+ (`nvm use` reads `.nvmrc`).

```bash
npm install
cp .env.example .env
openssl rand -hex 32        # paste into ENCRYPTION_KEY
```

### Google OAuth (one client for the whole platform)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the
   **Google Calendar API**.
2. Configure the **OAuth consent screen** as **External**, and **publish it to production**. An app
   left in Testing issues refresh tokens that expire after 7 days, which silently breaks every
   barber's booking a week after they sign up.
3. Create an **OAuth client ID** of type *Web application*. Add an authorized redirect URI of
   exactly `{APP_URL}/auth/google/callback` — the local ngrok URL in dev, the Render URL in prod.
4. Put the client ID and secret in `.env`.

Calendar is a sensitive scope, so an unverified app stops accepting new grants at 100 users. Start
verification before you get there; Google quotes 3–5 business days.

### Twilio (one account; numbers are bought per barber)

1. Sign up and upgrade out of trial.
2. Put the **Account SID** and **Auth Token** in `.env`. You don't buy a number by hand — the app
   buys one per barber when they click **Activate**, and points it at `{APP_URL}/sms` itself.
3. Register A2P 10DLC before real traffic. As a platform reselling numbers you're an ISV: either
   register each barber as a secondary customer profile with its own brand and campaign, or run all
   tenants under one shared campaign. This is the long pole in onboarding a new barber.

### OpenAI

Add credit to the account and put an API key in `OPENAI_API_KEY`. `gpt-4o-mini` is the default.

## Running locally

```bash
npm run dev
```

`scripts/dev.sh` handles first-run setup: it finds a Node 20+ install (falling back to nvm if the
`node` on your PATH is older), installs dependencies, creates **`.env.dev`** from `.env.example`,
generates an `ENCRYPTION_KEY`, warns about any values still on their placeholders, and starts
Express on `:3000` and Vite on `:5173`.

Local settings live in `.env.dev` rather than `.env` so they can't be mistaken for anything used by
a real deployment. The app reads whichever file `ENV_FILE` names, defaulting to `.env`; the dev
script sets it to `.env.dev`.

Then fill in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and `OPENAI_API_KEY` in `.env.dev`, add
`http://localhost:5173/auth/google/callback` to your Google OAuth client's redirect URIs, and open
http://localhost:5173.

`APP_URL` defaults to the **Vite** port, not the Express port, because Google redirects the browser
back to it and Vite proxies `/auth` and `/api` through to the server. Pointing it at `:3000` would
land you on a port that serves no UI in dev.

## Testing the SMS flow without Twilio

`scripts/mock-sms.sh` posts a realistic Twilio webhook payload to `POST /sms` and then prints the
agent's reply:

```bash
npm run mock:sms -- "any openings thursday afternoon?"
npm run mock:sms -- -i                          # interactive back-and-forth
npm run mock:sms -- -f +15551234567 "hi"        # pretend to be a different client
```

It fills in the details that make the request real rather than a stub:

- **Finds the tenant.** It looks up an activated number in SQLite and sends that as `To`, which is
  what the route uses to resolve the barber. A `To` that matches no barber is silently ignored by
  design, which is confusing to debug by hand.
- **Signs the request.** If `VALIDATE_TWILIO_SIGNATURE=true`, it computes a real
  `X-Twilio-Signature` (HMAC-SHA1 over the URL plus alphabetically sorted params), so the signature
  path is exercised rather than bypassed.
- **Waits for the reply.** The webhook acks before the model runs, so the reply can't come back in
  the HTTP response. The script polls the stored transcript and prints the assistant's message.

The dev script sets `SMS_TRANSPORT=console`, which logs outbound texts instead of sending them, so
none of this costs Twilio credit or needs working Twilio credentials. Set it to `twilio` in
`.env.dev` when you want real delivery.

First run, in order:

```bash
npm run dev              # sign in at http://localhost:5173 with Google
npm run seed:number      # give that barber a fake number to receive texts on
npm run mock:sms -- "any openings thursday?"
```

`seed:number` exists because `/sms` routes by the number a text was addressed to, and the only other
way to get one is **Activate my number**, which buys a real number from Twilio at ~$1.15/mo. The
seeded number is fake: fine for `mock-sms.sh`, useless for texts from an actual phone, and releasing
it from the dashboard will fail because Twilio has never heard of it. Pass `--email` when you have
more than one barber, and `--number` to choose the digits.

Signing in with Google is still worth doing before testing — it's what connects the calendar the
agent reads availability from. You also need a real `OPENAI_API_KEY` in `.env.dev`; with the
placeholder the agent just returns its "having trouble on my end" fallback.

Inbound SMS from a real phone needs a public URL: run `ngrok http 3000`, set `APP_URL` to the ngrok
https URL, add that callback to Google, and browse the ngrok URL instead of localhost.

To exercise the agent with no Twilio at all (real model and calendar calls, so bookings are real):

```bash
npm run simulate
```

## Checks

```bash
npm run typecheck    # server and client
npm test             # slot math and the per-conversation lock
npm run build        # what Render runs on deploy
```

GitHub Actions runs all three on push to `main` and on pull requests.

## Deploying to Render

`render.yaml` provisions the service, a 1GB disk, and all non-secret config. Choose **New →
Blueprint**, point it at this repo, and fill in `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`OPENAI_API_KEY`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`. `ENCRYPTION_KEY` is generated by
Render on first deploy.

After the first deploy, copy the service URL and add `https://<service>.onrender.com/auth/google/callback`
to the Google OAuth client's authorized redirect URIs. Nothing else needs pointing by hand — Twilio
webhooks are set on each number at purchase time.

Leave `APP_URL` unset; the app falls back to `RENDER_EXTERNAL_URL`.

Cost is $7/month for the instance, $0.25/month for the disk, and about $1.15/month per barber number.

### Operational notes

- **Never enable autoscaling.** The lock in `src/queue.ts` is in-process and SQLite is one file on
  one disk, so `numInstances` stays at 1. Outgrowing that means moving to Postgres and replacing the
  lock with an advisory lock.
- **`ENCRYPTION_KEY` is permanent.** It encrypts every barber's Google refresh token. Rotating it
  makes them all undecryptable and forces every barber to reconnect Google.
- **Expired Google grants are a visible state,** not a silent failure. An `invalid_grant` sets
  `needs_reauth`, the dashboard shows a reconnect banner, the client gets a human answer instead of
  a broken one, and the barber gets a text if they set a notify number.
- **Deploys have brief downtime** because attaching a disk disables zero-downtime deploys. That's
  the right tradeoff when one SQLite file is in play; Twilio retries texts that arrive during it.

## Next: two-way rescheduling

The schema is ready for it — `appointments.google_event_id` joins a calendar event back to the
customer who booked it, and the `calendar_sync` table holds the per-barber sync token and watch
channel. The work is a `/google/calendar-webhook` endpoint receiving push notifications, an
incremental sync that diffs changed events, and an outbound conversation opener so the agent can
start a thread ("Sam had to move your Thursday 2pm — here are three other times") rather than only
replying to inbound texts. A channel-renewal job is needed too, since watch channels expire.
