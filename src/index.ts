import path from "node:path";
import fs from "node:fs";
import express from "express";
import { appUrl, env } from "./config";
import { loadSession } from "./auth/session";
import { authRouter } from "./routes/auth";
import { apiRouter } from "./routes/api";
import { smsRouter } from "./routes/sms";
import "./db";

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(loadSession);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use(smsRouter);
app.use(authRouter);
app.use(apiRouter);

// The React app is built to dist/client. In dev it's served by Vite on its own port instead.
const clientDir = path.resolve(__dirname, "client");
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/auth")) return next();
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

app.listen(env.PORT, () => {
  console.log(`textbook listening on :${env.PORT}`);
  console.log(`  app             ${appUrl}`);
  console.log(`  twilio webhook  ${appUrl}/sms`);
  console.log(`  google redirect ${appUrl}/auth/google/callback`);
});
