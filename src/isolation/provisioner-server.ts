import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import type { UserIdentity, WorkerTarget } from "./types.js";

export interface UserProvisioningService {
  ensureWorker(identity: UserIdentity): Promise<WorkerTarget>;
}

export function createProvisionerApp(service: UserProvisioningService): Express {
  const app = express();
  app.use(express.json({ limit: "8kb" }));
  app.post("/v1/users/ensure", async (req, res) => {
    try {
      res.json(await service.ensureWorker(req.body as UserIdentity));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Provisioning failed";
      console.error(`[Provisioner] ${message}`);
      res.status(500).json({ error: { message: "Provisioning failed", type: "server_error", code: "provisioning_failed" } });
    }
  });
  app.use((_req, res) => {
    res.status(404).json({
      error: { message: "Not found", type: "invalid_request_error", code: "not_found" },
    });
  });
  return app;
}

export async function startProvisionerServer(
  service: UserProvisioningService,
  listen: { fd: number } | { path: string },
): Promise<Server> {
  const server = createServer(createProvisionerApp(service));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const done = () => {
      server.off("error", reject);
      resolve(server);
    };
    if ("fd" in listen) server.listen({ fd: listen.fd }, done);
    else server.listen(listen.path, done);
  });
}
