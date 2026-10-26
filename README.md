# BuurtApps Linktracker

Centrale linktracking voor ZeistApp, GooiseMerenApp en volgende lokale apps. Eén Node.js/TypeScript-service met één PostgreSQL-database; per app een eigen redirectdomein (`go.zeistapp.nl`, `go.gooisemerenapp.nl`).

## Werking in het kort

1. Een publicatieworkflow in n8n laat de Pagina Wizard (ongewijzigd) HTML maken.
2. De subworkflow **Linktracking | Links tracken** stuurt die HTML naar `POST /api/rewrite`.
3. De service vervangt alleen geschikte externe `href`'s door `https://go.<app>/r/<id>`. Alle andere tekens blijven byte-voor-byte gelijk (gecontroleerd vóór opslaan).
4. De gebruiker klikt in de app, de service stuurt direct door (302) en registreert de klik asynchroon.
5. Elke maandag 07:00 zet n8n de cijfers in Google Sheets.

## Deployment (Railway)

- Service: deze repository, `railway.json` regelt build, start en healthcheck (`/health`).
- Database: Railway PostgreSQL in hetzelfde project. Migraties draaien automatisch bij opstarten.
- Regio: EU.
- Replica's: 1 (dubbele-klikcontrole en cache zijn per proces; bij meer replica's wordt de 30-secondencontrole per replica).

### Omgevingsvariabelen

| Variabele | Verplicht | Uitleg |
|---|---|---|
| `DATABASE_URL` | ja | Referentie naar de Railway-Postgres (`${{Postgres.DATABASE_URL}}`) |
| `ADMIN_API_KEY` | ja | Beheersleutel, lang en willekeurig. Alleen gebruiken om andere sleutels aan te maken |
| `RETENTIE_DAGEN` | nee | Standaard 395 (13 maanden) |
| `UTM_UITZONDERINGEN` | nee | Hosts waar nooit UTM bij komt, komma-gescheiden |
| `NIET_HERSCHRIJVEN` | nee | Hosts die nooit getrackt worden |
| `EXTRA_BOT_PATRONEN` | nee | Extra user-agentfragmenten die als bot tellen |

### Domeinen

Per app in Railway een custom domain toevoegen en bij de registrar een CNAME naar het Railway-doel zetten. Vóór DNS werkt de service ook op het `*.up.railway.app`-adres (klikken worden dan als `neutrale_host` geregistreerd).

## n8n

| Workflow | Status | Functie |
|---|---|---|
| Linktracking \| Links tracken (subworkflow) | klaar | Herschrijft HTML. Bij storing gaat de originele HTML terug en komt de pagina in data table `linktracking_onverwerkt` |
| Linktracking \| Weekrapport naar Google Sheets | inactief | Maandag 07:00, upsert op `sleutel`, statusmail |
| Linktracking \| Dode links en back-up (dagelijks) | inactief | 06:30, mail bij ernstige problemen, zondag CSV-export als bijlage |
| Linktracking \| Uptimecontrole (elke 15 min) | inactief | Mailt alleen bij storing en herstel |

Vereiste n8n-variabelen: `LINKTRACKER_URL` (bijv. `https://go.zeistapp.nl`), `LINKTRACKER_KEY` (sleutel met recht `schrijven`), optioneel `LINKTRACKER_TESTLINK` (een bestaande trackinglink voor de uptimecontrole).

### Nieuwe CMS-items

Een nieuw item heeft pas een id na opslaan. Werkwijze in een publicatieworkflow:

1. Herschrijven met `cms_item_id = "tmp:<workflow>:<unieke waarde>"`.
2. Item opslaan in het CMS.
3. `POST /api/links/herkoppel` met `van_cms_item_id` = de voorlopige sleutel en `naar_cms_item_id` = het echte id. Link-id's blijven gelijk, de HTML hoeft niet opnieuw opgeslagen te worden.

## Gefaseerd inschakelen

Elke app heeft `rewrite_modus`: `uit`, `dry_run` (standaard, alleen rapporteren) of `aan`.

```
PUT /api/apps/zeist        { "rewrite_modus": "aan" }
```

## Beheer

