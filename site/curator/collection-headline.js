const siteSeparators = /\s+(?:[•·|｜\\›»–—-])\s+/u;
const breadcrumbSeparators = /\s+[•·|｜›»]\s+/u;
const regionalDomainPrefixes = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org']);

function label(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function words(value) {
  return new Set(value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
}

function pathSegments(url) {
  return url.pathname.split('/').filter(Boolean).map(segment => {
    try { return decodeURIComponent(segment); }
    catch { return segment; }
  });
}

function isExpandedSiteName(suffix, domain, heading, slug) {
  // A branded acronym such as an initialism in a hyphenated domain can be
  // expanded in the browser title. Require the preceding title to fit the URL.
  if (!/^[a-z]{2,5}(?:-[a-z]{2,5})+$/u.test(domain || '') || !/^(?:[A-Z][a-z]+ ){3,7}[A-Z][a-z]+$/u.test(suffix)) return false;
  const initials = suffix.split(' ').map(word => word[0].toLowerCase()).join('');
  if (initials !== label(domain)) return false;
  const headingWords = words(heading);
  const shared = [...slug].filter(word => headingWords.has(word)).length;
  return shared >= 3 && shared >= slug.size * .75;
}

/** Trim verified page metadata for display. Leave the captured title and source intact. */
export function collectionHeadline({ title = '', url: address, publisher } = {}) {
  const savedTitle = String(title || '').trim();
  let url;
  try { url = new URL(address); }
  catch { return savedTitle; }
  if (!['http:', 'https:'].includes(url.protocol)) return savedTitle;

  const hostname = url.hostname.replace(/^www\d*\./u, '');
  const domain = hostname.split('.');
  const hasRegionalPrefix = domain.at(-1)?.length === 2 && regionalDomainPrefixes.has(domain.at(-2));
  const registrableLabel = domain.at(hasRegionalPrefix ? -3 : -2);
  const websiteLabels = new Set([hostname, registrableLabel, publisher]
    .map(label).filter(value => value.length >= 3));
  const segments = pathSegments(url);
  const slug = words((segments.at(-1) || '').replace(/\.(?:html?|aspx?)$/iu, ''));

  const firstSeparator = savedTitle.match(siteSeparators);
  const first = firstSeparator?.index;
  let visible = savedTitle;
  if (first !== undefined && websiteLabels.has(label(savedTitle.slice(0, first)))) {
    visible = savedTitle.slice(first + firstSeparator[0].length);
  }
  const lastSeparator = [...visible.matchAll(new RegExp(siteSeparators, 'gu'))].at(-1);
  if (lastSeparator) {
    const beforeSuffix = visible.slice(0, lastSeparator.index);
    const suffix = visible.slice(lastSeparator.index + lastSeparator[0].length);
    if (websiteLabels.has(label(suffix)) || isExpandedSiteName(suffix, registrableLabel, beforeSuffix, slug)) visible = beforeSuffix;
  }

  // A separator can also introduce a real subtitle. Only remove a trail when
  // the URL identifies both its article segment and an earlier navigation segment.
  const candidates = visible.split(breadcrumbSeparators);
  if (candidates.length < 2) return visible || savedTitle;
  if (slug.size < 3) return visible;
  const navigation = new Set(segments.slice(0, -1).map(label));
  const matches = candidates.filter(candidate => {
    const terms = words(candidate);
    const shared = [...terms].filter(word => slug.has(word)).length;
    return shared >= 3 && shared >= terms.size * .75 && shared >= slug.size * .75;
  });
  if (matches.length !== 1 || !candidates.some(candidate => candidate !== matches[0] && navigation.has(label(candidate)))) return visible;
  return matches[0];
}
