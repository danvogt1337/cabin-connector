// Lokaler Zugang für das Tablet der Cabin (Phase 6, Schritt 6): wss im WLAN, damit Licht, Heizung und Sensoren am
// Tablet auch ohne Internet laufen – ohne Home-Assistant-Token auf dem Tablet.
// - Eigenes Zertifikat (einmal erzeugt, bleibt in /data). Der Fingerabdruck geht über den Cabinmanager aufs Tablet, das
//   genau dieses Zertifikat erwartet – im Gäste-WLAN nicht mitlesbar, nicht unterschiebbar.
// - Anmeldung mit dem Geräte-Token des Tablets. Der Connector kennt nur die Hashes (vom Server, gespeichert für den
//   Fall ohne Internet) und je Tablet die freigegebenen Geräte.
// - Spricht die Teilmenge der Home-Assistant-WebSocket-API, die das Tablet braucht: auth, get_states, subscribe_events
//   (state_changed), call_service (nur erlaubte Dienste, nur freigegebene Geräte), history/history_during_period, ping.
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { join } from "node:path";
import { ENTITY_MUSTER, TABLET_ATTRIBUTE, attributeFiltern, dienstErlaubt } from "./regeln.ts";
import { wsAnnehmen, type Kanal } from "./websocket.ts";

/** Port im Container; nach außen bestimmt die Netzwerk-Einstellung des Add-ons den Port. */
export const LOKAL_PORT = 8765;
const ANMELDUNG_MS = 10_000;
const MAX_SITZUNGEN = 20;
const FEHLVERSUCHE = 10;
const FEHL_FENSTER_MS = 5 * 60_000;
const NACHRICHTEN_JE_10S = 100;
const VERLAUF_MAX_MS = 7 * 86_400_000;

export interface TabletZugang { geraetId: string; tokenHash: string; entities: string[] }
interface HaZustand { entity_id: string; state: string; attributes: Record<string, unknown>; last_changed?: string; last_updated?: string }
interface Sitzung { kanal: Kanal; zugang: TabletZugang | null; erlaubt: Set<string>; abo: number | null; fenster: number; anzahl: number }

export interface LokalOptionen {
  ordner: string;
  port: number;
  version: string;
  ha: <T>(pfad: string, init?: RequestInit) => Promise<T>;
  log: (text: string) => void;
}

const hash = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
const ergebnis = (id: number, result: unknown = null) => JSON.stringify({ id, type: "result", success: true, result });
const fehler = (id: number, code: string, message: string) => JSON.stringify({ id, type: "result", success: false, error: { code, message } });

/** Schlüssel und Zertifikat (EC P-256, 10 Jahre) – einmal mit openssl erzeugt, danach aus /data. */
export function zertifikat(ordner: string): { schluessel: string; zertifikat: string; fingerabdruck: string } | null {
  const pfad = join(ordner, "lokal");
  const s = join(pfad, "schluessel.pem");
  const z = join(pfad, "zertifikat.pem");
  try {
    if (!existsSync(s) || !existsSync(z)) {
      mkdirSync(pfad, { recursive: true, mode: 0o700 });
      execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "3650",
        "-subj", "/CN=cabin-connector", "-keyout", s, "-out", z], { stdio: "ignore", timeout: 30_000 });
    }
    const zert = readFileSync(z, "utf8");
    return { schluessel: readFileSync(s, "utf8"), zertifikat: zert, fingerabdruck: hash(new X509Certificate(zert).raw) };
  } catch {
    return null;
  }
}

function tabletsLaden(ordner: string): Map<string, TabletZugang> {
  try {
    const liste = JSON.parse(readFileSync(join(ordner, "tablets.json"), "utf8")) as TabletZugang[];
    return new Map(liste.filter(gueltig).map((x) => [x.tokenHash, x]));
  } catch {
    return new Map();
  }
}
function gueltig(x: TabletZugang): boolean {
  return typeof x?.geraetId === "string" && /^[0-9a-f]{64}$/.test(x.tokenHash) && Array.isArray(x.entities) && x.entities.every((e) => typeof e === "string" && ENTITY_MUSTER.test(e));
}

