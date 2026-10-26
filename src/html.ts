import { parse, parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

export interface GevondenLink {
  /** Gedecodeerde waarde van href (entiteiten omgezet) */
  href: string;
  /** Positie van het volledige href-attribuut in de bron-HTML */
  start: number;
  eind: number;
  quote: '"' | "'" | '';
  label: string;
  tag: string;
}

function tekstVan(n: Node): string {
  if (n.nodeName === '#text') return (n as DefaultTreeAdapterMap['textNode']).value;
  const kinderen = (n as Element).childNodes;
  if (!kinderen) return '';
  return kinderen.map(tekstVan).join(' ');
}

function attr(el: Element, naam: string): string | undefined {
  return el.attrs.find((a) => a.name === naam)?.value;
}

/** Zoekt alle <a href> en <area href> met hun exacte positie in de originele HTML. */
export function vindLinks(html: string): GevondenLink[] {
  // Volledig document (Pagina Wizard levert soms <!doctype>/<html>) of fragment
  const isDocument = /^\s*(<!doctype|<html)/i.test(html);
  const root = isDocument
    ? parse(html, { sourceCodeLocationInfo: true })
    : parseFragment(html, { sourceCodeLocationInfo: true });
  const uit: GevondenLink[] = [];
  const stapel: Node[] = [root as unknown as Node];
  while (stapel.length) {
    const n = stapel.pop()!;
    const el = n as Element;
    if ((el.tagName === 'a' || el.tagName === 'area') && el.sourceCodeLocation?.attrs?.href) {
      const loc = el.sourceCodeLocation.attrs.href;
      const bron = html.slice(loc.startOffset, loc.endOffset);
      const m = bron.match(/=\s*(["']?)/);
      const quote = (m?.[1] ?? '') as '"' | "'" | '';
      const href = attr(el, 'href') ?? '';
      const label = (tekstVan(el).replace(/\s+/g, ' ').trim() || attr(el, 'title') || attr(el, 'aria-label') || '').slice(0, 160);
      uit.push({ href, start: loc.startOffset, eind: loc.endOffset, quote, label, tag: el.tagName });
    }
    // template-inhoud en gewone kinderen
    const tpl = (n as DefaultTreeAdapterMap['template']).content;
    if (tpl) stapel.push(tpl as unknown as Node);
    const kinderen = (n as Element).childNodes;
    if (kinderen) for (let i = kinderen.length - 1; i >= 0; i--) stapel.push(kinderen[i]);
  }
  uit.sort((a, b) => a.start - b.start);
  return uit;
}

/** Vervangt alleen de opgegeven href-attributen; alle andere tekens blijven byte-voor-byte gelijk. */
export function vervangHrefs(html: string, vervangingen: { start: number; eind: number; nieuweHref: string; quote: string }[]): string {
  const lijst = [...vervangingen].sort((a, b) => b.start - a.start);
  let uit = html;
  for (const v of lijst) {
    const q = v.quote || '"';
    const waarde = v.nieuweHref.replace(/&/g, '&amp;').replace(q === '"' ? /"/g : /'/g, q === '"' ? '&quot;' : '&#39;');
    uit = uit.slice(0, v.start) + `href=${q}${waarde}${q}` + uit.slice(v.eind);
  }
  return uit;
}

/** Controle: is alles behalve de href-waarden identiek? */
export function alleenHrefsGewijzigd(origineel: string, nieuw: string): boolean {
  const strip = (h: string) => {
    const links = vindLinks(h);
    let s = h;
    for (const l of [...links].sort((a, b) => b.start - a.start)) s = s.slice(0, l.start) + 'href=""' + s.slice(l.eind);
    return s;
  };
  return strip(origineel) === strip(nieuw);
}
