import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { startQueueRunner } from './src/controllers/queueEngine.js';
import admin from 'firebase-admin';
import fs from 'fs';

// 🔑 SAFE SERVICE ACCOUNT FALLBACK DETECTOR
let firebaseCredential;

try {
  if (fs.existsSync('/app/firebase-key.json')) {
    const rawKey = fs.readFileSync('/app/firebase-key.json', 'utf8');
    firebaseCredential = admin.credential.cert(JSON.parse(rawKey));
    console.log("🔑 Initializing Firebase with Direct Service Account Key File.");
  } else {
    firebaseCredential = admin.credential.applicationDefault();
    console.log("☁️ Initializing Firebase with default Workload Identity Federation.");
  }
} catch (err) {
  console.error("⚠️ Error parsing firebase-key.json, falling back to applicationDefault:", err.message);
  firebaseCredential = admin.credential.applicationDefault();
}

// 🎯 Explicitly passing projectId to ensure Workload Identity targets the correct resource scope
admin.initializeApp({
  credential: firebaseCredential,
  projectId: 'kondaas-5dfaa'
});

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


const app = new Hono();

app.use('*', cors());

// Routes
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