| Taak | Hoe |
|---|---|
| Doel-URL wijzigen | `PATCH /api/links/{id}` met `{ "doel_url": "https://..." }`. Wordt direct actief en vastgezet tegen overschrijven bij een latere paginaverwerking |
| Link uitschakelen | `PATCH /api/links/{id}` met `{ "actief": false }` (bezoeker gaat naar de app-website) |
| Statistieken bekijken | Google Sheets-dashboard, of `GET /api/stats?van=...&tot=...&groep=app,rubriek` |
| Problematische links herstellen | Tab *Problematische links* of `GET /api/broken-links`; daarna doel-URL wijzigen of de pagina aanpassen. Er wordt nooit iets automatisch gewijzigd |
| Ondernemer koppelen | `POST /api/ondernemers` met `app`, `naam`, `hosts` en/of `cms_items` |
| API-sleutel vervangen | `POST /api/clients` met dezelfde `naam`: de oude sleutel vervalt direct, nieuwe wordt eenmalig getoond. Daarna n8n-variabele bijwerken. Intrekken: `DELETE /api/clients/{naam}` |
| Beheersleutel vervangen | `ADMIN_API_KEY` wijzigen in Railway en opnieuw deployen |
| Back-up terugzetten | Railway Postgres: backups-tab, herstel naar een nieuw volume en `DATABASE_URL` omzetten. Daarnaast elke zondag een CSV-export per mail |
| Nieuwe app toevoegen | Zie hieronder |

### Nieuwe lokale app toevoegen (3e, 4e, 5e app)

1. `PUT /api/apps/<slug>` met `naam`, `redirect_domein` (bijv. `go.nieuweapp.nl`), `fallback_url`, `utm_source`, `rewrite_modus: "dry_run"`.
2. Custom domain in Railway toevoegen, CNAME bij de registrar.
3. In de publicatieworkflows van die app de subworkflow aanroepen met `app = <slug>`.
4. Na controle `rewrite_modus` op `aan`.

Geen nieuwe service, database of n8n-rapportageworkflow nodig: rapportage groepeert al per app.

## Herstelprocedure bij uitval

Omdat CMS-pagina's naar de redirectdomeinen verwijzen, is beschikbaarheid bedrijfskritisch.

1. Melding komt binnen via de uptimecontrole (n8n Cloud, onafhankelijk van Railway).
2. Railway: logs bekijken, service herstarten. Een draaiende instantie blijft bekende links doorsturen uit de cache als alleen de database weg is.
3. Database kapot: back-up terugzetten (zie Beheer).
4. Langdurige uitval van Railway: de redirectdomeinen tijdelijk naar een andere host met deze code verwijzen (DNS), of als uiterste maatregel de oorspronkelijke URL's terugzetten in de pagina's met de CSV-export (`oorspronkelijke_url` per `redirect_url`).

## Privacy (AVG)

Welke verwerking plaatsvindt:

- Per klik: link-id, tijdstip, bron, een grove apparaatklasse (bijv. `ios_webview`, `bot:whatsapp`) en een gepseudonimiseerde bezoekers-id.
- De bezoekers-id is een HMAC van IP-adres en apparaatklasse met een **dagelijks wisselende willekeurige sleutel**. Sleutels worden na 2 dagen gewist; daarna is de id niet meer te herleiden of over dagen te koppelen.
- Volledige IP-adressen en volledige user-agents worden niet opgeslagen. Geen cookies.
- Bewaartermijn 13 maanden, automatisch verwijderd.

Aandachtspunten voor juridische toets (niet door mij beoordeeld):

- Een gepseudonimiseerde id is nog steeds een persoonsgegeven zolang de dagsleutel bestaat. Grondslag is waarschijnlijk gerechtvaardigd belang; leg dat vast en neem de verwerking op in de privacyverklaring van de apps.
- Geen cookies betekent niet automatisch dat er niets gemeld hoeft te worden. Vermeld de doorkliktelling in de privacyverklaring.
- Ledenrapportages bevatten alleen geaggregeerde aantallen.

## Lokaal ontwikkelen en testen

```
npm ci
npm test         # vereist een PostgreSQL op TEST_DATABASE_BASIS (standaard postgres://postgres@localhost:5433)
npm run build && npm start
```

API-specificatie: `GET /openapi.yaml`.
