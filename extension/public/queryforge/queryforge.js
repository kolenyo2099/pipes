"use strict";

/* ══════════════════════════════════════════════════════════════
   CONSTANTS
   ══════════════════════════════════════════════════════════════ */

// Google reads the first 32 words of a query and silently ignores the rest,
// so a site: past word 32 is dropped with no warning. Measured through Serper
// on 2026-09-14, Verbatim on: OR, after: and before: don't count; each word,
// -word, intitle:, filetype: and site: counts 1; inurl:, intext: and AROUND(n)
// count 2. Length in characters didn't matter; this cap only keeps URLs sane.
const GOOGLE_WORD_LIMIT = 32;
const MAX_QUERY_CHARS = 1800;
// Web tab + Verbatim. Verbatim makes inurl: and intext: return nothing or junk
// (measured the same day), so a query using them opens without it.
const GOOGLE_SEARCH_URL = 'https://www.google.com/search?udm=14&tbs=li:1&q=';
const GOOGLE_SEARCH_URL_NO_VERBATIM = 'https://www.google.com/search?udm=14&q=';
const needsNoVerbatim = query => /(^|[\s(])(inurl|intext):/i.test(query);

const $ = id => document.getElementById(id);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
// The vault shows a domain, not a URL — https:// is a guess, not a fact
// from the source, so this is "probably works", not a verified link.
const domLink = domain => {
  const a = el('a', 'dom', domain);
  a.href = 'https://' + domain;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = 'Open ' + domain + ' (opens in a new tab)';
  return a;
};
const googleSearchUrl = query =>
  (needsNoVerbatim(query) ? GOOGLE_SEARCH_URL_NO_VERBATIM : GOOGLE_SEARCH_URL) + encodeURIComponent(query);

/* ══════════════════════════════════════════════════════════════
   NORMALISATION
   Every adapter must emit this shape:
   { domain, name, type, country, region, source_db, retrieved_at, confidence }
   confidence ∈ asserted | inferred | authoritative | custom
   ══════════════════════════════════════════════════════════════ */

function toDomain(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(s)) return null;
  return s;
}

function record(o) {
  const domain = toDomain(o.domain);
  if (!domain) return null;
  return {
    domain,
    name: (o.name || domain).trim(),
    type: o.type || 'source',
    country: o.country || '',
    region: o.region || '',
    source_db: o.source_db,
    retrieved_at: new Date().toISOString(),
    confidence: o.confidence
  };
}

/* ══════════════════════════════════════════════════════════════
   COUNTRY REGISTRY
   One table for every database, keyed on ISO 3166-1 alpha-2.
   Each adapter carries its own naming scheme as a column — Wikidata
   QIDs, FIPS 10-4 for GDELT — so the picker speaks one language and
   the adapters translate on the way out.
   That is also what lets your country survive a database switch.

   Generated. Do not hand-edit between the markers; run
   ./build-countries.sh to rebuild from Wikidata's own code properties.
   ══════════════════════════════════════════════════════════════ */

/* ── COUNTRIES:GENERATED ── */
const COUNTRY_ROWS = [
  ["AF", "Afghanistan", "AFG", "AF", "Q889"],
  ["AL", "Albania", "ALB", "AL", "Q222"],
  ["DZ", "Algeria", "DZA", "AG", "Q262"],
  ["AS", "American Samoa", "ASM", "AQ", "Q16641"],
  ["AD", "Andorra", "AND", "AN", "Q228"],
  ["AO", "Angola", "AGO", "AO", "Q916"],
  ["AI", "Anguilla", "AIA", "AV", "Q25228"],
  ["AQ", "Antarctica", "ATA", "AY", "Q10372207"],
  ["AG", "Antigua and Barbuda", "ATG", "AC", "Q781"],
  ["AR", "Argentina", "ARG", "AR", "Q414"],
  ["AM", "Armenia", "ARM", "AM", "Q399"],
  ["AW", "Aruba", "ABW", "AA", "Q21203"],
  ["AC", "Ascension", "ASC", "SH01", "Q31890709"],
  ["AU", "Australia", "AUS", "AS", "Q408"],
  ["AT", "Austria", "AUT", "AU", "Q40"],
  ["AZ", "Azerbaijan", "AZE", "AJ", "Q227"],
  ["BS", "Bahamas", "BHS", "BF", "Q778"],
  ["BH", "Bahrain", "BHR", "BA", "Q398"],
  ["BD", "Bangladesh", "BGD", "BG", "Q902"],
  ["BB", "Barbados", "BRB", "BB", "Q244"],
  ["BY", "Belarus", "BLR", "BO", "Q184"],
  ["BE", "Belgium", "BEL", "BE", "Q31"],
  ["BZ", "Belize", "BLZ", "BH", "Q242"],
  ["BJ", "Benin", "BEN", "BN", "Q962"],
  ["BM", "Bermuda", "BMU", "BD", "Q23635"],
  ["BT", "Bhutan", "BTN", "BT", "Q917"],
  ["BO", "Bolivia", "BOL", "BL", "Q750"],
  ["BA", "Bosnia and Herzegovina", "BIH", "BK", "Q225"],
  ["BW", "Botswana", "BWA", "BC", "Q963"],
  ["BV", "Bouvet Island", "BVT", "BV", "Q23408"],
  ["BR", "Brazil", "BRA", "BR", "Q155"],
  ["IO", "British Indian Ocean Territory", "IOT", "IO", "Q43448"],
  ["VG", "British Virgin Islands", "VGB", "VI", "Q25305"],
  ["BN", "Brunei", "BRN", "BX", "Q921"],
  ["BG", "Bulgaria", "BGR", "BU", "Q219"],
  ["BF", "Burkina Faso", "BFA", "UV", "Q965"],
  ["BI", "Burundi", "BDI", "BY", "Q967"],
  ["KH", "Cambodia", "KHM", "CB", "Q424"],
  ["CM", "Cameroon", "CMR", "CM", "Q1009"],
  ["CA", "Canada", "CAN", "CA", "Q16"],
  ["CV", "Cape Verde", "CPV", "CV", "Q1011", "cabo verde"],
  ["BQ", "Caribbean Netherlands", "BES", "", "Q27561"],
  ["KY", "Cayman Islands", "CYM", "CJ", "Q5785"],
  ["CF", "Central African Republic", "CAF", "CT", "Q929"],
  ["TD", "Chad", "TCD", "CD", "Q657"],
  ["CL", "Chile", "CHL", "CI", "Q298"],
  ["CN", "China", "CHN", "CH", "Q148"],
  ["CX", "Christmas Island", "CXR", "KT", "Q31063"],
  ["CP", "Clipperton Island", "", "IP", "Q161258"],
  ["CC", "Cocos (Keeling) Islands", "CCK", "CK", "Q36004"],
  ["CO", "Colombia", "COL", "CO", "Q739"],
  ["KM", "Comoros", "COM", "CN", "Q970"],
  ["CK", "Cook Islands", "COK", "CW", "Q26988"],
  ["CR", "Costa Rica", "CRI", "CS", "Q800"],
  ["HR", "Croatia", "HRV", "HR", "Q224"],
  ["CU", "Cuba", "CUB", "CU", "Q241"],
  ["CW", "Curaçao", "CUW", "UC", "Q25279"],
  ["CY", "Cyprus", "CYP", "CY", "Q644636"],
  ["CZ", "Czech Republic", "CZE", "EZ", "Q213", "czechia"],
  ["CD", "DR Congo", "COD", "CG", "Q974", "congo kinshasa zaire"],
  ["DK", "Denmark", "DNK", "DA", "Q35"],
  ["DG", "Diego Garcia", "", "", "Q184851"],
  ["DJ", "Djibouti", "DJI", "DJ", "Q977"],
  ["DM", "Dominica", "DMA", "DO", "Q784"],
  ["DO", "Dominican Republic", "DOM", "DR", "Q786"],
  ["EC", "Ecuador", "ECU", "EC", "Q736"],
  ["EG", "Egypt", "EGY", "EG", "Q79"],
  ["SV", "El Salvador", "SLV", "ES", "Q792"],
  ["GQ", "Equatorial Guinea", "GNQ", "EK", "Q983"],
  ["ER", "Eritrea", "ERI", "ER", "Q986"],
  ["EE", "Estonia", "EST", "EN", "Q191"],
  ["SZ", "Eswatini", "SWZ", "WZ", "Q1050", "swaziland"],
  ["ET", "Ethiopia", "ETH", "ET", "Q115"],
  ["FK", "Falkland Islands", "FLK", "FK", "Q9648"],
  ["FO", "Faroe Islands", "FRO", "FO", "Q4628"],
  ["FM", "Federated States of Micronesia", "FSM", "FM", "Q702"],
  ["FJ", "Fiji", "FJI", "FJ", "Q712"],
  ["FI", "Finland", "FIN", "FI", "Q33"],
  ["FR", "France", "FRA", "FR", "Q142"],
  ["GF", "French Guiana", "GUF", "FG", "Q3769"],
  ["PF", "French Polynesia", "PYF", "FP", "Q30971"],
  ["TF", "French Southern and Antarctic Lands", "ATF", "FS", "Q129003"],
  ["GA", "Gabon", "GAB", "GB", "Q1000"],
  ["GM", "Gambia", "GMB", "GA", "Q1005"],
  ["GE", "Georgia", "GEO", "GG", "Q230"],
  ["DD", "German Democratic Republic", "DDR", "", "Q16957"],
  ["DE", "Germany", "DEU", "GM", "Q183"],
  ["GH", "Ghana", "GHA", "GH", "Q117"],
  ["GI", "Gibraltar", "GIB", "GI", "Q1410"],
  ["GR", "Greece", "GRC", "GR", "Q41"],
  ["GL", "Greenland", "GRL", "GL", "Q223"],
  ["GD", "Grenada", "GRD", "GJ", "Q769"],
  ["GP", "Guadeloupe", "GLP", "GP", "Q17012"],
  ["GU", "Guam", "GUM", "GQ", "Q16635"],
  ["GT", "Guatemala", "GTM", "GT", "Q774"],
  ["GG", "Guernsey", "GGY", "GK", "Q25230"],
  ["GN", "Guinea", "GIN", "GV", "Q1006"],
  ["GW", "Guinea-Bissau", "GNB", "PU", "Q1007"],
  ["GY", "Guyana", "GUY", "GY", "Q734"],
  ["HT", "Haiti", "HTI", "HA", "Q790"],
  ["HM", "Heard Island and McDonald Islands", "HMD", "HM", "Q131198"],
  ["HN", "Honduras", "HND", "HO", "Q783"],
  ["HK", "Hong Kong", "HKG", "HK", "Q8646"],
  ["HU", "Hungary", "HUN", "HU", "Q28"],
  ["IS", "Iceland", "ISL", "IC", "Q189"],
  ["IN", "India", "IND", "IN", "Q668"],
  ["ID", "Indonesia", "IDN", "ID", "Q252"],
  ["IR", "Iran", "IRN", "IR", "Q794", "persia"],
  ["IQ", "Iraq", "IRQ", "IZ", "Q796"],
  ["IE", "Ireland", "IRL", "EI", "Q27"],
  ["IM", "Isle of Man", "IMN", "IM", "Q9676"],
  ["IL", "Israel", "ISR", "IS", "Q801"],
  ["IT", "Italy", "ITA", "IT", "Q38"],
  ["CI", "Ivory Coast", "CIV", "IV", "Q1008", "cote d'ivoire"],
  ["JM", "Jamaica", "JAM", "JM", "Q766"],
  ["JP", "Japan", "JPN", "JA", "Q17"],
  ["JE", "Jersey", "JEY", "JE", "Q785"],
  ["JO", "Jordan", "JOR", "JO", "Q810"],
  ["KZ", "Kazakhstan", "KAZ", "KZ", "Q232"],
  ["KE", "Kenya", "KEN", "KE", "Q114"],
  ["KI", "Kiribati", "KIR", "KR", "Q710"],
  ["XK", "Kosovo", "XKS", "KV", "Q1246"],
  ["KW", "Kuwait", "KWT", "KU", "Q817"],
  ["KG", "Kyrgyzstan", "KGZ", "KG", "Q813"],
  ["LA", "Laos", "LAO", "LA", "Q819", "lao"],
  ["LV", "Latvia", "LVA", "LG", "Q211"],
  ["LB", "Lebanon", "LBN", "LE", "Q822"],
  ["LS", "Lesotho", "LSO", "LT", "Q1013"],
  ["LR", "Liberia", "LBR", "LI", "Q1014"],
  ["LY", "Libya", "LBY", "LY", "Q1016"],
  ["LI", "Liechtenstein", "LIE", "LS", "Q347"],
  ["LT", "Lithuania", "LTU", "LH", "Q37"],
  ["LU", "Luxembourg", "LUX", "LU", "Q32"],
  ["MO", "Macau", "MAC", "MC", "Q14773"],
  ["MG", "Madagascar", "MDG", "MA", "Q1019"],
  ["MW", "Malawi", "MWI", "MI", "Q1020"],
  ["MY", "Malaysia", "MYS", "MY", "Q833"],
  ["MV", "Maldives", "MDV", "MV", "Q826"],
  ["ML", "Mali", "MLI", "ML", "Q912"],
  ["MT", "Malta", "MLT", "MT", "Q233"],
  ["MH", "Marshall Islands", "MHL", "RM", "Q709"],
  ["MQ", "Martinique", "MTQ", "MB", "Q17054"],
  ["MR", "Mauritania", "MRT", "MR", "Q1025"],
  ["MU", "Mauritius", "MUS", "MP", "Q1027"],
  ["YT", "Mayotte", "MYT", "MF", "Q17063"],
  ["MX", "Mexico", "MEX", "MX", "Q96"],
  ["MD", "Moldova", "MDA", "MD", "Q217"],
  ["MC", "Monaco", "MCO", "MN", "Q235"],
  ["MN", "Mongolia", "MNG", "MG", "Q711"],
  ["ME", "Montenegro", "MNE", "MJ", "Q236"],
  ["MS", "Montserrat", "MSR", "MH", "Q13353"],
  ["MA", "Morocco", "MAR", "MO", "Q1028"],
  ["MZ", "Mozambique", "MOZ", "MZ", "Q1029"],
  ["MM", "Myanmar", "MMR", "BM", "Q836", "burma"],
  ["NA", "Namibia", "NAM", "WA", "Q1030"],
  ["NR", "Naoero", "NRU", "NR", "Q697"],
  ["NP", "Nepal", "NPL", "NP", "Q837"],
  ["NL", "Netherlands", "NLD", "NL", "Q55", "holland dutch"],
  ["AN", "Netherlands Antilles", "ANT", "NT", "Q25227"],
  ["NC", "New Caledonia", "NCL", "NC", "Q33788"],
  ["NZ", "New Zealand", "NZL", "NZ", "Q664"],
  ["NI", "Nicaragua", "NIC", "NU", "Q811"],
  ["NE", "Niger", "NER", "NG", "Q1032"],
  ["NG", "Nigeria", "NGA", "NI", "Q1033"],
  ["NU", "Niue", "NIU", "NE", "Q34020"],
  ["NF", "Norfolk Island", "NFK", "NF", "Q31057"],
  ["KP", "North Korea", "PRK", "KN", "Q423", "korea dprk"],
  ["MK", "North Macedonia", "MKD", "MK", "Q221", "macedonia"],
  ["MP", "Northern Mariana Islands", "MNP", "CQ", "Q16644"],
  ["NO", "Norway", "NOR", "NO", "Q20"],
  ["OM", "Oman", "OMN", "MU", "Q842"],
  ["PK", "Pakistan", "PAK", "PK", "Q843"],
  ["PW", "Palau", "PLW", "PS", "Q695"],
  ["PS", "Palestine", "PSE", "", "Q219060"],
  ["PA", "Panama", "PAN", "PM", "Q804"],
  ["PG", "Papua New Guinea", "PNG", "PP", "Q691"],
  ["PY", "Paraguay", "PRY", "PA", "Q733"],
  ["PE", "Peru", "PER", "PE", "Q419"],
  ["PH", "Philippines", "PHL", "RP", "Q928"],
  ["PN", "Pitcairn Islands", "PCN", "PC", "Q35672"],
  ["PL", "Poland", "POL", "PL", "Q36"],
  ["PT", "Portugal", "PRT", "PO", "Q45"],
  ["PR", "Puerto Rico", "PRI", "RQ", "Q1183"],
  ["QA", "Qatar", "QAT", "QA", "Q846"],
  ["CG", "Republic of the Congo", "COG", "CF", "Q971", "congo brazzaville"],
  ["RO", "Romania", "ROU", "RO", "Q218"],
  ["RU", "Russia", "RUS", "RS", "Q159", "russian federation"],
  ["RW", "Rwanda", "RWA", "RW", "Q1037"],
  ["RE", "Réunion", "REU", "RE", "Q17070"],
  ["BL", "Saint Barthélemy", "BLM", "TB", "Q25362"],
  ["SH", "Saint Helena, Ascension and Tristan da Cunha", "SHN", "SH", "Q192184"],
  ["KN", "Saint Kitts and Nevis", "KNA", "SC", "Q763"],
  ["LC", "Saint Lucia", "LCA", "ST", "Q760"],
  ["PM", "Saint Pierre and Miquelon", "SPM", "SB", "Q34617"],
  ["VC", "Saint Vincent and the Grenadines", "VCT", "VC", "Q757"],
  ["MF", "Saint-Martin", "MAF", "RN", "Q126125"],
  ["WS", "Samoa", "WSM", "WS", "Q683"],
  ["SM", "San Marino", "SMR", "SM", "Q238"],
  ["CQ", "Sark", "CRQ", "", "Q3405693"],
  ["SA", "Saudi Arabia", "SAU", "SA", "Q20394549"],
  ["SN", "Senegal", "SEN", "SG", "Q1041"],
  ["RS", "Serbia", "SRB", "RB", "Q403"],
  ["SC", "Seychelles", "SYC", "SE", "Q1042"],
  ["SL", "Sierra Leone", "SLE", "SL", "Q1044"],
  ["SG", "Singapore", "SGP", "SN", "Q334"],
  ["SX", "Sint Maarten", "SXM", "NN", "Q26273"],
  ["SK", "Slovakia", "SVK", "LO", "Q214"],
  ["SI", "Slovenia", "SVN", "SI", "Q215"],
  ["SB", "Solomon Islands", "SLB", "BP", "Q685"],
  ["SO", "Somalia", "SOM", "SO", "Q1045"],
  ["ZA", "South Africa", "ZAF", "SF", "Q258"],
  ["GS", "South Georgia and the South Sandwich Islands", "SGS", "SX", "Q35086"],
  ["KR", "South Korea", "KOR", "KS", "Q884", "korea"],
  ["SS", "South Sudan", "SSD", "OD", "Q958"],
  ["ES", "Spain", "ESP", "SP", "Q29"],
  ["LK", "Sri Lanka", "LKA", "CE", "Q854"],
  ["SD", "Sudan", "SDN", "SU", "Q1049"],
  ["SR", "Suriname", "SUR", "NS", "Q730"],
  ["SJ", "Svalbard and Jan Mayen", "SJM", "", "Q842829"],
  ["SE", "Sweden", "SWE", "SW", "Q34"],
  ["CH", "Switzerland", "CHE", "SZ", "Q39"],
  ["SY", "Syria", "SYR", "SY", "Q858", "syrian arab republic"],
  ["ST", "São Tomé and Príncipe", "STP", "TP", "Q1039"],
  ["TW", "Taiwan", "TWN", "TW", "Q865"],
  ["TJ", "Tajikistan", "TJK", "TI", "Q863"],
  ["TZ", "Tanzania", "TZA", "TZ", "Q924"],
  ["TH", "Thailand", "THA", "TH", "Q869"],
  ["TL", "Timor-Leste", "TLS", "TT", "Q574", "east timor"],
  ["TG", "Togo", "TGO", "TO", "Q945"],
  ["TK", "Tokelau", "TKL", "TL", "Q36823"],
  ["TO", "Tonga", "TON", "TN", "Q678"],
  ["TT", "Trinidad and Tobago", "TTO", "TD", "Q754"],
  ["TA", "Tristan da Cunha", "", "", "Q34625512"],
  ["PC", "Trust Territory of the Pacific Islands", "PCI", "", "Q129237"],
  ["TN", "Tunisia", "TUN", "TS", "Q948"],
  ["TR", "Turkey", "TUR", "TU", "Q43", "turkiye"],
  ["TM", "Turkmenistan", "TKM", "TX", "Q874"],
  ["TC", "Turks and Caicos Islands", "TCA", "TK", "Q18221"],
  ["TV", "Tuvalu", "TUV", "TV", "Q672"],
  ["UG", "Uganda", "UGA", "UG", "Q1036"],
  ["UA", "Ukraine", "UKR", "UP", "Q212"],
  ["AE", "United Arab Emirates", "ARE", "AE", "Q878", "uae dubai abu dhabi"],
  ["GB", "United Kingdom", "GBR", "UK", "Q145", "uk britain england scotland wales"],
  ["US", "United States", "USA", "US", "Q30", "usa america united states of america"],
  ["UM", "United States Minor Outlying Islands", "UMI", "", "Q16645"],
  ["VI", "United States Virgin Islands", "VIR", "VQ", "Q11703"],
  ["UY", "Uruguay", "URY", "UY", "Q77"],
  ["UZ", "Uzbekistan", "UZB", "UZ", "Q265"],
  ["VU", "Vanuatu", "VUT", "NH", "Q686"],
  ["VA", "Vatican City", "VAT", "VT", "Q237", "holy see"],
  ["VE", "Venezuela", "VEN", "VE", "Q717"],
  ["VN", "Vietnam", "VNM", "VM", "Q881"],
  ["WF", "Wallis and Futuna", "WLF", "WF", "Q35555"],
  ["EH", "Western Sahara", "ESH", "WI", "Q6250"],
  ["YE", "Yemen", "YEM", "YM", "Q805"],
  ["YU", "Yugoslavia", "", "", "Q36704"],
  ["ZM", "Zambia", "ZMB", "ZA", "Q953"],
  ["ZW", "Zimbabwe", "ZWE", "ZI", "Q954"],
  ["AX", "Åland", "ALA", "FI01", "Q5689"],
];
/* ── /COUNTRIES:GENERATED ── */

