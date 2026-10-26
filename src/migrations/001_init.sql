-- Basis-schema linktracker

CREATE TABLE apps (
  id              smallserial PRIMARY KEY,
  slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  naam            text NOT NULL,
  redirect_domein text NOT NULL UNIQUE,
  fallback_url    text NOT NULL,
  utm_source      text NOT NULL,
  -- uit = herschrijven doet niets, dry_run = alleen rapporteren, aan = herschrijven
  rewrite_modus   text NOT NULL DEFAULT 'dry_run' CHECK (rewrite_modus IN ('uit','dry_run','aan')),
  actief          boolean NOT NULL DEFAULT true,
  aangemaakt      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ondernemers (
  id          serial PRIMARY KEY,
  app_id      smallint NOT NULL REFERENCES apps(id),
  naam        text NOT NULL,
  extern_id   text,
  actief      boolean NOT NULL DEFAULT true,
  aangemaakt  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, naam)
);

-- Koppelregels: host (bijv. restaurantvoorbeeld.nl) of cms_item (bijv. 31919163)
CREATE TABLE ondernemer_koppelingen (
  id             serial PRIMARY KEY,
  ondernemer_id  integer NOT NULL REFERENCES ondernemers(id) ON DELETE CASCADE,
  type           text NOT NULL CHECK (type IN ('host','cms_item')),
  waarde         text NOT NULL,
  UNIQUE (type, waarde, ondernemer_id)
);
CREATE INDEX ondernemer_koppelingen_zoek ON ondernemer_koppelingen (type, waarde);

CREATE TABLE links (
  id                  text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9]{8}$'),
  app_id              smallint NOT NULL REFERENCES apps(id),
  cms_item_id         text NOT NULL,
  rubriek             text,
  pagina_titel        text,
  -- genormaliseerde bestemming zonder utm_* en fragment: bepaalt identiteit
  sleutel_url         text NOT NULL,
  -- volgnummer: tweede knop naar dezelfde bestemming op dezelfde pagina = 2
  volgnr              smallint NOT NULL DEFAULT 1,
  oorspronkelijke_url text NOT NULL,
  doel_url            text NOT NULL,
  label               text,
  ondernemer_id       integer REFERENCES ondernemers(id) ON DELETE SET NULL,
  handmatig_vast      boolean NOT NULL DEFAULT false,
  actief              boolean NOT NULL DEFAULT true,
  aangemaakt          timestamptz NOT NULL DEFAULT now(),
  bijgewerkt          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT links_identiteit UNIQUE (app_id, cms_item_id, sleutel_url, volgnr)
);
CREATE INDEX links_app_item ON links (app_id, cms_item_id);
CREATE INDEX links_ondernemer ON links (ondernemer_id) WHERE ondernemer_id IS NOT NULL;

CREATE TABLE link_wijzigingen (
  id          bigserial PRIMARY KEY,
  link_id     text NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  veld        text NOT NULL,
  oud         text,
  nieuw       text,
  door        text NOT NULL,
  tijdstip    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX link_wijzigingen_link ON link_wijzigingen (link_id, tijdstip DESC);

CREATE TABLE clicks (
  id             bigserial PRIMARY KEY,
  link_id        text NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  app_id         smallint NOT NULL,
  ts             timestamptz NOT NULL,
  ip_hash        text,
  ua_klasse      text NOT NULL,
  is_bot         boolean NOT NULL,
  is_dubbel      boolean NOT NULL,
  bron           text NOT NULL,
  -- mens | bot | inactief | domein_mismatch | neutrale_host
  classificatie  text NOT NULL
);
CREATE INDEX clicks_ts ON clicks (ts);
CREATE INDEX clicks_link_ts ON clicks (link_id, ts);
CREATE INDEX clicks_app_ts ON clicks (app_id, ts);

-- Dagsleutels voor HMAC van IP-adressen; worden na 2 dagen verwijderd
CREATE TABLE dag_sleutels (
  dag      date PRIMARY KEY,
  sleutel  bytea NOT NULL
);

CREATE TABLE api_clients (
  id          serial PRIMARY KEY,
  naam        text NOT NULL UNIQUE,
  key_hash    text NOT NULL UNIQUE,
  recht       text NOT NULL CHECK (recht IN ('lezen','schrijven','beheer')),
  actief      boolean NOT NULL DEFAULT true,
  aangemaakt  timestamptz NOT NULL DEFAULT now(),
  laatst_gebruikt timestamptz
);

CREATE TABLE verwerkingen (
  id            bigserial PRIMARY KEY,
  app_id        smallint REFERENCES apps(id),
  cms_item_id   text,
  bron          text,
  modus         text NOT NULL,
  gevonden      integer NOT NULL,
  gewijzigd     integer NOT NULL,
  nieuw         integer NOT NULL,
  waarschuwingen jsonb NOT NULL DEFAULT '[]',
  client        text,
  tijdstip      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verwerkingen_item ON verwerkingen (app_id, cms_item_id, tijdstip DESC);

CREATE TABLE fouten (
  id        bigserial PRIMARY KEY,
  soort     text NOT NULL,
  detail    jsonb NOT NULL DEFAULT '{}',
  tijdstip  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fouten_tijdstip ON fouten (tijdstip DESC);

-- Tellers per dag (ontvangen, opgeslagen, verworpen, onbekend_id, ...): controle op verloren registraties
CREATE TABLE metriek_dag (
  dag     date NOT NULL,
  sleutel text NOT NULL,
  waarde  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (dag, sleutel)
);

CREATE TABLE link_controles (
  link_id               text PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
  gecontroleerd         timestamptz NOT NULL,
  resultaat             text NOT NULL,   -- ok | tijdelijk | definitief | dns | timeout | loop | ongeldig
  http_status           integer,
  detail                text,
  opeenvolgend_fout     integer NOT NULL DEFAULT 0,
  eerste_fout           timestamptz
);
