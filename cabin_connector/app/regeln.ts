// Was der Connector ausführt – unabhängig davon, was der Server verlangt (zweite Schranke auf dem Gerät).
// Muss mit packages/shared/src/smarthome.ts übereinstimmen; tests/connector-addon.test.ts prüft das.

export const DIENSTE: Readonly<Record<string, readonly string[]>> = {
  light: ["turn_on", "turn_off", "toggle"],
  switch: ["turn_on", "turn_off", "toggle"],
  input_boolean: ["turn_on", "turn_off", "toggle"],
  fan: ["turn_on", "turn_off", "toggle"],
  cover: ["open_cover", "close_cover", "stop_cover", "toggle"],
  climate: ["turn_on", "turn_off", "set_temperature", "set_hvac_mode"],
  scene: ["turn_on"],
  script: ["turn_on"],
  lock: ["lock", "unlock"],
};

export const ATTRIBUTE = [
  "friendly_name", "unit_of_measurement", "device_class", "temperature", "current_temperature", "hvac_action", "hvac_modes",
  "min_temp", "max_temp", "brightness", "current_position",
] as const;

/** Am Tablet zusätzlich: Grund, warum ein Rollladen-Motor gestoppt hat (Warnung am Tablet). Nur lokal, nie zum Server. */
export const TABLET_ATTRIBUTE = [...ATTRIBUTE, "last_trip_reason"] as const;

export const ENTITY_MUSTER = /^[a-z_]+\.[a-z0-9_]+$/;
const DATEN_FELDER = new Set(["entity_id", "temperature", "hvac_mode", "brightness_pct"]);

/** Erlaubter Dienstaufruf? Domain und Dienst aus der Liste, Gerät passt zur Domain, nur bekannte Datenfelder. */
export function dienstErlaubt(domain: string, dienst: string, daten: Record<string, unknown>): boolean {
  const id = daten.entity_id;
  return (DIENSTE[domain] ?? []).includes(dienst) && typeof id === "string" && ENTITY_MUSTER.test(id) && id.startsWith(`${domain}.`)
    && Object.keys(daten).every((k) => DATEN_FELDER.has(k))
    && (daten.temperature === undefined || (typeof daten.temperature === "number" && daten.temperature >= 5 && daten.temperature <= 35))
    && (daten.brightness_pct === undefined || (typeof daten.brightness_pct === "number" && daten.brightness_pct >= 1 && daten.brightness_pct <= 100))
    && (daten.hvac_mode === undefined || ["off", "heat", "auto", "cool", "heat_cool"].includes(String(daten.hvac_mode)));
}

export function attributeFiltern(a: Record<string, unknown> | null | undefined, nur: readonly string[] = ATTRIBUTE): Record<string, unknown> {
  const aus: Record<string, unknown> = {};
  for (const k of nur) if (a && a[k] !== undefined) aus[k] = a[k];
  return aus;
}
