// Cabin Connector 2.0 (Home-Assistant-Add-on). Ablauf:
// 1. Beim ersten Start Geräte-ID und Geheimnis erzeugen (bleiben in /data, verlassen das Gerät nur zum Anmelden).
// 2. Jede Minute beim Cabinmanager melden: wartend → 8-stelligen Code in der Oberfläche zeigen; verbunden → Verbindung aufbauen.
// 3. Verbindung (wss, ausgehend): Anfragen des Servers ausführen – nur erlaubte (regeln.ts) –, beobachtete Geräte bei
//    Änderung melden. Home Assistant wird nur lokal über den Supervisor angesprochen.
// 4. Tablet-Zugang im WLAN (lokal.ts): wss mit eigenem Zertifikat, Tablets melden sich mit ihrem Geräte-Token an.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { attributeFiltern, dienstErlaubt } from "./regeln.ts";
import { LOKAL_PORT, lokalStarten, type TabletZugang } from "./lokal.ts";
import { seite } from "./seite.ts";

export interface Optionen {
  /** Adresse des Cabinmanagers, z. B. https://cabinmanager.de */
  server: string;
  /** Dauerhafter Ordner des Add-ons (/data) */
  ordner: string;
  /** REST-API von Home Assistant (über den Supervisor: http://supervisor/core/api) */
  haApi: string;
  /** WebSocket-API von Home Assistant (ws://supervisor/core/websocket) */
  haWs: string;
  /** Supervisor-API für Netzwerk und Port (http://supervisor) – ohne Angabe keine LAN-Adresse */
  supervisor: string | null;
  token: string;
  version: string;
  /** Port der Oberfläche (Ingress); null = keine */
  port: number | null;
  /** Port des Tablet-Zugangs im Container (8765); null = aus */
  lokalPort?: number | null;
  /** Nur Tests und Testsystem: http statt https erlauben */
  httpErlaubt?: boolean;
  meldenMs?: number;
  log?: (text: string) => void;
}

export type Status = "start" | "wartet" | "verbunden" | "abgelehnt" | "fehler";
export interface Zustand { status: Status; code: string | null; gueltigBis: string | null; name: string | null; fehler: string | null; verbindung: boolean; lan: string | null; tablet: string | null }

interface Identitaet { geraeteId: string; geheimnis: string }
interface HaZustand { entity_id: string; state: string; attributes: Record<string, unknown>; last_changed?: string }

const FRIST_MS = 7000;
const MELDUNG_DROSSEL_MS = 2000;

