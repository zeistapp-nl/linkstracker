import json
SHEET='1Vfn6ml4K29ywyq27lwVVY1zu53mPAjAfByJ7C8biBIo'
tabs=[('Weekoverzicht',101,["sleutel","week","van","tot","app","totaal","bots","dubbel","niet_doorgestuurd","geldig","geschat_uniek","geldig_vorige_week","verschil_pct"]),
('Rubrieken',102,["sleutel","week","app","rubriek","totaal","geldig","geschat_uniek"]),
('Bronnen',103,["sleutel","week","app","bron","totaal","geldig","geschat_uniek"]),
('Toppaginas',104,["sleutel","week","app","cms_item_id","pagina_titel","totaal","geldig","geschat_uniek"]),
('Detail',105,["sleutel","datum","week","app","rubriek","cms_item_id","pagina_titel","label","bestemming","bron","link_id","totaal","geldig","geschat_uniek"]),
('Ledenrapportage',106,["sleutel","maand","app","ondernemer","geldig","totaal","geschat_uniek","bijgewerkt"]),
('Status',108,["sleutel","week","uitgevoerd","ontvangen","opgeslagen","verworpen","in_database","compleet","regels_detail","opmerking"])]
code_fetch=r'''// Haalt de weekrapportage op en zet die om naar regels per tabblad (sleutel = upsert-sleutel, dus opnieuw draaien geeft geen dubbele regels)
const basis = String($vars.LINKTRACKER_URL || '').replace(/\/$/, '');
const sleutel = String($vars.LINKTRACKER_KEY || '');
if (!basis || !sleutel) throw new Error('LINKTRACKER_URL of LINKTRACKER_KEY ontbreekt in n8n-variabelen');
const get = (pad) => this.helpers.httpRequest({ method: 'GET', url: basis + pad, headers: { 'x-api-key': sleutel }, json: true, timeout: 60000 });
const r = await get('/api/rapport/week');
const week = r.week || (r.periode.van + '/' + r.periode.tot);
const uit = [];
const vorige = Object.fromEntries((r.per_app_vorige || []).map((x) => [x.app, x.geldig]));
for (const a of r.per_app) {
  const v = vorige[a.app] ?? 0;
  uit.push({ _tab: 0, sleutel: week + '|' + a.app, week, van: r.periode.van, tot: r.periode.tot, app: a.app, totaal: a.totaal, bots: a.bots, dubbel: a.dubbel,
    niet_doorgestuurd: a.niet_doorgestuurd, geldig: a.geldig, geschat_uniek: a.geschat_uniek, geldig_vorige_week: v,
    verschil_pct: v ? Math.round((a.geldig - v) / v * 1000) / 10 + '%' : (a.geldig ? 'nieuw' : '0%') });
}
for (const x of r.per_rubriek) uit.push({ _tab: 1, sleutel: [week, x.app, x.rubriek].join('|'), week, app: x.app, rubriek: x.rubriek, totaal: x.totaal, geldig: x.geldig, geschat_uniek: x.geschat_uniek });
for (const x of r.per_bron) uit.push({ _tab: 2, sleutel: [week, x.app, x.bron].join('|'), week, app: x.app, bron: x.bron, totaal: x.totaal, geldig: x.geldig, geschat_uniek: x.geschat_uniek });
for (const x of r.top_paginas) uit.push({ _tab: 3, sleutel: [week, x.app, x.cms_item_id].join('|'), week, app: x.app, cms_item_id: x.cms_item_id, pagina_titel: x.pagina_titel || '', totaal: x.totaal, geldig: x.geldig, geschat_uniek: x.geschat_uniek });
for (const x of r.detail) uit.push({ _tab: 4, sleutel: [x.dag, x.app, x.link_id, x.bron].join('|'), datum: x.dag, week, app: x.app, rubriek: x.rubriek || '', cms_item_id: x.cms_item_id, pagina_titel: x.pagina_titel || '', label: x.label || '', bestemming: x.bestemming, bron: x.bron, link_id: x.link_id, totaal: x.totaal, geldig: x.geldig, geschat_uniek: x.geschat_uniek });
// Ledenrapportage per kalendermaand: lopende maand(en) van deze week, telkens vanaf de 1e (overschrijft eerdere stand)
const maanden = [...new Set([r.periode.van.slice(0, 7), r.periode.tot.slice(0, 7)])];
for (const m of maanden) {
  const van = m + '-01';
  const eindMaand = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
  const tot = eindMaand < r.periode.tot ? eindMaand : r.periode.tot;
  const o = await get('/api/stats/ondernemers?van=' + van + '&tot=' + tot);
  for (const x of o.rijen) uit.push({ _tab: 5, sleutel: [m, x.app, x.ondernemer_id].join('|'), maand: m, app: x.app, ondernemer: x.ondernemer, geldig: x.geldig, totaal: x.totaal, geschat_uniek: x.geschat_uniek, bijgewerkt: 't/m ' + tot });
}
const i = r.integriteit;
uit.push({ _tab: 6, sleutel: week, week, uitgevoerd: $now.setZone('Europe/Amsterdam').toFormat('yyyy-MM-dd HH:mm'), ontvangen: i.ontvangen, opgeslagen: i.opgeslagen, verworpen: i.verworpen, in_database: i.in_database, compleet: i.compleet ? 'ja' : 'NEE', regels_detail: r.detail.length, opmerking: i.compleet ? '' : 'Er zijn kliks verworpen: controleer /api/status' });
return uit.map((json) => ({ json }));'''
nodes=[]
nodes.append(f"""const schema = trigger({{ type: 'n8n-nodes-base.scheduleTrigger', version: 1.4, config: {{ name: 'Elke maandag 07:00', parameters: {{ rule: {{ interval: [{{ field: 'cronExpression', expression: '0 7 * * 1' }}] }} }} }} }});
const ophalen = node({{ type: 'n8n-nodes-base.code', version: 2, config: {{ name: 'Weekrapport ophalen', retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, parameters: {{ mode: 'runOnceForAllItems', language: 'javaScript', jsCode: {json.dumps(code_fetch)} }} }} }});
const verdeel = switchCase({{ version: 3.4, config: {{ name: 'Per tabblad', parameters: {{ mode: 'expression', numberOutputs: 7, output: expr('{{{{ $json._tab }}}}') }} }} }});""")
for idx,(tab,gid,cols) in enumerate(tabs):
    schema=", ".join([f"{{ id: '{c}', displayName: '{c}', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true }}" for c in cols[:1]])
    nodes.append(f"""const t{idx} = node({{ type: 'n8n-nodes-base.googleSheets', version: 4.7, config: {{ name: 'Sheets: {tab}', retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, credentials: {{ googleSheetsOAuth2Api: {{ id: 'xLbp4wvzEBjahwMn', name: 'Google Sheets account' }} }}, parameters: {{ resource: 'sheet', operation: 'appendOrUpdate', authentication: 'oAuth2', documentId: {{ __rl: true, mode: 'id', value: '{SHEET}', cachedResultName: 'Linktracking BuurtApps – Dashboard' }}, sheetName: {{ __rl: true, mode: 'list', value: '{gid}', cachedResultName: '{tab}' }}, columns: {{ mappingMode: 'autoMapInputData', value: {{}}, matchingColumns: ['sleutel'], schema: [{schema}] }}, options: {{ handlingExtraData: 'ignoreIt', cellFormat: 'RAW' }} }} }} }});""")
