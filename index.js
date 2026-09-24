import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { startQueueRunner } from './src/controllers/queueEngine.js';
import { ensureAuditLogIndexes } from "./src/utils/auditLogger.js";
import { auditHttpMiddleware } from "./src/middleware/audit.middleware.js";
import { metricsMiddleware } from "./src/middleware/metrics.middleware.js";
import { requireAuth } from "./src/middleware/authMiddleware.js";
import admin from 'firebase-admin';
import fs from 'fs';

// 🔑 DYNAMIC SERVICE ACCOUNT INITIALIZATION
let firebaseCredential;
let detectedProjectId;

try {
  let rawKey = null;

  if (fs.existsSync('./firebase-service-account.json')) {
    rawKey = fs.readFileSync('./firebase-service-account.json', 'utf8');
    console.log("🔑 Using Root Service Account Key File (firebase-service-account.json).");
  } else if (fs.existsSync('/app/firebase-key.json')) {
    rawKey = fs.readFileSync('/app/firebase-key.json', 'utf8');
    console.log("🔑 Using Docker Service Account Key File (/app/firebase-key.json).");
  }

  if (rawKey) {
    const parsedKey = JSON.parse(rawKey);
    firebaseCredential = admin.credential.cert(parsedKey);
    // 🎯 Dynamically extract the project ID directly from the JSON file:
    detectedProjectId = parsedKey.project_id;
  } else {
    firebaseCredential = admin.credential.applicationDefault();
    console.log("☁️ Falling back to Workload Identity Federation.");
  }
} catch (err) {
  console.error("⚠️ Error loading Firebase credentials:", err.message);
  firebaseCredential = admin.credential.applicationDefault();
}

// 🎯 Initialize Firebase Admin with dynamic credentials and project ID
if (!admin.apps.length) {
  admin.initializeApp({
    credential: firebaseCredential,
    ...(detectedProjectId ? { projectId: detectedProjectId } : {})
  });
  console.log(`✅ Firebase Admin initialized for project: ${detectedProjectId || 'Default'}`);
}


import locationRoutes from './src/routes/locationRoutes.js';
import logisticRoutes from './src/routes/logisticRoutes.js';
import userRoutes from './src/routes/userRoutes.js';
import orderRoutes from './src/routes/orderRoutes.js';
import templateRoutes from './src/routes/templateRoutes.js';
import notificationRoutes from './src/routes/notificationRoutes.js';
import solarmanRoutes from './src/routes/solarmanRoutes.js';
import deyeRoutes from './src/routes/deyeRoutes.js';
import solisRoutes from './src/routes/solisRoutes.js';
import savingsRoutes from './src/routes/savingsRoutes.js';
import ticketRoutes from './src/routes/ticketRoutes.js';
import referralRoutes from './src/routes/referralRoutes.js';
import installerRoutes from './src/routes/installerRoutes.js';
import adminRoutes from './src/routes/adminRoutes.js';
import crashRoutes from './src/routes/crashRoutes.js';
import metricsRoute from "./src/routes/metrics.route.js";

const app = new Hono();

app.use('*', cors());
ensureAuditLogIndexes();

// 1. Observability Middlewares
app.use("*", auditHttpMiddleware);
app.use("*", metricsMiddleware);

// 2. 🛡️ Global Auth Gatekeeper Middleware
app.use("*", async (c, next) => {
  const path = c.req.path;
  const method = c.req.method;

  // Exact public endpoints permitted without internal session headers:
  const isMetrics = (path === '/metrics' || path === '/metrics/') && method === 'GET';
  const isCrashLogger = (path === '/crash/add' || path.startsWith('/crash')) && method === 'POST';
  const isUserOnboarding = path === '/solarman/user' && method === 'POST';

  if (isMetrics || isCrashLogger || isUserOnboarding) {
    return next();
  }

  // Enforce MongoDB session verification on everything else
  return requireAuth(c, next);
});

// 3. Application Routes
app.route('/location', locationRoutes);
app.route('/user', userRoutes);
app.route('/order', orderRoutes);
app.route('/template', templateRoutes);
app.route('/notification', notificationRoutes);
app.route('/solarman', solarmanRoutes);
app.route('/deye', deyeRoutes);
app.route('/solis', solisRoutes);
app.route('/savings', savingsRoutes);
app.route('/ticket', ticketRoutes);
app.route('/referral', referralRoutes);
app.route('/logistic', logisticRoutes);
app.route('/installer', installerRoutes);
app.route('/admin', adminRoutes);
app.route('/crash', crashRoutes);
app.route("/metrics", metricsRoute);

const port = 8080;

serve({
  fetch: app.fetch,
  port,
  hostname: '0.0.0.0'
}, (info) => {
  console.log(`🚀 Kondaaas Backend Live: http://localhost:${info.port}`);
});

// 🕒 START THE BACKGROUND QUEUE RUNNER HERE 
startQueueRunner();