const COUNTRIES = COUNTRY_ROWS.map(([iso2, name, iso3, fips, wd, alias]) => ({
  iso2, name, iso3: iso3 || '', fips: fips || '', wd: wd || '',
  // One pre-lowered haystack so filtering 250 rows on every keystroke
  // stays a substring test and never builds a string.
  hay: [name, iso2, iso3, fips, alias].filter(Boolean).join(' ').toLowerCase()
}));

const COUNTRY_BY_ISO  = new Map(COUNTRIES.map(c => [c.iso2, c]));
const COUNTRY_BY_WD   = new Map(COUNTRIES.filter(c => c.wd).map(c => [c.wd, c]));
const COUNTRY_BY_FIPS = new Map(COUNTRIES.filter(c => c.fips).map(c => [c.fips, c]));

// GDELT emits a handful of codes that aren't in Wikidata's FIPS property:
// territories filed separately, and two halves of one ISO entry.
const GDELT_EXTRA_CODES = {
  WE: 'PS',   // West Bank
  GZ: 'PS',   // Gaza Strip
  SV: 'SJ',   // Svalbard
  HQ: 'UM'    // Howland Island
  // OS and OC are ocean regions, not countries. Deliberately unmapped.
};

function isoForGdelt(code) {
  const c = COUNTRY_BY_FIPS.get(code);
  if (c) return c.iso2;
  return GDELT_EXTRA_CODES[code] || '';
}

const countryName = iso2 => (COUNTRY_BY_ISO.get(iso2) || {}).name || iso2 || '';

/* ══════════════════════════════════════════════════════════════
   ADAPTER 1 · WIKIDATA  (SPARQL, no key, CORS-enabled)
   confidence: asserted — a human wrote this claim down
   ══════════════════════════════════════════════════════════════ */

const WD_ENDPOINT = 'https://query.wikidata.org/sparql';

const WD_TYPES = {
  newspaper:      { label: 'Newspapers',           q: 'Q11032'   },
  magazine:       { label: 'Magazines',            q: 'Q41298'   },
  tv_station:     { label: 'Television stations',  q: 'Q1616075' },
  radio_station:  { label: 'Radio stations',       q: 'Q14350'   },
  news_agency:    { label: 'News agencies',        q: 'Q192283'  },
  publisher:      { label: 'Publishers',           q: 'Q2085381' },
  university:     { label: 'Universities',         q: 'Q3918'    },
  ngo:            { label: 'NGOs',                 q: 'Q79913'   },
  think_tank:     { label: 'Think tanks',          q: 'Q1046563' },
  gov_agency:     { label: 'Government agencies',  q: 'Q327333'  },
  court:          { label: 'Courts',               q: 'Q41487'   },
  political_party:{ label: 'Political parties',    q: 'Q7278'    },
  trade_union:    { label: 'Trade unions',         q: 'Q178790'  },
  hospital:       { label: 'Hospitals',            q: 'Q16917'   },
  police:         { label: 'Police forces',        q: 'Q101695'  }
};


// A hard client-side timeout so a heavy query can never hang the UI for
// WDQS's full 60s server budget. On abort we surface a clear message
// instead of the browser's misleading "CORS" error (a timed-out WDQS
// response drops its Access-Control-Allow-Origin header).
async function wdSparql(query, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // POST (not GET) so large VALUES lists don't overflow the URL and
    // trip a 431. Form-urlencoded is CORS-safelisted, so no preflight.
    const res = await fetch(WD_ENDPOINT, {
      method: 'POST',
      headers: {
        'Accept': 'application/sparql-results+json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'query=' + encodeURIComponent(query),
      signal: ctrl.signal
    });
    if (!res.ok) {
      if (res.status === 500 || res.status === 502 || res.status === 504)
        throw new Error('Wikidata timed out on that query (' + res.status + '). Try a narrower category, or "Whole country".');
      throw new Error('Wikidata returned ' + res.status);
    }
    const json = await res.json();
    return json.results.bindings;
  } catch (e) {
    if (e.name === 'AbortError')
      throw new Error('Wikidata took too long and was stopped. Try a narrower category or a smaller country.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const qid = uri => uri.split('/').pop();

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Labels for a bounded set of Q-ids. Cheap because VALUES anchors the
// query to an explicit list — the label SERVICE only explodes when run
// over an unbounded transitive result set (which is why query 1 omits it).
async function wdLabels(qids) {
  const labels = new Map();
  const parts = chunk([...new Set(qids)], 400).filter(p => p.length);
  const results = await Promise.all(parts.map(part => {
    const values = part.map(q => 'wd:' + q).join(' ');
    return wdSparql(`
SELECT ?x ?xLabel WHERE {
  VALUES ?x { ${values} }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
}`);
  }));
  for (const rows of results) for (const r of rows) {
    const id = qid(r.x.value);
    if (r.xLabel && r.xLabel.value !== id) labels.set(id, r.xLabel.value);
  }
  return labels;
}

// For a bounded set of place Q-ids, return each place's full chain of
// administrative ancestors (town → county → state → …). We test region
// membership client-side against the department Q-id the user already
// picked, so this query needs NO subclass classification — adding
// `?region wdt:P31/wdt:P279* wd:Q10864048` back in makes it 502 at scale.
// Walking P131* up from a small VALUES set is what keeps it ~1s.
async function wdPlaceAncestors(placeQids) {
  const map = new Map();   // placeQ -> Set(ancestorQ)
  const parts = chunk([...new Set(placeQids)], 500).filter(p => p.length);
  const results = await Promise.all(parts.map(part => {
    const values = part.map(q => 'wd:' + q).join(' ');
    return wdSparql(`
SELECT ?place ?ancestor WHERE {
  VALUES ?place { ${values} }
  ?place wdt:P131* ?ancestor .
}`);
  }));
  for (const rows of results) for (const r of rows) {
    const p = qid(r.place.value), a = qid(r.ancestor.value);
    if (!map.has(p)) map.set(p, new Set());
    map.get(p).add(a);
  }
  return map;
}

// Which countries have subdivisions catalogued used to be a hand-kept
// boolean per country. With the full ISO list in play that is no longer
// maintainable, so we learn it from the answer and remember it: an empty
// region list IS the "no subdivisions" signal.
const _wdRegionCache = new Map();   // iso2 -> [{id,label}]

async function wdRegions(iso2) {
  if (_wdRegionCache.has(iso2)) return _wdRegionCache.get(iso2);
  const c = COUNTRY_BY_ISO.get(iso2);
  if (!c || !c.wd) return [];
  const q = `
SELECT DISTINCT ?r ?rLabel WHERE {
  ?r wdt:P31/wdt:P279* wd:Q10864048 ;
     wdt:P17 wd:${c.wd} .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY ?rLabel
LIMIT 200`;
  const rows = await wdSparql(q);
  const out = rows.map(r => ({
    id: r.r.value.split('/').pop(),
    label: r.rLabel.value
  }));
  _wdRegionCache.set(iso2, out);
  return out;
}

// One grouped count tells us every country Wikidata actually holds this
// kind of source for. Costs 5–20s once, then it's cached for a week —
// far cheaper than the alternative, which was guessing in a literal.
async function wdAvailability(type) {
  const cls = WD_TYPES[type] && WD_TYPES[type].q;
  if (!cls) return null;
  const rows = await wdSparql(`
SELECT ?c (COUNT(DISTINCT ?o) AS ?n) WHERE {
  ?o wdt:P31/wdt:P279* wd:${cls} ;
     wdt:P856 ?site ;
     wdt:P17 ?c .
}
GROUP BY ?c`, 30000);
  const out = new Map();
  for (const r of rows) {
    // P17 also carries historical states (the USSR, the Weimar Republic).
    // They have no ISO code, so they simply don't join — which is correct.
    const c = COUNTRY_BY_WD.get(qid(r.c.value));
    if (c) out.set(c.iso2, (out.get(c.iso2) || 0) + (parseInt(r.n.value, 10) || 0));
  }
  return out;
}

// Region filtering is done in three cheap steps instead of one heavy
// query. The old approach put two unbounded transitive paths
// (P31/P279* AND P131*) plus the label SERVICE in a single query, which
// times out server-side. Instead:
//   1. fetch the whole country (one transitive path, P17 direct) — fast;
//   2. resolve each outlet's town UP to its department via a bounded
//      VALUES query — fast because anchored on a small set;
//   3. label the survivors via another bounded VALUES query.
async function wdFetch({ type, country, region, regionLabel }, onProgress) {
  const cls = WD_TYPES[type].q;
  const c = COUNTRY_BY_ISO.get(country);
  if (!c || !c.wd) throw new Error('Wikidata has no entity for that country.');

  // Query 1 — every outlet of this type in the country. No label SERVICE:
  // running it over the subclass tree is what makes WDQS time out (502).
  onProgress?.(0.1, 'Querying outlets…');
  const rows = await wdSparql(`
SELECT DISTINCT ?item ?site ?place WHERE {
  ?item wdt:P31/wdt:P279* wd:${cls} ;
        wdt:P856 ?site ;
        wdt:P17 wd:${c.wd} .
  OPTIONAL { ?item wdt:P131 ?place . }
  FILTER NOT EXISTS { ?item wdt:P576 ?dissolved . }
}
LIMIT 1500`);

  // Query 2 — when a region is requested, keep only outlets whose town
  // resolves up to that department. Outlets with no P131 can't be placed,
  // so they're honestly dropped from a region-specific result.
  let keep = rows;
  if (region) {
    onProgress?.(0.45, 'Resolving region…');
    const places = rows.filter(r => r.place).map(r => qid(r.place.value));
    const ancestors = await wdPlaceAncestors(places);
    keep = rows.filter(r => {
      if (!r.place) return false;
      const anc = ancestors.get(qid(r.place.value));
      return anc && anc.has(region);
    });
  }

  // Query 3 — labels for the survivors and their towns (bounded → cheap).
  onProgress?.(0.8, 'Fetching labels…');
  const ids = [];
  keep.forEach(r => { ids.push(qid(r.item.value)); if (r.place) ids.push(qid(r.place.value)); });
  const labels = await wdLabels(ids);

  const countryLabel = c.name;
  return keep.map(r => {
    const placeId = r.place ? qid(r.place.value) : '';
    return record({
      domain: r.site.value,
      name: labels.get(qid(r.item.value)) || '',
      type,
      country: countryLabel,
      // Filtering by region → label with the requested department;
      // otherwise show the outlet's own town.
      region: region ? (regionLabel || '') : (placeId ? (labels.get(placeId) || '') : ''),
      source_db: 'wikidata',
      confidence: 'asserted'
    });
  }).filter(Boolean);
}

// Shared with the .gov registry below, which is the only remaining
// adapter that filters by US state.
const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID',
  'IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE',
  'NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN',
  'TX','UT','VT','VA','WA','WV','WI','WY','DC'];
const US_STATE_NAMES = {CA:'California',NY:'New York',TX:'Texas',FL:'Florida',
  IL:'Illinois',PA:'Pennsylvania',OH:'Ohio',GA:'Georgia',NC:'North Carolina',
  MI:'Michigan',NJ:'New Jersey',VA:'Virginia',WA:'Washington',AZ:'Arizona',
  MA:'Massachusetts',TN:'Tennessee',IN:'Indiana',MO:'Missouri',MD:'Maryland',
  WI:'Wisconsin',CO:'Colorado',MN:'Minnesota',SC:'South Carolina',AL:'Alabama',
  LA:'Louisiana',KY:'Kentucky',OR:'Oregon',OK:'Oklahoma',CT:'Connecticut',
  UT:'Utah',IA:'Iowa',NV:'Nevada',AR:'Arkansas',MS:'Mississippi',KS:'Kansas',
  NM:'New Mexico',NE:'Nebraska',WV:'West Virginia',ID:'Idaho',HI:'Hawaii',
  NH:'New Hampshire',ME:'Maine',MT:'Montana',RI:'Rhode Island',DE:'Delaware',
  SD:'South Dakota',ND:'North Dakota',AK:'Alaska',VT:'Vermont',WY:'Wyoming',
  DC:'District of Columbia'};

/* ══════════════════════════════════════════════════════════════
   ADAPTER 2 · GDELT  (bundled lookup, no key)
   confidence: inferred — country guessed from coverage patterns
   NO region granularity. Country only.
   ══════════════════════════════════════════════════════════════ */

const GDELT_URL = './data/gdelt-news-outlets-by-country.csv';
// A 2 KB sidecar of per-country totals, written by build-gdelt.sh, so
// filling a dropdown doesn't mean parsing 3.9 MB of CSV. If it's absent
// (older deploy) we fall back to counting the CSV itself.
const GDELT_COUNTS_URL = './data/gdelt-country-counts.json';

let _gdeltCache = null;

async function gdeltLoad() {
  if (_gdeltCache) return _gdeltCache;

  // This file gets regenerated in place by check-gdelt-sources.py — a
  // plain fetch() lets the browser serve last visit's disk-cached copy
  // indefinitely, silently undoing a prune for anyone who doesn't hard
  // refresh. no-cache forces a revalidation round trip (a cheap 304 if
  // nothing changed) instead of trusting the cache blindly.
  const res = await fetch(GDELT_URL, { cache: 'no-cache' });
  if (!res.ok) {
    throw new Error('The GDELT lookup file could not be loaded (HTTP ' + res.status + ').');
  }

  const rows = parseCsv(await res.text());
  const head = rows[0].map(h => h.trim().toLowerCase());
  const iDom = head.indexOf('domain');
  const iCode = head.indexOf('countrycode');
  const iCnt = head.indexOf('cnt');
  if (iDom === -1 || iCode === -1) {
    throw new Error('That CSV does not have domain and countrycode columns.');
  }

  const top = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[iDom] || !r[iCode]) continue;
    const domain = r[iDom].trim();
    const code = r[iCode].trim().toUpperCase();
    const cnt = parseInt(r[iCnt], 10) || 0;
    const cur = top.get(domain);
    // GDELT's own codes are FIPS 10-4; translate once, here, so the rest
    // of the app only ever sees alpha-2.
    if (!cur || cnt > cur.cnt) top.set(domain, { iso2: isoForGdelt(code), cnt });
  }

  _gdeltCache = top;
  return top;
}

// Exact, free, and offline: the file is already on our own origin.
async function gdeltAvailability() {
  try {
    const res = await fetch(GDELT_COUNTS_URL, { cache: 'no-cache' });
    if (res.ok) {
      const byCode = await res.json();
      const out = new Map();
      for (const [code, n] of Object.entries(byCode)) {
        const iso2 = isoForGdelt(code.toUpperCase());
        if (iso2) out.set(iso2, (out.get(iso2) || 0) + n);
      }
      return out;
    }
  } catch (e) { /* fall through to the CSV */ }

  const top = await gdeltLoad();
  const out = new Map();
  for (const { iso2 } of top.values()) {
    if (iso2) out.set(iso2, (out.get(iso2) || 0) + 1);
  }
  return out;
}

