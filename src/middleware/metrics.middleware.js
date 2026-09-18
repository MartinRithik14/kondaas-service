import { httpRequestCounter, httpRequestDuration } from "../utils/metrics.js";

export const metricsMiddleware = async (c, next) => {
  // Avoid self-monitoring the metrics scrape endpoint
  if (c.req.path === "/metrics") {
    return await next();
  }

  const start = Date.now();
  await next();
  const duration = (Date.now() - start) / 1000;

  const route = c.req.path;
  const method = c.req.method;
  const status = String(c.res.status);

  httpRequestCounter.labels(method, route, status).inc();
  httpRequestDuration.labels(method, route, status).observe(duration);
};