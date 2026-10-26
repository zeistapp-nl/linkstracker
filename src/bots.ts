import { config } from './config.js';

// Bekende bots, linkpreviews en mailbeveiligingsscanners. Aanvulbaar via EXTRA_BOT_PATRONEN.
const BASIS: [string, RegExp][] = [
  ['whatsapp', /whatsapp/i],
  ['facebook', /facebookexternalhit|facebookcatalog|meta-externalagent|meta-externalfetcher/i],
  ['slack', /slackbot|slack-imgproxy/i],
  ['telegram', /telegrambot/i],
  ['discord', /discordbot/i],
  ['twitter', /twitterbot/i],
  ['linkedin', /linkedinbot/i],
  ['skype', /skypeuripreview/i],
  ['apple', /applebot/i],
  ['google', /googlebot|google-inspectiontool|googleother|apis-google|adsbot-google|feedfetcher-google|google-read-aloud/i],
  ['bing', /bingbot|bingpreview|msnbot/i],
  ['zoekmachine', /yandex|baiduspider|duckduckbot|petalbot|sogou|seznambot/i],
  ['seo', /ahrefsbot|semrushbot|mj12bot|dotbot|dataforseobot|blexbot/i],
  ['ai', /gptbot|chatgpt-user|oai-searchbot|claudebot|claude-user|perplexitybot|ccbot|bytespider|amazonbot/i],
  ['ms_safelinks', /safelinks|microsoft office|ms-office|outlook-(ios|android|express)?\s*link|microsoftpreview/i],
  ['mimecast', /mimecast/i],
  ['proofpoint', /proofpoint|urldefense/i],
  ['barracuda', /barracuda/i],
  ['mailscanner', /symantec|messagelabs|trendmicro|forcepoint|sophos|fortiguard|cisco|ironport|zscaler|virustotal/i],
  ['monitor', /uptimerobot|pingdom|statuscake|betteruptime|better stack|n8n|site24x7/i],
  ['http_bibliotheek', /curl\/|wget\/|python-requests|python-urllib|aiohttp|httpx|go-http-client|okhttp|java\/|libwww|node-fetch|axios\/|undici|headlesschrome|phantomjs|puppeteer|playwright/i],
  ['generiek', /\b(bot|crawler|spider|preview|scanner|fetcher|scraper)\b/i],
];

export interface UaOordeel {
  isBot: boolean;
  klasse: string;
}

/** Privacyvriendelijke afgeleide van de user-agent: alleen platform of botnaam, nooit de volledige string. */
export function beoordeelUa(ua: string | undefined): UaOordeel {
  const s = (ua ?? '').trim();
  if (!s) return { isBot: true, klasse: 'bot:leeg' };
  for (const p of config.extraBotPatronen) {
    if (s.toLowerCase().includes(p)) return { isBot: true, klasse: `bot:extra` };
  }
  for (const [naam, re] of BASIS) {
    if (re.test(s)) return { isBot: true, klasse: `bot:${naam}` };
  }
  let klasse = 'overig';
  if (/iphone|ipad|ipod/i.test(s)) klasse = /safari\//i.test(s) && !/(fban|fbav|instagram)/i.test(s) ? 'ios_browser' : 'ios_webview';
  else if (/android/i.test(s)) klasse = /\bwv\b|; wv\)/i.test(s) ? 'android_webview' : 'android_browser';
  else if (/macintosh|windows|linux|cros/i.test(s)) klasse = 'desktop';
  return { isBot: false, klasse };
}
