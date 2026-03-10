/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */
import { Hono } from "hono";
import { handle } from "hono/vercel";
import { cors } from "hono/cors";
import { jwt, sign } from "hono/jwt";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const app = new Hono().basePath("/api");

// -------------------------------------------------------------------------
// CORS — allow only configured origin
// -------------------------------------------------------------------------
app.use(
  "/*",
  cors({
    origin: process.env.ALLOWED_ORIGIN ?? "http://localhost:3000",
    allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// -------------------------------------------------------------------------
// JWT auth — protect all routes except /health
// -------------------------------------------------------------------------
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  throw new Error("JWT_SECRET environment variable is not set");
}

app.use(
  "/devices/*",
  jwt({ secret: jwtSecret, alg: "HS256" })
);
app.use(
  "/alerts/*",
  jwt({ secret: jwtSecret, alg: "HS256" })
);

// -------------------------------------------------------------------------
// GET /api/health — public
// -------------------------------------------------------------------------
app.get("/health", (c) => c.json({ status: "ok", service: "fovet-vigie" }));

// -------------------------------------------------------------------------
// POST /api/auth/token — exchange dashboard password for JWT
// -------------------------------------------------------------------------
app.post("/auth/token", async (c) => {
  const body = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
  const dashboardPassword = process.env.DASHBOARD_PASSWORD;

  if (!dashboardPassword || !body.password || body.password !== dashboardPassword) {
    return c.json({ error: "Invalid password" }, 401);
  }

  const token = await sign(
    { role: "dashboard", exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 }, // 7 days
    jwtSecret,
    "HS256"
  );
  return c.json({ token });
});

// -------------------------------------------------------------------------
// GET /api/devices — list all active devices
// -------------------------------------------------------------------------
app.get("/devices", async (c) => {
  const devices = await prisma.device.findMany({
    where: { active: true },
    orderBy: { createdAt: "desc" },
  });
  return c.json(devices);
});

// -------------------------------------------------------------------------
// POST /api/devices — register a new device
// -------------------------------------------------------------------------
app.post("/devices", async (c) => {
  const body = await c.req.json<{
    name: string;
    mqttClientId: string;
    description?: string;
    location?: string;
  }>();

  if (!body.name || !body.mqttClientId) {
    return c.json({ error: "name and mqttClientId are required" }, 400);
  }
  if (
    typeof body.name !== "string" || body.name.length > 100 ||
    typeof body.mqttClientId !== "string" || body.mqttClientId.length > 100 ||
    (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 500)) ||
    (body.location !== undefined && (typeof body.location !== "string" || body.location.length > 200))
  ) {
    return c.json({ error: "Invalid input: check field types and lengths" }, 400);
  }

  const device = await prisma.device.create({
    data: {
      name: body.name,
      mqttClientId: body.mqttClientId,
      description: body.description,
      location: body.location,
    },
  });
  return c.json(device, 201);
});

// -------------------------------------------------------------------------
// GET /api/devices/:id/readings — last N readings for a device
// -------------------------------------------------------------------------
app.get("/devices/:id/readings", async (c) => {
  const { id } = c.req.param();
  const rawLimit = parseInt(c.req.query("limit") ?? "100", 10);
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100, 1000);

  const device = await prisma.device.findUnique({ where: { id }, select: { id: true } });
  if (!device) return c.json({ error: "Device not found" }, 404);

  const readings = await prisma.reading.findMany({
    where: { deviceId: id },
    orderBy: { timestamp: "desc" },
    take: limit,
  });
  return c.json(readings.reverse()); // chronological order for charts
});

// -------------------------------------------------------------------------
// GET /api/devices/:id/alerts — unacknowledged alerts for a device
// -------------------------------------------------------------------------
app.get("/devices/:id/alerts", async (c) => {
  const { id } = c.req.param();

  const device = await prisma.device.findUnique({ where: { id }, select: { id: true } });
  if (!device) return c.json({ error: "Device not found" }, 404);

  const alerts = await prisma.alert.findMany({
    where: { deviceId: id, acknowledged: false },
    orderBy: { timestamp: "desc" },
    take: 50,
  });
  return c.json(alerts);
});

// -------------------------------------------------------------------------
// PATCH /api/alerts/:id/ack — acknowledge an alert
// -------------------------------------------------------------------------
app.patch("/alerts/:id/ack", async (c) => {
  const { id } = c.req.param();
  const existing = await prisma.alert.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return c.json({ error: "Alert not found" }, 404);

  const alert = await prisma.alert.update({
    where: { id },
    data: { acknowledged: true, acknowledgedAt: new Date() },
  });
  return c.json(alert);
});

export const GET = handle(app);
export const POST = handle(app);
export const PATCH = handle(app);