export function lokalStarten(o: LokalOptionen) {
  const zert = zertifikat(o.ordner);
  if (!zert) { o.log("Tablet-Zugang aus: Zertifikat konnte nicht erzeugt werden (openssl fehlt?)"); return null; }
  let tablets = tabletsLaden(o.ordner);
  const sitzungen = new Set<Sitzung>();
  const fehlversuche = new Map<string, number[]>();

  const gesperrt = (ip: string) => (fehlversuche.get(ip) ?? []).filter((t) => t > Date.now() - FEHL_FENSTER_MS).length >= FEHLVERSUCHE;
  const fehlversuch = (ip: string) => fehlversuche.set(ip, [...(fehlversuche.get(ip) ?? []).filter((t) => t > Date.now() - FEHL_FENSTER_MS), Date.now()]);
  const zustand = (z: HaZustand) => ({
    entity_id: z.entity_id, state: String(z.state).slice(0, 255), attributes: attributeFiltern(z.attributes, TABLET_ATTRIBUTE),
    last_changed: z.last_changed ?? null, last_updated: z.last_updated ?? z.last_changed ?? null,
  });

  async function befehl(s: Sitzung, n: Record<string, unknown>) {
    const id = Number(n.id);
    if (!Number.isInteger(id)) return;
    switch (n.type) {
      case "ping":
        s.kanal.senden(JSON.stringify({ id, type: "pong" }));
        return;
      case "get_states":
        s.kanal.senden(ergebnis(id, (await o.ha<HaZustand[]>("/states")).filter((z) => s.erlaubt.has(z.entity_id)).map(zustand)));
        return;
      case "subscribe_events":
        if (n.event_type !== "state_changed") { s.kanal.senden(fehler(id, "not_allowed", "Nur state_changed")); return; }
        s.abo = id;
        s.kanal.senden(ergebnis(id));
        return;
      case "unsubscribe_events":
        s.abo = null;
        s.kanal.senden(ergebnis(id));
        return;
      case "call_service": {
        const domain = String(n.domain ?? "");
        const dienst = String(n.service ?? "");
        const daten = { ...(typeof n.service_data === "object" && n.service_data ? n.service_data as Record<string, unknown> : {}) };
        const ziel = (n.target as { entity_id?: unknown } | undefined)?.entity_id;
        if (daten.entity_id === undefined && typeof ziel === "string") daten.entity_id = ziel;
        if (typeof daten.entity_id !== "string" || !s.erlaubt.has(daten.entity_id) || !dienstErlaubt(domain, dienst, daten)) {
          s.kanal.senden(fehler(id, "not_allowed", "Nicht erlaubt"));
          return;
        }
        await o.ha(`/services/${domain}/${dienst}`, { method: "POST", body: JSON.stringify(daten) });
        s.kanal.senden(ergebnis(id));
        return;
      }
      case "history/history_during_period": {
        const ids = Array.isArray(n.entity_ids) ? n.entity_ids.map(String) : [];
        const von = new Date(String(n.start_time));
        const bis = n.end_time ? new Date(String(n.end_time)) : new Date();
        if (!ids.length || ids.length > 5 || !ids.every((x) => s.erlaubt.has(x)) || Number.isNaN(von.getTime()) || Number.isNaN(bis.getTime())
          || bis <= von || bis.getTime() - von.getTime() > VERLAUF_MAX_MS) {
          s.kanal.senden(fehler(id, "not_allowed", "Nicht erlaubt"));
          return;
        }
        const roh = await o.ha<HaZustand[][]>(`/history/period/${encodeURIComponent(von.toISOString())}?filter_entity_id=${ids.join(",")}&end_time=${encodeURIComponent(bis.toISOString())}&minimal_response&no_attributes`);
        const aus: Record<string, { s: string; lu: number }[]> = {};
        for (const reihe of roh ?? []) {
          const eid = reihe[0]?.entity_id;
          if (!eid || !s.erlaubt.has(eid)) continue;
          aus[eid] = reihe.flatMap((p) => {
            const t = Date.parse(p.last_changed ?? p.last_updated ?? "");
            return Number.isFinite(t) ? [{ s: String(p.state).slice(0, 255), lu: t / 1000 }] : [];
          });
        }
        s.kanal.senden(ergebnis(id, aus));
        return;
      }
      default:
        s.kanal.senden(fehler(id, "unknown_command", "Unbekannter Befehl"));
    }
  }

  const server: Server = createServer({ key: zert.schluessel, cert: zert.zertifikat, minVersion: "TLSv1.2" }, (_req, res) => {
    res.writeHead(426, { "content-type": "text/plain" }).end("WebSocket");
  });
  server.on("upgrade", (req, socket) => {
    const ip = req.socket.remoteAddress ?? "";
    if (new URL(req.url ?? "/", "https://x").pathname !== "/api/websocket" || sitzungen.size >= MAX_SITZUNGEN || gesperrt(ip)) { socket.destroy(); return; }
    let s: Sitzung | null = null;
    const kanal = wsAnnehmen(req, socket, {
      text: (t) => {
        if (!s) return;
        // Bremse je Sitzung
        if (Date.now() - s.fenster > 10_000) { s.fenster = Date.now(); s.anzahl = 0; }
        if (++s.anzahl > NACHRICHTEN_JE_10S) { s.kanal.schliessen(1008, "zu_viele"); return; }
        let n: Record<string, unknown>;
        try { n = JSON.parse(t) as Record<string, unknown>; } catch { s.kanal.schliessen(1007, "ungueltig"); return; }
        if (!n || typeof n !== "object") return;
        if (!s.zugang) {
          const token = n.type === "auth" && typeof n.access_token === "string" && n.access_token.length <= 200 ? n.access_token : null;
          const z = token ? tablets.get(hash(token)) : undefined;
          if (!z) {
            fehlversuch(ip);
            s.kanal.senden(JSON.stringify({ type: "auth_invalid", message: "Ungültiger Zugang" }));
            s.kanal.schliessen(4401, "abgelehnt");
            return;
          }
          s.zugang = z;
          s.erlaubt = new Set(z.entities);
          s.kanal.senden(JSON.stringify({ type: "auth_ok", ha_version: `cabin-connector-${o.version}` }));
          return;
        }
        const sitzung = s;
        void befehl(sitzung, n).catch(() => {
          if (Number.isInteger(Number(n.id))) sitzung.kanal.senden(fehler(Number(n.id), "home_assistant_error", "Home Assistant nicht erreichbar"));
        });
      },
      zu: () => { if (s) sitzungen.delete(s); },
    });
    if (!kanal) return;
    s = { kanal, zugang: null, erlaubt: new Set(), abo: null, fenster: Date.now(), anzahl: 0 };
    sitzungen.add(s);
    kanal.senden(JSON.stringify({ type: "auth_required", ha_version: `cabin-connector-${o.version}` }));
    const sitzung = s;
    setTimeout(() => { if (!sitzung.zugang) sitzung.kanal.schliessen(4408, "anmeldung_fehlt"); }, ANMELDUNG_MS).unref();
  });
  server.on("tlsClientError", () => undefined);
  server.listen(o.port);

  return {
    fingerabdruck: zert.fingerabdruck,
    port: () => (server.address() as { port: number } | null)?.port ?? null,
    /** Neue Liste vom Server: speichern (für den Fall ohne Internet), entzogene Tablets sofort trennen. */
    tabletsSetzen(liste: TabletZugang[]) {
      const neu = liste.filter(gueltig);
      tablets = new Map(neu.map((x) => [x.tokenHash, x]));
      writeFileSync(join(o.ordner, "tablets.json"), JSON.stringify(neu), { mode: 0o600 });
      for (const s of sitzungen) {
        if (!s.zugang) continue;
        const z = tablets.get(s.zugang.tokenHash);
        if (!z) { s.kanal.schliessen(4403, "entzogen"); continue; }
        s.zugang = z;
        s.erlaubt = new Set(z.entities);
      }
    },
    /** Zustandsänderung aus Home Assistant an alle Tablets, die das Gerät sehen dürfen (ohne Drossel, lokal). */
    aenderung(z: HaZustand) {
      for (const s of sitzungen) {
        if (s.abo == null || !s.erlaubt.has(z.entity_id)) continue;
        s.kanal.senden(JSON.stringify({ id: s.abo, type: "event", event: { event_type: "state_changed", data: { entity_id: z.entity_id, old_state: null, new_state: zustand(z) } } }));
      }
    },
    sitzungen: () => sitzungen.size,
    stoppen: () => new Promise<void>((ok) => {
      for (const s of sitzungen) s.kanal.schliessen(1001, "aus");
      server.close(() => ok());
      server.closeAllConnections();
    }),
  };
}
export type Lokal = NonNullable<ReturnType<typeof lokalStarten>>;
