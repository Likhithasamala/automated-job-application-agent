// ============================================================
//  JOB FIT FILTER  —  Likhitha (3.9 yrs experience)
//  Runs BEFORE any LLM call or email, so Groq/Gmail/Apify
//  budget is only spent on posts that are real job openings.
//
//  POLICY (set 2026-11-18, revision 2):
//    * APPLY to any experience band — 1+, 4+, 7+, 9+, 10+ …
//    * APPLY to fresher / trainee / entry-level / graduate roles
//    * APPLY to posts that never state a number of years
//    * The ONLY hard experience block is INTERNSHIPS.
// ============================================================

// ---- CONFIG (edit these, nothing else) ----------------------
const MIN_YEARS = 0;     // no lower bound
const MAX_YEARS = 99;    // no upper bound — 10+, 15+ roles are allowed
const ACCEPT_UNSTATED_EXPERIENCE = true;   // keep posts that never state years
const BLOCK_CSUITE = true;   // skip CEO/CTO/VP/Director-of-Engineering searches
const BLOCK_NONTECH = true;  // skip telecaller / sales / insurance / content-writer posts
// -------------------------------------------------------------

// THE ONE HARD BLOCK: internships only. "trainee", "fresher", "entry level",
// "graduate" and "stipend" are deliberately NOT in here any more.
const RE_INTERN = /\b(intern|interns|interning|internship|internships)\b/i;

// Only true C-suite / exec searches, not staff / principal / architect / manager.
const RE_CSUITE = /\b(chief\s+\w+\s+officer|\bcto\b|\bceo\b|\bcfo\b|\bcoo\b|vice\s+president|vp\s+of\s+\w+|head\s+of\s+(engineering|technology)|director\s+of\s+(engineering|technology))\b/i;

const RE_NONTECH = /\b(business\s+development|sales\s+(executive|manager|representative)|inside\s+sales|tele\s*caller|telesales|bpo\b|voice\s+process|customer\s+(support|service)\s+(executive|associate)|digital\s+marketing|seo\s+(executive|specialist)|content\s+writer|graphic\s+designer|video\s+editor|accountant|field\s+executive|insurance\s+advisor|real\s+estate)\b/i;

// Other job seekers' "open to work" posts — not employers, nothing to apply to.
const RE_SEEKER = /(open\s*to\s*(work|new\s+opportunit|opportunit)|#opentowork|kindly\s+refer|please\s+refer\s+me|refer\s+me\s+for|my\s+resume\s+is\s+attached|i(?:'m|\s+am)\s+(currently\s+)?(actively\s+)?(looking|seeking|searching)\s+(for|to)|actively\s+seeking\s+(a\s+)?(new\s+)?(job|role|opportunit)|available\s+for\s+(immediate\s+)?(joining|opportunit))/i;

const RE_UNPAID = /\b(unpaid|no\s+salary|without\s+salary|commission[\s-]*(only|based)|equity[\s-]*only|volunteer)\b/i;

const RE_YEARS = /(\d{1,2})\s*(\+)?\s*(?:-|–|—|to)?\s*(\d{1,2})?\s*(\+)?\s*(?:year|yr)s?\b/gi;

const RE_ROLE_NOUN = /\b(engineer|developer|programmer|scientist|analyst|specialist|consultant|administrator|devops|sre|trainee)\b/i;

function clean(s) {
  return String(s || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/\*+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function stripLead(l) {
  return l
    .replace(/^(?:we(?:'re| are)?\s+)?(?:urgently\s+)?(?:now\s+)?(?:hiring|looking for|seeking|required|opening for|job role|position|role|vacancy)\s*[:\-|,]?\s*/i, '')
    .replace(/^(?:a|an|for)\s+/i, '')
    .replace(/[|\-–—:,!]+\s*$/, '')
    .trim();
}

function extractTitle(content) {
  const lines = clean(content).split('\n').map(l => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (l.length <= 110 && RE_ROLE_NOUN.test(l)) {
      const t = stripLead(l);
      if (t.length >= 4 && RE_ROLE_NOUN.test(t)) return t.slice(0, 90);
    }
  }
  const cue = /(hiring|looking for|opening|position|vacancy)/i;
  for (const l of lines) {
    if (cue.test(l) && l.length < 120) {
      const t = stripLead(l);
      if (t.length >= 4) return t.slice(0, 90);
    }
  }
  return (lines[0] || '').slice(0, 90);
}

function parseYearRanges(text) {
  const ranges = [];
  let m;
  RE_YEARS.lastIndex = 0;
  while ((m = RE_YEARS.exec(text)) !== null) {
    const lo = parseInt(m[1], 10);
    const plus = Boolean(m[2] || m[4]);
    const hi = m[3] != null ? parseInt(m[3], 10) : (plus ? Infinity : lo);
    if (Number.isFinite(lo) && lo <= 40 && hi >= lo) ranges.push([lo, hi]);
  }
  return ranges;
}

function dedupeKey(content) {
  const norm = clean(content).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').slice(0, 180);
  let h = 0;
  for (let i = 0; i < norm.length; i++) { h = (h * 31 + norm.charCodeAt(i)) | 0; }
  return 'fp_' + Math.abs(h).toString(36) + '_' + norm.length;
}

const kept = [];
const rejected = [];

for (const item of $input.all()) {
  const j = item.json;
  const content = j.content || '';
  const titleZone = clean(content).slice(0, 400);

  let reason = null;
  if (!content || clean(content).length < 60) reason = 'empty_or_too_short';
  else if (RE_INTERN.test(content)) reason = 'internship';
  else if (RE_SEEKER.test(titleZone)) reason = 'job_seeker_post';
  else if (RE_UNPAID.test(content)) reason = 'unpaid_or_commission';
  else if (BLOCK_CSUITE && RE_CSUITE.test(titleZone)) reason = 'c_suite_search';
  else if (BLOCK_NONTECH && RE_NONTECH.test(titleZone)) reason = 'non_tech_role';

  const ranges = reason ? [] : parseYearRanges(content);
  let expMin = null, expMax = null, expLabel = 'not specified in the post';

  if (!reason) {
    if (ranges.length === 0) {
      if (!ACCEPT_UNSTATED_EXPERIENCE) reason = 'experience_not_stated';
    } else {
      const fit = ranges.filter(([lo, hi]) => hi >= MIN_YEARS && lo <= MAX_YEARS);
      if (fit.length === 0) {
        reason = 'experience_out_of_band_' + Math.min(...ranges.map(r => r[0])) + '+';
      } else {
        expMin = Math.min(...fit.map(r => r[0]));
        const hiFinite = fit.map(r => r[1]).filter(Number.isFinite);
        expMax = hiFinite.length ? Math.max(...hiFinite) : null;
        expLabel = expMax ? expMin + '-' + expMax + ' years' : expMin + '+ years';
      }
    }
  }

  if (reason) {
    rejected.push(reason);
    continue;
  }

  kept.push({
    json: {
      ...j,
      jobTitle: extractTitle(content),
      expMin,
      expMax,
      expLabel,
      dedupeKey: dedupeKey(content),
    },
  });
}

const counts = rejected.reduce((a, r) => { a[r] = (a[r] || 0) + 1; return a; }, {});
console.log('JOB FILTER: kept ' + kept.length + ' of ' + (kept.length + rejected.length));
console.log('rejected: ' + JSON.stringify(counts));

return kept;
