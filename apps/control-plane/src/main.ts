import { loadConfig } from "../../../packages/config/src/config.js";
import { MemoryJobStore } from "../../../packages/contracts/src/memory-store.js";
import { createControlPlane } from "./server.js";

const config = loadConfig(process.env);
if (config.mode === "cloud") throw new Error("Cloud database adapter is not configured; refusing to start without persistence");
const server = createControlPlane(config, new MemoryJobStore());
server.listen(config.port, "127.0.0.1", () => process.stdout.write(`Orloom local control plane listening on 127.0.0.1:${config.port}\n`));
