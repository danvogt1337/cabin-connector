// Einstieg im Add-on: Optionen aus /data/options.json, Zugang zu Home Assistant über den Supervisor.
import { readFileSync } from "node:fs";
import { starte } from "./connector.ts";
import { LOKAL_PORT } from "./lokal.ts";

export const VERSION = "2.0.0";

const optionen = JSON.parse(readFileSync("/data/options.json", "utf8")) as { server?: string };
const token = process.env.SUPERVISOR_TOKEN;
if (!token) throw new Error("SUPERVISOR_TOKEN fehlt – läuft das Add-on mit homeassistant_api?");

const c = starte({
  server: optionen.server || "https://cabinmanager.de",
  ordner: "/data",
  haApi: "http://supervisor/core/api",
  haWs: "ws://supervisor/core/websocket",
  supervisor: "http://supervisor",
  token,
  version: VERSION,
  port: 8099,
  lokalPort: LOKAL_PORT,
});
console.info(`[connector] Cabin Connector ${VERSION} gestartet (Gerät ${c.geraeteId().slice(0, 8)}…)`);

for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void c.stoppen().then(() => process.exit(0)));
