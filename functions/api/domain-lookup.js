// Domain Tenant Lookup API, a Cloudflare Pages Function.
// POST /api/domain-lookup with a JSON body: { "domain": "...", "compareDomain": "..." }
// Queries two fixed Microsoft endpoints per domain and returns a short summary.
// Web version of Get-DomainTenant.ps1 in github.com/hiaror/entra-domain-tenant-release.
// Nothing is logged or stored.

const MAX_BODY_BYTES = 1024;
const MAX_UPSTREAM_BYTES = 65536;
const TIMEOUT_MS = 8000;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KNOWN_STATUSES = ['Managed', 'Federated', 'Unknown'];

export async function onRequest({ request }) {
  if (request.method !== 'POST') {
    return reply({ error: 'Method not allowed. Use POST.' }, 405, { Allow: 'POST' });
  }

  // Browsers send Origin on POST. Only this site's own pages may call the API.
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return reply({ error: 'Cross-origin requests are not accepted.' }, 403);
  }

  const contentType = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    return reply({ error: 'Send the request body as application/json.' }, 415);
  }

  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) {
    return reply({ error: 'The request body is too large.' }, 413);
  }

  let input;
  try {
    const text = await readText(request.body, MAX_BODY_BYTES);
    if (text === null) {
      return reply({ error: 'The request body is too large.' }, 413);
    }
    input = JSON.parse(text);
  } catch {
    return reply({ error: 'The request body is not valid JSON.' }, 400);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return reply({ error: 'The request body must be a JSON object.' }, 400);
  }

  const primary = checkDomain(input.domain);
  if (!primary.ok) {
    return reply({ error: primary.error, field: 'domain' }, 400);
  }

  let second = null;
  if (input.compareDomain !== undefined && input.compareDomain !== null && input.compareDomain !== '') {
    second = checkDomain(input.compareDomain);
    if (!second.ok) {
      return reply({ error: second.error, field: 'compareDomain' }, 400);
    }
  }

  try {
    const [first, other] = await Promise.all([
      lookup(primary.value),
      second ? lookup(second.value) : null,
    ]);
    const body = { domain: first };
    if (other) {
      body.compare = other;
      body.sameTenant = first.tenantId && other.tenantId ? first.tenantId === other.tenantId : null;
    }
    return reply(body, 200);
  } catch {
    return reply({ error: 'The lookup failed. Try again in a moment.' }, 502);
  }
}

// Hostname rules: 253 characters at most, at least one dot, labels of 1 to 63
// characters from a-z, 0-9 and hyphens, no hyphen at either end of a label.
// Punycode labels (xn--) pass. A last label with no letter rules out IP addresses.
function checkDomain(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, error: 'Enter a domain name, such as contoso.com.' };
  }
  const domain = value.trim().toLowerCase();
  if (domain.length > 253) {
    return { ok: false, error: 'A domain name can be at most 253 characters long.' };
  }
  const labels = domain.split('.');
  if (labels.length < 2) {
    return { ok: false, error: 'Enter a full domain name with at least one dot, such as contoso.com.' };
  }
  if (!labels.every((label) => LABEL.test(label))) {
    return {
      ok: false,
      error: 'A domain name can contain only the letters a to z, digits and hyphens, in parts of 1 to 63 characters that do not start or end with a hyphen.',
    };
  }
  if (!/[a-z]/.test(labels[labels.length - 1])) {
    return { ok: false, error: 'IP addresses are not accepted. Enter a domain name.' };
  }
  return { ok: true, value: domain };
}

// Same two lookups as Get-DomainTenant.ps1. A failed OpenID call means no tenant.
async function lookup(domain) {
  const realmUrl = 'https://login.microsoftonline.com/getuserrealm.srf?login=test@' + encodeURIComponent(domain) + '&json=1';
  const openidUrl = 'https://login.microsoftonline.com/' + encodeURIComponent(domain) + '/v2.0/.well-known/openid-configuration';

  const [realm, openid] = await Promise.all([getJson(realmUrl), getJson(openidUrl)]);

  const nameSpaceType = realm && typeof realm.NameSpaceType === 'string' ? realm.NameSpaceType : '';
  const status = KNOWN_STATUSES.includes(nameSpaceType) ? nameSpaceType : 'Inconclusive';

  return {
    domain,
    status,
    organisation: realm ? cleanText(realm.FederationBrandName, 200) : null,
    tenantId: openid ? tenantFromIssuer(openid.issuer) : null,
    cloud: openid ? matchOrNull(openid.cloud_instance_name, /^[a-z0-9.-]{1,100}$/i) : null,
    region: openid ? matchOrNull(openid.tenant_region_scope, /^[a-z0-9_-]{1,32}$/i) : null,
    identityProvider: status === 'Federated' && realm ? schemeAndHost(realm.AuthURL) : null,
  };
}

async function getJson(url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status !== 200) {
      if (response.body) await response.body.cancel();
      return null;
    }
    const text = await readText(response.body, MAX_UPSTREAM_BYTES);
    if (text === null) return null;
    const data = JSON.parse(text);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

// Reads a body up to a byte limit. Returns null when the limit is exceeded.
async function readText(stream, limit) {
  if (!stream) return '';
  const reader = stream.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// The issuer is https://login.microsoftonline.com/<tenant GUID>/v2.0
function tenantFromIssuer(issuer) {
  if (typeof issuer !== 'string') return null;
  try {
    const segment = (new URL(issuer).pathname.split('/')[1] || '').toLowerCase();
    return GUID.test(segment) ? segment : null;
  } catch {
    return null;
  }
}

// Only the scheme and host of AuthURL are returned, never the full URL.
function schemeAndHost(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.protocol + '//' + url.host : null;
  } catch {
    return null;
  }
}

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function matchOrNull(value, pattern) {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

function reply(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}
