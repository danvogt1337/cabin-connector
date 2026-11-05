# Cabin Connector

Verbindet dieses Home Assistant mit dem Cabinmanager. Danach kannst du Licht, Heizung, Sauna und mehr im Cabinmanager
schalten – auch von unterwegs –, deine Gäste können freigegebene Geräte in der Gästemappe bedienen, und Sensorwerte
erscheinen im Dashboard.

## So verbindest du

1. Add-on installieren und starten.
2. Die Oberfläche des Add-ons öffnen: Dort steht ein 8-stelliger Code.
3. Im Cabinmanager unter **Einstellungen → Gateways** den Code eingeben und dem Gateway einen Namen geben.

## Sicherheit

- Der Connector baut selbst eine verschlüsselte Verbindung (wss) zum Cabinmanager auf. Es wird kein Port ins Internet
  geöffnet und kein Tunnel eingerichtet; Home Assistant bleibt von außen unerreichbar. (Port 8765 ist nur im eigenen
  WLAN erreichbar und nur für das Tablet, siehe unten.)
- Der Connector führt nur erlaubte Befehle aus: Licht, Schalter, Ventilatoren, Rollos, Thermostate, Szenen, Skripte und
  Schlösser schalten sowie Zustände und Verläufe lesen. Einstellungen, Automationen oder Add-ons kann der Cabinmanager
  nicht ändern.
- Das Gerät meldet sich mit einem Geheimnis, das nur auf diesem Home Assistant liegt (der Cabinmanager speichert nur
  einen Hash davon).

## Tablet der Cabin

Das Tablet in der Cabin spricht im WLAN direkt mit dem Connector (Port **8765**, verschlüsselt). So funktionieren Licht,
Heizung und Sensoren am Tablet auch, wenn das Internet ausfällt.

- Der Connector erzeugt beim ersten Start ein eigenes Zertifikat. Das Tablet bekommt dessen Fingerabdruck über den
  Cabinmanager und verbindet sich nur mit genau diesem Zertifikat – im Gäste-WLAN kann niemand mitlesen oder sich
  dazwischenschalten.
- Tablets melden sich mit ihrem Geräte-Token an. Der Connector kennt davon nur Hashes und für jedes Tablet die Geräte,
  die im Cabinmanager fürs Tablet freigegeben sind. Ein Home-Assistant-Token liegt nie auf dem Tablet.
- Wird ein Tablet im Cabinmanager getrennt, endet sein Zugang sofort.
- Wer keinen Tablet-Zugang braucht, lässt in den Netzwerk-Einstellungen des Add-ons den Port leer.

**Neu koppeln** in der Oberfläche erzeugt ein neues Geheimnis; danach muss das Gateway im Cabinmanager neu verbunden werden.
