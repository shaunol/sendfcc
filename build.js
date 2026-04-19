const fs = require('fs');
const path = require('path');

const DOMAIN = 'https://sendf.cc';
const localesDir = path.join(__dirname, 'src', 'locales');
const template = fs.readFileSync(path.join(__dirname, 'src', 'index.html'), 'utf8');
const workerSrc = fs.readFileSync(path.join(__dirname, 'src', 'worker.js'), 'utf8');

// Load all locale files
const locales = [];
for (const file of fs.readdirSync(localesDir).filter(f => f.endsWith('.json'))) {
  const data = JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8'));
  locales.push(data);
}

// Sort so default locale comes first
locales.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));

function getHomeUrl(loc) {
  return loc.isDefault ? '/' : '/' + loc.locale + '/';
}

function getCanonicalUrl(loc) {
  return DOMAIN + getHomeUrl(loc);
}

// Build hreflang tags for a given locale
function buildHreflangTags(currentLocale) {
  const tags = [];
  for (const loc of locales) {
    const url = getCanonicalUrl(loc);
    tags.push(`<link rel="alternate" hreflang="${loc.hreflang}" href="${url}">`);
    if (loc.isDefault) {
      tags.push(`<link rel="alternate" hreflang="x-default" href="${url}">`);
    }
  }
  return tags.join('\n');
}

// Build OG locale alternate tags
function buildOgLocaleAlternates(currentLocale) {
  return locales
    .filter(loc => loc.ogLocale !== currentLocale.ogLocale)
    .map(loc => `<meta property="og:locale:alternate" content="${loc.ogLocale}">`)
    .join('\n');
}

// Build JSON-LD structured data
function buildJsonLd(currentLocale) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'sendf.cc',
    url: DOMAIN,
    description: currentLocale.metaDesc,
    applicationCategory: 'UtilityApplication',
    operatingSystem: 'Any',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    inLanguage: currentLocale.hreflang,
  };
  return '<script type="application/ld+json">' + JSON.stringify(ld) + '</script>';
}

// Build language picker <option> elements
function buildLanguageOptions(currentLocale) {
  return locales.map(loc => {
    const selected = loc.locale === currentLocale.locale ? ' selected' : '';
    return `<option value="${getHomeUrl(loc)}"${selected}>${loc.langName}</option>`;
  }).join('\n');
}

// Stamp a locale into the template
function stampLocale(loc) {
  let html = template;

  // Simple {{key}} replacements from top-level locale keys
  const simpleKeys = [
    'htmlLang', 'dir', 'title', 'metaDesc', 'ogTitle', 'ogDesc', 'ogLocale',
    'h1Sub', 'dropText', 'dropLimit', 'selectFile', 'uploading',
    'fileExpired', 'uploadAnother', 'expires', 'copy', 'copied',
    'featuresHeading', 'feature1', 'feature2', 'feature3', 'feature4',
    'noscriptText', 'footerText',
    'expiryLabel',
    'feedbackToggle', 'feedbackPlaceholder', 'feedbackSubmit',
    'resumeYes', 'resumeNo', 'cancelUpload',
  ];

  for (const key of simpleKeys) {
    html = html.replace(new RegExp('\\{\\{' + key + '\\}\\}', 'g'), loc[key] || '');
  }

  // Computed replacements
  html = html.replace(/\{\{homeUrl\}\}/g, getHomeUrl(loc));
  html = html.replace(/\{\{canonicalUrl\}\}/g, getCanonicalUrl(loc));
  html = html.replace(/\{\{hreflangTags\}\}/g, buildHreflangTags(loc));
  html = html.replace(/\{\{ogLocaleAlternates\}\}/g, buildOgLocaleAlternates(loc));
  html = html.replace(/\{\{languageOptions\}\}/g, buildLanguageOptions(loc));
  html = html.replace(/\{\{jsonLd\}\}/g, buildJsonLd(loc));
  html = html.replace(/\{\{jsStrings\}\}/g, JSON.stringify(loc.js));

  return html;
}

// Build all locale pages
const pages = {};
for (const loc of locales) {
  pages[loc.locale] = stampLocale(loc);
}

// Generate the PAGES object for the worker
function escapeForTemplateLiteral(str) {
  return str.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

const pagesEntries = Object.entries(pages)
  .map(([locale, html]) => `  "${locale}": \`${escapeForTemplateLiteral(html)}\``)
  .join(',\n');

const pagesObj = `{\n${pagesEntries}\n}`;

const output = workerSrc
  .replace("const PAGES = '%%PAGES%%';", 'const PAGES = ' + pagesObj + ';');

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'worker.js'), output);
console.log(`Build complete: dist/worker.js (${locales.length} locales)`);

// Check for unreplaced placeholders
const unreplaced = output.match(/\{\{[a-zA-Z]+\}\}/g);
if (unreplaced) {
  const unique = [...new Set(unreplaced)];
  console.warn('WARNING: Unreplaced placeholders found:', unique.join(', '));
  process.exit(1);
}