async function gdeltFetch({ country }) {
  const top = await gdeltLoad();
  const out = [];
  const label = countryName(country);

  for (const [domain, { iso2 }] of top) {
    if (iso2 !== country) continue;
    const r = record({
      domain,
      name: domain,
      type: 'news_outlet',
      country: label,
      region: '',
      source_db: 'gdelt',
      confidence: 'inferred'
    });
    if (r) out.push(r);
  }
  out.sort((a, b) => a.domain.localeCompare(b.domain));
  return out;
}

/* ══════════════════════════════════════════════════════════════
   ADAPTER 3 · OFFICIAL REGISTRIES  (static files, no key)
   confidence: authoritative — the registrar itself published this
   ══════════════════════════════════════════════════════════════ */

const DOTGOV_URL = 'https://raw.githubusercontent.com/cisagov/dotgov-data/main/current-full.csv';
const UNIV_URL   = 'https://raw.githubusercontent.com/Hipo/university-domains-list/master/world_universities_and_domains.json';

const REG_TYPES = {
  us_gov:     'US government (.gov)',
  university: 'Universities worldwide'
};

let _dotgovCache = null, _univCache = null;

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function univLoad() {
  if (!_univCache) {
    const res = await fetch(UNIV_URL);
    if (!res.ok) throw new Error('Could not reach the university list');
    _univCache = await res.json();
  }
  return _univCache;
}

// The registry's two types have nothing in common geographically, so
// availability is answered per type: .gov is the United States and only
// the United States, while the university list has to be counted.
async function regAvailability(type) {
  // -1 means "covered, but we're not paying a 20 MB download to count it".
  if (type === 'us_gov') return new Map([['US', -1]]);
  if (type === 'university') {
    const out = new Map();
    for (const u of await univLoad()) {
      const iso2 = (u.alpha_two_code || '').toUpperCase();
      if (COUNTRY_BY_ISO.has(iso2)) {
        out.set(iso2, (out.get(iso2) || 0) + (u.domains || []).length);
      }
    }
    return out;
  }
  return null;
}

async function regFetch({ type, country, region }) {
  if (type === 'us_gov') {
    if (!_dotgovCache) {
      const res = await fetch(DOTGOV_URL);
      if (!res.ok) throw new Error('Could not reach the .gov registry');
      const rows = parseCsv(await res.text());
      const head = rows[0].map(h => h.trim().toLowerCase());
      const iDom = head.indexOf('domain name');
      const iOrg = head.indexOf('organization name');
      const iSt  = head.indexOf('state');
      const iTy  = head.indexOf('domain type');
      _dotgovCache = rows.slice(1)
        .filter(r => r.length > iDom && r[iDom])
        .map(r => ({
          domain: r[iDom], org: r[iOrg] || '', state: (r[iSt] || '').trim(),
          kind: r[iTy] || ''
        }));
    }
    return _dotgovCache
      .filter(r => !region || r.state === region)
      .map(r => record({
        domain: r.domain,
        name: r.org || r.domain,
        type: 'gov_agency',
        country: 'United States',
        region: US_STATE_NAMES[r.state] || r.state,
        source_db: 'registry',
        confidence: 'authoritative'
      }))
      .filter(Boolean);
  }

  if (type === 'university') {
    return (await univLoad())
      .filter(u => !country || u.alpha_two_code === country)
      .filter(u => !region || (u['state-province'] || '') === region)
      .flatMap(u => (u.domains || []).map(d => record({
        domain: d,
        name: u.name,
        type: 'university',
        country: u.country || '',
        region: u['state-province'] || '',
        source_db: 'registry',
        confidence: 'authoritative'
      })))
      .filter(Boolean);
  }
  throw new Error('Unknown registry');
}


/* ══════════════════════════════════════════════════════════════
   ADAPTER 4 · MEDIA CLOUD  (bundled lookup, no key)
   confidence: asserted — country comes from Media Cloud's own
   "<Country> - National" collection membership or its own pub_country
   field, not guessed from coverage the way GDELT's is.
   NO region granularity. Country only.

   Built by scripts living in a separate exploration project
   (mediacloud_explorer/scripts/), not in this repo:
     export_all_sources.py            — every online_news source, globally
     export_national_collections.py   — sources per "<Country> - National"
     build_classified_outlets.py      — drops uncurated noise, tags country
     build_gdelt_shape_iso2.py        — reshapes to domain,countrycode,cnt
                                         with alpha-2 codes and copies here
   Re-run that pipeline and re-copy data/mediacloud-*.{csv,json} to refresh.
   ══════════════════════════════════════════════════════════════ */

const MEDIACLOUD_URL = './data/mediacloud-news-outlets-by-country.csv';
// Sidecar of per-country totals, same idea as GDELT's — fills the country
// picker without parsing the whole CSV first.
const MEDIACLOUD_COUNTS_URL = './data/mediacloud-country-counts.json';

let _mediacloudCache = null;

async function mediacloudLoad() {
  if (_mediacloudCache) return _mediacloudCache;

  const res = await fetch(MEDIACLOUD_URL, { cache: 'no-cache' });
  if (!res.ok) {
    throw new Error('The Media Cloud lookup file could not be loaded (HTTP ' + res.status + ').');
  }

  const rows = parseCsv(await res.text());
  const head = rows[0].map(h => h.trim().toLowerCase());
  const iDom = head.indexOf('domain');
  const iCode = head.indexOf('countrycode');
  const iCnt = head.indexOf('cnt');
  if (iDom === -1 || iCode === -1) {
    throw new Error('That CSV does not have domain and countrycode columns.');
  }

  const top = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[iDom] || !r[iCode]) continue;
    const domain = r[iDom].trim();
    // Already alpha-2 — generated straight into the scheme every adapter
    // shares, unlike GDELT's FIPS codes, so there's no translation step.
    const iso2 = r[iCode].trim().toUpperCase();
    const cnt = parseInt(r[iCnt], 10) || 0;
    const cur = top.get(domain);
    if (!cur || cnt > cur.cnt) top.set(domain, { iso2, cnt });
  }

  _mediacloudCache = top;
  return top;
}

async function mediacloudAvailability() {
  try {
    const res = await fetch(MEDIACLOUD_COUNTS_URL, { cache: 'no-cache' });
    if (res.ok) {
      const byCode = await res.json();
      return new Map(Object.entries(byCode));
    }
  } catch (e) { /* fall through to the CSV */ }

  const top = await mediacloudLoad();
  const out = new Map();
  for (const { iso2 } of top.values()) {
    if (iso2) out.set(iso2, (out.get(iso2) || 0) + 1);
  }
  return out;
}

async function mediacloudFetch({ country }) {
  const top = await mediacloudLoad();
  const out = [];
  const label = countryName(country);

  for (const [domain, { iso2 }] of top) {
    if (iso2 !== country) continue;
    const r = record({
      domain,
      name: domain,
      type: 'news_outlet',
      country: label,
      region: '',
      source_db: 'mediacloud',
      confidence: 'asserted'
    });
    if (r) out.push(r);
  }
  out.sort((a, b) => a.domain.localeCompare(b.domain));
  return out;
}


/* ══════════════════════════════════════════════════════════════
   DATABASE REGISTRY
   ══════════════════════════════════════════════════════════════ */

const DATABASES = {
  wikidata: {
    label: 'Wikidata',
    blurb: 'Volunteer-catalogued. Widest range of source types, and the only one that goes down to province level for most countries.',
    confidence: 'asserted',
    fetch: wdFetch,
    types: Object.fromEntries(Object.entries(WD_TYPES).map(([k, v]) => [k, v.label])),
    // Coverage depends on what kind of source you asked for: Wikidata has
    // newspapers in 190 countries and think tanks in far fewer.
    availability: wdAvailability,
    availabilityPerType: true,
    regions: 'dynamic',
    // Learned, not declared: wdRegions caches its answer per country and an
    // empty list is what "no subdivisions catalogued" looks like.
    regionSupported: c => {
      const known = _wdRegionCache.get(c);
      return known ? known.length > 0 : !!(COUNTRY_BY_ISO.get(c) || {}).wd;
    }
  },
  gdelt: {
    label: 'GDELT',
    blurb: 'Country inferred from what each outlet covers, not from any registration record. Widest net, loosest fit.',
    confidence: 'inferred',
    fetch: gdeltFetch,
    types: { news_outlet: 'News outlets (all kinds)' },
    availability: gdeltAvailability,
    regions: 'none',
    regionSupported: () => false
  },
  mediacloud: {
    label: 'Media Cloud',
    blurb: 'Country comes from Media Cloud’s own national collections and pub_country field — narrower than GDELT, but not inferred from coverage patterns.',
    confidence: 'asserted',
    fetch: mediacloudFetch,
    types: { news_outlet: 'News outlets (all kinds)' },
    availability: mediacloudAvailability,
    regions: 'none',
    regionSupported: () => false
  },
  registry: {
    label: 'Official registries',
    blurb: 'Published by the registrar itself. Nothing inferred, nothing crowdsourced.',
    confidence: 'authoritative',
    fetch: regFetch,
    types: REG_TYPES,
    availability: regAvailability,
    availabilityPerType: true,
    regions: 'by_type',
    regionSupported: (c, t) => t === 'us_gov' || (t === 'university' && c === 'US')
  }
};

const CONF_WORD = {
  asserted:      'asserted',
  inferred:      'inferred',
  authoritative: 'official',
  custom:        'your list'
};

/* ══════════════════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════════════════ */

const state = {
  groups: [],        // { id, label, db, confidence, requestedRegion, gotRegion, items:[] }
  operators: [],     // { token, describe }  (v3 operator model)
  extraSites: [],    // manual one-off domains
  vaultOpen: false,
  batchIndex: 0,
  activeOpId: null,
  regionIntent: '',
  country: ''        // ISO 3166-1 alpha-2, the one language all adapters share
};

let nextId = 1;

const selected = () => state.groups.flatMap(g => g.items.filter(i => i.on));
const allItems = () => state.groups.flatMap(g => g.items);

/* ══════════════════════════════════════════════════════════════
   OPERATORS  (v3 — buttons + panel + chips)
   ══════════════════════════════════════════════════════════════ */

/* after:, before:, phrase, AND and OR live in the question fields of
   step 2, not here — so the buttons below are the operators a search
   only sometimes needs. */
const OP_DEFS = [
  { id:'exclude',  name:'Exclude a word',   label:'−',
    inputType:'text',   defaultVal:'', placeholder:'word to exclude',
    tip:'Exclude pages that contain this word.',
    build: v=>`-${v}`,            describe: v=>`excluding <b>${v}</b>` },
  { id:'intitle',  name:'In the headline',  label:'intitle:',
    inputType:'text',   defaultVal:'', placeholder:'title keyword',
    tip:'Only pages with this word in the page title.',
    build: v=>`intitle:${v}`,     describe: v=>`with <b>${v}</b> in the title` },
  { id:'inurl',    name:'In the address',   label:'inurl:',
    inputType:'text',   defaultVal:'', placeholder:'word in URL',
    tip:'Only pages with this word in the URL.',
    build: v=>`inurl:${v}`,       describe: v=>`with <b>${v}</b> in the URL` },
  { id:'intext',   name:'In the body text', label:'intext:',
    inputType:'text',   defaultVal:'', placeholder:'word in body text',
    tip:'Only pages with this word in the body text.',
    build: v=>`intext:${v}`,      describe: v=>`with <b>${v}</b> in the body` },
  { id:'filetype', name:'File type',        label:'filetype:',
    inputType:'select', defaultOption:'pdf',
    optionGroups: {
      'Documents':          ['pdf', 'doc', 'docx', 'rtf', 'odt', 'epub', 'hwp'],
      'Spreadsheets, data': ['xls', 'xlsx', 'ods', 'csv'],
      'Presentations':      ['ppt', 'pptx', 'odp'],
      'Text and markup':    ['txt', 'xml', 'tex'],
      'Maps and GPS':       ['kml', 'kmz', 'gpx'],
    },
    tip:'Only return files of this type.',
    build: v=>`filetype:${v}`,    describe: v=>`as <b>${v.toUpperCase()}</b> files` },
];

/* ── The question fields of step 2 ──
   AND/OR terms, the exact phrase and the period are the near-universal
   questions, so they are permanent inputs rather than operator buttons.
   They feed the query builders directly through these helpers. */
const QUESTION_FIELD_IDS = ['termsAnd', 'termsOr', 'phrase', 'dateFrom', 'dateUntil'];
let activeMode = 'advanced';

const splitTerms = v => v.split(',').map(t => t.trim()).filter(Boolean);
// A multi-word OR operand has to be quoted, or only its first word binds to the OR.
const orToken = t => /\s/.test(t) ? `"${t.replace(/"/g, '')}"` : t;

function andTerms()  { return splitTerms($('termsAnd').value); }
function orTerms()   { return splitTerms($('termsOr').value); }
function phraseVal() { return $('phrase').value.trim().replace(/^"+|"+$/g, ''); }
function periodVal() { return { after: $('dateFrom').value, before: $('dateUntil').value }; }

function termsText() {
  if (activeMode === 'simple') return $('simpleQuery').value.trim();
  const ands = andTerms(), ors = orTerms();
  const orStr = ors.length > 1
    ? '(' + ors.map(orToken).join(' OR ') + ')'
    : ors.map(orToken).join(' ');
  return [ands.join(' '), orStr].filter(Boolean).join(' ');
}

function phraseToken() {
  const p = phraseVal();
  return p ? `"${p.replace(/"/g, '')}"` : '';
}

function hasCoreTerms() {
  const { after, before } = periodVal();
  return !!(termsText() || phraseVal() || after || before);
}

function clearQuestionFields() {
  QUESTION_FIELD_IDS.forEach(id => { $(id).value = ''; });
}

const sitesZone     = $('sitesZone');
const opChipsEl     = $('opChips');
const previewEl     = $('preview');
const translationEl = $('translation');
const budgetFill    = $('budgetFill');
const budgetLabel   = $('budgetLabel');
const opPanel       = $('opPanel');
const opPanelLabel  = $('opPanelLabel');
const opPanelInput  = $('opPanelInput');
const opPanelSelect = $('opPanelSelect');
const siteCountNote = $('siteCountNote');
const vaultEl       = $('vault');
const vaultBody     = $('vaultBody');
const vaultFilter   = $('vaultFilter');
const vaultOverlay  = $('vaultOverlay');
const btnVault      = $('btnVault');

function initOpButtons() {
  const container = $('opButtons');
  OP_DEFS.forEach(op => {
    const btn = document.createElement('button');
    btn.className = 'op-btn';
    btn.dataset.opId = op.id;
    // Plain language on the button, the Google syntax underneath it.
    btn.appendChild(el('span', 'op-name', op.name));
    btn.appendChild(el('span', 'op-syn', op.label));
    if (op.tip) { btn.dataset.tip = op.tip; btn.setAttribute('aria-label', op.name + ' — ' + op.tip); }
    btn.addEventListener('click', () => toggleOpPanel(op.id));
    container.appendChild(btn);
  });
}

function toggleOpPanel(opId) {
  if (state.activeOpId === opId) { closeOpPanel(); return; }
  const def = OP_DEFS.find(o => o.id === opId);
  if (!def) return;
  state.activeOpId = opId;

  document.querySelectorAll('.op-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.opId === opId)
  );

  opPanelLabel.textContent = def.name;

  if (def.inputType === 'select') {
    // The select is populated from the definition, so the file-type list
    // lives in one place and arrives grouped the way v5 groups it.
    if (def.optionGroups || def.options) {
      const option = o => {
        const opt = el('option', null, String(o));
        opt.value = String(o);
        return opt;
      };
      opPanelSelect.innerHTML = '';
      if (def.optionGroups) {
        for (const [label, items] of Object.entries(def.optionGroups)) {
          const g = document.createElement('optgroup');
          g.label = label;
          items.forEach(o => g.appendChild(option(o)));
          opPanelSelect.appendChild(g);
        }
      } else {
        def.options.forEach(o => opPanelSelect.appendChild(option(o)));
      }
      opPanelSelect.value = def.defaultOption ||
        (def.options ? String(def.options[0]) : opPanelSelect.options[0].value);
    }
    opPanelInput.style.display = 'none';
    opPanelSelect.style.display = '';
  } else {
    opPanelInput.type = def.inputType;
    opPanelInput.value = def.defaultVal || '';
    opPanelInput.placeholder = def.placeholder || '';
    opPanelInput.style.display = '';
    opPanelSelect.style.display = 'none';
    setTimeout(() => opPanelInput.focus(), 40);
  }
  opPanel.classList.add('visible');
}

function closeOpPanel() {
  state.activeOpId = null;
  opPanel.classList.remove('visible');
  document.querySelectorAll('.op-btn').forEach(b => b.classList.remove('active'));
}

function addOperatorFromPanel() {
  if (!state.activeOpId) return;
  const def = OP_DEFS.find(o => o.id === state.activeOpId);
  if (!def) return;
  const val = (def.inputType === 'select' ? opPanelSelect.value : opPanelInput.value.trim());
  if (!val) return;
  state.operators.push({ token: def.build(val), describe: def.describe ? def.describe(val) : null });
  state.batchIndex = 0;
  renderOpChips();
  render();
  closeOpPanel();
}

opPanelInput.addEventListener('keydown', e => { if (e.key === 'Enter') addOperatorFromPanel(); });
$('opAddBtn').addEventListener('click', addOperatorFromPanel);
$('opCancelBtn').addEventListener('click', closeOpPanel);

function renderOpChips() {
  opChipsEl.innerHTML = '';
  state.operators.forEach((op, idx) => {
    const chip = document.createElement('span');
    chip.className = 'op-chip';
    chip.dataset.idx = idx;
    chip.innerHTML = `${escHTML(op.token)}<button class="chip-x" aria-label="Remove">✕</button>`;
    opChipsEl.appendChild(chip);
  });
}

opChipsEl.addEventListener('click', e => {
  const btn = e.target.closest('.chip-x');
  if (!btn) return;
  const chip = btn.closest('.op-chip');
  state.operators.splice(parseInt(chip.dataset.idx, 10), 1);
  state.batchIndex = 0;
  renderOpChips();
  render();
});