mail_code=r'''const s = $('Weekrapport ophalen').all().map((i) => i.json);
const st = s.find((x) => x._tab === 6) || {};
const apps = s.filter((x) => x._tab === 0);
const regels = apps.map((a) => `<li><b>${a.app}</b>: ${a.geldig} geldige kliks (vorige week ${a.geldig_vorige_week}, ${a.verschil_pct}), geschat uniek ${a.geschat_uniek}, bots ${a.bots}</li>`).join('');
const top = s.filter((x) => x._tab === 3).sort((a, b) => b.geldig - a.geldig).slice(0, 5).map((p) => `<li>${p.app}: ${p.pagina_titel || p.cms_item_id} (${p.geldig})</li>`).join('');
return [{ json: {
  onderwerp: `Linktracking ${st.week}: ${apps.reduce((n, a) => n + a.geldig, 0)} geldige kliks` + (st.compleet === 'ja' ? '' : ' (LET OP: onvolledig)'),
  html: `<p>Weekrapport ${st.week} is bijgewerkt in Google Sheets.</p><ul>${regels || '<li>Geen kliks gemeten.</li>'}</ul>` +
    (top ? `<p>Best presterende pagina's:</p><ul>${top}</ul>` : '') +
    `<p>Controle: ontvangen ${st.ontvangen}, opgeslagen ${st.opgeslagen}, verworpen ${st.verworpen}, detailregels ${st.regels_detail}. Volledig: ${st.compleet}.</p>` +
    `<p><a href="https://docs.google.com/spreadsheets/d/''' + SHEET + r'''/edit">Open het dashboard</a></p>`
} }];'''
nodes.append(f"""const mailTekst = node({{ type: 'n8n-nodes-base.code', version: 2, config: {{ name: 'Statusbericht opstellen', executeOnce: true, parameters: {{ mode: 'runOnceForAllItems', language: 'javaScript', jsCode: {json.dumps(mail_code)} }} }} }});
const mail = node({{ type: 'n8n-nodes-base.gmail', version: 2.2, config: {{ name: 'Statusmail', credentials: {{ gmailOAuth2: {{ id: 'UlDPU3VRpN45JxDT', name: 'Gmail account' }} }}, parameters: {{ resource: 'message', operation: 'send', sendTo: 'zeistapp@gmail.com', subject: expr('{{{{ $json.onderwerp }}}}'), emailType: 'html', message: expr('{{{{ $json.html }}}}'), options: {{ appendAttribution: false }} }} }} }});
const fout = trigger({{ type: 'n8n-nodes-base.errorTrigger', version: 1, config: {{ name: 'Bij fout' }} }});
const foutmail = node({{ type: 'n8n-nodes-base.gmail', version: 2.2, config: {{ name: 'Foutmelding', credentials: {{ gmailOAuth2: {{ id: 'UlDPU3VRpN45JxDT', name: 'Gmail account' }} }}, parameters: {{ resource: 'message', operation: 'send', sendTo: 'zeistapp@gmail.com', subject: 'Linktracking weekrapport MISLUKT', emailType: 'html', message: expr('<p>Het weekrapport is niet (volledig) bijgewerkt.</p><p>Stap: {{{{ $json.execution.lastNodeExecuted }}}}<br>Fout: {{{{ $json.execution.error.message }}}}</p><p><a href="{{{{ $json.execution.url }}}}">Open de uitvoering</a>. Opnieuw draaien is veilig: regels worden bijgewerkt, niet verdubbeld.</p>'), options: {{ appendAttribution: false }} }} }} }});""")
wf="""export default workflow('linktracking-weekrapport', 'Linktracking | Weekrapport naar Google Sheets')
  .add(schema)
  .to(ophalen)
  .to(verdeel
    .onCase(0, t0)
    .onCase(1, t1)
    .onCase(2, t2)
    .onCase(3, t3)
    .onCase(4, t4)
    .onCase(5, t5)
    .onCase(6, t6.to(mailTekst).to(mail)))
  .add(fout)
  .to(foutmail);"""
code="import { workflow, node, trigger, switchCase, expr } from '@n8n/workflow-sdk';\n\n"+"\n".join(nodes)+"\n\n"+wf
open('/home/claude/linktracker/n8n/weekrapport.ts','w').write(code)
print(len(code))