export function starte(o: Optionen) {
  const log = o.log ?? ((t: string) => console.info(`[connector] ${t}`));
  const basis = new URL(o.server);
  if (basis.protocol !== "https:" && !(o.httpErlaubt && basis.protocol === "http:")) throw new Error("Die Cabinmanager-Adresse muss mit https:// beginnen.");
  const zustand: Zustand = { status: "start", code: null, gueltigBis: null, name: null, fehler: null, verbindung: false, lan: null, tablet: null };
  let ich = identitaet(o.ordner);
  let aus = false;
  let kanal: WebSocket | null = null;
  let haWs: WebSocket | null = null;
  let beobachtet = new Set<string>();
  const meldungen = new Map<string, { letzte: number; uhr: NodeJS.Timeout | null; neu: HaZustand | null }>();
  const uhren = new Set<NodeJS.Timeout>();
  const spaeter = (fn: () => void, ms: number) => { const u = setTimeout(() => { uhren.delete(u); fn(); }, ms); uhren.add(u); return u; };

  // --- Home Assistant (lokal) ------------------------------------------------------------------------
  async function ha<T>(pfad: string, init: RequestInit = {}): Promise<T> {
    const r = await fetch(`${o.haApi}${pfad}`, { ...init, headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" }, signal: AbortSignal.timeout(FRIST_MS) });
    if (!r.ok) throw new Error(`Home Assistant ${r.status}`);
    const text = await r.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Adressen im WLAN: Home Assistant und – falls an – der Tablet-Zugang (Port laut Netzwerk-Einstellung des Add-ons). */
  async function netz(): Promise<{ lan: string | null; tablet: string | null }> {
    if (!o.supervisor) return { lan: null, tablet: null };
    try {
      const holen = async (pfad: string) => (await (await fetch(`${o.supervisor}${pfad}`, { headers: { authorization: `Bearer ${o.token}` }, signal: AbortSignal.timeout(FRIST_MS) })).json()) as { data: Record<string, unknown> };
      const netz = (await holen("/network/info")).data as { interfaces?: { primary?: boolean; ipv4?: { address?: string[] } }[] };
      const kern = (await holen("/core/info")).data as { port?: number; ssl?: boolean };
      const iface = netz.interfaces?.find((i) => i.primary && i.ipv4?.address?.length) ?? netz.interfaces?.find((i) => i.ipv4?.address?.length);
      const ip = iface?.ipv4?.address?.[0]?.split("/")[0];
      if (!ip) return { lan: null, tablet: null };
      const port = lokal ? ((await holen("/addons/self/info")).data as { network?: Record<string, number | null> }).network?.[`${LOKAL_PORT}/tcp`] : null;
      return { lan: `${kern.ssl ? "https" : "http"}://${ip}:${kern.port ?? 8123}`, tablet: port ? `wss://${ip}:${port}` : null };
    } catch {
      return { lan: null, tablet: null };
    }
  }
  const lokalInfo = () => (lokal && zustand.tablet ? { adresse: zustand.tablet, fingerabdruck: lokal.fingerabdruck } : null);

  /** Anfragen des Servers – nur diese vier, nur erlaubte Dienste. */
  async function ausfuehren(aktion: string, daten: Record<string, unknown>): Promise<unknown> {
    if (aktion === "zustaende") {
      const ids = new Set(Array.isArray(daten.entityIds) ? daten.entityIds.map(String) : []);
      return (await ha<HaZustand[]>("/states")).filter((z) => ids.has(z.entity_id)).map((z) => ({ entity_id: z.entity_id, state: z.state, attributes: attributeFiltern(z.attributes), last_changed: z.last_changed }));
    }
    if (aktion === "alle") {
      return (await ha<HaZustand[]>("/states")).map((z) => ({ entity_id: z.entity_id, state: String(z.state).slice(0, 255), attributes: attributeFiltern(z.attributes, ["friendly_name", "device_class", "unit_of_measurement"]) }));
    }
    if (aktion === "dienst") {
      const domain = String(daten.domain);
      const dienst = String(daten.dienst);
      const werte = (daten.daten ?? {}) as Record<string, unknown>;
      if (!dienstErlaubt(domain, dienst, werte)) throw new Error("nicht_erlaubt");
      await ha(`/services/${domain}/${dienst}`, { method: "POST", body: JSON.stringify(werte) });
      return null;
    }
    if (aktion === "verlauf") {
      const id = String(daten.entityId);
      if (!/^[a-z_]+\.[a-z0-9_]+$/.test(id)) throw new Error("nicht_erlaubt");
      const klima = id.startsWith("climate.");
      const von = new Date(String(daten.von)).toISOString();
      const bis = new Date(String(daten.bis)).toISOString();
      const roh = await ha<HaZustand[][]>(`/history/period/${encodeURIComponent(von)}?filter_entity_id=${id}&end_time=${encodeURIComponent(bis)}${klima ? "" : "&minimal_response&no_attributes"}`);
      return (roh[0] ?? []).flatMap((p) => {
        const wert = Number(klima ? p.attributes?.current_temperature : p.state);
        return Number.isFinite(wert) && p.last_changed ? [{ zeit: p.last_changed, wert }] : [];
      });
    }
    throw new Error("unbekannt");
  }

  // --- Zustandsänderungen beobachten (lokale WebSocket-API, mit Drossel je Gerät) ----------------------------------
  function zustandMelden(z: HaZustand) {
    if (!kanal || kanal.readyState !== WebSocket.OPEN) return;
    kanal.send(JSON.stringify({ art: "zustand", zustand: { entity_id: z.entity_id, state: String(z.state).slice(0, 255), attributes: attributeFiltern(z.attributes), last_changed: z.last_changed } }));
  }
  function aenderung(z: HaZustand) {
    lokal?.aenderung(z);
    if (!beobachtet.has(z.entity_id)) return;
    const m = meldungen.get(z.entity_id) ?? { letzte: 0, uhr: null, neu: null };
    meldungen.set(z.entity_id, m);
    const rest = m.letzte + MELDUNG_DROSSEL_MS - Date.now();
    if (rest <= 0) { m.letzte = Date.now(); zustandMelden(z); return; }
    m.neu = z;
    m.uhr ??= spaeter(() => { m.uhr = null; m.letzte = Date.now(); if (m.neu) zustandMelden(m.neu); m.neu = null; }, rest);
  }
  function haBeobachten(versuch = 0) {
    if (aus || haWs) return;
    const ws = new WebSocket(o.haWs);
    haWs = ws;
    ws.addEventListener("message", (e) => {
      const n = JSON.parse(String(e.data)) as { type: string; event?: { data?: { new_state?: HaZustand | null } } };
      if (n.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: o.token }));
      else if (n.type === "auth_ok") { versuch = 0; ws.send(JSON.stringify({ id: 1, type: "subscribe_events", event_type: "state_changed" })); }
      else if (n.type === "event" && n.event?.data?.new_state) aenderung(n.event.data.new_state);
    });
    ws.addEventListener("close", () => {
      if (haWs === ws) haWs = null;
      if (!aus) spaeter(() => haBeobachten(versuch + 1), Math.min(60_000, 2000 * 2 ** versuch));
    });
    ws.addEventListener("error", () => undefined);
  }

  // --- Verbindung zum Cabinmanager ---------------------------------------------------------------------
  function verbinden(versuch = 0) {
    if (aus || kanal) return;
    const adresse = new URL("/api/connector/verbindung", basis);
    adresse.protocol = basis.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(adresse);
    kanal = ws;
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ art: "hallo", geraeteId: ich.geraeteId, geheimnis: ich.geheimnis, version: o.version, lan: zustand.lan, lokal: lokalInfo() }));
    });
    ws.addEventListener("message", async (e) => {
      let n: { art: string; id?: number; aktion?: string; daten?: Record<string, unknown>; entityIds?: string[]; name?: string; tablets?: TabletZugang[] };
      try { n = JSON.parse(String(e.data)); } catch { return; }
      if (n.art === "willkommen") {
        versuch = 0;
        Object.assign(zustand, { status: "verbunden", verbindung: true, name: n.name ?? null, code: null, gueltigBis: null, fehler: null });
        log(`verbunden als „${n.name}“`);
      } else if (n.art === "beobachten") {
        beobachtet = new Set((n.entityIds ?? []).map(String));
        haBeobachten();
      } else if (n.art === "tablets" && Array.isArray(n.tablets)) {
        lokal?.tabletsSetzen(n.tablets);
      } else if (n.art === "anfrage" && typeof n.id === "number") {
        try {
          ws.send(JSON.stringify({ art: "antwort", id: n.id, ok: true, daten: await ausfuehren(String(n.aktion), n.daten ?? {}) }));
        } catch (f) {
          ws.send(JSON.stringify({ art: "antwort", id: n.id, ok: false, fehler: (f as Error).message === "nicht_erlaubt" ? "nicht_erlaubt" : "ha_fehler" }));
        }
      }
    });
    ws.addEventListener("close", (e) => {
      if (kanal === ws) kanal = null;
      zustand.verbindung = false;
      if (aus) return;
      // Getrennt oder abgelehnt: wieder melden (dann wartend mit neuem Code); sonst neu verbinden mit wachsender Pause
      if (e.code === 4403 || e.code === 4401) { zustand.status = "start"; void anmelden(); return; }
      spaeter(() => verbinden(versuch + 1), Math.min(60_000, 2000 * 2 ** versuch));
    });
    ws.addEventListener("error", () => undefined);
  }

  /** Melden per HTTP (wartend: Code holen; verbunden: Verbindung aufbauen). */
  async function anmelden() {
    if (aus || kanal) return;
    try {
      if (!zustand.lan) Object.assign(zustand, await netz());
      const r = await fetch(new URL("/api/connector/melden", basis), {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ geraeteId: ich.geraeteId, geheimnis: ich.geheimnis, version: o.version, lan: zustand.lan }),
      });
      if (r.status === 401) { Object.assign(zustand, { status: "abgelehnt", code: null, fehler: "abgelehnt" }); return; }
      if (!r.ok) throw new Error(`Cabinmanager ${r.status}`);
      const a = (await r.json()) as { status: string; code?: string; gueltigBis?: string; name?: string };
      if (a.status === "wartet") Object.assign(zustand, { status: "wartet", code: a.code ?? null, gueltigBis: a.gueltigBis ?? null, name: null, fehler: null });
      else if (a.status === "verbunden") { zustand.name = a.name ?? null; verbinden(); }
    } catch (f) {
      Object.assign(zustand, { status: zustand.status === "verbunden" ? "verbunden" : "fehler", fehler: (f as Error).message });
    }
  }
  const takt = setInterval(() => void anmelden(), o.meldenMs ?? 60_000);

  // --- Oberfläche (Ingress) -----------------------------------------------------------------------------
  let oberflaeche: Server | null = null;
  if (o.port != null) {
    oberflaeche = createServer((req, res) => {
      // Nur der Ingress-Proxy des Supervisors (und lokal für Tests)
      const von = req.socket.remoteAddress ?? "";
      if (!["172.30.32.2", "::ffff:172.30.32.2", "127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(von)) { res.writeHead(403).end(); return; }
      if (req.method === "POST" && req.url?.endsWith("/neu")) {
        neuKoppeln();
        res.writeHead(303, { location: req.headers["x-ingress-path"] ? `${req.headers["x-ingress-path"]}/` : "/" }).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
      res.end(seite(zustand, String(req.headers["accept-language"] ?? "de"), o.server));
    });
    oberflaeche.listen(o.port);
  }

  /** Neues Geheimnis (Werksreset der Kopplung): danach im Cabinmanager neu verbinden. */
  function neuKoppeln() {
    rmSync(join(o.ordner, "identitaet.json"), { force: true });
    ich = identitaet(o.ordner);
    kanal?.close(1000, "neu");
    kanal = null;
    Object.assign(zustand, { status: "start", code: null, name: null, verbindung: false });
    log("neu gekoppelt – neues Geheimnis");
    void anmelden();
  }

  // Tablet-Zugang im WLAN: läuft auch ohne Internet (Tablets aus dem Speicher, Home Assistant lokal)
  const lokal = o.lokalPort != null ? lokalStarten({ ordner: o.ordner, port: o.lokalPort, version: o.version, ha, log }) : null;
  if (lokal) haBeobachten();

  void anmelden();
  return {
    zustand: () => ({ ...zustand }),
    geraeteId: () => ich.geraeteId,
    melden: anmelden,
    neuKoppeln,
    lokal: () => (lokal ? { port: lokal.port(), fingerabdruck: lokal.fingerabdruck, sitzungen: lokal.sitzungen() } : null),
    async stoppen() {
      aus = true;
      clearInterval(takt);
      for (const u of uhren) clearTimeout(u);
      kanal?.close(1000, "aus");
      haWs?.close();
      await lokal?.stoppen();
      await new Promise<void>((ok) => (oberflaeche ? oberflaeche.close(() => ok()) : ok()));
    },
  };
}

/** Geräte-ID und Geheimnis: einmal erzeugt, dauerhaft im Ordner des Add-ons. */
function identitaet(ordner: string): Identitaet {
  const datei = join(ordner, "identitaet.json");
  if (existsSync(datei)) {
    const x = JSON.parse(readFileSync(datei, "utf8")) as Identitaet;
    if (/^[A-Za-z0-9_-]{8,64}$/.test(x.geraeteId) && x.geheimnis?.length >= 32) return x;
  }
  mkdirSync(ordner, { recursive: true });
  const neu = { geraeteId: randomUUID(), geheimnis: randomBytes(32).toString("base64url") };
  writeFileSync(datei, JSON.stringify(neu), { mode: 0o600 });
  return neu;
}