/* Examples */
const EXAMPLES = {
  recent: {
    fields: { termsOr: 'deportation, expulsion, removal', dateFrom: '2026-01-01' },
    operators: [],
  },
  pdf: {
    fields: { termsAnd: 'climate, migration report' },
    operators: [
      { token:'filetype:pdf',     describe:'as <b>PDF</b> files' },
      { token:'intitle:report',   describe:'with <b>report</b> in the title' },
    ],
  },
  headline: {
    fields: { termsAnd: 'forced returns', phrase: 'forced returns' },
    operators: [
      { token:'intitle:returns',  describe:'with <b>returns</b> in the title' },
    ],
  },
};

document.querySelectorAll('.example-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const ex = EXAMPLES[btn.dataset.example];
    if (!ex) return;
    clearQuestionFields();
    Object.entries(ex.fields || {}).forEach(([id, v]) => { $(id).value = v; });
    state.operators = ex.operators.slice();
    state.batchIndex = 0;
    renderOpChips();
    render();
  });
});

/* ══════════════════════════════════════════════════════════════
   EXTRA SITES  (Step 3 — manual one-offs)
   ══════════════════════════════════════════════════════════════ */

function addExtraSite(url) {
  const d = toDomain(url);
  if (!d || state.extraSites.includes(d)) return;
  state.extraSites.push(d);
  state.batchIndex = 0;
  render();
}

function removeExtraSite(url) {
  state.extraSites = state.extraSites.filter(s => s !== url);
  state.batchIndex = 0;
  render();
}

function renderSites() {
  sitesZone.innerHTML = '';
  state.extraSites.forEach(url => {
    const chip = document.createElement('div');
    chip.className = 'site-chip';
    chip.innerHTML = `${escHTML(url)}<button class="chip-x" data-url="${escAttr(url)}" aria-label="Remove site">✕</button>`;
    sitesZone.appendChild(chip);
  });

  const n = allSites().length;
  if (n === 0) {
    siteCountNote.textContent = '';
    siteCountNote.className = 'site-count-note';
  } else if (buildBatches().length > 1) {
    siteCountNote.textContent = `${n} sites total — will be split into passes`;
    siteCountNote.className = 'site-count-note warn';
  } else {
    siteCountNote.textContent = `${n} site${n !== 1 ? 's' : ''} total`;
    siteCountNote.className = 'site-count-note';
  }
}

sitesZone.addEventListener('click', e => {
  const btn = e.target.closest('.chip-x[data-url]');
  if (btn) removeExtraSite(btn.dataset.url);
});

$('domainAddBtn').addEventListener('click', addDomainFromInput);
$('domainInput').addEventListener('keydown', e => { if (e.key === 'Enter') addDomainFromInput(); });

function addDomainFromInput() {
  const inp = $('domainInput');
  addExtraSite(inp.value);
  inp.value = '';
}

/* ══════════════════════════════════════════════════════════════
   PICKER  (database → type → country → region)
   ══════════════════════════════════════════════════════════════ */

function fillSelect(sel, obj, placeholder) {
  sel.innerHTML = '';
  if (placeholder) {
    const o = el('option', null, placeholder);
    o.value = '';
    sel.appendChild(o);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === '' && placeholder) continue;
    const o = el('option', null, v);
    o.value = k;
    sel.appendChild(o);
  }
}

function currentDb() { return DATABASES[$('dbPick').value]; }

/* ── coverage discovery ──
   Ask each database which countries it actually holds, instead of
   shipping a guess. Answers are cached in this browser for a week: the
   underlying corpora move on a scale of months, and a first-run cost of
   a few seconds is worth paying once, not on every keystroke.

   A null answer means "unknowable", which is different from "empty"
   and is presented differently. */

const AVAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const _availMem = new Map();     // cacheKey -> Map(iso2 -> count) | null
const _availPending = new Map(); // cacheKey -> Promise, so a fast switch
                                 // back and forth doesn't fire twice

function availKey(dbKey, type) {
  const db = DATABASES[dbKey];
  return 'qf_avail_' + dbKey + (db.availabilityPerType ? '__' + type : '');
}

async function availabilityFor(dbKey, type) {
  const db = DATABASES[dbKey];
  if (!db.availability) return null;

  const key = availKey(dbKey, type);
  if (_availPending.has(key)) return _availPending.get(key);
  const known = cachedAvailability(dbKey, type);
  if (known) return known;

  const p = (async () => {
    try {
      const counts = await db.availability(type);
      if (counts) {
        _availMem.set(key, counts);
        try {
          localStorage.setItem(key, JSON.stringify(
            { at: Date.now(), counts: Object.fromEntries(counts) }));
        } catch (e) { /* quota — memory cache still holds for this session */ }
      }
      return counts;
    } catch (e) {
      // A coverage probe failing must never block a fetch. Fall back to
      // offering everything, unannotated.
      return null;
    } finally {
      _availPending.delete(key);
    }
  })();
  _availPending.set(key, p);
  return p;
}

/* ── country combobox ──
   A 259-entry <select> is unusable, so the country field is a text input
   over a filtered listbox. state.country holds alpha-2 throughout; the
   input's text is only ever a label. */

const countryPicker = {
  get value() { return state.country; },
  set value(iso2) {
    state.country = COUNTRY_BY_ISO.has(iso2) ? iso2 : '';
    const input = $('countryPick');
    input.value = state.country ? countryName(state.country) : '';
    $('countryClear').hidden = !state.country;
  }
};

// Set by renderCountryList so the note and the fetch button can speak
// about coverage without re-querying.
let _countryCounts = null;      // Map(iso2 -> count) | null
let _countryToken = 0;          // guards against a slow probe landing late

function countryCount(iso2) {
  return _countryCounts ? _countryCounts.get(iso2) : undefined;
}

function countLabel(n) {
  if (n === undefined || n === null) return '';
  if (n < 0) return 'covered';
  return n.toLocaleString() + (n === 1 ? ' source' : ' sources');
}

// Typing "ni" should offer Nigeria before it offers U-ni-ted States, so
// where the match landed beats how big the country is.
function matchRank(c, q) {
  if (c.iso2.toLowerCase() === q || c.iso3.toLowerCase() === q) return 0;
  const name = c.name.toLowerCase();
  if (name.startsWith(q)) return 1;
  if (name.split(/[\s-]+/).some(w => w.startsWith(q))) return 2;
  return 3;
}

function renderCountryList(filter) {
  const box = $('countryList');
  const q = (filter || '').trim().toLowerCase();
  const matches = q ? COUNTRIES.filter(c => c.hay.includes(q)) : COUNTRIES.slice();
  if (q) matches.sort((a, b) => matchRank(a, q) - matchRank(b, q));

  // Countries the database actually holds come first, biggest first; the
  // rest stay visible but muted, because "Wikidata has no Togolese think
  // tanks" is a finding, not a reason to hide Togo.
  const have = [], lack = [];
  for (const c of matches) {
    const n = countryCount(c.iso2);
    (n === undefined ? lack : have).push(c);
  }
  if (_countryCounts) {
    // Within a rank band, the database's biggest holdings first.
    have.sort((a, b) => (q ? matchRank(a, q) - matchRank(b, q) : 0)
                     || (countryCount(b.iso2) || 0) - (countryCount(a.iso2) || 0)
                     || a.name.localeCompare(b.name));
  }

  box.innerHTML = '';
  const add = (c, muted) => {
    const li = el('li', 'combo-opt' + (muted ? ' muted' : ''));
    li.setAttribute('role', 'option');
    li.dataset.iso = c.iso2;
    li.setAttribute('aria-selected', String(c.iso2 === state.country));
    li.appendChild(el('span', 'combo-name', c.name));
    const n = countryCount(c.iso2);
    li.appendChild(el('span', 'combo-count',
      muted ? (_countryCounts ? 'none here' : '') : countLabel(n)));
    box.appendChild(li);
  };
  have.forEach(c => add(c, false));
  if (have.length && lack.length) {
    const h = el('li', 'combo-head', 'Not in this database');
    h.setAttribute('role', 'presentation');
    box.appendChild(h);
  }
  lack.forEach(c => add(c, true));

  if (!matches.length) {
    box.appendChild(el('li', 'combo-empty', 'No country matches that.'));
  }
  box.hidden = false;
  $('countryPick').setAttribute('aria-expanded', 'true');
  markActive(box.querySelector('.combo-opt'));
}

function markActive(li) {
  const box = $('countryList');
  box.querySelectorAll('.combo-opt.active').forEach(n => n.classList.remove('active'));
  if (!li) return;
  li.classList.add('active');
  li.scrollIntoView({ block: 'nearest' });
}

function closeCountryList() {
  $('countryList').hidden = true;
  $('countryPick').setAttribute('aria-expanded', 'false');
  // Typing a partial name then clicking away must not leave a phantom
  // filter in the box — snap back to whatever is actually selected.
  $('countryPick').value = state.country ? countryName(state.country) : '';
}

// Load coverage for the current database/type and repaint anything that
// depends on it. Late answers from a database the user has already left
// are discarded rather than applied.
async function refreshAvailability() {
  const dbKey = $('dbPick').value;
  const type = $('typePick').value;
  const token = ++_countryToken;
  const db = DATABASES[dbKey];

  if (!db.availability) { _countryCounts = null; refreshDbNote(); return; }

  // Known already (this session or last week's cache) — paint immediately,
  // no "checking…" flicker.
  const cached = cachedAvailability(dbKey, type);
  if (cached) { _countryCounts = cached; refreshDbNote(); return; }

  _countryCounts = null;
  $('countryHint').textContent = 'Checking which countries this database covers…';
  const counts = await availabilityFor(dbKey, type);
  if (token !== _countryToken) return;
  _countryCounts = counts;
  $('countryHint').textContent = '';
  if (!$('countryList').hidden) renderCountryList($('countryPick').value);
  refreshDbNote();
}

