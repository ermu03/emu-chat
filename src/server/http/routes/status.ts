import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { StatusService } from "../../services/status-service.js";

export interface StatusRoutesOptions {
  statusService: StatusService;
}

export function isRequestLanHttp(hostname: string, protocol: string): boolean {
  if (protocol === "https") {
    return false;
  }
  const host = hostname.split(":")[0]?.toLowerCase() ?? "";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return false;
  }
  return true;
}

export const statusRoutes: FastifyPluginAsync<StatusRoutesOptions> = async (
  fastify: FastifyInstance,
  options: StatusRoutesOptions,
) => {
  const { statusService } = options;

  fastify.get("/status", async (req, reply) => {
    const proto =
      (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
    const isLan = isRequestLanHttp(req.hostname, proto);
    const status = await statusService.getStatus(isLan);
    return reply.status(200).send(status);
  });

  fastify.post("/status/recheck", async (req, reply) => {
    const proto =
      (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
    const isLan = isRequestLanHttp(req.hostname, proto);
    const status = await statusService.recheck(isLan);
    return reply.status(200).send(status);
  });
};
