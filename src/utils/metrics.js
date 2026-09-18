import client from "prom-client";

export const register = new client.Registry();

// Standard Node.js process metrics (memory, event loop, CPU)
client.collectDefaultMetrics({ register });

// Track total requests
export const httpRequestCounter = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests received",
  labelNames: ["method", "route", "status"],
  registers: [register]
});

// Track request latency in seconds
export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register]
});