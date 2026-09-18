import { Hono } from "hono";
import { register } from "../utils/metrics.js";

const metricsRoute = new Hono();

metricsRoute.get("/", async (c) => {
  const metrics = await register.metrics();
  return c.text(metrics, 200, {
    "Content-Type": register.contentType
  });
});

export default metricsRoute;