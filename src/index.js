/**
 * Paligo Review Chain Service v4
 *
 * Receives ASSIGNMENT_USERSTATUS_CHANGED webhooks from Paligo
 * and handles approvals (advance chain) and rejections (revert chain).
 *
 * v4: Assignment cleanup on completion, taxonomy removal on new cycle,
 *     audit logging before deletion.
 * v4.1: Persistent audit logging to GitHub (audit-log.json).
 */

require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const PaligoClient = require("./paligo-client");
const ChainHandler = require("./chain-handler");

// -- Validate environment --
const required = ["PALIGO_INSTANCE", "PALIGO_EMAIL", "PALIGO_API_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// -- Initialize --
const paligo = new PaligoClient({
  instance: process.env.PALIGO_INSTANCE,
  email: process.env.PALIGO_EMAIL,
  apiKey: process.env.PALIGO_API_KEY,
});

const chainHandler = new ChainHandler(paligo);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// -- Webhook signature validation (optional) --
function validateWebhook(req, res, next) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    return next();
  }

  const signature = req.headers["x-webhook-signature"] || req.headers["x-paligo-signature"];
  if (!signature) {
    console.warn("[webhook] No signature header found");
    return res.status(401).json({ error: "Missing webhook signature" });
  }

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(JSON.stringify(req.body))
    .digest("hex");

  try {
    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
    if (!isValid) throw new Error("mismatch");
  } catch {
    console.warn("[webhook] Invalid signature");
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  next();
}

// -- Webhook endpoint --
app.post("/webhooks/review-approved", validateWebhook, async (req, res) => {
  const ts = new Date().toISOString();
  console.log(`\n[webhook] ================================================`);
  console.log(`[webhook] Incoming at ${ts}`);
  console.log(`[webhook] Event: ${req.body.event}`);
  console.log(`[webhook] Payload:`, JSON.stringify(req.body, null, 2));

  try {
    const result = await chainHandler.handleEvent(req.body);

    if (result) {
      console.log(`[webhook] Result:`, JSON.stringify(result));
      res.status(200).json({ status: "processed", result });
    } else {
      console.log(`[webhook] Skipped (wrong event type, duplicate, or no action needed)`);
      res.status(200).json({ status: "skipped" });
    }
  } catch (error) {
    console.error("[webhook] Error:", error.message);
    // Return 200 to prevent Paligo from retrying
    res.status(200).json({ status: "error", message: error.message });
  }
});

// -- Health check --
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "paligo-review-chain",
    instance: process.env.PALIGO_INSTANCE,
    version: "4.2.0",
  });
});

// -- Start --
app.listen(PORT, () => {
  console.log(`\n[server] ================================================`);
  console.log(`[server] Paligo Review Chain v4 on port ${PORT}`);
  console.log(`[server] Instance: ${process.env.PALIGO_INSTANCE}`);
  console.log(`[server] Endpoints:`);
  console.log(`[server]   POST /webhooks/review-approved  (webhook)`);
  console.log(`[server]   GET  /health`);
  console.log(`[server] ================================================\n`);
});
