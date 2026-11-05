// Oberfläche des Add-ons (Ingress): Status, Code zum Verbinden, „Neu koppeln“. In der Sprache des Browsers (5 Sprachen),
// ohne Skripte und ohne fremde Dateien.
import type { Zustand } from "./connector.ts";

const TEXTE = {
  de: { titel: "Cabin Connector", wartet: "Noch nicht verbunden", code: "Gib diesen Code im Cabinmanager unter Einstellungen → Gateways ein:", gueltig: "Der Code erneuert sich alle 10 Minuten. Diese Seite aktualisiert sich selbst.", verbunden: "Verbunden als", verbindung: "Verbindung aktiv", keineVerbindung: "Verbindung wird aufgebaut …", abgelehnt: "Der Cabinmanager lehnt dieses Gerät ab. Koppel es neu.", fehler: "Der Cabinmanager ist gerade nicht erreichbar:", start: "Startet …", neu: "Neu koppeln", neuText: "Erzeugt ein neues Geheimnis. Danach musst du das Gateway im Cabinmanager neu verbinden.", server: "Cabinmanager", lan: "Adresse im WLAN", tablet: "Tablet-Zugang im WLAN" },
  en: { titel: "Cabin Connector", wartet: "Not connected yet", code: "Enter this code in Cabinmanager under Settings → Gateways:", gueltig: "The code renews every 10 minutes. This page refreshes itself.", verbunden: "Connected as", verbindung: "Connection active", keineVerbindung: "Connecting …", abgelehnt: "Cabinmanager rejects this device. Pair it again.", fehler: "Cabinmanager can’t be reached right now:", start: "Starting …", neu: "Pair again", neuText: "Creates a new secret. You’ll then need to connect the gateway in Cabinmanager again.", server: "Cabinmanager", lan: "Local network address", tablet: "Tablet access on Wi-Fi" },
  fr: { titel: "Cabin Connector", wartet: "Pas encore connecté", code: "Saisissez ce code dans Cabinmanager sous Paramètres → Passerelles :", gueltig: "Le code se renouvelle toutes les 10 minutes. Cette page s’actualise d’elle-même.", verbunden: "Connecté en tant que", verbindung: "Connexion active", keineVerbindung: "Connexion en cours …", abgelehnt: "Cabinmanager refuse cet appareil. Couplez-le à nouveau.", fehler: "Cabinmanager est injoignable pour le moment :", start: "Démarrage …", neu: "Coupler à nouveau", neuText: "Crée un nouveau secret. Vous devrez ensuite reconnecter la passerelle dans Cabinmanager.", server: "Cabinmanager", lan: "Adresse sur le réseau local", tablet: "Accès tablette en Wi-Fi" },
  es: { titel: "Cabin Connector", wartet: "Aún no conectado", code: "Introduce este código en Cabinmanager, en Ajustes → Pasarelas:", gueltig: "El código se renueva cada 10 minutos. Esta página se actualiza sola.", verbunden: "Conectado como", verbindung: "Conexión activa", keineVerbindung: "Conectando …", abgelehnt: "Cabinmanager rechaza este dispositivo. Vuelve a vincularlo.", fehler: "Cabinmanager no está accesible ahora:", start: "Iniciando …", neu: "Volver a vincular", neuText: "Crea un secreto nuevo. Después tendrás que volver a conectar la pasarela en Cabinmanager.", server: "Cabinmanager", lan: "Dirección en la red local", tablet: "Acceso de la tableta por wifi" },
  pt: { titel: "Cabin Connector", wartet: "Ainda não ligado", code: "Introduza este código no Cabinmanager em Definições → Gateways:", gueltig: "O código renova-se a cada 10 minutos. Esta página atualiza-se sozinha.", verbunden: "Ligado como", verbindung: "Ligação ativa", keineVerbindung: "A ligar …", abgelehnt: "O Cabinmanager rejeita este dispositivo. Volte a emparelhá-lo.", fehler: "O Cabinmanager não está acessível agora:", start: "A iniciar …", neu: "Emparelhar de novo", neuText: "Cria um novo segredo. Depois tem de voltar a ligar o gateway no Cabinmanager.", server: "Cabinmanager", lan: "Endereço na rede local", tablet: "Acesso do tablet por Wi-Fi" },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function seite(z: Zustand, sprachen: string, server: string): string {
  const sprache = (sprachen.split(",").map((x) => x.trim().slice(0, 2).toLowerCase()).find((x) => x in TEXTE) ?? "de") as keyof typeof TEXTE;
  const t = TEXTE[sprache];
  const code = z.code ? `${z.code.slice(0, 4)} ${z.code.slice(4)}` : "";
  const inhalt = z.status === "wartet" ? `<h2>${t.wartet}</h2><p>${t.code}</p><p class="code">${esc(code)}</p><p class="leise">${t.gueltig}</p>`
    : z.status === "verbunden" ? `<h2>${t.verbunden} „${esc(z.name ?? "")}“</h2><p class="${z.verbindung ? "gut" : "leise"}">${z.verbindung ? t.verbindung : t.keineVerbindung}</p>`
    : z.status === "abgelehnt" ? `<h2>${t.abgelehnt}</h2>`
    : z.status === "fehler" ? `<h2>${t.fehler}</h2><p class="leise">${esc(z.fehler ?? "")}</p>`
    : `<h2>${t.start}</h2>`;
  return `<!doctype html><html lang="${sprache}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="10"><title>${t.titel}</title>
<style>
:root { color-scheme: light dark; --text: #18181b; --leise: #52525b; --flaeche: #fff; --grund: #f4f4f5; --akzent: #cc4c0a; --gut: #15803d; }
@media (prefers-color-scheme: dark) { :root { --text: #fafafa; --leise: #a1a1aa; --flaeche: #18181b; --grund: #09090b; --gut: #4ade80; } }
body { margin: 0; padding: 24px; background: var(--grund); color: var(--text); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 560px; margin: 0 auto; padding: 24px; border-radius: 20px; background: var(--flaeche); }
h1 { margin: 0 0 16px; font-size: 20px; } h2 { margin: 0 0 8px; font-size: 18px; }
.code { margin: 16px 0; font-size: 40px; font-weight: 700; letter-spacing: 0.08em; color: var(--akzent); }
.leise { color: var(--leise); font-size: 14px; } .gut { color: var(--gut); font-weight: 600; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; margin: 20px 0; font-size: 14px; } dt { color: var(--leise); } dd { margin: 0; overflow-wrap: anywhere; }
button { padding: 10px 16px; border: 1px solid var(--leise); border-radius: 10px; background: transparent; color: var(--text); font: inherit; cursor: pointer; }
</style></head><body><main><h1>${t.titel}</h1>${inhalt}
<dl><dt>${t.server}</dt><dd>${esc(server)}</dd>${z.lan ? `<dt>${t.lan}</dt><dd>${esc(z.lan)}</dd>` : ""}${z.tablet ? `<dt>${t.tablet}</dt><dd>${esc(z.tablet)}</dd>` : ""}</dl>
<form method="post" action="neu"><p class="leise">${t.neuText}</p><button type="submit">${t.neu}</button></form></main></body></html>`;
}