// Whatever coverage we already know for a database, without going to the
// network — memory first, then last week's answer on disk.
function cachedAvailability(dbKey, type) {
  const key = availKey(dbKey, type);
  if (_availMem.has(key)) return _availMem.get(key);
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const { at, counts } = JSON.parse(raw);
      if (Date.now() - at < AVAIL_TTL_MS) {
        const m = new Map(Object.entries(counts));
        _availMem.set(key, m);
        return m;
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

// Which other databases hold the country this one doesn't. Turns a dead
// end into a next step. Only ever suggests on evidence: a database we've
// measured and found holds it, or one that can't be measured at all.
function alternativesFor(iso2) {
  const out = [];
  for (const [k, db] of Object.entries(DATABASES)) {
    if (k === $('dbPick').value) continue;
    if (!db.availability) { out.push(db.label); continue; }
    const cached = cachedAvailability(k, $('typePick').value);
    if (cached && cached.has(iso2)) out.push(db.label);
  }
  return out;
}

function refreshPicker() {
  const db = currentDb();
  const prevType = $('typePick').value;

  fillSelect($('typePick'), db.types);
  if (db.types[prevType]) $('typePick').value = prevType;

  // The country survives the switch: it's the same alpha-2 either way.
  countryPicker.value = state.country;

  refreshAvailability();
  refreshRegions();
  refreshDbNote();
}

async function refreshRegions() {
  const db = currentDb();
  const country = state.country;
  const type = $('typePick').value;
  const field = $('regionField');
  const sel = $('regionPick');

  const supported = country && db.regionSupported(country, type);

  if (!supported) {
    field.style.display = 'none';
    sel.innerHTML = '';
    sel.value = '';
    return;
  }
  field.style.display = '';

  if (db === DATABASES.registry) {
    fillSelect(sel, Object.fromEntries(
      US_STATES.map(s => [s, US_STATE_NAMES[s] || s])
    ), 'Whole country');
    restoreIntent(sel);
    return;
  }
  if (db === DATABASES.wikidata) {
    fillSelect(sel, {}, 'Loading regions…');
    sel.disabled = true;
    try {
      const regions = await wdRegions(country);
      // Nothing catalogued — hide the control entirely rather than offer an
      // empty menu, and let the note explain why results are country-wide.
      if (!regions.length) {
        field.style.display = 'none';
        sel.innerHTML = '';
        sel.disabled = false;
        refreshDbNote();
        return;
      }
      fillSelect(sel, Object.fromEntries(regions.map(r => [r.id, r.label])), 'Whole country');
    } catch (e) {
      fillSelect(sel, {}, 'Whole country (regions unavailable)');
    }
    sel.disabled = false;
    restoreIntent(sel);
    return;
  }
  restoreIntent(sel);
}

function restoreIntent(sel) {
  if (!state.regionIntent) return;
  for (const o of sel.options) {
    if (o.textContent.trim() === state.regionIntent) { sel.value = o.value; return; }
  }
}

function refreshDbNote() {
  const db = currentDb();
  const country = state.country;
  const type = $('typePick').value;
  const note = $('dbNote');

  const bits = [`<strong>${db.label}.</strong> ${db.blurb}`];

  // Coverage first — if the database doesn't hold this country at all,
  // that matters more than anything about regions.
  let uncovered = false;
  if (country) {
    const n = countryCount(country);
    const name = countryName(country);
    uncovered = db.availability && !!_countryCounts && n === undefined;
    if (!db.availability) {
      bits.push(`Coverage for <strong>${name}</strong> is unverified here.`);
    } else if (n === undefined && _countryCounts) {
      const alt = alternativesFor(country);
      bits.push(`<strong>No ${name} sources of this kind here.</strong>` +
        (alt.length ? ` Try ${alt.join(' or ')}.` : ''));
    } else if (n > 0) {
      bits.push(`${n.toLocaleString()} ${name} ${n === 1 ? 'source' : 'sources'} available.`);
    }
  }

  // No point explaining region granularity for a country with nothing in it.
  if (country && !uncovered && !db.regionSupported(country, type)) {
    let why;
    if (db.regions === 'none') {
      why = 'This database has no region field at all, so results come back country-wide.';
    } else {
      why = 'No subdivisions catalogued for this country, so results come back country-wide.';
    }
    if (state.regionIntent) {
      why += ` You asked for <strong>${state.regionIntent}</strong> — that filter will be dropped.`;
    }
    bits.push(why);
  }
  note.innerHTML = bits.join(' ');
}

/* ══════════════════════════════════════════════════════════════
   IMPORT
   ══════════════════════════════════════════════════════════════ */

function addGroup({ label, db, confidence, items, requestedRegion, gotRegion }) {
  const known = new Set(allItems().map(i => i.domain));
  const fresh = [];
  for (const r of items) {
    if (known.has(r.domain)) continue;
    known.add(r.domain);
    fresh.push({ ...r, on: true, uid: nextId++ });
  }
  state.groups.push({
    id: nextId++, label, db, confidence, items: fresh,
    requestedRegion: requestedRegion || '',
    gotRegion: gotRegion !== false
  });
  const dupes = items.length - fresh.length;
  state.batchIndex = 0;
  openVault(true);
  render();
  return { added: fresh.length, dupes };
}

function setDbProgress(fraction, label) {
  const track = $('dbProgressTrack');
  const fill = $('dbProgressFill');
  track.hidden = false;
  if (fraction == null) {
    track.classList.add('indeterminate');
  } else {
    track.classList.remove('indeterminate');
    fill.style.width = Math.max(0, Math.min(1, fraction)) * 100 + '%';
  }
  if (label) $('dbStatus').textContent = label;
}

function hideDbProgress() {
  $('dbProgressTrack').hidden = true;
  $('dbProgressTrack').classList.remove('indeterminate');
  $('dbProgressFill').style.width = '0%';
}

function corsHint(dbKey, message) {
  if (!/Failed to fetch|NetworkError|Load failed/i.test(message)) return '';
  if (dbKey === 'gdelt') {
    return ' — this looks like a block on loading the local CSV. That resolves once the app is served over http(s) rather than opened as a file:// page, and once data/gdelt-news-outlets-by-country.csv actually exists at that path.';
  }
  if (dbKey === 'mediacloud') {
    return ' — this looks like a block on loading the local CSV. That resolves once the app is served over http(s) rather than opened as a file:// page, and once data/mediacloud-news-outlets-by-country.csv actually exists at that path.';
  }
  return ' — this looks like a network problem reaching the database, not a CORS block. Check your connection and try again.';
}

async function runDbFetch() {
  const db = currentDb();
  const dbKey = $('dbPick').value;
  const type = $('typePick').value;
  const country = state.country;
  const regionRaw = $('regionPick').value;

  $('dbErr').hidden = true;

  // The .gov registry is the United States by definition, so it's the one
  // fetch that needs no country.
  if (!country && !(dbKey === 'registry' && type === 'us_gov')) {
    $('dbErr').textContent = 'Choose a country first.';
    $('dbErr').hidden = false;
    $('countryPick').focus();
    return;
  }

  const supported = country && db.regionSupported(country, type);
  const region = supported ? regionRaw : '';

  const wanted = supported
    ? (($('regionPick').selectedOptions[0] || {}).textContent || '').trim()
    : state.regionIntent;
  const honoured = !(wanted && !region);

  $('dbFetch').disabled = true;
  setDbProgress(null, 'Fetching…');

  try {
    const items = await db.fetch(
      { type, country, region, regionLabel: wanted },
      (fraction, label) => setDbProgress(fraction, label)
    );
    const typeLabel = db.types[type] || type;
    const countryLabel = countryName(country);
    const regionLabel = region ? wanted : '';
    const label = [typeLabel, regionLabel || countryLabel].filter(Boolean).join(' · ');

    const { added, dupes } = addGroup({
      label, db: dbKey, confidence: db.confidence, items,
      requestedRegion: wanted,
      gotRegion: honoured
    });

    $('dbStatus').textContent =
      added + ' added' + (dupes ? `, ${dupes} already in vault` : '');
    announce(`${added} sources added from ${db.label}`);
  } catch (e) {
    $('dbErr').innerHTML = e.message + corsHint(dbKey, e.message);
    $('dbErr').hidden = false;
    $('dbStatus').textContent = '';
  } finally {
    $('dbFetch').disabled = false;
    hideDbProgress();
  }
}

// Thrown when the header has no column csvTextToSources recognizes as a
// domain — the caller opens the column-mapping modal instead of failing.
class CsvMappingNeeded extends Error {
  constructor(rows) { super('column mapping needed'); this.rows = rows; }
}

function csvRowsToSources(rows, iDom, iNam) {
  const items = rows.slice(1)
    .map(r => record({
      domain: r[iDom],
      name: iNam > -1 ? r[iNam] : '',
      type: 'source',
      source_db: 'custom',
      confidence: 'custom'
    }))
    .filter(Boolean);

  if (!items.length) throw new Error('No readable domains in that file.');
  return items;
}

// Shared by the URL door and the paste door: one domain column is required,
// name becomes the label when the file has one, everything else is ignored.
function csvTextToSources(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('That file has no rows.');

  const head = rows[0].map(h => h.trim().toLowerCase());
  const iDom = head.findIndex(h => ['domain', 'url', 'site', 'website', 'source_url'].includes(h));
  if (iDom === -1) throw new CsvMappingNeeded(rows);

  const iNam = head.findIndex(h => ['name', 'title', 'outlet', 'label', 'classification'].includes(h));
  return csvRowsToSources(rows, iDom, iNam);
}

let pendingCsvMapping = null;

function openCsvMapping(rows, onConfirm) {
  const head = rows[0];
  const fillSelect = (sel, withNone) => {
    sel.textContent = '';
    if (withNone) sel.appendChild(new Option('— none —', '-1'));
    head.forEach((h, i) => sel.appendChild(new Option(h.trim() || `(column ${i + 1})`, String(i))));
  };
  fillSelect($('mapDomain'), false);
  fillSelect($('mapName'), true);
  $('mapIntro').textContent =
    `This file's columns are: ${head.map(h => h.trim() || '(blank)').join(', ')}. ` +
    `None of them are named domain, url or site — pick which one holds it.`;
  $('mapErr').hidden = true;
  pendingCsvMapping = { rows, onConfirm };
  $('mapBackdrop').classList.add('visible');
  $('mapDomain').focus();
}

function closeCsvMapping() {
  $('mapBackdrop').classList.remove('visible');
  pendingCsvMapping = null;
}

async function runCsvLoad() {
  const url = $('csvUrl').value.trim();
  $('csvErr').hidden = true;
  if (!url) return;

  $('csvLoad').disabled = true;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('That URL returned ' + res.status);
    const text = await res.text();
    try {
      finishCsvLoad(csvTextToSources(text));
    } catch (e) {
      if (!(e instanceof CsvMappingNeeded)) throw e;
      openCsvMapping(e.rows, finishCsvLoad);
    }
  } catch (e) {
    $('csvErr').textContent = e.message + (
      /Failed to fetch|CORS/i.test(e.message)
        ? ' — make sure the sheet is published to the web as CSV.'
        : ''
    );
    $('csvErr').hidden = false;
  } finally {
    $('csvLoad').disabled = false;
  }
}

function finishCsvLoad(items) {
  const { added } = addGroup({
    label: 'Your list', db: 'custom', confidence: 'custom', items
  });
  announce(added + ' sources loaded from your list');
  $('csvUrl').value = '';
}

function runPasteImport() {
  const text = $('csvPaste').value;
  $('pasteErr').hidden = true;
  $('pasteStatus').textContent = '';
  if (!text.trim()) return;

  try {
    finishPasteImport(csvTextToSources(text));
  } catch (e) {
    if (!(e instanceof CsvMappingNeeded)) {
      $('pasteErr').textContent = e.message;
      $('pasteErr').hidden = false;
      return;
    }
    openCsvMapping(e.rows, finishPasteImport);
  }
}

function finishPasteImport(items) {
  const { added, dupes } = addGroup({
    label: 'Your list', db: 'custom', confidence: 'custom', items
  });
  $('pasteStatus').textContent =
    added + ' added' + (dupes ? `, ${dupes} skipped as duplicates` : '');
  announce(added + ' sources imported from your pasted list');
  $('csvPaste').value = '';
}

/* ══════════════════════════════════════════════════════════════
   COVERAGE NOTICE
   ══════════════════════════════════════════════════════════════ */

function coverageNotice() {
  const box = $('coverage');
  const groups = state.groups.filter(g => g.items.length || g.requestedRegion);

  if (!groups.length) { box.hidden = true; return; }

  const lines = [];
  const byConf = {};
  for (const g of groups) {
    byConf[g.confidence] = (byConf[g.confidence] || 0) + g.items.filter(i => i.on).length;
  }
  const confs = Object.keys(byConf).filter(c => byConf[c] > 0);

  if (confs.length > 1) {
    const parts = confs.map(c => `${byConf[c]} ${CONF_WORD[c]}`).join(', ');
    lines.push(`<strong>Mixed sources.</strong> ${parts}. They are not equally reliable, and the vault marks each one.`);
  }

  if (byConf.inferred) {
    lines.push(`<strong>${byConf.inferred} inferred.</strong> These are guessed rather than asserted, so misfiled entries can turn up. Check anything surprising.`);
  }

  const dropped = groups.filter(g => g.requestedRegion && !g.gotRegion);
  if (dropped.length) {
    const said = dropped.map(g =>
      `${DATABASES[g.db].label} could not narrow to ${g.requestedRegion}`
    ).join('; ');
    lines.push(`<strong>Region dropped.</strong> ${said}. Those results are country-wide, so they include far more than you asked for.`);
  }

  const thin = groups.filter(g => g.db !== 'custom' && g.items.length > 0 && g.items.length < 8);
  if (thin.length) {
    lines.push(`<strong>Thin result.</strong> ${thin.map(g => `${g.label} returned ${g.items.length}`).join('; ')}. That is a fact about the database, not about the place. Try another database before concluding the sources do not exist.`);
  }

  const empty = groups.filter(g => g.items.length === 0);
  if (empty.length) {
    lines.push(`<strong>Nothing found.</strong> ${empty.map(g => g.label).join('; ')}. The category may not be catalogued here at all.`);
  }

  if (!lines.length) {
    const only = confs[0];
    // 'asserted' now covers two different catalogues (Wikidata, Media
    // Cloud) with different coverage biases, so the note has to name
    // which one actually filled the vault instead of assuming Wikidata.
    const dbs = new Set(groups.map(g => g.db));
    if (only === 'authoritative') {
      lines.push(`<strong>Official registry.</strong> Complete as published, though a registered domain does not always host a live site.`);
    } else if (only === 'asserted' && dbs.size === 1 && dbs.has('wikidata')) {
      lines.push(`<strong>Catalogued by volunteers.</strong> Good for North America and Western Europe. Expect real gaps in local media elsewhere.`);
    } else if (only === 'asserted' && dbs.size === 1 && dbs.has('mediacloud')) {
      lines.push(`<strong>Catalogued by Media Cloud.</strong> Country comes from their own national collections and registry metadata, not guessed from coverage — but only as complete as their catalogue is.`);
    } else if (only === 'asserted') {
      lines.push(`<strong>Asserted sources.</strong> A cataloguing process assigned these countries directly rather than guessing from coverage.`);
    } else {
      lines.push(`<strong>Your own list.</strong> Coverage is whatever you put in it.`);
    }
  }

  box.className = (byConf.inferred || dropped.length || empty.length) ? 'notice warn' : 'notice';
  box.innerHTML = lines.join('<br><br>');
  box.hidden = false;
}

/* ══════════════════════════════════════════════════════════════
   VAULT
   ══════════════════════════════════════════════════════════════ */

function openVault(open) {
  state.vaultOpen = open;
  vaultEl.classList.toggle('open', open);
  vaultOverlay.classList.toggle('visible', open);
  btnVault.setAttribute('aria-expanded', String(open));
  btnVault.textContent = open ? '✕ Close Vault' : '▶ Open Vault';
}

function toggleVault() { openVault(!state.vaultOpen); }

function renderVault() {
  const v = vaultBody;
  v.innerHTML = '';

  if (!state.groups.length) {
    v.innerHTML = '<div class="vault-status">Nothing loaded yet.<br>Use a database or your own list on the left to fill the Vault.</div>';
    return;
  }

  const q = vaultFilter.value.trim().toLowerCase();
  const match = it =>
    !q ||
    it.domain.toLowerCase().includes(q) ||
    (it.name && it.name.toLowerCase().includes(q));

  let anyShown = false;

  for (const g of state.groups) {
    const visible = g.items.filter(match);
    const groupMatchesLabel = q && g.label.toLowerCase().includes(q);
    const shown = groupMatchesLabel ? g.items : visible;
    if (q && !shown.length && !groupMatchesLabel) continue;
    anyShown = true;

    const wrap = el('div', 'vgroup');
    const head = el('div', 'vgroup-head');

    const all = el('input');
    all.type = 'checkbox';
    all.checked = g.items.length > 0 && g.items.every(i => i.on);
    all.indeterminate = g.items.some(i => i.on) && !all.checked;
    all.setAttribute('aria-label', 'Select all in ' + g.label);
    all.onchange = () => { g.items.forEach(i => i.on = all.checked); state.batchIndex = 0; render(); };
    head.appendChild(all);

    head.appendChild(el('span', 'vgroup-name', `${g.label} — ${g.items.filter(i => i.on).length}/${g.items.length}`));
    head.appendChild(el('span', 'tag ' + g.confidence, CONF_WORD[g.confidence]));

    const rm = el('button', 'vgroup-remove', '✕');
    rm.setAttribute('aria-label', 'Remove ' + g.label);
    rm.onclick = () => { state.groups = state.groups.filter(x => x.id !== g.id); state.batchIndex = 0; render(); };
    head.appendChild(rm);

    wrap.appendChild(head);

    for (const it of shown) {
      const row = el('div', 'vitem' + (it.on ? '' : ' off'));
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = it.on;
      cb.setAttribute('aria-label', it.domain);
      cb.onchange = () => { it.on = cb.checked; state.batchIndex = 0; render(); };
      row.appendChild(cb);
      row.appendChild(domLink(it.domain));
      if (it.name && it.name !== it.domain) row.appendChild(el('span', 'nm', it.name));
      wrap.appendChild(row);
    }

    v.appendChild(wrap);
  }

  if (!anyShown) {
    v.innerHTML = '<div class="vault-status">No sources match that filter.</div>';
  }
}

vaultFilter.addEventListener('input', renderVault);

$('vaultAll').onclick = () => { allItems().forEach(i => i.on = true); state.batchIndex = 0; render(); };
$('vaultNone').onclick = () => { allItems().forEach(i => i.on = false); state.batchIndex = 0; render(); };

$('vaultClear').onclick = () => {
  state.groups = [];
  state.batchIndex = 0;
  render();
  announce('Vault emptied');
};

btnVault.addEventListener('click', toggleVault);
$('vaultCloseBtn').addEventListener('click', () => openVault(false));
vaultOverlay.addEventListener('click', () => openVault(false));

/* ══════════════════════════════════════════════════════════════
   QUERY BUILDING + BATCHING
   ══════════════════════════════════════════════════════════════ */

function baseQuery() {
  const { after, before } = periodVal();
  return [
    termsText(),
    phraseToken(),
    state.operators.map(o => o.token).join(' '),
    after ? 'after:' + after : '',
    before ? 'before:' + before : ''
  ].filter(Boolean).join(' ').trim();
}

function allSites() {
  const s = new Set();
  selected().forEach(i => s.add(i.domain));
  state.extraSites.forEach(d => s.add(d));
  return [...s];
}

/* How many of Google's 32 words a query uses (see GOOGLE_WORD_LIMIT).
   Splitting on parentheses makes AROUND(5) two tokens, matching Google. */
function googleWords(query) {
  return (query.match(/[^\s()"]+/g) || []).reduce((n, t) => n + (
    t === 'OR' || /^(after|before):/i.test(t) ? 0
    : /^(inurl|intext):/i.test(t) ? 2
    : /^[a-z]+:/i.test(t) ? 1
    // "open-pit" counts as two: too many costs a pass, too few drops a site
    : Math.max(1, (t.match(/[\p{L}\p{N}]+/gu) || []).length)
  ), 0);
}

function buildBatches(base) {
  if (base === undefined) base = baseQuery();
  const sites = allSites();

  if (!sites.length) return [{ text: base, sites: [] }];

  // As many sites per pass as fit in Google's 32 words. A base that fills
  // them on its own still gets one site per pass, and render() flags it.
  const perPass = Math.max(1, GOOGLE_WORD_LIMIT - googleWords(base));
  const budget = MAX_QUERY_CHARS - base.length - 4;
  const batches = [];
  let chunk = [];
  const clauseLen = d => d.length + 9;   // "site:" + " OR "

  for (const d of sites) {
    const wouldBe = chunk.reduce((n, x) => n + clauseLen(x), 0) + clauseLen(d);
    if (chunk.length >= perPass || (chunk.length && wouldBe > budget)) {
      batches.push(chunk);
      chunk = [];
    }
    chunk.push(d);
  }
  if (chunk.length) batches.push(chunk);

  return batches.map(c => ({
    text: (base + ' (' + c.map(d => 'site:' + d).join(' OR ') + ')').trim(),
    sites: c
  }));
}

/* ── Syntax highlighting (v3) ── */
function syntaxHighlight(q) {
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const tokens = [];
  let i = 0;
  while (i < q.length) {
    if (q[i] === ' ') { tokens.push({t:'ws'}); i++; }
    else if (q[i] === '"') {
      let j = i+1;
      while (j < q.length && q[j] !== '"') j++;
      tokens.push({t:'quoted', v:q.slice(i, j+1)});
      i = j+1;
    } else if (q[i] === '(' || q[i] === ')') {
      tokens.push({t:'paren', v:q[i]}); i++;
    } else {
      let j = i;
      while (j < q.length && q[j] !== ' ' && q[j] !== '(' && q[j] !== ')') j++;
      tokens.push({t:'word', v:q.slice(i,j)});
      i = j;
    }
  }
  return tokens.map(tk => {
    if (tk.t === 'ws') return ' ';
    if (tk.t === 'paren') return `<span class="hl-paren">${esc(tk.v)}</span>`;
    if (tk.t === 'quoted') return `<span class="hl-op">${esc(tk.v)}</span>`;
    if (tk.v === 'OR' || tk.v === 'AND') return `<span class="hl-kw">${tk.v}</span>`;
    if (tk.v.startsWith('site:')) return `<span class="hl-site">${esc(tk.v)}</span>`;
    if (/^(after:|before:|intitle:|inurl:|intext:|filetype:)/.test(tk.v)) return `<span class="hl-op">${esc(tk.v)}</span>`;
    if (tk.v.startsWith('-')) return `<span class="hl-op">${esc(tk.v)}</span>`;
    return esc(tk.v);
  }).join('');
}

/* ── Plain-English translation (v3, batch-aware) ── */
function translateQuery(batch, total) {
  const ands  = andTerms();
  const ors   = orTerms();
  const phrase = phraseVal();
  const { after, before } = periodVal();
  const ops    = state.operators;
  const nSites = allSites().length;
  if (!ands.length && !ors.length && !phrase && !after && !before && !ops.length && !nSites) return '';

  const pieces = [];
  const b = t => `<b>${escHTML(t)}</b>`;
  const list = arr => arr.map(b).join(', ');

  if (ands.length && ors.length) {
    pieces.push(`pages mentioning ${ands.length === 1 ? b(ands[0]) : 'all of ' + list(ands)}`);
    pieces.push(`and any of ${ors.map(b).join(' or ')}`);
  } else if (ands.length) {
    pieces.push(ands.length === 1
      ? `pages mentioning ${b(ands[0])}`
      : `pages mentioning all of ${list(ands)}`);
  } else if (ors.length) {
    pieces.push(ors.length === 1
      ? `pages mentioning ${b(ors[0])}`
      : `pages mentioning any of ${ors.map(b).join(' or ')}`);
  } else {
    pieces.push('pages');
  }

  if (phrase) pieces.push(`with the exact phrase <b>"${escHTML(phrase)}"</b>`);
  if (after && before)      pieces.push(`published between <b>${after}</b> and <b>${before}</b>`);
  else if (after)           pieces.push(`published after <b>${after}</b>`);
  else if (before)          pieces.push(`published before <b>${before}</b>`);

  ops.forEach(op => { if (op.describe) pieces.push(op.describe); });

  if (!batch.sites.length) {
    if (nSites === 0) { /* whole web — say nothing extra */ }
  } else if (total > 1) {
    pieces.push(`across <b>${batch.sites.length}</b> of your <b>${nSites}</b> sites — this is pass ${state.batchIndex + 1} of a ${total}-part sweep`);
  } else if (batch.sites.length === 1) {
    pieces.push(`on <b>${escHTML(batch.sites[0])}</b>`);
  } else if (batch.sites.length <= 4) {
    const urls = batch.sites.map(s => `<b>${escHTML(s)}</b>`);
    pieces.push(`on ${urls.slice(0,-1).join(', ')} or ${urls[urls.length-1]}`);
  } else {
    pieces.push(`on any of your <b>${batch.sites.length} selected sites</b>`);
  }

  return 'Find ' + pieces.join(', ') + '.';
}

/* ══════════════════════════════════════════════════════════════
   RENDER
   ══════════════════════════════════════════════════════════════ */

/* ── Step status cues ──
   A configured step dims and its label carries a one-line summary of
   what was entered. The number keeps its place — steps stay countable,
   and completion is said by the summary, not by replacing the number.
   Everything routes through render(), so this one call keeps every
   step current. */
function setStep(id, num, done, summary) {
  const sec = $(id);
  if (!sec) return;
  sec.classList.toggle('step-done', done);
  const chip = sec.querySelector('.step-num');
  if (chip) chip.textContent = num;
  const status = sec.querySelector('.step-status');
  if (status) {
    status.hidden = !done;
    status.textContent = done ? summary : '';
  }
}

function updateStepStates() {
  const more = (arr, first) => first + (arr.length > 1 ? ` +${arr.length - 1} more` : '');

  const nSel = selected().length;
  setStep('step0', '1', nSel > 0, `${nSel} source${nSel !== 1 ? 's' : ''} selected`);

  const { after, before } = periodVal();
  // With operators folded into step 2, its collapsed summary stands in for
  // both: terms first, then the phrase, the period, or the first filter.
  const ops = state.operators;
  const summary = termsText()
    || (phraseVal() ? `"${phraseVal()}"` : '')
    || (after || before ? `${after || '…'} → ${before || '…'}` : '')
    || (ops.length ? more(ops, ops[0].token) : '');
  setStep('step1', '2', hasCoreTerms() || ops.length > 0,
    summary.length > 40 ? summary.slice(0, 40) + '…' : summary);

  const sites = state.extraSites;
  setStep('step3', '3', sites.length > 0, sites.length ? more(sites, sites[0]) : '');
}

function render() {
  renderVault();
  coverageNotice();
  renderSites();

  const batches = buildBatches();
  if (state.batchIndex >= batches.length) state.batchIndex = 0;
  const cur = batches[state.batchIndex];

  // Vault counts
  const sel = selected().length;
  const tot = allItems().length;
  $('vaultCount').textContent = `${tot} ${tot === 1 ? 'source' : 'sources'} · ${sel} selected`;
  $('vaultToolCount').textContent = `${sel}/${tot}`;

  // Query preview
  if (!cur.text) {
    previewEl.innerHTML = '<span class="preview-empty">Type a word above — your query builds itself here.</span>';
  } else {
    previewEl.innerHTML = syntaxHighlight(cur.text);
  }

  const tr = translateQuery(cur, batches.length);
  if (!tr) {
    translationEl.classList.add('empty');
    translationEl.innerHTML = 'In plain English, your search will appear here.';
  } else {
    translationEl.classList.remove('empty');
    translationEl.innerHTML = tr;
  }

  // Budget bar (current batch): Google's word limit, the one that drops terms.
  // A pass filled with sites sits at 32/32 by design, so only a query without
  // sites turns amber as it nears the limit.
  const words = googleWords(cur.text);
  const pct = Math.min(100, Math.round((words / GOOGLE_WORD_LIMIT) * 100));
  budgetFill.style.width = pct + '%';
  budgetFill.classList.remove('amber', 'red');
  if (words > GOOGLE_WORD_LIMIT) budgetFill.classList.add('red');
  else if (!cur.sites.length && words > GOOGLE_WORD_LIMIT * 0.85) budgetFill.classList.add('amber');
  const nSites = allSites().length;
  budgetLabel.textContent = `${words}/${GOOGLE_WORD_LIMIT} words · ${nSites} site${nSites !== 1 ? 's' : ''}`;

  // Length / sweep warning
  const w = $('lenWarn');
  if (words > GOOGLE_WORD_LIMIT) {
    w.innerHTML =
      `<strong>Too long for Google.</strong> This query uses ${words} of Google's ${GOOGLE_WORD_LIMIT} words, ` +
      `and Google ignores everything past that${cur.sites.length ? ', including sites' : ''}. ` +
      `Remove some terms or operators.`;
    w.hidden = false;
  } else if (batches.length > 1) {
    w.innerHTML =
      `<strong>Too many sites for one query.</strong> Google reads only ${GOOGLE_WORD_LIMIT} words, so with ` +
      `these terms one query holds ${batches[0].sites.length} sites and your ${nSites} are split into ${batches.length} passes. ` +
      `Run each one and combine the results — that is a systematic sweep, not a workaround.`;
    w.hidden = false;
  } else {
    w.hidden = true;
  }
  $('searchNote').textContent = needsNoVerbatim(cur.text)
    ? 'opens Web tab without Verbatim (Verbatim breaks inurl: and intext:)'
    : 'opens Web tab in Verbatim mode';

  // Batch nav
  const nav = $('batchNav');
  if (batches.length > 1) {
    nav.hidden = false;
    $('bLabel').textContent = `pass ${state.batchIndex + 1} / ${batches.length}`;
    $('bPrev').disabled = state.batchIndex === 0;
    $('bNext').disabled = state.batchIndex === batches.length - 1;
  } else {
    nav.hidden = true;
  }

  updateStepStates();
}

function announce(msg) { $('live').textContent = msg; }

/* ══════════════════════════════════════════════════════════════
   UTILITIES
   ══════════════════════════════════════════════════════════════ */

function escHTML(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) {
  return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ══════════════════════════════════════════════════════════════
   LOCAL SEARCH LEDGER
   IndexedDB keeps query records on this origin. Each entry carries
   the SHA-256 hash of its canonical contents and the previous entry,
   making accidental edits, gaps, and reordering detectable.
   ══════════════════════════════════════════════════════════════ */

const LEDGER_DB = 'query-forge-search-ledger';
const LEDGER_DB_VERSION = 1;
const LEDGER_SCHEMA = 1;
const LEDGER_APP_VERSION = '4';

let ledgerDbPromise;
let ledgerEntries = [];
let ledgerAvailable = true;
let ledgerQueue = Promise.resolve();
let persistenceRequested = false;
let projects = [{ id: 'general', name: 'General', archived: false }];
let activeProjectId = 'general';
let ledgerProjectId = 'general';

function projectName(id) { return projects.find(p => p.id === id)?.name || 'General'; }
function projectAssignments() {
  const assignments = new Map(ledgerEntries.map(e => [e.id, e.projectId || 'general']));
  for (const e of ledgerEntries) {
    if (e.event === 'project_move' && e.details?.targetId) assignments.set(e.details.targetId, e.details.toProjectId);
  }
  // Notes follow the query they annotate, including after a later project move.
  for (const e of ledgerEntries) {
    if (e.details?.targetId && ['annotation', 'project_move'].includes(e.event))
      assignments.set(e.id, assignments.get(e.details.targetId) || e.projectId || 'general');
  }
  return assignments;
}
function visibleLedgerEntries(scope = ledgerProjectId) {
  if (scope === 'all') return ledgerEntries;
  const assignments = projectAssignments();
  return ledgerEntries.filter(e => assignments.get(e.id) === scope);
}
function renderProjectControls() {
  for (const id of ['startProject', 'activeProject']) {
    const select = $(id);
    select.replaceChildren();
    projects.filter(p => !p.archived).forEach(p => select.add(new Option(p.name, p.id)));
    select.add(new Option('＋ New project', '__new'));
    select.add(new Option('Manage projects…', '__manage'));
    select.value = activeProjectId;
    select.disabled = !ledgerAvailable;
  }
  const view = $('ledgerProject');
  view.replaceChildren(new Option('All projects', 'all'));
  projects.forEach(p => view.add(new Option(p.name + (p.archived ? ' (archived)' : ''), p.id)));
  view.value = ledgerProjectId;
}
async function loadProjects() {
  const saved = await ledgerGetPref('projects');
  projects = Array.isArray(saved) ? saved : [{ id: 'general', name: 'General', archived: false }];
  if (!projects.some(p => p.id === 'general')) projects.unshift({ id: 'general', name: 'General', archived: false });
}
function projectAction(work) {
  return queueLedger(async () => {
    await ledgerReady;
    await withLedgerWriteLock(async () => {
      await loadProjects();
      ledgerEntries = await ledgerGetAll();
      await work();
      await ledgerSetPref('projects', projects);
    });
    if (!projects.some(p => p.id === activeProjectId && !p.archived)) {
      activeProjectId = 'general';
      await ledgerSetPref('activeProject', activeProjectId);
    }
    if (ledgerProjectId !== 'all' && !projects.some(p => p.id === ledgerProjectId)) ledgerProjectId = activeProjectId;
    renderProjectControls(); renderLedger(); renderProjectList();
    return true;
  }).catch(error => { $('projectMessage').textContent = error.message || 'The project could not be saved. Try again.'; return false; });
}
function openProjects(create = false) {
  $('projectMessage').textContent = '';
  renderProjectList();
  $('projectDialog').showModal();
  (create ? $('projectName') : $('projectClose')).focus();
}
function renderProjectList() {
  const list = $('projectList'); list.replaceChildren();
  projects.forEach(project => {
    const row = el('div', 'project-row');
    const count = visibleLedgerEntries(project.id).filter(e => ['saved', 'performed'].includes(e.event)).length;
    row.append(el('div', 'project-row-title', `${project.name}${project.archived ? ' (archived)' : ''} · ${count} search${count === 1 ? '' : 'es'}`));
    if (project.id !== 'general') {
      const actions = el('div', 'project-row-actions');
      const rename = el('button', 'ledger-tool-btn', 'Rename');
      rename.onclick = () => {
        actions.replaceChildren();
        const input = el('input', 'project-input'); input.value = project.name; input.maxLength = 80; input.setAttribute('aria-label', 'Project name');
        const save = el('button', 'ledger-tool-btn', 'Save name');
        save.onclick = () => void projectAction(() => {
          const name = validProjectName(input.value, project.id);
          projects.find(p => p.id === project.id).name = name;
        });
        input.onkeydown = e => { if (e.key === 'Enter') save.click(); if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); renderProjectList(); } };
        const cancel = el('button', 'ledger-tool-btn', 'Cancel'); cancel.onclick = renderProjectList;
        actions.append(input, save, cancel); input.focus(); input.select();
      };
      const archive = el('button', 'ledger-tool-btn', project.archived ? 'Restore' : 'Archive');
      archive.onclick = () => void projectAction(() => { const p = projects.find(p => p.id === project.id); p.archived = !p.archived; });
      const remove = el('button', 'ledger-tool-btn ledger-danger', 'Delete');
      remove.onclick = () => {
        actions.replaceChildren(el('p', 'project-hint', `Delete “${project.name}”? Choose what happens to its logs.`));
        const keep = el('button', 'ledger-tool-btn', 'Move logs to General and delete project');
        keep.onclick = () => void deleteProject(project.id, false);
        const erase = el('button', 'ledger-tool-btn ledger-danger', 'Delete project and its logs');
        erase.onclick = () => {
          if (erase.dataset.confirm === 'yes') return void deleteProject(project.id, true);
          erase.dataset.confirm = 'yes'; erase.textContent = 'Confirm permanent deletion of logs';
        };
        const cancel = el('button', 'ledger-tool-btn', 'Cancel'); cancel.onclick = renderProjectList;
        actions.append(keep, erase, cancel);
      };
      actions.append(rename, archive, remove); row.append(actions);
    }
    list.append(row);
  });
}
function validProjectName(value, exceptId = '') {
  const name = value.trim();
  if (!name || name.length > 80) throw new Error('Use a project name between 1 and 80 characters.');
  if (projects.some(p => p.id !== exceptId && p.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('That project name already exists. Choose another name.');
  return name;
}
async function moveLedgerEntry(entry, destination) {
  return projectAction(async () => {
    if (!projects.some(p => p.id === destination && !p.archived)) throw new Error('Choose an active project.');
    if (!ledgerEntries.some(e => e.id === entry.id)) throw new Error('This entry is no longer in the ledger.');
    await appendLedgerEntry({ event: 'project_move', projectId: destination, note: 'Search moved to another project.', details: { targetId: entry.id, toProjectId: destination } });
  });
}
function deleteProject(id, erase) {
  return projectAction(async () => {
    if (id === 'general') throw new Error('General cannot be deleted.');
    const entries = visibleLedgerEntries(id);
    if (erase) {
      const ids = new Set(entries.map(e => e.id));
      await resealLedger(ledgerEntries.filter(e => !ids.has(e.id)));
      await appendLedgerEntry({ event: 'redaction', projectId: 'general', note: 'A project and its logs were deleted.', details: { removedProjectId: id, removedCount: entries.length } });
    } else {
      for (const e of entries.filter(e => !['annotation', 'project_move'].includes(e.event)))
        await appendLedgerEntry({ event: 'project_move', projectId: 'general', note: 'Entry moved to General when its project was deleted.', details: { targetId: e.id, toProjectId: 'general' } });
    }
    projects = projects.filter(p => p.id !== id);
  });
}

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Browser storage request failed.'));
  });
}

function idbTransactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('Browser storage transaction was aborted.'));
    tx.onerror = () => reject(tx.error || new Error('Browser storage transaction failed.'));
  });
}

function openLedgerDb() {
  if (ledgerDbPromise) return ledgerDbPromise;
  ledgerDbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('This browser does not support IndexedDB.'));
    const req = indexedDB.open(LEDGER_DB, LEDGER_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('entries')) {
        const entries = db.createObjectStore('entries', { keyPath: 'id' });
        entries.createIndex('by_chain_index', 'chainIndex', { unique: true });
        entries.createIndex('by_created_at', 'createdAt');
      }
      if (!db.objectStoreNames.contains('prefs')) db.createObjectStore('prefs', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('The local ledger could not be opened.'));
    req.onblocked = () => reject(new Error('Close other QueryForge tabs, then try opening the ledger again.'));
  });
  return ledgerDbPromise;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function ledgerCanonical(entry) {
  const copy = { ...entry };
  delete copy.hash;
  return stableStringify(copy);
}

async function sha256Hex(text) {
  if (!window.crypto || !crypto.subtle) throw new Error('Secure hashing is unavailable. Serve QueryForge over HTTPS or localhost.');
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function ledgerId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

async function ledgerGetAll() {
  const db = await openLedgerDb();
  const tx = db.transaction('entries', 'readonly');
  const rows = await idbRequest(tx.objectStore('entries').getAll());
  await idbTransactionDone(tx);
  return rows.sort((a, b) => a.chainIndex - b.chainIndex);
}

async function ledgerGetPref(key) {
  const db = await openLedgerDb();
  const tx = db.transaction('prefs', 'readonly');
  const value = await idbRequest(tx.objectStore('prefs').get(key));
  await idbTransactionDone(tx);
  return value ? value.value : null;
}

async function ledgerSetPref(key, value) {
  const db = await openLedgerDb();
  const tx = db.transaction('prefs', 'readwrite');
  tx.objectStore('prefs').put({ key, value });
  await idbTransactionDone(tx);
}

async function ledgerPut(entry) {
  const db = await openLedgerDb();
  const tx = db.transaction('entries', 'readwrite');
  tx.objectStore('entries').put(entry);
  await idbTransactionDone(tx);
}

async function ledgerReplaceAll(entries) {
  const db = await openLedgerDb();
  const tx = db.transaction('entries', 'readwrite');
  const store = tx.objectStore('entries');
  store.clear();
  entries.forEach(entry => store.put(entry));
  await idbTransactionDone(tx);
}

async function resealLedger(entries) {
  const resealed = [];
  let previousHash = '';
  for (let i = 0; i < entries.length; i++) {
    const entry = { ...entries[i], chainIndex: i + 1, previousHash };
    entry.hash = await sha256Hex(ledgerCanonical(entry));
    previousHash = entry.hash;
    resealed.push(entry);
  }
  await ledgerReplaceAll(resealed);
  ledgerEntries = resealed;
}

async function appendLedgerEntry(data) {
  const previous = ledgerEntries[ledgerEntries.length - 1];
  const entry = {
    schema: LEDGER_SCHEMA,
    id: ledgerId(),
    event: data.event,
    projectId: data.projectId || activeProjectId,
    createdAt: new Date().toISOString(),
    query: data.query || '',
    engine: data.engine || '',
    batch: data.batch || null,
    sweepWindow: data.sweepWindow || null,
    sourceCount: Number.isFinite(data.sourceCount) ? data.sourceCount : 0,
    appVersion: LEDGER_APP_VERSION,
    note: data.note || '',
    details: data.details || null,
    previousHash: previous ? previous.hash : '',
    chainIndex: previous ? previous.chainIndex + 1 : 1
  };
  entry.hash = await sha256Hex(ledgerCanonical(entry));
  await ledgerPut(entry);
  ledgerEntries.push(entry);
  return entry;
}

function queueLedger(work) {
  ledgerQueue = ledgerQueue.then(work, work);
  return ledgerQueue;
}

async function withLedgerWriteLock(work) {
  if (navigator.locks && navigator.locks.request)
    return navigator.locks.request('query-forge-ledger-write', { mode: 'exclusive' }, work);
  return work();
}

async function requestDurableStorage() {
  if (persistenceRequested) return;
  persistenceRequested = true;
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (_) { /* Export remains the durable backup. */ }
  }
}

function setLedgerStatus(message, kind = '') {
  const status = $('ledgerStatus');
  status.className = 'ledger-status' + (kind ? ' ' + kind : '');
  status.textContent = message;
}

function ledgerMeaningfulCount() {
  return visibleLedgerEntries(activeProjectId).filter(e => e.event === 'saved' || e.event === 'performed').length;
}

