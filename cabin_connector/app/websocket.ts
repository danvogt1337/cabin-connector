// Kleiner WebSocket-Server (RFC 6455) für den lokalen Tablet-Zugang – ohne Fremdpakete, damit das Add-on nur Node.js
// braucht. Kann genau das Nötige: Textnachrichten (auch in Teilen), Ping/Pong, Schließen; Nachrichten höchstens 64 KB,
// Clients müssen maskieren, keine Erweiterungen. Wer 60 s nichts sendet und auf Ping nicht antwortet, wird getrennt.
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const MAX_NACHRICHT = 64 * 1024;
const PING_MS = 30_000;

export interface Kanal {
  senden(text: string): void;
  schliessen(code: number, grund?: string): void;
  offen(): boolean;
}

export function wsAnnehmen(req: IncomingMessage, socket: Duplex, auf: { text(t: string): void; zu(): void }): Kanal | null {
  const key = req.headers["sec-websocket-key"];
  if (req.method !== "GET" || String(req.headers.upgrade).toLowerCase() !== "websocket" || req.headers["sec-websocket-version"] !== "13"
    || typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash("sha1").update(key + GUID).digest("base64")}\r\n\r\n`);

  let puffer: Buffer = Buffer.alloc(0);
  let teile: Buffer[] = [];
  let teilLaenge = 0;
  let teilArt = 0;
  let zu = false;
  let lebt = true;

  const rahmen = (art: number, daten: Buffer) => {
    const n = daten.length;
    let kopf: Buffer;
    if (n < 126) kopf = Buffer.from([0x80 | art, n]);
    else if (n < 65_536) { kopf = Buffer.alloc(4); kopf[0] = 0x80 | art; kopf[1] = 126; kopf.writeUInt16BE(n, 2); }
    else { kopf = Buffer.alloc(10); kopf[0] = 0x80 | art; kopf[1] = 127; kopf.writeBigUInt64BE(BigInt(n), 2); }
    if (!socket.destroyed) socket.write(Buffer.concat([kopf, daten]));
  };
  const schliessen = (code: number, grund = "") => {
    if (zu) return;
    zu = true;
    const b = Buffer.alloc(2 + Buffer.byteLength(grund.slice(0, 100)));
    b.writeUInt16BE(code);
    b.write(grund.slice(0, 100), 2);
    rahmen(8, b);
    socket.end();
    setTimeout(() => socket.destroy(), 1000).unref();
  };

  socket.on("data", (stueck: Buffer) => {
    lebt = true;
    puffer = puffer.length ? Buffer.concat([puffer, stueck]) : stueck;
    while (!zu && puffer.length >= 2) {
      const b0 = puffer[0]!;
      const b1 = puffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const art = b0 & 0x0f;
      let laenge = b1 & 0x7f;
      let pos = 2;
      if ((b0 & 0x70) !== 0 || (b1 & 0x80) === 0) { schliessen(1002, "protokoll"); return; }
      if (laenge === 126) {
        if (puffer.length < 4) return;
        laenge = puffer.readUInt16BE(2);
        pos = 4;
      } else if (laenge === 127) {
        if (puffer.length < 10) return;
        const l = puffer.readBigUInt64BE(2);
        laenge = l > BigInt(MAX_NACHRICHT) ? MAX_NACHRICHT + 1 : Number(l);
        pos = 10;
      }
      if (laenge > MAX_NACHRICHT) { schliessen(1009, "zu_gross"); return; }
      if (puffer.length < pos + 4 + laenge) return;
      const maske = puffer.subarray(pos, pos + 4);
      const daten = Buffer.from(puffer.subarray(pos + 4, pos + 4 + laenge));
      for (let i = 0; i < daten.length; i++) daten[i]! ^= maske[i & 3]!;
      puffer = puffer.subarray(pos + 4 + laenge);

      if (art >= 8) {
        // Steuerrahmen: nie geteilt, höchstens 125 Byte
        if (!fin || laenge > 125) { schliessen(1002, "protokoll"); return; }
        if (art === 8) { schliessen(1000); return; }
        if (art === 9) rahmen(10, daten);
        continue;
      }
      if (art === 0 ? teilArt === 0 : teilArt !== 0) { schliessen(1002, "protokoll"); return; }
      if (art !== 0) teilArt = art;
      teile.push(daten);
      teilLaenge += daten.length;
      if (teilLaenge > MAX_NACHRICHT) { schliessen(1009, "zu_gross"); return; }
      if (!fin) continue;
      const ganz = Buffer.concat(teile);
      const ganzArt = teilArt;
      teile = [];
      teilLaenge = 0;
      teilArt = 0;
      if (ganzArt !== 1) { schliessen(1003, "nur_text"); return; }
      auf.text(ganz.toString("utf8"));
    }
  });
  const ping = setInterval(() => {
    if (!lebt) { socket.destroy(); return; }
    lebt = false;
    rahmen(9, Buffer.alloc(0));
  }, PING_MS);
  ping.unref();
  socket.on("close", () => { zu = true; clearInterval(ping); auf.zu(); });
  socket.on("error", () => socket.destroy());

  return {
    senden: (t) => { if (!zu) rahmen(1, Buffer.from(t)); },
    schliessen,
    offen: () => !zu,
  };
}