function ledgerEntryMeta(entry) {
  const bits = [];
  if (entry.engine) bits.push(entry.engine === 'google-web' ? 'Google Web' : entry.engine);
  if (entry.batch && entry.batch.total > 1) bits.push(`pass ${entry.batch.index} of ${entry.batch.total}`);
  if (entry.sweepWindow) bits.push(`${entry.sweepWindow.from} through ${entry.sweepWindow.to}`);
  if (entry.sourceCount) bits.push(`${entry.sourceCount} source${entry.sourceCount === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

// Annotations are their own sealed entries (the chain is append-only), so
// gather them back onto the entry they point at for display and export.
function ledgerNotesFor(entry) {
  return ledgerEntries
    .filter(a => a.event === 'annotation' && a.details && a.details.targetId === entry.id)
    .map(a => a.note);
}

function renderLedger() {
  $('ledgerCount').textContent = String(ledgerMeaningfulCount());
  const list = $('ledgerList');
  const visible = visibleLedgerEntries();
  const assignments = projectAssignments();
  $('ledgerClear').textContent = ledgerProjectId === 'all' ? 'Clear all projects’ logs' : 'Clear project logs';
  $('ledgerClear').dataset.confirm = '';
  $('ledgerExportJsonl').disabled = $('ledgerExportCsv').disabled = $('ledgerClear').disabled = !visible.length;
  $('ledgerScope').textContent = ledgerProjectId === 'all'
    ? 'Exports include the complete chain across all projects. Verify chain checks all projects.'
    : 'Exports contain this project’s entries, notes and moves. They are a subset of the shared chain; use All projects for a complete verifiable JSONL backup. Verify chain checks all projects.';
  list.innerHTML = '';
  if (!ledgerAvailable) {
    list.innerHTML = '<div class="ledger-empty">The local ledger is unavailable in this browser context.<br>Your searches will still open normally.</div>';
    return;
  }
  if (!visible.length) {
    list.innerHTML = '<div class="ledger-empty">No entries in this project yet.<br>Save a query or perform a search to start its log.</div>';
    setLedgerStatus('Empty ledger · stored only in this browser', 'good');
    return;
  }

  [...visible].reverse().forEach(entry => {
    const row = el('article', 'ledger-entry');
    const head = el('div', 'ledger-entry-head');
    const systemEvent = !['saved', 'performed'].includes(entry.event);
    head.appendChild(el('span', 'ledger-event ' + (systemEvent ? 'system' : entry.event), entry.event));
    head.appendChild(el('time', 'ledger-when', new Date(entry.createdAt).toLocaleString()));
    head.appendChild(el('span', 'ledger-seal', '#' + entry.chainIndex + ' · ' + entry.hash.slice(0, 10)));
    row.appendChild(head);

    if (entry.query) row.appendChild(el('div', 'ledger-query', entry.query));
    const meta = [projectName(assignments.get(entry.id)), ledgerEntryMeta(entry)].filter(Boolean).join(' · ');
    if (meta) row.appendChild(el('div', 'ledger-meta', meta));
    if (entry.note) row.appendChild(el('div', 'ledger-note', entry.note));
    ledgerNotesFor(entry).forEach(n => row.appendChild(el('div', 'ledger-note', n)));

    if (entry.query) {
      const actions = el('div', 'ledger-entry-actions');
      const rerun = el('button', 'ledger-tool-btn', 'Run again ↗');
      rerun.addEventListener('click', () => {
        window.open(googleSearchUrl(entry.query), '_blank');
        void recordLedgerEvent('performed', entry.query, {
          engine: entry.engine || 'google-web', sourceCount: entry.sourceCount,
          batch: entry.batch, sweepWindow: entry.sweepWindow, details: { rerunOf: entry.id }
        });
      });
      const annotate = el('button', 'ledger-tool-btn', 'Add note');
      annotate.addEventListener('click', () => {
        if (row.querySelector('.ledger-note-editor')) return;
        annotate.disabled = true;
        const editor = el('div', 'ledger-note-editor');
        const input = el('input', 'ledger-note-input');
        input.type = 'text'; input.maxLength = 500; input.placeholder = 'Why this search matters…';
        input.setAttribute('aria-label', 'Ledger note');
        const save = el('button', 'ledger-tool-btn', 'Seal note');
        const cancel = el('button', 'ledger-tool-btn', 'cancel');
        const closeEditor = () => { editor.remove(); annotate.disabled = false; };
        const saveNote = () => {
          const note = input.value.trim();
          if (!note) return input.focus();
          save.disabled = true;
          void recordLedgerEvent('annotation', '', {
            projectId: projectAssignments().get(entry.id), note, details: { targetId: entry.id, targetHash: entry.hash }
          });
        };
        save.addEventListener('click', saveNote);
        cancel.addEventListener('click', closeEditor);
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') saveNote();
          if (e.key === 'Escape') closeEditor();
        });
        editor.append(input, save, cancel);
        row.appendChild(editor);
        input.focus();
      });
      const remove = el('button', 'ledger-tool-btn ledger-danger', 'Remove');
      remove.addEventListener('click', () => {
        if (remove.dataset.confirm === 'true') return void removeLedgerEntry(entry);
        remove.dataset.confirm = 'true';
        remove.textContent = 'Confirm remove';
        const cancelRemove = el('button', 'ledger-tool-btn', 'cancel');
        cancelRemove.addEventListener('click', () => {
          remove.dataset.confirm = '';
          remove.textContent = 'Remove';
          cancelRemove.remove();
        });
        actions.appendChild(cancelRemove);
      });
      const move = el('select', 'project-move');
      move.setAttribute('aria-label', 'Move search to project');
      move.add(new Option('Move to project…', ''));
      const currentProject = assignments.get(entry.id);
      projects.filter(p => !p.archived && p.id !== currentProject).forEach(p => move.add(new Option(p.name, p.id)));
      move.onchange = () => { if (move.value) { move.disabled = true; void moveLedgerEntry(entry, move.value).then(ok => { if (!ok) { move.disabled = false; setLedgerStatus($('projectMessage').textContent, 'bad'); } }); } };
      actions.append(rerun, annotate, move, remove);
      row.appendChild(actions);
    }
    list.appendChild(row);
  });

  const head = ledgerEntries[ledgerEntries.length - 1].hash.slice(0, 12).toUpperCase();
  setLedgerStatus(`${visible.length} entries shown · ${ledgerEntries.length} sealed entries across all projects · ledger fingerprint ${head}`, 'good');
}

async function verifyLedger() {
  return queueLedger(async () => {
    await ledgerReady;
    ledgerEntries = await ledgerGetAll();
    let previousHash = '';
    for (let i = 0; i < ledgerEntries.length; i++) {
      const entry = ledgerEntries[i];
      if (entry.chainIndex !== i + 1 || entry.previousHash !== previousHash)
        throw new Error(`Chain break detected at entry ${i + 1}. Export the ledger before making changes.`);
      const actual = await sha256Hex(ledgerCanonical(entry));
      if (actual !== entry.hash)
        throw new Error(`Integrity check failed at entry ${i + 1}. Its sealed contents have changed.`);
      previousHash = entry.hash;
    }
    const head = previousHash ? previousHash.slice(0, 12).toUpperCase() : 'EMPTY';
    setLedgerStatus(`Chain verified · ${ledgerEntries.length} entr${ledgerEntries.length === 1 ? 'y' : 'ies'} · fingerprint ${head}`, 'good');
    return true;
  }).catch(error => setLedgerStatus(error.message || 'The ledger could not be verified.', 'bad'));
}

async function recordLedgerEvent(event, query, context = {}) {
  const projectId = context.projectId || activeProjectId;
  let shared;
  return queueLedger(async () => {
    await ledgerReady;
    await requestDurableStorage();
    await withLedgerWriteLock(async () => {
      ledgerEntries = await ledgerGetAll();
      await loadProjects();
      shared = await appendLedgerEntry({
        projectId: projects.some(p => p.id === projectId) ? projectId : 'general', event, query, engine: context.engine || '', batch: context.batch || null,
        sweepWindow: context.sweepWindow || null, sourceCount: context.sourceCount || 0,
        note: context.note || '', details: context.details || null
      });
    });
    renderLedger();
    shareWithTeam(shared);
    announce(event === 'saved' ? 'Query saved to the local ledger' : 'Search recorded in the local ledger');
    return true;
  }).catch(error => {
    ledgerAvailable = false;
    renderLedger();
    setLedgerStatus(error.message || 'The search could not be written to local storage.', 'bad');
    return false;
  });
}

async function removeLedgerEntry(entry) {
  return queueLedger(async () => {
    await withLedgerWriteLock(async () => {
      ledgerEntries = await ledgerGetAll();
      const current = ledgerEntries.find(e => e.id === entry.id);
      if (!current) return;
      const projectId = projectAssignments().get(current.id);
      await resealLedger(ledgerEntries.filter(e => e.id !== entry.id && e.details?.targetId !== entry.id));
      await appendLedgerEntry({
        event: 'redaction', projectId, note: 'An entry was removed by the user.',
        details: { removedHash: current.hash, removedEvent: current.event, removedAt: new Date().toISOString() }
      });
    });
    renderLedger();
  }).catch(error => setLedgerStatus(error.message || 'The entry could not be removed.', 'bad'));
}

async function applyLedgerRetention(recordChange = true) {
  return withLedgerWriteLock(async () => {
    ledgerEntries = await ledgerGetAll();
    const value = $('ledgerRetention').value;
    if (value === 'forever') return;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - Number(value));
    const keep = ledgerEntries.filter(e => new Date(e.createdAt) >= cutoff);
    const removed = ledgerEntries.length - keep.length;
    if (!removed) return;
    await resealLedger(keep);
    if (recordChange) {
      await appendLedgerEntry({
        event: 'retention', note: `${removed} expired entr${removed === 1 ? 'y was' : 'ies were'} removed by the retention policy.`,
        details: { cutoff: cutoff.toISOString(), removedCount: removed }
      });
    }
  });
}

function downloadLedgerFile(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ledgerExportName(extension) {
  const name = ledgerProjectId === 'all' ? 'all-projects' : projectName(ledgerProjectId);
  const safe = name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'project';
  return `query-forge-${safe}-${isoDate(new Date())}.${extension}`;
}
function exportLedgerJsonl() {
  const entries = visibleLedgerEntries();
  if (!entries.length) return;
  // All enrichment is outside the sealed row: recompute hashes using `entry` only.
  const assignments = projectAssignments();
  const text = entries.map(entry => JSON.stringify({
    entry, project: { id: assignments.get(entry.id), name: projectName(assignments.get(entry.id)) },
    annotations: ledgerNotesFor(entry),
    exportScope: ledgerProjectId === 'all' ? 'complete-chain' : 'project-subset'
  })).join('\n') + '\n';
  downloadLedgerFile(ledgerExportName('jsonl'), 'application/x-ndjson', text);
}

function csvCell(value) {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return '"' + text.replace(/"/g, '""') + '"';
}

function exportLedgerCsv() {
  const entries = visibleLedgerEntries();
  if (!entries.length) return;
  const assignments = projectAssignments();
  const fields = ['projectId','projectName','chainIndex','event','createdAt','query','engine','batch','sweepWindow','sourceCount','note','previousHash','hash'];
  const rows = [fields.map(csvCell).join(',')];
  entries.forEach(entry => {
    const notes = [entry.note, ...ledgerNotesFor(entry)].filter(Boolean).join(' | ');
    rows.push(fields.map(field => csvCell(field === 'note' ? notes : field === 'projectId' ? assignments.get(entry.id) : field === 'projectName' ? projectName(assignments.get(entry.id)) : entry[field])).join(','));
  });
  downloadLedgerFile(ledgerExportName('csv'), 'text/csv;charset=utf-8', rows.join('\r\n') + '\r\n');
}

async function clearLedger() {
  const scope = ledgerProjectId;
  if (!visibleLedgerEntries(scope).length) return;
  return queueLedger(async () => {
    await withLedgerWriteLock(async () => {
      ledgerEntries = await ledgerGetAll();
      const ids = new Set(visibleLedgerEntries(scope).map(e => e.id));
      await resealLedger(ledgerEntries.filter(e => !ids.has(e.id)));
      if (scope !== 'all') await appendLedgerEntry({ event: 'redaction', projectId: scope, note: 'Project logs were cleared.', details: { removedCount: ids.size } });
    });
    renderLedger();
    announce('Local search ledger cleared');
  }).catch(error => setLedgerStatus(error.message || 'The ledger could not be cleared.', 'bad'));
}

async function initialiseLedger() {
  try {
    ledgerEntries = await ledgerGetAll();
    await loadProjects();
    const savedProject = await ledgerGetPref('activeProject');
    activeProjectId = projects.some(p => p.id === savedProject && !p.archived) ? savedProject : 'general';
    ledgerProjectId = activeProjectId;
    renderProjectControls();
    const retention = await ledgerGetPref('retention');
    if (retention && [...$('ledgerRetention').options].some(o => o.value === retention)) $('ledgerRetention').value = retention;
    await applyLedgerRetention(true);
    renderLedger();
  } catch (error) {
    ledgerAvailable = false;
    renderProjectControls();
    setLedgerStatus(error.message || 'The local ledger could not be opened.', 'bad');
    renderLedger();
  }
}

/* ── Pipeline ──
   In a team project the ledger's project is Pipeline's active project, and every
   saved or performed query (and its notes) is also queued for the team sheet's
   Queries tab through the extension's outbox (public/outbox.js). */
let pipelineTeam = null;
const QUERY_HEADERS = ['Logged At', 'Saved By', 'Event', 'Query', 'Search URL', 'Engine', 'Sweep Window', 'Pass', 'Sources', 'Note', 'Entry ID', 'Refers To', 'Hash'];
function queryRow(entry, savedBy) {
  return [entry.createdAt, savedBy || '', entry.event, entry.query, entry.query ? googleSearchUrl(entry.query) : '', entry.engine,
    entry.sweepWindow ? `${entry.sweepWindow.from} to ${entry.sweepWindow.to}` : '',
    entry.batch && entry.batch.total > 1 ? `${entry.batch.index} of ${entry.batch.total}` : '',
    entry.sourceCount || '', entry.note, entry.id, entry.details?.targetId || entry.details?.rerunOf || '', entry.hash];
}
function shareWithTeam(entry) {
  if (!pipelineTeam || !entry || entry.projectId !== pipelineTeam.id) return;
  Promise.resolve(chrome.runtime.sendMessage({ type: 'pipeline:save', item: { kind: 'query', key: 'query ' + entry.id, headers: QUERY_HEADERS, row: queryRow(entry, pipelineTeam.name) } }))
    .then(reply => { if (reply && !reply.ok) setLedgerStatus('Saved here, but not sent to the team sheet: ' + reply.error, 'bad'); })
    .catch(() => {});
}
async function bindPipelineProject() {
  pipelineTeam = (await globalThis.chrome?.storage?.local.get('pipelineTeam'))?.pipelineTeam || null;
  if (!pipelineTeam?.id || !ledgerAvailable) { pipelineTeam = null; return; }
  await projectAction(async () => {
    const mine = projects.find(p => p.id === pipelineTeam.id);
    if (mine) Object.assign(mine, { name: pipelineTeam.label, archived: false });
    else projects.push({ id: pipelineTeam.id, name: pipelineTeam.label, archived: false });
    await ledgerSetPref('activeProject', pipelineTeam.id);
    activeProjectId = ledgerProjectId = pipelineTeam.id;
  });
  document.body.classList.add('pipeline-team');
  $('pipelineProject').textContent = 'Project: ' + pipelineTeam.label;
  document.querySelectorAll('.team-only').forEach(n => { n.hidden = false; });
}

const ledgerReady = initialiseLedger();
ledgerReady.then(bindPipelineProject);

/* ══════════════════════════════════════════════════════════════
   WIRING
   ══════════════════════════════════════════════════════════════ */

// Three ways in; opening one closes the others.
const SOURCE_DOORS = [
  ['doorUrl', 'panelUrl'],
  ['doorPaste', 'panelPaste'],
  ['doorDb', 'panelDb'],
];

function toggleDoor(door) {
  const open = door.getAttribute('aria-expanded') === 'true';
  for (const [doorId, panelId] of SOURCE_DOORS) {
    const isChosen = $(doorId) === door;
    $(doorId).setAttribute('aria-expanded', String(isChosen && !open));
    $(panelId).hidden = !isChosen || open;
  }
}

SOURCE_DOORS.forEach(([doorId]) => {
  $(doorId).onclick = () => toggleDoor($(doorId));
});
$('pasteImport').onclick = runPasteImport;

fillSelect($('dbPick'), Object.fromEntries(
  Object.entries(DATABASES).map(([k, v]) => [k, v.label])
));
refreshPicker();

$('dbPick').onchange = refreshPicker;
$('typePick').onchange = () => {
  // Coverage is per type for Wikidata and the registries, so the country
  // annotations have to be re-read when the type changes.
  refreshAvailability();
  refreshRegions();
  refreshDbNote();
};

/* ── country combobox wiring ── */
function chooseCountry(iso2) {
  countryPicker.value = iso2;
  state.regionIntent = '';
  closeCountryList();
  refreshRegions();
  refreshDbNote();
}

$('countryPick').oninput = e => renderCountryList(e.target.value);
// Focus empties the box and shows everything, rather than selecting the
// current label and relying on the next keystroke to replace it — typing
// over a selection isn't reliable across input methods, and half-replaced
// text ("Kenyakeny") matches nothing. closeCountryList puts the label back
// if they leave without choosing.
$('countryPick').onfocus = e => { e.target.value = ''; renderCountryList(''); };
$('countryPick').onkeydown = e => {
  const box = $('countryList');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (box.hidden) return renderCountryList($('countryPick').value);
    const opts = [...box.querySelectorAll('.combo-opt')];
    if (!opts.length) return;
    const i = opts.indexOf(box.querySelector('.combo-opt.active'));
    markActive(opts[Math.max(0, Math.min(opts.length - 1,
      i + (e.key === 'ArrowDown' ? 1 : -1)))]);
    return;
  }
  if (e.key === 'Enter') {
    const active = box.hidden ? null : box.querySelector('.combo-opt.active');
    if (active) { e.preventDefault(); chooseCountry(active.dataset.iso); }
    return;
  }
  if (e.key === 'Escape' && !box.hidden) { e.preventDefault(); closeCountryList(); }
};
$('countryList').onmousedown = e => {
  // mousedown, not click: blur would close the list out from under it.
  const li = e.target.closest('.combo-opt');
  if (!li) return;
  e.preventDefault();
  chooseCountry(li.dataset.iso);
};
$('countryPick').onblur = () => setTimeout(closeCountryList, 0);
$('countryClear').onclick = () => { chooseCountry(''); $('countryPick').focus(); };
$('regionPick').onchange = e => {
  const opt = e.target.selectedOptions[0];
  state.regionIntent = e.target.value ? (opt ? opt.textContent.trim() : '') : '';
  refreshDbNote();
};
$('dbFetch').onclick = runDbFetch;

$('csvLoad').onclick = runCsvLoad;
$('csvUrl').onkeydown = e => { if (e.key === 'Enter') runCsvLoad(); };

$('mapConfirm').addEventListener('click', () => {
  if (!pendingCsvMapping) return;
  const iDom = Number($('mapDomain').value);
  const iNam = Number($('mapName').value);
  try {
    const items = csvRowsToSources(pendingCsvMapping.rows, iDom, iNam);
    const onConfirm = pendingCsvMapping.onConfirm;
    closeCsvMapping();
    onConfirm(items);
  } catch (e) {
    $('mapErr').textContent = e.message;
    $('mapErr').hidden = false;
  }
});
$('mapCancel').addEventListener('click', closeCsvMapping);
$('mapBackdrop').addEventListener('click', e => { if (e.target === $('mapBackdrop')) closeCsvMapping(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('mapBackdrop').classList.contains('visible')) closeCsvMapping();
});

QUESTION_FIELD_IDS.forEach(id => {
  $(id).addEventListener('input', () => { state.batchIndex = 0; render(); });
  $(id).addEventListener('change', () => { state.batchIndex = 0; render(); });
});

/* Projects: selecting a history view never changes the recording destination. */
for (const id of ['startProject', 'activeProject']) {
  $(id).addEventListener('change', async e => {
    const selected = e.target.value;
    e.target.value = activeProjectId;
    if (selected === '__new' || selected === '__manage') return openProjects(selected === '__new');
    await projectAction(async () => {
      if (!projects.some(p => p.id === selected && !p.archived)) throw new Error('This project is no longer active.');
      await ledgerSetPref('activeProject', selected);
      activeProjectId = selected; ledgerProjectId = selected;
    });
  });
}
$('projectForm').addEventListener('submit', async e => {
  e.preventDefault();
  const value = $('projectName').value;
  const button = e.target.querySelector('button'); button.disabled = true;
  const ok = await projectAction(async () => {
    const name = validProjectName(value);
    const project = { id: ledgerId(), name, archived: false };
    projects.push(project);
    await ledgerSetPref('activeProject', project.id);
    activeProjectId = ledgerProjectId = project.id;
  });
  button.disabled = false;
  if (ok) { $('projectName').value = ''; $('projectDialog').close(); }
});
$('projectClose').onclick = () => $('projectDialog').close();
$('projectDialog').addEventListener('keydown', e => { if (e.key === 'Escape') e.stopPropagation(); });
$('ledgerManageProjects').onclick = () => openProjects();
$('ledgerProject').onchange = e => { ledgerProjectId = e.target.value; renderLedger(); };

/* Local ledger controls */
const ledgerBackdrop = $('ledgerBackdrop');
function openLedger() {
  ledgerProjectId = activeProjectId;
  renderProjectControls();
  renderLedger();
  ledgerBackdrop.classList.add('visible');
  $('ledgerClose').focus();
  void queueLedger(async () => {
    await ledgerReady;
    ledgerEntries = await ledgerGetAll();
    renderLedger();
  }).catch(error => setLedgerStatus(error.message || 'The local ledger could not be refreshed.', 'bad'));
}
function closeLedger() { ledgerBackdrop.classList.remove('visible'); }

$('ledgerOpen').addEventListener('click', openLedger);
$('ledgerClose').addEventListener('click', closeLedger);
$('ledgerDone').addEventListener('click', closeLedger);
ledgerBackdrop.addEventListener('click', e => { if (e.target === ledgerBackdrop) closeLedger(); });
$('ledgerVerify').addEventListener('click', () => void verifyLedger());
$('ledgerExportJsonl').addEventListener('click', exportLedgerJsonl);
$('ledgerExportCsv').addEventListener('click', exportLedgerCsv);
$('ledgerClear').addEventListener('click', () => {
  const btn = $('ledgerClear');
  if (btn.dataset.confirm === 'true') {
    btn.dataset.confirm = '';
    btn.textContent = ledgerProjectId === 'all' ? 'Clear all projects’ logs' : 'Clear project logs';
    return void clearLedger();
  }
  btn.dataset.confirm = 'true';
  btn.textContent = 'Confirm clear';
  setTimeout(() => {
    if (btn.dataset.confirm === 'true') {
      btn.dataset.confirm = '';
      btn.textContent = ledgerProjectId === 'all' ? 'Clear all projects’ logs' : 'Clear project logs';
    }
  }, 5000);
});
$('ledgerRetention').addEventListener('change', () => {
  void queueLedger(async () => {
    await ledgerReady;
    await ledgerSetPref('retention', $('ledgerRetention').value);
    await applyLedgerRetention(true);
    renderLedger();
  }).catch(error => setLedgerStatus(error.message || 'The retention policy could not be saved.', 'bad'));
});

/* Copy */
$('copyBtn').addEventListener('click', async () => {
  const b = buildBatches()[state.batchIndex];
  if (!b.text) return;
  const btn = $('copyBtn');
  try {
    await navigator.clipboard.writeText(b.text);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = b.text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy');
    document.body.removeChild(ta);
  }
  btn.textContent = 'copied ✓';
  setTimeout(() => { btn.textContent = 'copy'; }, 1800);
});

/* Save a deliberate query snapshot without claiming it was performed. */
$('btnSaveLedger').addEventListener('click', () => {
  const batches = buildBatches();
  const b = batches[state.batchIndex];
  if (!b.text) return;
  const btn = $('btnSaveLedger');
  void recordLedgerEvent('saved', b.text, {
    sourceCount: allSites().length,
    batch: { index: state.batchIndex + 1, total: batches.length }
  }).then(saved => {
    if (!saved) return;
    btn.textContent = 'saved ✓';
    setTimeout(() => { btn.textContent = 'Save query'; }, 1800);
  });
});

/* Search — use Google's Web tab and Verbatim results by default. */
$('btnSearch').addEventListener('click', () => {
  const batches = buildBatches();
  const b = batches[state.batchIndex];
  if (!b.text) return;
  window.open(googleSearchUrl(b.text), '_blank');
  void recordLedgerEvent('performed', b.text, {
    engine: 'google-web', sourceCount: allSites().length,
    batch: { index: state.batchIndex + 1, total: batches.length }
  });
});

/* Simple mode uses the same query launcher and ledger as the full builder.
   Its one input is deliberately passed through untouched. */
$('simpleQuery').addEventListener('input', render);
$('simpleForm').addEventListener('submit', event => {
  event.preventDefault();
  $('btnSearch').click();
});
$('simpleSweep').addEventListener('click', () => $('btnSweep').click());

/* Batch nav */
$('bPrev').onclick = () => { if (state.batchIndex > 0) { state.batchIndex--; render(); } };
$('bNext').onclick = () => { state.batchIndex++; render(); };

/* Clear all */
$('btnClear').addEventListener('click', () => {
  state.operators = [];
  state.extraSites = [];
  state.batchIndex = 0;
  clearQuestionFields();
  renderOpChips();
  render();
  closeOpPanel();
});

/* ══════════════════════════════════════════════════════════════
   SYSTEMATIC SEARCH SWEEP — time-sliced searching
   Slices a date range into contiguous windows and appends
   after:/before: to the forged query, one window at a time.
   Google's after:/before: are exclusive, so each window is padded
   by one day on both ends — adjacent windows then cover every date
   with no gaps and no overlap.
   ══════════════════════════════════════════════════════════════ */

const sweepBackdrop = $('sweepBackdrop');
const sweepDone = new Set();   // keys: "from|to" as ISO dates

function isoDate(d) {
  const p = x => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* date inputs give "YYYY-MM-DD" — parse as local time, not UTC */
function parseLocalDate(v) {
  const [y, m, d] = v.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addWindowUnit(d, n, unit) {
  const r = new Date(d);
  if (unit === 'weeks')       r.setDate(r.getDate() + 7 * n);
  else if (unit === 'months') r.setMonth(r.getMonth() + n);
  else                        r.setDate(r.getDate() + n);
  return r;
}

function sweepWindows() {
  const start = $('sweepStart').value, end = $('sweepEnd').value;
  if (!start || !end) return { error: 'Pick a start and an end date to slice.' };
  const s0 = parseLocalDate(start), e0 = parseLocalDate(end);
  if (s0 > e0) return { error: 'The start date must be before the end date.' };
  const n = Math.max(1, parseInt($('sweepSize').value, 10) || 1);
  const unit = $('sweepUnit').value;
  const wins = [];
  let cur = s0;
  while (cur <= e0) {
    const wEnd = addWindowUnit(cur, n, unit);
    wEnd.setDate(wEnd.getDate() - 1);
    if (wEnd > e0) wEnd.setTime(e0.getTime());
    wins.push({ from: new Date(cur), to: wEnd });
    cur = new Date(wEnd);
    cur.setDate(cur.getDate() + 1);
    if (wins.length > 366) return { error: 'That is over 366 windows — widen the window size.' };
  }
  return { windows: wins };
}

const winKey = w => isoDate(w.from) + '|' + isoDate(w.to);

/* The forged query for one window: the question fields + operator
   chips, with the period replaced by the window's own dates. */
function sweepBase(w) {
  const after = new Date(w.from);  after.setDate(after.getDate() - 1);
  const before = new Date(w.to);   before.setDate(before.getDate() + 1);
  const opStr = state.operators.map(o => o.token).join(' ');
  return [termsText(), phraseToken(), opStr, `after:${isoDate(after)}`, `before:${isoDate(before)}`]
    .filter(Boolean).join(' ');
}

function sweepHasQuery() {
  return !!(termsText() || phraseVal() || state.operators.length);
}

function openSweepWindow(w) {
  const batches = buildBatches(sweepBase(w));
  const batchIndex = Math.min(state.batchIndex, batches.length - 1);
  const b = batches[batchIndex];
  if (!b.text) return;
  window.open(googleSearchUrl(b.text), '_blank');
  void recordLedgerEvent('performed', b.text, {
    engine: 'google-web', sourceCount: allSites().length,
    batch: { index: batchIndex + 1, total: batches.length },
    sweepWindow: { from: isoDate(w.from), to: isoDate(w.to) }
  });
  sweepDone.add(winKey(w));
  renderSweep();
}

function updateSweepSummary(wins) {
  const doneCount = wins.filter(w => sweepDone.has(winKey(w))).length;
  $('sweepSummary').innerHTML =
    `<b>${wins.length}</b> window${wins.length === 1 ? '' : 's'} · <b>${doneCount}</b> swept`;
  const next = $('sweepNext');
  next.disabled = !sweepHasQuery() || doneCount === wins.length;
  next.textContent = doneCount === wins.length ? 'Sweep complete ✓' : 'Open next window ↗';
}

function renderSweep() {
  const list = $('sweepList');
  list.innerHTML = '';
  const res = sweepWindows();
  if (res.error) {
    $('sweepSummary').textContent = res.error;
    $('sweepNext').disabled = true;
    $('sweepNote').textContent = '';
    return;
  }
  const wins = res.windows;
  const hasQuery = sweepHasQuery();
  const fmt = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  wins.forEach((w, i) => {
    const row = el('div', 'sweep-row' + (sweepDone.has(winKey(w)) ? ' done' : ''));
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = sweepDone.has(winKey(w));
    cb.title = 'Mark this window as swept';
    cb.addEventListener('change', () => {
      if (cb.checked) sweepDone.add(winKey(w)); else sweepDone.delete(winKey(w));
      row.classList.toggle('done', cb.checked);
      updateSweepSummary(wins);
    });
    row.appendChild(cb);
    row.appendChild(el('span', 'sweep-row-num', String(i + 1)));
    row.appendChild(el('span', 'sweep-row-dates', `${fmt(w.from)} – ${fmt(w.to)}`));
    const open = el('button', 'sweep-open', 'search ↗');
    open.disabled = !hasQuery;
    open.addEventListener('click', () => openSweepWindow(w));
    row.appendChild(open);
    list.appendChild(row);
  });

  const notes = [];
  if (!hasQuery)
    notes.push('<strong>No query yet.</strong> Type your search terms first — the sweep slices the query you forge above.');
  if (state.operators.some(o => /^(after|before):/.test(o.token)))
    notes.push('Your after:/before: operators are replaced by each window&rsquo;s dates.');
  const batches = buildBatches(sweepBase(wins[0]));
  if (batches.length > 1)
    notes.push(`Your site list splits into ${batches.length} passes — windows open pass ${Math.min(state.batchIndex, batches.length - 1) + 1}. Switch passes with ← → before sweeping.`);
  notes.push('Window dates come from Google&rsquo;s index and shift when pages are edited, so edges are soft — confirm the date on the page itself before making claims.');
  $('sweepNote').innerHTML = notes.join('<br><br>');

  updateSweepSummary(wins);
}

function openSweep() {
  if (!$('sweepEnd').value) $('sweepEnd').value = isoDate(new Date());
  if (!$('sweepStart').value) {
    const d = new Date(); d.setFullYear(d.getFullYear() - 1);
    $('sweepStart').value = isoDate(d);
  }
  renderSweep();
  sweepBackdrop.classList.add('visible');
  $('sweepNext').focus();
}

function closeSweep() { sweepBackdrop.classList.remove('visible'); }

$('btnSweep').addEventListener('click', openSweep);
$('sweepClose').addEventListener('click', closeSweep);
sweepBackdrop.addEventListener('click', e => { if (e.target === sweepBackdrop) closeSweep(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && sweepBackdrop.classList.contains('visible')) closeSweep();
  if (e.key === 'Escape' && ledgerBackdrop.classList.contains('visible')) closeLedger();
});
['sweepStart', 'sweepEnd', 'sweepSize', 'sweepUnit'].forEach(id =>
  $(id).addEventListener('input', renderSweep));
$('sweepNext').addEventListener('click', () => {
  const res = sweepWindows();
  if (!res.windows) return;
  const next = res.windows.find(w => !sweepDone.has(winKey(w)));
  if (next) openSweepWindow(next);
});
$('sweepReset').addEventListener('click', () => { sweepDone.clear(); renderSweep(); });

/* ══════════════════════════════════════════════════════════════
   TUTORIAL — 5 steps
   ══════════════════════════════════════════════════════════════ */

const TUT_STEPS = [
  {
    label: 'Welcome',
    heading: 'Build smarter Google searches',
    content: `
      <p class="tut-text">Investigations Lab's Query Forge helps you combine keywords, operators, and site filters into precise Google searches — and shows you what each piece <em>means</em> as you build it.</p>
      <div class="tut-example">
        <span class="hl-muted">deportation OR expulsion </span><span class="hl-op">after:2026-01-01 </span><span class="hl-muted">(</span><span class="hl-site">site:latimes.com</span> <span class="hl-kw">OR</span> <span class="hl-site">site:sfchronicle.com</span><span class="hl-muted">)</span>
      </div>
      <div class="tut-translation">Find <b>pages mentioning deportation or expulsion</b>, <b>published after 2026-01-01</b>, on <b>latimes.com</b> or <b>sfchronicle.com</b>.</div>
      <p class="tut-tip">Every search opens Google's Web tab in Verbatim mode — no AI summaries, automatic synonym expansion, or spelling substitutions. Searches using <em>In the address</em> or <em>In the body text</em> open without Verbatim, because Google ignores those operators in it.</p>
    `,
  },
  {
    label: 'Sources',
    heading: 'Pull real source lists automatically',
    content: `
      <p class="tut-text">
        <b>Step 1</b> can fill a <b>Vault</b> of sites to search inside. Load your own list from a
        <code>published CSV</code>, or <b>browse source databases</b> — Wikidata, GDELT,
        and official registries — to fetch, say, every newspaper in a country or province.
      </p>
      <p class="tut-text">Each source is tagged by how trustworthy its origin is — <b>asserted</b>, <b>inferred</b>, or <b>official</b> — and a coverage note flags gaps and guesses.</p>
      <p class="tut-tip">Fetched a whole country? The Vault has a filter and Select all / none, and long site lists split into numbered search passes automatically.</p>
    `,
  },
  {
    label: 'What and where',
    heading: 'What are you looking for, then extra sites',
    content: `
      <p class="tut-text">
        <b>2. What are you looking for?</b> — the only required step. It asks plain questions: terms that must all appear, terms where any one is enough, an exact phrase, a period of interest. Under each field you can see the Google syntax your answer becomes, and rarer filters (headline, file type, address&hellip;) wait behind the buttons below.<br><br>
        <b>3. Extra sites</b> — add one-off sites by hand; they join whatever's selected in the Vault.
      </p>
      <p class="tut-tip">Skip anything you don't need. A single word in the first field is a valid search.</p>
    `,
  },
  {
    label: 'Read your query',
    heading: 'The preview translates itself',
    content: `
      <p class="tut-text">As you build, two things update in real time — the raw Google syntax, and a plain-English translation so you can catch mistakes before searching.</p>
      <div class="tut-example"><span class="hl-muted">migration </span><span class="hl-op">filetype:pdf intitle:report</span></div>
      <div class="tut-translation">Find <b>pages about migration</b>, <b>as PDF files</b>, <b>with report in the title</b>.</div>
      <p class="tut-tip">The budget bar warns when a query approaches Google's ~1,800 character limit.</p>
    `,
  },
  {
    label: 'Launch',
    heading: 'Copy or search in one click',
    content: `
      <p class="tut-text"><b>copy</b> grabs the raw query string — useful for pasting into other tools or sharing with colleagues.<br><br><b>Search Google ↗</b> opens results in a new tab, directly in Google's Web view.</p>
      <p class="tut-tip">When your sites span several passes, use the ← / → buttons to step through each one.</p>
    `,
  },
];

let tutStep = 0;

const tutBackdrop = $('tutorialBackdrop');
const tutBody     = $('tutBody');
const tutDots     = $('tutDots');
const tutPrev     = $('tutPrev');
const tutNext     = $('tutNext');

function renderTutStep() {
  const step   = TUT_STEPS[tutStep];
  const isLast = tutStep === TUT_STEPS.length - 1;

  tutBody.innerHTML = `
    <div class="tut-step-label">${escHTML(step.label)} &nbsp;·&nbsp; ${tutStep+1} / ${TUT_STEPS.length}</div>
    <div class="tut-heading" id="tutHeading">${escHTML(step.heading)}</div>
    ${step.content}
  `;

  tutDots.innerHTML = '';
  TUT_STEPS.forEach((_,i) => {
    const d = document.createElement('div');
    d.className = 'tut-dot' + (i === tutStep ? ' active' : i < tutStep ? ' done' : '');
    tutDots.appendChild(d);
  });

  tutPrev.disabled = tutStep === 0;
  tutNext.textContent = isLast ? 'Get started ✓' : 'Next →';
}

function openTutorial() {
  tutStep = 0;
  renderTutStep();
  tutBackdrop.classList.add('visible');
  tutNext.focus();
}

function closeTutorial() {
  tutBackdrop.classList.remove('visible');
  localStorage.setItem('qf-tutorial-done-v4','1');
}

tutNext.addEventListener('click', () => {
  if (tutStep < TUT_STEPS.length-1) { tutStep++; renderTutStep(); }
  else closeTutorial();
});
tutPrev.addEventListener('click', () => { if (tutStep > 0) { tutStep--; renderTutStep(); } });
$('tutSkip').addEventListener('click', closeTutorial);
tutBackdrop.addEventListener('click', e => { if (e.target === tutBackdrop) closeTutorial(); });

document.addEventListener('keydown', e => {
  if (!tutBackdrop.classList.contains('visible')) return;
  if (e.key === 'Escape')      closeTutorial();
  if (e.key === 'ArrowRight')  tutNext.click();
  if (e.key === 'ArrowLeft')   tutPrev.click();
});

/* "?" button in header */
(function() {
  const btn = document.createElement('button');
  btn.id = 'tutorialOpen';
  btn.title = 'Open tutorial';
  btn.textContent = '?';
  btn.style.cssText = `
    font-family:var(--mono); font-size:0.68rem; font-weight:600;
    background:none; border:1px solid var(--border); color:var(--muted);
    width:22px; height:22px; border-radius:50%; cursor:pointer; flex-shrink:0;
    display:flex; align-items:center; justify-content:center;
    transition:border-color 0.15s, color 0.15s;
  `;
  btn.addEventListener('mouseenter', () => { btn.style.color='var(--ink)'; btn.style.borderColor='var(--ink)'; });
  btn.addEventListener('mouseleave', () => { btn.style.color='var(--muted)'; btn.style.borderColor='var(--border)'; });
  btn.addEventListener('click', openTutorial);
  document.querySelector('.header-left').appendChild(btn);
})();

/* ══════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════ */
initOpButtons();
render();

/* Every page load starts with an intentional mode choice. The full builder
   remains untouched behind Advanced; Simple is a direct search front door. */
const modeBackdrop = $('modeBackdrop');
function chooseMode(mode) {
  activeMode = mode;
  const simple = mode === 'simple';
  document.body.classList.remove('mode-choice');
  document.body.classList.toggle('simple-mode', simple);
  document.querySelector('header').inert = false;
  $('app').inert = false;
  $('simpleMode').hidden = !simple;
  modeBackdrop.classList.remove('visible');
  render();
  if (simple) {
    $('simpleQuery').focus();
  } else {
    if (!localStorage.getItem('qf-tutorial-done-v4')) openTutorial();
    else $('termsAnd').focus();
  }
}

$('chooseSimple').addEventListener('click', () => chooseMode('simple'));
$('chooseAdvanced').addEventListener('click', () => chooseMode('advanced'));
modeBackdrop.classList.add('visible');
$('chooseSimple').focus();
