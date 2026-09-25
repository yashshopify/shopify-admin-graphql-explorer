#!/usr/bin/env node
/**
 * Shopify Admin GraphQL API explorer — single-file generator
 * ==========================================================
 *
 * Introspects the Shopify Admin GraphQL schema and renders a self-contained,
 * interactive HTML explorer of the whole API surface: Queries, Mutations and
 * Types grouped into domains, with drill-down type navigation, search, filters,
 * per-field GraphQL/curl snippets, an overview dashboard, keyboard navigation,
 * and optional version comparison.
 *
 * Zero dependencies. Node.js 18+ (uses the global `fetch`).
 *
 * ---------------------------------------------------------------------------
 * ENVIRONMENT
 * ---------------------------------------------------------------------------
 *   SHOPIFY_SHOP          store domain: "mystore" or "mystore.myshopify.com"
 *   SHOPIFY_API_VERSION   API version to introspect (default: 2026-07)
 *
 * Authentication — the first source that resolves wins:
 *
 *   1) SHOPIFY_ADMIN_ACCESS_TOKEN
 *        An Admin API access token (shpat_ / shp_). Works for any store and
 *        app. Simplest option.
 *
 *   2) SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
 *        Dev Dashboard app credentials. The script performs the client
 *        credentials grant and mints a fresh 24h token. Note: that grant only
 *        works for stores inside your own Shopify organization.
 *
 * Apps created directly in the Shopify admin no longer expose a static token,
 * so one of the two options above is required.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *   node scripts/shopify-admin-tree.mjs
 *   node scripts/shopify-admin-tree.mjs --version 2026-04 --out tree.html
 *   node scripts/shopify-admin-tree.mjs --schema schema.json
 *   node scripts/shopify-admin-tree.mjs --schema new.json --compare old.json
 *
 * FLAGS
 *   --version <v>         API version to introspect (overrides the env var)
 *   --schema <file>       read introspection JSON from a file, not the network
 *   --compare <file>      annotate every entry with what changed vs this schema
 *   --compare-version <v> label for the comparison schema (else inferred from
 *                         the file name, then "previous")
 *   --out <path>          output page (default: shopify-admin-graphql-tree.html)
 *   --help
 *
 * --schema and --compare expect GraphQL introspection JSON — the payload of an
 * IntrospectionQuery. SDL is not parsed, because that would need a parser
 * dependency. Anything that exports introspection JSON works, for example:
 *
 *   npx get-graphql-schema --json https://SHOP.myshopify.com/admin/api/2026-07/graphql.json > schema.json
 *
 * Accepted shapes: { data: { __schema } }, { __schema }, or a bare __schema.
 *
 * Introspection is schema-only and needs no special access scope, but if your
 * store restricts it, use --schema with a dump obtained elsewhere. The output
 * is identical either way.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve as resolvePath, basename } from 'node:path';
import process from 'node:process';

const DEFAULT_VERSION = '2026-07';
const DEFAULT_OUT = 'shopify-admin-graphql-tree.html';
const MAX_DESCRIPTION = 240;

/* -------------------------------------------------------------------------- */
/* Domain grouping                                                            */
/* -------------------------------------------------------------------------- */

/**
 * First-match-wins rules. The same table classifies query fields, mutation
 * fields and type names, because Shopify's naming convention is consistent
 * (productCreate, ProductConnection, OrderEdge, ...).
 */
const DOMAIN_RULES = [
  ['Analytics & Reporting', /^(shopifyql|report)/i],
  ['Functions & Extensibility', /^(paymentCustomization|deliveryCustomization|cartTransform|validation|shopifyFunction|function|flow)/i],
  ['Point of Sale', /^(cash|pointOfSale)/i],
  ['Privacy & Consent', /^(privacy|consentPolicy|dataSale|deletionEvent|consent)/i],
  ['Staff & Permissions', /^(staff|currentStaffMember|assignable)/i],
  ['Sales Channels', /^(channel|webPresence)/i],
  ['Storefront & Access', /^(storefrontAccessToken|storefront|delegateAccessToken|delegatedAccess|accessScope|apiAccess|mobilePlatformApplication)/i],
  ['Bulk Operations', /^(bulk|currentBulkOperation|job)/i],
  ['Webhooks, Pixels & Events', /^(webhookSubscription|eventBridgeWebhookSubscription|pubSubWebhookSubscription|pubSubServerPixel|serverPixel|webPixel|event)/i],
  ['Marketing', /^marketing/i],
  ['Markets, Catalogs & B2B', /^(market|primaryMarket|catalog|regional|compan|businessEntit|b2b)/i],
  ['Discounts & Pricing', /^(discount|priceRule|codeDiscount|automaticDiscount|priceList|quantityPricing|quantityRules)/i],
  ['Returns & Refunds', /^(return|removeFromReturn|refund|reverseDelivery|reverseFulfillmentOrder|suggestedRefund)/i],
  ['Gift Cards', /^giftCard/i],
  ['Subscriptions', /^(subscription|sellingPlan)/i],
  ['Customers', /^(customer|segment)/i],
  ['Fulfillment', /^(fulfillment|assignedFulfillmentOrder|manualHoldsFulfillmentOrders)/i],
  ['Orders & Checkout', /^(order|pendingOrders|draftOrder|abandonedCheckout|abandonment|checkout)/i],
  ['Payments & Finance', /^(shopifyPayments|payout|payment|dispute|transaction|tender|storeCredit|finance|tax)/i],
  ['Inventory & Locations', /^(inventory|location|shippingPackage)/i],
  ['Shipping & Delivery', /^(deliveryProfile|deliveryOption|deliveryPromise|deliverySetting|deliveryShippingOrigin|carrierService|availableCarrierServices|shipping)/i],
  ['Products', /^(product|taxonomy)/i],
  ['Collections & Publishing', /^(collection|publication|combinedListing|publishable|publishedProducts)/i],
  ['Metafields & Metaobjects', /^(metafield|metaobject|standardMeta(field|object)Definition)/i],
  ['Localization', /^(translatable|translation|shopLocale|availableLocales|localization)/i],
  ['Content & Online Store', /^(file|stagedUpload|blog|article|page|comment|menu|navigation|urlRedirect|theme|scriptTag|onlineStore|asset|domain)/i],
  ['Apps & Billing', /^(app|currentAppInstallation|previewInstall)/i],
  ['Shop & Platform', /^(shop|node|savedSearch|limit|count|backupRegion|availableBackupRegions|apiVersion|publicApi|tagsAdd|tagsRemove)/i],
];

/**
 * Second pass: unanchored keyword fallback for names the precise rules miss.
 * This is what pulls in the long tail of derived types — payloads, user errors,
 * calculated wrappers, connections — that embed their domain in the middle of
 * the name (CalculatedDraftOrderLineItem, AbandonmentEmailStateUpdatePayload).
 * Order still matters: first match wins.
 */
const DOMAIN_KEYWORDS = [
  ['Functions & Extensibility', /(customization|cartTransform|flowTrigger|flowGenerate|validation|requirement)/i],
  ['Point of Sale', /(cashDrawer|cashTracking|cashManagement|pointOfSale|sale)/i],
  ['Privacy & Consent', /(privacy|consent|dataSale|deletionEvent|cookie)/i],
  ['Staff & Permissions', /(staffMember|permission|assignable|identityProvider)/i],
  ['Bulk Operations', /(bulk|job)/i],
  ['Webhooks, Pixels & Events', /(webhook|pixel|event)/i],
  ['Markets, Catalogs & B2B', /(market|catalog|compan|businessEntit|b2b)/i],
  ['Returns & Refunds', /(return|refund|reverseDelivery)/i],
  ['Discounts & Pricing', /(discount|priceRule|pricing|priceList|quantityRule)/i],
  ['Gift Cards', /giftCard/i],
  ['Subscriptions', /(subscription|sellingPlan|billingAttempt)/i],
  ['Customers', /(customer|segment|mailingAddress|address)/i],
  ['Fulfillment', /(fulfillment|delivery|carrier|shipping)/i],
  ['Orders & Checkout', /(order|checkout|abandon|lineItem|exchange|buyerExperience)/i],
  ['Payments & Finance', /(payment|transaction|tender|balance|bankAccount|storeCredit|finance|kyc|tax|fee|duty|deposit)/i],
  ['Inventory & Locations', /(inventory|location|shippingPackage)/i],
  ['Products', /(product|variant|bundle|taxonomy)/i],
  ['Collections & Publishing', /(collection|publication|publish)/i],
  ['Metafields & Metaobjects', /(metafield|metaobject)/i],
  ['Localization', /(translat|locale|localiz)/i],
  ['Content & Online Store', /(file|upload|blog|article|page|comment|menu|navigation|urlRedirect|theme|scriptTag|onlineStore|domain|webPresence|image|media|video)/i],
  ['Marketing', /marketing/i],
  ['Analytics & Reporting', /report/i],
  ['Sales Channels', /(channel|sync)/i],
  ['Apps & Billing', /(appInstallation|appSubscription|appUsageRecord|application|appDiscount|entitlement)/i],
  ['Shop & Platform', /(shop|region|apiVersion|currency|attribute|link|property|filter|distance)/i],
];

const UNCLASSIFIED = 'Unclassified';

/** Shared scalar / plumbing types that belong to no single domain. */
const CORE_DOMAIN = 'Core & Shared Types';
const CORE_TYPE_NAMES = new Set([
  'QueryRoot', 'Mutation', 'MutationOperation', 'PageInfo', 'Node', 'Edge',
  'ID', 'String', 'Int', 'Float', 'Boolean', 'DateTime', 'Date', 'Decimal',
  'URL', 'JSON', 'Money', 'MoneyBag', 'MoneyV2', 'CurrencyCode', 'ARN',
  'FormattedString', 'BigInt', 'UnsignedInt64', 'StorefrontID', 'UtcOffset',
  'Color', 'HTML', 'Weight', 'UnitSystem', 'LengthUnit', 'WeightUnit',
  'HasMetafields', 'MetafieldReference', 'MetafieldReferencer', 'HasEvents',
  'CommentEventSubject', 'LegacyInteroperability', 'Publishable', 'Discount',
  'DiscountCode', 'DiscountAutomatic', 'DiscountApplication', 'HasPublishedTranslations',
  'LocalizedString', 'TaxonomyCategory', 'Region', 'CountryCode',
  'UserError', 'DisplayableError', 'ResourceAlert', 'ResourceAlertAction',
  'ResourceOperation', 'RestrictedForResource', 'SearchResult',
  'SearchResultConnection', 'SearchResultEdge', 'Navigable', 'HasCompareDigest',
  'StringConnection', 'StringEdge',
]);

function domainFor(name) {
  for (const [domain, re] of DOMAIN_RULES) {
    if (re.test(name)) return domain;
  }
  for (const [domain, re] of DOMAIN_KEYWORDS) {
    if (re.test(name)) return domain;
  }
  return UNCLASSIFIED;
}

function domainForType(name) {
  if (CORE_TYPE_NAMES.has(name)) return CORE_DOMAIN;
  return domainFor(name);
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const out = { version: null, schema: null, compare: null, compareVersion: null, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = (flag) => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} requires a value`);
      return v;
    };
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version') out.version = take('--version');
    else if (a.startsWith('--version=')) out.version = a.slice('--version='.length);
    else if (a === '--schema') out.schema = take('--schema');
    else if (a.startsWith('--schema=')) out.schema = a.slice('--schema='.length);
    else if (a === '--compare') out.compare = take('--compare');
    else if (a.startsWith('--compare=')) out.compare = a.slice('--compare='.length);
    else if (a === '--compare-version') out.compareVersion = take('--compare-version');
    else if (a.startsWith('--compare-version=')) out.compareVersion = a.slice('--compare-version='.length);
    else if (a === '--out') out.out = take('--out');
    else if (a.startsWith('--out=')) out.out = a.slice('--out='.length);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

const HELP = `Shopify Admin GraphQL API explorer generator

Usage:
  node scripts/shopify-admin-tree.mjs [options]

Options:
  --version <v>          API version to introspect (default ${DEFAULT_VERSION},
                         overrides SHOPIFY_API_VERSION)
  --schema <file>        read introspection JSON from a file, not the network
  --compare <file>       annotate every entry with what changed vs this schema
  --compare-version <v>  label for the comparison schema (default: inferred from
                         the file name, else "previous")
  --out <path>           output page (default ${DEFAULT_OUT})
  --help

Environment:
  SHOPIFY_SHOP, SHOPIFY_API_VERSION,
  SHOPIFY_ADMIN_ACCESS_TOKEN   (or)   SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET

Writes a self-contained HTML page — no server, no build step. Open the file
directly, or point your editor's preview pane at it.

Interactive features in the page: drill-down type navigation, search, type-kind
/ deprecated / connection / change filters, overview dashboard, keyboard
navigation ( / to search, j/k or arrows to move, Enter to expand ), and
per-field "Copy query" / "Copy curl" snippets.`;

/* -------------------------------------------------------------------------- */
/* Config & auth                                                              */
/* -------------------------------------------------------------------------- */

function normalizeShop(raw) {
  let s = String(raw).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!s) throw new Error('SHOPIFY_SHOP is empty');
  if (!s.includes('.')) s += '.myshopify.com';
  return s;
}

function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) {
    if (s && s.length > 6) out = out.split(s).join('***');
  }
  return out;
}

async function exchangeClientCredentials(shop, clientId, clientSecret) {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });
  const body = await res.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`Token endpoint returned non-JSON (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  if (!res.ok || !json.access_token) {
    const detail = json.error_description || json.error || body.slice(0, 300);
    throw new Error(
      `Client credentials grant failed (HTTP ${res.status}): ${detail}\n` +
        'This grant only works for stores inside your own Shopify organization. ' +
        'For other stores, set SHOPIFY_ADMIN_ACCESS_TOKEN instead.',
    );
  }
  const hours = json.expires_in ? Math.round(json.expires_in / 3600) : '?';
  return { token: json.access_token, tokenSource: `client credentials (${hours}h)`, scopes: json.scope || null };
}

async function resolveToken(shop) {
  const direct = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (direct) {
    return { token: direct, tokenSource: 'SHOPIFY_ADMIN_ACCESS_TOKEN', secrets: [direct] };
  }
  const id = process.env.SHOPIFY_CLIENT_ID;
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (id && secret) {
    const r = await exchangeClientCredentials(shop, id, secret);
    return { ...r, secrets: [id, secret, r.token] };
  }
  throw new Error(
    'No credentials found.\n\n' +
      'Set one of:\n' +
      '  SHOPIFY_ADMIN_ACCESS_TOKEN                    an Admin API access token (shpat_/shp_)\n' +
      '  SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET     Dev Dashboard app credentials (24h token)\n\n' +
      'Apps created directly in the Shopify admin no longer expose a static token.',
  );
}

/* -------------------------------------------------------------------------- */
/* Introspection                                                              */
/* -------------------------------------------------------------------------- */

const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types { ...FullType }
  }
}
fragment FullType on __Type {
  kind
  name
  description
  fields(includeDeprecated: true) {
    name
    description
    isDeprecated
    deprecationReason
    args { ...InputValue }
    type { ...TypeRef }
  }
  inputFields { ...InputValue }
  interfaces { ...TypeRef }
  enumValues(includeDeprecated: true) {
    name
    description
    isDeprecated
    deprecationReason
  }
  possibleTypes { ...TypeRef }
}
fragment InputValue on __InputValue {
  name
  description
  defaultValue
  type { ...TypeRef }
}
fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
      }
    }
  }
}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function adminGraphql(shop, version, token, query, secrets, attempt = 0) {
  const res = await fetch(`https://${shop}/admin/api/${version}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query }),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status} returned non-JSON: ${redact(text, secrets).slice(0, 400)}`);
  }

  const failures = (json.errors || []).map((e) => e.extensions?.code).filter(Boolean);
  const retryAfter = Number(res.headers.get('retry-after'));
  const throttled = res.status === 429 || res.status === 430 || failures.includes('THROTTLED');

  if (throttled && attempt < 5) {
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(30000, 1500 * 2 ** attempt);
    process.stderr.write(`  throttled — retrying in ${Math.round(waitMs / 1000)}s\n`);
    await sleep(waitMs);
    return adminGraphql(shop, version, token, query, secrets, attempt + 1);
  }

  if (json.errors?.length) {
    const codes = failures.join(', ');
    const msgs = json.errors.map((e) => e.message).join('\n  ');
    let hint = '';
    if (codes.includes('MAX_COST_EXCEEDED')) {
      hint = '\n\nIntrospection exceeded the single-query cost limit. Use --schema with a schema dumped elsewhere.';
    } else if (codes.includes('ACCESS_DENIED')) {
      hint = '\n\nCheck that the token is valid and that the app has access to this store.';
    } else if (codes.includes('SHOP_INACTIVE')) {
      hint = '\n\nThe shop is not active (unpaid or flagged).';
    }
    throw new Error(`GraphQL errors${codes ? ` [${codes}]` : ''}:\n  ${redact(msgs, secrets)}${hint}`);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${redact(text, secrets).slice(0, 400)}`);
  if (!json.data) throw new Error(`Response contained no data: ${redact(text, secrets).slice(0, 400)}`);
  return json;
}

function extractSchema(json) {
  const schema = json?.data?.__schema ?? json?.__schema ?? (json?.queryType && json?.types ? json : null);
  if (!schema || !Array.isArray(schema.types)) {
    throw new Error('Could not find a __schema object with a types array in that file.');
  }
  return schema;
}

/* -------------------------------------------------------------------------- */
/* Normalize                                                                  */
/* -------------------------------------------------------------------------- */

const truncate = (s, max = MAX_DESCRIPTION) => {
  if (!s) return null;
  const clean = String(s).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).trimEnd() + '…';
};

function typeRef(t) {
  if (!t) return 'Unknown';
  if (t.kind === 'NON_NULL') return typeRef(t.ofType) + '!';
  if (t.kind === 'LIST') return '[' + typeRef(t.ofType) + ']';
  return t.name || 'Unknown';
}

/** Innermost named type of a wrapped type ref. */
function innerName(t) {
  let cur = t;
  while (cur && !cur.name && cur.ofType) cur = cur.ofType;
  return cur?.name || null;
}

function fieldEntry(f) {
  return {
    name: f.name,
    type: typeRef(f.type),
    inner: innerName(f.type),
    args: (f.args || []).map((a) => ({
      name: a.name,
      type: typeRef(a.type),
      required: a.type?.kind === 'NON_NULL',
      description: truncate(a.description, 160),
    })),
    description: truncate(f.description),
    deprecated: !!f.isDeprecated,
    deprecationReason: truncate(f.deprecationReason, 160),
  };
}

/**
 * Reduce an introspection result to a comparable "surface": named operations
 * and types. Kept separate from grouping so the same surface can be diffed
 * against another API version.
 */
function extractSurface(schema) {
  const types = schema.types.filter((t) => t && t.name && !t.name.startsWith('__'));
  const byName = new Map(types.map((t) => [t.name, t]));
  const queryRoot = schema.queryType?.name || 'QueryRoot';
  const mutationRoot = schema.mutationType?.name || 'Mutation';

  const queries = new Map();
  const mutations = new Map();
  for (const f of byName.get(queryRoot)?.fields || []) queries.set(f.name, fieldEntry(f));
  for (const f of byName.get(mutationRoot)?.fields || []) mutations.set(f.name, fieldEntry(f));

  const typeMap = new Map();
  for (const t of types) {
    if (t.name === queryRoot || t.name === mutationRoot) continue;
    const entry = { name: t.name, kind: t.kind, description: truncate(t.description) };

    if (t.kind === 'OBJECT' || t.kind === 'INTERFACE') {
      entry.fields = (t.fields || []).map(fieldEntry);
      entry.interfaces = (t.interfaces || []).map((i) => i.name).filter(Boolean);
      if (t.possibleTypes?.length) entry.possibleTypes = t.possibleTypes.map((p) => p.name);
    } else if (t.kind === 'INPUT_OBJECT') {
      entry.inputFields = (t.inputFields || []).map((f) => ({
        name: f.name,
        type: typeRef(f.type),
        required: f.type?.kind === 'NON_NULL',
        description: truncate(f.description, 160),
      }));
    } else if (t.kind === 'ENUM') {
      entry.enumValues = (t.enumValues || []).map((v) => ({
        name: v.name,
        description: truncate(v.description, 120),
        deprecated: !!v.isDeprecated,
      }));
    } else if (t.kind === 'UNION') {
      entry.possibleTypes = (t.possibleTypes || []).map((p) => p.name);
    } else if (t.kind === 'SCALAR') {
      entry.description = entry.description || 'Custom scalar.';
    }

    typeMap.set(t.name, entry);
  }

  return { queryRoot, mutationRoot, queries, mutations, types: typeMap };
}

/* -------------------------------------------------------------------------- */
/* Diff                                                                       */
/* -------------------------------------------------------------------------- */

const opSig = (e) => e.type + '(' + (e.args || []).map((a) => a.name + ':' + a.type).join(',') + ')';

function countFieldDelta(beforeList = [], afterList = []) {
  const before = new Map(beforeList.map((f) => [f.name, f.type]));
  const after = new Map(afterList.map((f) => [f.name, f.type]));
  let added = 0, removed = 0, retyped = 0;
  for (const [n, t] of after) {
    if (!before.has(n)) added++;
    else if (before.get(n) !== t) retyped++;
  }
  for (const n of before.keys()) if (!after.has(n)) removed++;
  return { added, removed, retyped };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function opDelta(before, after) {
  const notes = [];
  if (before.type !== after.type) notes.push(`returns ${before.type} → ${after.type}`);
  const d = countFieldDelta(before.args, after.args);
  if (d.added) notes.push('+' + plural(d.added, 'arg'));
  if (d.removed) notes.push('-' + plural(d.removed, 'arg'));
  if (d.retyped) notes.push(plural(d.retyped, 'arg') + ' retyped');
  if (after.deprecated && !before.deprecated) notes.push('newly deprecated');
  return notes.join(', ') || 'changed';
}

function typeDelta(before, after) {
  const notes = [];
  if (before.kind !== after.kind) notes.unshift(`${before.kind} → ${after.kind}`);

  const d = countFieldDelta(
    before.fields || before.inputFields || [],
    after.fields || after.inputFields || [],
  );
  if (d.added) notes.push('+' + plural(d.added, 'field'));
  if (d.removed) notes.push('-' + plural(d.removed, 'field'));
  if (d.retyped) notes.push(plural(d.retyped, 'field') + ' retyped');

  if (before.enumValues || after.enumValues) {
    const e = countFieldDelta(
      (before.enumValues || []).map((v) => ({ name: v.name, type: '' })),
      (after.enumValues || []).map((v) => ({ name: v.name, type: '' })),
    );
    if (e.added) notes.push('+' + plural(e.added, 'value'));
    if (e.removed) notes.push('-' + plural(e.removed, 'value'));
  }

  if (before.possibleTypes && after.possibleTypes) {
    const b = new Set(before.possibleTypes);
    const a = new Set(after.possibleTypes);
    const added = [...a].filter((x) => !b.has(x)).length;
    const removed = [...b].filter((x) => !a.has(x)).length;
    if (added) notes.push('+' + plural(added, 'possible type'));
    if (removed) notes.push('-' + plural(removed, 'possible type'));
  }

  return notes.join(', ') || 'changed';
}

function diffMap(before, after, sig, delta) {
  const out = new Map();
  for (const [name, a] of after) {
    const b = before.get(name);
    if (!b) out.set(name, { change: 'added' });
    else if (sig(a) !== sig(b)) out.set(name, { change: 'changed', note: delta(b, a) });
    else if (a.deprecated && !b.deprecated) out.set(name, { change: 'deprecated' });
  }
  for (const name of before.keys()) {
    if (!after.has(name)) out.set(name, { change: 'removed' });
  }
  return out;
}

function typeSig(t) {
  const parts = [t.kind];
  if (t.fields) parts.push(t.fields.map((f) => f.name + ':' + f.type).join(','));
  if (t.inputFields) parts.push(t.inputFields.map((f) => f.name + ':' + f.type).join(','));
  if (t.enumValues) parts.push(t.enumValues.map((v) => v.name).join(','));
  if (t.possibleTypes) parts.push([...t.possibleTypes].sort().join(','));
  if (t.interfaces) parts.push([...t.interfaces].sort().join(','));
  return parts.join('|');
}

function diffSurfaces(before, after) {
  return {
    queries: diffMap(before.queries, after.queries, opSig, opDelta),
    mutations: diffMap(before.mutations, after.mutations, opSig, opDelta),
    types: diffMap(before.types, after.types, typeSig, typeDelta),
  };
}

/* -------------------------------------------------------------------------- */
/* Payload                                                                    */
/* -------------------------------------------------------------------------- */

function buildPayload(surface, meta, before, changes) {
  const domains = new Map();
  const bucket = (domain) => {
    if (!domains.has(domain)) domains.set(domain, { queries: [], mutations: [], types: [] });
    return domains.get(domain);
  };

  const withChange = (entry, map) => {
    const c = map ? map.get(entry.name) : null;
    if (!c) return entry;
    const copy = { ...entry, change: c.change };
    if (c.note) copy.changeNote = c.note;
    return copy;
  };

  for (const [name, e] of surface.queries) bucket(domainFor(name)).queries.push(withChange(e, changes?.queries));
  for (const [name, e] of surface.mutations) bucket(domainFor(name)).mutations.push(withChange(e, changes?.mutations));
  for (const [name, e] of surface.types) bucket(domainForType(name)).types.push(withChange(e, changes?.types));

  // Entries that vanished in the new version are still worth seeing.
  if (before) {
    for (const [name, e] of before.queries) {
      if (!surface.queries.has(name)) bucket(domainFor(name)).queries.push({ ...e, change: 'removed' });
    }
    for (const [name, e] of before.mutations) {
      if (!surface.mutations.has(name)) bucket(domainFor(name)).mutations.push({ ...e, change: 'removed' });
    }
    for (const [name, e] of before.types) {
      if (!surface.types.has(name)) bucket(domainForType(name)).types.push({ ...e, change: 'removed' });
    }
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  const kindOrder = { OBJECT: 0, INTERFACE: 1, UNION: 2, INPUT_OBJECT: 3, ENUM: 4, SCALAR: 5 };

  const counts = {
    byDomain: {},
    total: { queries: 0, mutations: 0, types: 0 },
    byKind: {},
    changes: { added: 0, removed: 0, changed: 0, deprecated: 0 },
    deprecated: { queries: 0, mutations: 0, fields: 0 },
  };

  const out = {};
  for (const domain of [...domains.keys()].sort()) {
    const b = domains.get(domain);
    b.queries.sort(byName);
    b.mutations.sort(byName);
    b.types.sort((a, c) => (kindOrder[a.kind] ?? 9) - (kindOrder[c.kind] ?? 9) || byName(a, c));
    if (!b.queries.length && !b.mutations.length && !b.types.length) continue;
    out[domain] = b;
    counts.byDomain[domain] = { queries: b.queries.length, mutations: b.mutations.length, types: b.types.length };
    counts.total.queries += b.queries.length;
    counts.total.mutations += b.mutations.length;
    counts.total.types += b.types.length;

    for (const e of [...b.queries, ...b.mutations, ...b.types]) {
      if (e.change) counts.changes[e.change] = (counts.changes[e.change] || 0) + 1;
    }
    for (const e of b.types) {
      if (e.kind) counts.byKind[e.kind] = (counts.byKind[e.kind] || 0) + 1;
      for (const f of e.fields || []) {
        if (f.deprecated) counts.deprecated.fields++;
      }
    }
    for (const e of b.queries) if (e.deprecated) counts.deprecated.queries++;
    for (const e of b.mutations) if (e.deprecated) counts.deprecated.mutations++;
  }

  const unclassified = out[UNCLASSIFIED];
  const warnings = unclassified
    ? {
        queries: unclassified.queries.map((q) => q.name),
        mutations: unclassified.mutations.map((m) => m.name),
        types: unclassified.types.map((t) => t.name),
      }
    : null;

  let changeTotals = null;
  if (before) {
    changeTotals = { added: 0, removed: 0, changed: 0, deprecated: 0 };
    for (const map of [changes.queries, changes.mutations, changes.types]) {
      for (const c of map.values()) {
        if (changeTotals[c.change] !== undefined) changeTotals[c.change]++;
      }
    }
  }

  return {
    meta: {
      ...meta,
      roots: { query: surface.queryRoot, mutation: surface.mutationRoot },
      counts,
      domains: Object.keys(out).length,
      compare: before ? { version: meta.compareVersion, totals: changeTotals } : null,
    },
    domains: out,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shopify Admin GraphQL API — explorer</title>
<style>
:root{
  --bg:#fff; --bg-soft:#f7f8fa; --bg-elev:#fff; --fg:#181c22; --fg-soft:#5c6672;
  --border:#e4e7ec; --accent:#3b5bfd; --accent-soft:#eef1fe; --mark:#fff2a8;
  --warn:#9a5b00; --warn-soft:#fff4d6; --ok:#0f7b45; --ok-soft:#e6f6ed;
  --danger:#b4232b; --danger-soft:#fdecec;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
}
@media (prefers-color-scheme:dark){
  :root{ --bg:#0e1216; --bg-soft:#141a21; --bg-elev:#161d25; --fg:#e7ebf0; --fg-soft:#94a0af;
         --border:#242c36; --accent:#8aa2ff; --accent-soft:#1a2334; --mark:#5a4a00;
         --warn:#f5c86a; --warn-soft:#2b2413; --ok:#6ede9f; --ok-soft:#12291d;
         --danger:#ff9a9a; --danger-soft:#2d1618; }
}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--fg);display:flex;flex-direction:column;height:100%;
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
code,.mono{font-family:var(--mono)}
a{color:var(--accent)}
.banner{flex:none;display:flex;gap:16px;align-items:center;justify-content:space-between;
  flex-wrap:wrap;padding:12px 20px;background:var(--bg-elev);border-bottom:1px solid var(--border)}
.brand h1{margin:0;font-size:15px;letter-spacing:.01em}
.meta{margin-top:4px;color:var(--fg-soft);font-size:12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.chip{display:inline-block;padding:1px 7px;border:1px solid var(--border);border-radius:999px;
  background:var(--bg-soft);font-size:11px;color:var(--fg-soft)}
.chip.n{background:var(--accent-soft);color:var(--accent);border-color:transparent;font-weight:600}
.search input{width:min(46vw,460px);padding:8px 12px;border:1px solid var(--border);border-radius:8px;
  background:var(--bg-soft);color:var(--fg);font-size:13px;outline:none}
.search input:focus{border-color:var(--accent);background:var(--bg-elev);box-shadow:0 0 0 3px var(--accent-soft)}
.layout{flex:1;min-height:0;display:grid;grid-template-columns:262px minmax(0,1fr)}
@media (max-width:820px){
  .layout{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,36%) minmax(0,64%)}
  .sidebar{border-right:0;border-bottom:1px solid var(--border)}
  .search input{width:100%}
}
.sidebar{border-right:1px solid var(--border);background:var(--bg-soft);overflow:auto;padding:12px}
.seg{display:flex;gap:2px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:2px;margin-bottom:12px}
.seg button{flex:1;border:0;background:transparent;color:var(--fg-soft);font:inherit;font-size:12px;
  padding:6px 4px;border-radius:6px;cursor:pointer}
.seg button[aria-selected="true"]{background:var(--accent-soft);color:var(--accent);font-weight:600}
.side-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--fg-soft);margin:14px 0 6px 6px}
.side-label:first-of-type{margin-top:0}
.filters{display:flex;flex-wrap:wrap;gap:4px;padding:0 4px}
.filters button{border:1px solid var(--border);background:var(--bg);color:var(--fg-soft);font:inherit;
  font-size:11.5px;padding:3px 8px;border-radius:999px;cursor:pointer}
.filters button:hover{border-color:var(--accent);color:var(--accent)}
.filters button[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent);border-color:transparent;font-weight:600}
.filters button.c-added[aria-pressed="true"]{background:var(--ok-soft);color:var(--ok)}
.filters button.c-removed[aria-pressed="true"]{background:var(--danger-soft);color:var(--danger)}
.domains{display:flex;flex-direction:column;gap:1px}
.domains button{display:flex;gap:8px;align-items:baseline;width:100%;text-align:left;border:0;border-radius:6px;
  background:transparent;color:var(--fg);font:inherit;font-size:13px;padding:6px 8px;cursor:pointer}
.domains button:hover{background:var(--bg-elev)}
.domains button[aria-current="true"]{background:var(--accent-soft);color:var(--accent);font-weight:600}
.domains .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.domains .ct{color:var(--fg-soft);font-size:11px;font-variant-numeric:tabular-nums}
.domains button[aria-current="true"] .ct{color:inherit}
.domains .empty{color:var(--fg-soft);font-size:12px;padding:6px 8px}
.pane{overflow:auto;padding:16px 20px 60px}
.pane-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;
  flex-wrap:wrap;margin-bottom:10px}
.pane-title{font-size:13px;color:var(--fg-soft)}
.pane-title strong{color:var(--fg);font-size:15px}
.pane-actions button{margin-left:6px;border:1px solid var(--border);background:var(--bg-elev);color:var(--fg-soft);
  font:inherit;font-size:12px;padding:4px 9px;border-radius:6px;cursor:pointer}
.pane-actions button:hover{color:var(--accent);border-color:var(--accent)}
.group{border:1px solid var(--border);border-radius:9px;background:var(--bg-elev);margin-bottom:10px;overflow:hidden}
.group-head{display:flex;gap:9px;align-items:baseline;padding:10px 12px;cursor:pointer;user-select:none;min-width:0}
.group-head:hover{background:var(--bg-soft)}
.group-head .caret{color:var(--fg-soft);font-size:11px;width:10px;flex:none}
.group-name{font-weight:600;font-size:13.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.group .count{color:var(--fg-soft);font-size:11px;font-variant-numeric:tabular-nums;
  border:1px solid var(--border);border-radius:999px;padding:0 7px}
.group-body{border-top:1px solid var(--border)}
.node{border-bottom:1px solid var(--border)}
.node:last-child{border-bottom:0}
.row{display:flex;gap:10px;align-items:baseline;padding:7px 12px;cursor:default;overflow:hidden}
.row.has-detail{cursor:pointer}
.row.has-detail:hover{background:var(--bg-soft)}
.row .caret{color:var(--fg-soft);font-size:10px;width:9px;flex:none}
.row .nm{font-family:var(--mono);font-size:12.5px;font-weight:600;white-space:nowrap;
  flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.row .sig{font-family:var(--mono);font-size:11.5px;color:var(--fg-soft);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}
.badge{font-size:10px;padding:0 6px;border-radius:999px;border:1px solid var(--border);color:var(--fg-soft);flex:none}
.badge.dep{background:var(--warn-soft);color:var(--warn);border-color:transparent}
.badge.conn{background:var(--accent-soft);color:var(--accent);border-color:transparent}
.badge.added{background:var(--ok-soft);color:var(--ok);border-color:transparent}
.badge.removed{background:var(--danger-soft);color:var(--danger);border-color:transparent}
.badge.changed{background:var(--warn-soft);color:var(--warn);border-color:transparent}
.badge.deprecated{background:var(--warn-soft);color:var(--warn);border-color:transparent}
.type-link{color:var(--accent);cursor:pointer;border-bottom:1px dotted var(--accent)}
.type-link:hover{background:var(--accent-soft)}
.detail{padding:2px 12px 12px 31px;background:var(--bg-soft);font-size:12.5px;color:var(--fg-soft)}
.detail p{margin:6px 0}
.detail .args{margin:6px 0 0;padding:0;list-style:none;font-family:var(--mono);font-size:11.5px}
.detail .args li{padding:2px 0}
.detail .args .req{color:var(--accent)}
.note{background:var(--warn-soft);color:var(--warn);border-radius:6px;padding:6px 9px;margin:8px 0;font-size:12px}
.note.err{background:var(--danger-soft);color:var(--danger)}
.note.ok{background:var(--ok-soft);color:var(--ok)}
.tools{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.tools button{border:1px solid var(--border);background:var(--bg-elev);color:var(--fg-soft);font:inherit;
  font-size:11.5px;padding:3px 9px;border-radius:6px;cursor:pointer}
.tools button:hover{border-color:var(--accent);color:var(--accent)}
.tools button.ok{border-color:var(--ok);color:var(--ok)}
mark{background:var(--mark);color:inherit;border-radius:2px}
.node.flash{animation:flash 1.7s ease-out}
@keyframes flash{0%{background:var(--accent-soft)}100%{background:transparent}}
.row.kbd,.group-head.kbd{box-shadow:inset 0 0 0 2px var(--accent)}
.empty-state{color:var(--fg-soft);padding:20px 4px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;margin-bottom:16px}
.tile{border:1px solid var(--border);border-radius:9px;background:var(--bg-elev);padding:12px 14px}
.tile .v{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.tile .l{color:var(--fg-soft);font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
.card{border:1px solid var(--border);border-radius:9px;background:var(--bg-elev);padding:14px 16px;margin-bottom:12px}
.card h2{margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--fg-soft)}
.bars{display:flex;flex-direction:column;gap:6px}
.bar{display:grid;grid-template-columns:190px minmax(0,1fr) 52px;gap:10px;align-items:center;font-size:12.5px}
.bar .bl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg)}
.bar .bt{height:8px;border-radius:999px;background:var(--bg-soft);overflow:hidden}
.bar .bf{height:100%;background:var(--accent);border-radius:999px}
.bar .bv{text-align:right;color:var(--fg-soft);font-variant-numeric:tabular-nums}
.kinds{display:flex;gap:8px;flex-wrap:wrap}
.kinds span{border:1px solid var(--border);border-radius:999px;padding:2px 9px;font-size:12px;color:var(--fg-soft)}
.kinds b{color:var(--fg)}
.hint{color:var(--fg-soft);font-size:12px;margin-top:8px}
.example{margin-top:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-soft);padding:10px 12px}
.example .ex-title{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--fg-soft);margin-bottom:6px}
.example .ex-sub{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--fg-soft);margin:10px 0 4px}
.example pre.code{margin:0;overflow-x:auto;font-family:var(--mono);font-size:12px;line-height:1.5;color:var(--fg);white-space:pre}
.example .hint{margin-top:8px}
kbd{border:1px solid var(--border);border-bottom-width:2px;border-radius:4px;padding:0 4px;font-size:11px;
  background:var(--bg-soft);font-family:var(--mono)}
.versions{display:flex;gap:6px;margin-bottom:8px}
.versions a{font:inherit;font-size:12px;text-decoration:none;border:1px solid var(--border);border-radius:999px;
  padding:2px 10px;color:var(--fg-soft);background:var(--bg-elev)}
.versions a:hover{border-color:var(--accent);color:var(--accent)}
.versions a.current{background:var(--accent-soft);border-color:var(--accent);color:var(--accent);font-weight:600}
</style>
</head>
<body>
<header class="banner">
  <div class="brand">
    <h1>Shopify Admin GraphQL API</h1>
    <div class="meta" id="meta"></div>
  </div>
  <div class="versions" id="versions"></div>
  <div class="search"><input id="q" type="search" placeholder="Search fields, types, domains…   ( / )" autocomplete="off" spellcheck="false"></div>
</header>
<div class="layout">
  <aside class="sidebar">
    <div class="seg" id="seg" role="tablist"></div>
    <p class="side-label">Filters</p>
    <div class="filters" id="filters"></div>
    <p class="side-label">Domains</p>
    <nav class="domains" id="domains"></nav>
  </aside>
  <main class="pane">
    <div class="pane-head">
      <div class="pane-title" id="paneTitle"></div>
      <div class="pane-actions">
        <button id="expandAll" type="button">Expand all</button>
        <button id="collapseAll" type="button">Collapse all</button>
      </div>
    </div>
    <div class="tree" id="tree"></div>
  </main>
</div>
<script>
var DATA = "__SHOPIFY_TREE_DATA__";
(function(){
  "use strict";

  var KINDS = ["queries","mutations","types"];
  var LABEL = { queries:"Queries", mutations:"Mutations", types:"Types" };
  var KIND_FILTERS = [["","All kinds"],["OBJECT","Object"],["INTERFACE","Interface"],["UNION","Union"],
                      ["INPUT_OBJECT","Input"],["ENUM","Enum"],["SCALAR","Scalar"]];
  var CHANGE_LABELS = { added:"New", removed:"Removed", changed:"Changed", deprecated:"Deprecated" };
  var RESULT_CAP = 400;

  var state = {
    kind:"queries", domain:"all", q:"", focus:null,
    typeKind:"", change:"",
    deprecatedOnly:false, connectionsOnly:false
  };
  var index = [];
  var typeIndex = {};
  var typeByName = {};
  var expansion = {};
  var groups = [];
  var changeCounts = {};

  var $ = function(id){ return document.getElementById(id); };
  var el = function(tag, cls, text){
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  /* --------------------------- indices ---------------------------------- */

  function buildIndices(){
    var out = [], doms = DATA.domains;
    for (var d in doms){
      if (!Object.prototype.hasOwnProperty.call(doms, d)) continue;
      var bucket = doms[d];
      for (var k = 0; k < KINDS.length; k++){
        var arr = bucket[KINDS[k]] || [];
        for (var i = 0; i < arr.length; i++){
          var it = arr[i];
          out.push({
            domain:d, kind:KINDS[k], name:it.name, item:it,
            hay: (it.name + " " + (it.type||"") + " " + d + " " + (it.description||"")).toLowerCase()
          });
          if (KINDS[k] === "types"){ typeIndex[it.name] = { kind: it.kind, domain: d }; typeByName[it.name] = it; }
        }
      }
    }
    index = out;
    changeCounts = (DATA.meta.counts && DATA.meta.counts.changes) || {};
  }

  /* --------------------------- filtering -------------------------------- */

  function passesFilters(item){
    if (state.deprecatedOnly && !item.deprecated && item.change !== "deprecated") return false;
    if (state.connectionsOnly){
      if (!(item.args && /Connection!?$/.test(item.type || ""))) return false;
    }
    if (state.change && item.change !== state.change) return false;
    if (state.kind === "types" && state.typeKind && item.kind !== state.typeKind) return false;
    return true;
  }

  function filtersActive(){
    return !!(state.typeKind || state.change || state.deprecatedOnly || state.connectionsOnly);
  }

  function terms(){ return state.q.trim().toLowerCase().split(/\\s+/).filter(Boolean); }

  function searchResults(){
    var t = terms();
    if (!t.length) return null;
    var out = [];
    for (var i = 0; i < index.length; i++){
      var e = index[i];
      if (e.kind !== state.kind) continue;
      if (!passesFilters(e.item)) continue;
      var ok = true;
      for (var j = 0; j < t.length; j++){
        if (e.hay.indexOf(t[j]) === -1){ ok = false; break; }
      }
      if (ok) out.push(e);
    }
    return out;
  }

  function domainCounts(){
    var counts = {};
    for (var i = 0; i < index.length; i++){
      var e = index[i];
      if (e.kind !== state.kind) continue;
      if (!passesFilters(e.item)) continue;
      counts[e.domain] = (counts[e.domain] || 0) + 1;
    }
    return counts;
  }

  function byDomain(list){
    var map = {}, order = [];
    for (var i = 0; i < list.length; i++){
      var d = list[i].domain;
      if (!map[d]){ map[d] = []; order.push(d); }
      map[d].push(list[i]);
    }
    order.sort();
    return { map:map, order:order };
  }

  function highlight(text, q){
    var t = q.trim().toLowerCase().split(/\\s+/).filter(Boolean);
    if (!t.length) return document.createTextNode(text);
    var frag = document.createDocumentFragment(), lower = text.toLowerCase(), i = 0;
    while (i < text.length){
      var best = -1, len = 0;
      for (var j = 0; j < t.length; j++){
        var idx = lower.indexOf(t[j], i);
        if (idx !== -1 && (best === -1 || idx < best)){ best = idx; len = t[j].length; }
      }
      if (best === -1){ frag.appendChild(document.createTextNode(text.slice(i))); break; }
      if (best > i) frag.appendChild(document.createTextNode(text.slice(i, best)));
      var m = document.createElement("mark");
      m.textContent = text.substr(best, len);
      frag.appendChild(m);
      i = best + len;
    }
    return frag;
  }

  /* --------------------------- type drill-down -------------------------- */

  function typeSigFragment(sig){
    var frag = document.createDocumentFragment();
    var tokens = String(sig).match(/[A-Za-z_][A-Za-z0-9_]*|[^A-Za-z0-9_]+/g) || [];
    for (var i = 0; i < tokens.length; i++){
      var tok = tokens[i];
      if (typeIndex[tok]){
        (function(name){
          var link = el("span","type-link", name);
          link.title = "Go to " + name + " (" + typeIndex[name].kind + ")";
          link.addEventListener("click", function(ev){
            ev.stopPropagation();
            drillTo(name);
          });
          frag.appendChild(link);
        })(tok);
      } else {
        frag.appendChild(document.createTextNode(tok));
      }
    }
    return frag;
  }

  function drillTo(typeName){
    var hit = typeIndex[typeName];
    if (!hit) return;
    state.kind = "types";
    state.domain = hit.domain;
    state.q = "";
    state.typeKind = "";
    state.change = "";
    $("q").value = "";
    state.focus = hit.domain + "|" + typeName;
    render({ push:true });
  }

  /* --------------------------- snippets --------------------------------- */

  function cap(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

  /* ------------------------ example generation -------------------------- */

  // Realistic-looking sample values, keyed off the argument's named type so
  // the generated snippets feel like real requests instead of "TODO"s.
  function sampleValueFor(typeName, argName){
    var t = String(typeName || "");
    var bare = t.replace(/[\\[\\]!]/g, "");
    var isList = /\\[/.test(t);
    var info = typeByName[bare];
    var n = argName || "";
    if (bare === "ID") return isList ? ["gid://shopify/Product/1234567890"] : "gid://shopify/Product/1234567890";
    if (bare === "Int") return isList ? [10, 20] : 10;
    if (bare === "Float") return 1.5;
    if (bare === "Boolean") return true;
    if (bare === "String") return n === "query" ? "status:ACTIVE" : "example";
    if (info && info.kind === "INPUT_OBJECT"){
      var obj = {};
      var ins = info.inputFields || [];
      for (var i = 0; i < ins.length && i < 4; i++){
        obj[ins[i].name] = sampleValueFor(ins[i].type, ins[i].name);
      }
      return obj;
    }
    if (/DateTime|Date$/.test(bare)) return bare === "Date" ? "2026-01-15" : "2026-01-15T12:30:00Z";
    if (/URL/.test(bare)) return "https://example.com";
    if (/HTML/.test(bare)) return "<p>Hello world</p>";
    if (/Money$/.test(bare)) return { amount: "10.99", currencyCode: "USD" };
    if (bare === "Decimal") return "10.99";
    if (bare === "CountryCode") return isList ? ["US", "CA"] : "US";
    if (bare === "LanguageCode") return "EN";
    if (bare === "CurrencyCode") return "USD";
    if (info && info.kind === "ENUM"){
      var vals = (info.enumValues || []).filter(function(v){ return !v.deprecated; });
      var pick = vals.length ? vals[0].name : (info.enumValues[0] ? info.enumValues[0].name : "VALUE");
      return isList ? [pick] : pick;
    }
    return "REPLACE_ME";
  }

  function variablesFor(item){
    var req = (item.args || []).filter(function(a){ return a.required; });
    if (!req.length) return null;
    var out = {};
    for (var i = 0; i < req.length; i++) out[req[i].name] = sampleValueFor(req[i].type, req[i].name);
    return out;
  }

  // A scalar-ish field we can safely terminate a selection on.
  function isLeafType(name){
    var info = typeByName[name];
    if (!info) return true; // built-in scalar
    return info.kind === "SCALAR" || info.kind === "ENUM";
  }

  function pickFields(typeName, max){
    var info = typeByName[typeName];
    if (!info || !info.fields) return [];
    var out = [];
    var fields = info.fields;
    for (var i = 0; i < fields.length && out.length < max; i++){
      var f = fields[i];
      if (f.deprecated) continue;
      if (f.args && f.args.length) continue; // needs args — skip in auto examples
      var inner = f.inner;
      if (isLeafType(inner)) out.push(f);
    }
    return out;
  }

  // Build a multi-level example selection. Connections expand to
  // edges { node { ... } } + pageInfo so the snippet shows pagination too.
  function selectionForType(typeName, depth){
    function indent(n){ return new Array(n + 1).join("  "); }
    var bare = String(typeName || "").replace(/[\\[\\]!]/g, "");
    var info = typeByName[bare];
    if (depth > 2) return [["id", 0]];
    if (/Connection$/.test(bare)){
      var m = bare.match(/^(.+)Connection$/);
      var nodeType = m ? m[1] : null;
      var nodeSel = (nodeType && typeByName[nodeType]) ? selectionForType(nodeType, depth + 1) : [["id", 0]];
      var out = [["edges {", 0], ["node {", 1]];
      for (var i = 0; i < nodeSel.length; i++){
        out.push([nodeSel[i][0], nodeSel[i][1] + 2]);
      }
      out.push(["}", 1]);
      out.push(["}", 0]);
      out.push(["pageInfo {", 0]);
      out.push(["hasNextPage", 1]);
      out.push(["endCursor", 1]);
      out.push(["}", 0]);
      return out;
    }
    if (!info) return [["id", 0]];
    if (info.kind === "INTERFACE" || info.kind === "UNION"){
      var poss = info.possibleTypes || [];
      if (!poss.length || depth > 1) return [["id", 0]];
      var frag = [["__typename", 0], ["... on " + poss[0] + " {", 0]];
      var sub = selectionForType(poss[0], depth + 1);
      for (var j = 0; j < sub.length; j++) frag.push([sub[j][0], sub[j][1] + 1]);
      frag.push(["}", 0]);
      return frag;
    }
    if (info.kind === "OBJECT"){
      var leaves = pickFields(bare, 5);
      var out2 = [];
      for (var k = 0; k < leaves.length; k++) out2.push([leaves[k].name, 0]);
      if (!out2.length) return [["id", 0]];
      if (depth < 2){
        var fields = info.fields;
        for (var f2 = 0; f2 < fields.length && out2.length < 6; f2++){
          var ff = fields[f2];
          if (ff.deprecated || (ff.args && ff.args.length)) continue;
          var inner2 = ff.inner;
          if (inner2 && typeByName[inner2] && typeByName[inner2].kind === "OBJECT" && !/Connection$/.test(inner2)){
            var nested = selectionForType(inner2, depth + 1);
            if (nested.length && nested.length <= 3){
              out2.push([ff.name + " {", 0]);
              for (var n2 = 0; n2 < nested.length; n2++) out2.push([nested[n2][0], nested[n2][1] + 1]);
              out2.push(["}", 0]);
              break;
            }
          }
        }
      }
      return out2;
    }
    return [["id", 0]];
  }

  function selectionFor(item){
    var lines;
    if (/Connection!?$/.test(item.type || "")) lines = selectionForType(item.type.replace(/!$/, ""), 0);
    else if (item.inner && typeByName[item.inner]) lines = selectionForType(item.inner, 0);
    else return "";
    return lines.map(function(pair){ return pair[1] > 0 ? indentOf(pair[1]) + pair[0] : pair[0]; }).join("\\n");
    function indentOf(n){ return new Array(n + 1).join("  "); }
  }

  function variablesTextFor(item){
    var v = variablesFor(item);
    return v ? JSON.stringify(v, null, 2) : null;
  }

  function opFor(item, kind){
    var req = (item.args || []).filter(function(a){ return a.required; });
    var decls = req.map(function(a){ return "$" + a.name + ": " + a.type; });
    var uses = req.map(function(a){ return a.name + ": $" + a.name; });
    var opType = kind === "mutations" ? "mutation" : "query";
    var opName = (kind === "mutations" ? "Do" : "Get") + cap(item.name);
    var body = selectionFor(item);
    var call = item.name + (uses.length ? "(" + uses.join(", ") + ")" : "");
    var out = [];
    out.push(opType + " " + opName + (decls.length ? "(" + decls.join(", ") + ")" : "") + " {");
    if (body){
      out.push("  " + call + " {");
      body.split("\\n").forEach(function(l){ out.push("    " + l); });
      out.push("  }");
    } else {
      out.push("  " + call);
    }
    out.push("}");
    if (req.length){
      out.push("");
      out.push("# required arguments: " + req.map(function(a){ return "$" + a.name + " (" + a.type + ")"; }).join(", "));
    }
    return out.join("\\n");
  }

  function curlFor(query, variables){
    var payload = { query: query };
    if (variables) payload.variables = variables;
    var body = JSON.stringify(payload);
    return "curl -X POST \\\\\\n" +
      "  https://{shop}.myshopify.com/admin/api/" + DATA.meta.version + "/graphql.json \\\\\\n" +
      "  -H 'Content-Type: application/json' \\\\\\n" +
      "  -H 'X-Shopify-Access-Token: $SHOPIFY_ACCESS_TOKEN' \\\\\\n" +
      "  -d '" + body + "'";
  }

  function copyText(text, btn){
    function done(ok){
      btn.classList.add(ok ? "ok" : "err");
      var prev = btn.getAttribute("data-label") || btn.textContent;
      btn.setAttribute("data-label", prev);
      btn.textContent = ok ? "Copied" : "Select & copy";
      setTimeout(function(){ btn.textContent = prev; btn.classList.remove("ok"); btn.classList.remove("err"); }, 1300);
    }
    function fallback(){
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly","");
      ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch(e){ ok = false; }
      document.body.removeChild(ta);
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){ done(true); }, fallback);
    } else {
      fallback();
    }
  }

  /* --------------------------- building --------------------------------- */

  function changeBadge(change){
    if (!change) return null;
    return el("span","badge " + change, CHANGE_LABELS[change] || change);
  }

  function buildGroup(title, count, key, buildBody, initiallyOpen){
    var wrap = el("div","group");
    var head = el("div","group-head");
    head.tabIndex = 0;
    var caret = el("span","caret","▸");
    var nameEl = el("span","group-name", title);
    var countEl = el("span","count", String(count));
    head.appendChild(caret); head.appendChild(nameEl); head.appendChild(countEl);
    var body = el("div","group-body");
    body.style.display = "none";
    var built = false, open = false;

    function setOpen(v){
      open = v;
      expansion[key] = v;
      caret.textContent = v ? "▾" : "▸";
      if (v && !built){ built = true; buildBody(body); }
      body.style.display = v ? "" : "none";
    }
    head.addEventListener("click", function(){ setOpen(!open); });
    head.addEventListener("keydown", function(e){
      if (e.key === "Enter" || e.key === " "){ e.preventDefault(); setOpen(!open); }
    });

    wrap.appendChild(head); wrap.appendChild(body);
    groups.push({ setOpen:setOpen, isOpen:function(){ return open; }, key:key });
    setOpen(initiallyOpen);
    return wrap;
  }

  function fieldNode(item, domain, q){
    var node = el("div","node");
    node.setAttribute("data-key", domain + "|" + item.name);

    var hasDetail = !!(item.description || (item.args && item.args.length) ||
                       (item.inputFields && item.inputFields.length) || item.deprecated ||
                       item.change || (item.enumValues && item.enumValues.length) ||
                       (item.fields && item.fields.length) || item.interfaces ||
                       item.possibleTypes);

    var row = el("div","row" + (hasDetail ? " has-detail" : ""));
    var caret = el("span","caret", hasDetail ? "▸" : "");
    var nm = el("span","nm");
    nm.appendChild(q ? highlight(item.name, q) : document.createTextNode(item.name));
    row.appendChild(caret); row.appendChild(nm);

    if (item.type){
      var sig = el("span","sig");
      sig.appendChild(document.createTextNode(": "));
      sig.appendChild(typeSigFragment(item.type));
      row.appendChild(sig);
      if (/Connection!?$/.test(item.type)) row.appendChild(el("span","badge conn","connection"));
    } else if (item.kind){
      var kindLabels = { OBJECT:"object", INTERFACE:"interface", UNION:"union",
                         INPUT_OBJECT:"input", ENUM:"enum", SCALAR:"scalar" };
      row.appendChild(el("span","badge", kindLabels[item.kind] || item.kind.toLowerCase()));
    }

    if (item.deprecated) row.appendChild(el("span","badge dep","deprecated"));
    var cb = changeBadge(item.change);
    if (cb) row.appendChild(cb);

    node.appendChild(row);
    if (!hasDetail) return node;

    var detail = null, open = false;
    function toggle(){
      if (!detail){
        detail = el("div","detail");
        if (item.change){
          detail.appendChild(el("div","note",
            CHANGE_LABELS[item.change] + " in " + (DATA.meta.compare ? DATA.meta.compare.version : "this version") +
            (item.changeNote ? ": " + item.changeNote : ".")));
        }
        if (item.deprecated){
          detail.appendChild(el("div","note","Deprecated" +
            (item.deprecationReason ? ": " + item.deprecationReason : ".")));
        }
        if (item.description) detail.appendChild(el("p", null, item.description));

        var args = item.args || item.inputFields || [];
        if (args.length){
          detail.appendChild(el("p", null, "Arguments:"));
          var ul = el("ul","args");
          for (var i = 0; i < args.length; i++){
            var li = el("li");
            var sig = el("span", args[i].required ? "req" : null);
            sig.appendChild(document.createTextNode(args[i].name + ": "));
            sig.appendChild(typeSigFragment(args[i].type));
            li.appendChild(sig);
            if (args[i].description) li.appendChild(document.createTextNode("  — " + args[i].description));
            ul.appendChild(li);
          }
          detail.appendChild(ul);
        }
        if (item.interfaces && item.interfaces.length) detail.appendChild(el("p", null, "Implements: " + item.interfaces.join(", ")));
        if (item.possibleTypes && item.possibleTypes.length) detail.appendChild(el("p", null, "Possible types: " + item.possibleTypes.join(", ")));

        if (item.enumValues && item.enumValues.length){
          detail.appendChild(el("p", null, item.enumValues.length + " values:"));
          var eu = el("ul","args");
          for (var v = 0; v < item.enumValues.length; v++){
            var eli = el("li");
            eli.appendChild(el("span", null, item.enumValues[v].name));
            if (item.enumValues[v].deprecated) eli.appendChild(document.createTextNode("  (deprecated)"));
            else if (item.enumValues[v].description) eli.appendChild(document.createTextNode("  — " + item.enumValues[v].description));
            eu.appendChild(eli);
          }
          detail.appendChild(eu);
        }

        if (item.fields && item.fields.length){
          detail.appendChild(el("p", null, item.fields.length + " field" + (item.fields.length === 1 ? "" : "s") + ":"));
          var fu = el("ul","args");
          for (var f = 0; f < item.fields.length; f++){
            var fli = el("li");
            fli.appendChild(el("span", null, item.fields[f].name + ": "));
            fli.appendChild(typeSigFragment(item.fields[f].type));
            if (item.fields[f].deprecated) fli.appendChild(document.createTextNode("  (deprecated)"));
            fu.appendChild(fli);
          }
          detail.appendChild(fu);
        }

        if (item.args){
          var exQuery = opFor(item, state.kind);
          var exVars = variablesTextFor(item);

          // --- runnable example block --------------------------------
          var exWrap = el("div","example");
          exWrap.appendChild(el("div","ex-title","Example"));
          var pre = el("pre","code");
          pre.textContent = exQuery;
          exWrap.appendChild(pre);
          if (exVars){
            exWrap.appendChild(el("div","ex-sub","Variables (JSON)"));
            var vpre = el("pre","code");
            vpre.textContent = exVars;
            exWrap.appendChild(vpre);
          }
          if (/Connection!?$/.test(item.type || "")){
            exWrap.appendChild(el("div","hint","This returns a connection — page through it with the after argument and pageInfo.endCursor, and cap page size with first. Example: first: 50, after: \\"<endCursor>\\"."));
          }
          var req = (item.args || []).filter(function(a){ return a.required; });
          if (req.length){
            exWrap.appendChild(el("div","hint","Required arguments are declared as variables — replace the sample values above with your own IDs and inputs."));
          }

          var tools = el("div","tools");
          var mkBtn = function(label, getText){
            var b = el("button","",label);
            b.type = "button";
            b.addEventListener("click", function(ev){
              ev.stopPropagation();
              copyText(getText(), b);
            });
            return b;
          };
          tools.appendChild(mkBtn("Copy query", function(){ return exQuery; }));
          if (exVars) tools.appendChild(mkBtn("Copy variables", function(){ return exVars; }));
          tools.appendChild(mkBtn("Copy curl", function(){
            return curlFor(exQuery, exVars ? JSON.parse(exVars) : undefined);
          }));
          tools.appendChild(mkBtn("Copy JS fetch", function(){
            var payload = { query: exQuery };
            if (exVars) payload.variables = JSON.parse(exVars);
            return "const response = await fetch(\\"https://{shop}.myshopify.com/admin/api/" + DATA.meta.version + "/graphql.json\\", {\\n" +
              "  method: \\"POST\\",\\n" +
              "  headers: {\\n" +
              "    \\"Content-Type\\": \\"application/json\\",\\n" +
              "    \\"X-Shopify-Access-Token\\": process.env.SHOPIFY_ACCESS_TOKEN,\\n" +
              "  },\\n" +
              "  body: JSON.stringify(" + JSON.stringify(payload, null, 2) + "),\\n" +
              "});\\nconst { data, errors } = await response.json();\\nif (errors) console.error(errors);\\nconsole.log(JSON.stringify(data, null, 2));";
          }));
          exWrap.appendChild(tools);
          detail.appendChild(exWrap);
        }

        node.appendChild(detail);
      }
      open = !open;
      caret.textContent = open ? "▾" : "▸";
      detail.style.display = open ? "" : "none";
    }
    row.addEventListener("click", toggle);
    return node;
  }

  /* --------------------------- rendering -------------------------------- */

  function renderSeg(){
    var seg = $("seg");
    while (seg.firstChild) seg.removeChild(seg.firstChild);
    var counts = DATA.meta.counts.total;
    for (var i = 0; i < KINDS.length; i++){
      (function(k){
        var b = el("button","",LABEL[k]);
        b.type = "button";
        b.setAttribute("role","tab");
        b.setAttribute("aria-selected", state.kind === k ? "true" : "false");
        b.title = LABEL[k] + " " + counts[k];
        b.addEventListener("click", function(){
          if (state.kind === k) return;
          state.kind = k;
          state.focus = null;
          state.typeKind = "";
          expansion = {};
          render({ push:true });
        });
        seg.appendChild(b);
      })(KINDS[i]);
    }
  }

  function renderFilters(){
    var host = $("filters");
    while (host.firstChild) host.removeChild(host.firstChild);

    function toggle(label, active, cls, onHit){
      var b = el("button", cls, label);
      b.type = "button";
      b.setAttribute("aria-pressed", active ? "true" : "false");
      b.addEventListener("click", function(){ onHit(!active); });
      host.appendChild(b);
      return b;
    }

    if (state.kind === "types"){
      for (var i = 0; i < KIND_FILTERS.length; i++){
        (function(pair){
          var on = state.typeKind === pair[0];
          toggle(pair[1], on, "", function(){
            state.typeKind = on ? "" : pair[0];
            render();
          });
        })(KIND_FILTERS[i]);
      }
    }

    toggle("Deprecated only", state.deprecatedOnly, "", function(v){
      state.deprecatedOnly = v; render();
    });

    if (state.kind !== "types"){
      toggle("Connections only", state.connectionsOnly, "", function(v){
        state.connectionsOnly = v; render();
      });
    }

    if (DATA.meta.compare){
      var keys = ["added","removed","changed","deprecated"];
      for (var c = 0; c < keys.length; c++){
        (function(key){
          var on = state.change === key;
          var n = changeCounts[key] || 0;
          toggle(CHANGE_LABELS[key] + " " + n, on, "c-" + key, function(){
            state.change = on ? "" : key;
            render();
          });
        })(keys[c]);
      }
    }

    if (!host.firstChild) host.appendChild(el("span","hint","No filters for this tab."));
  }

  function renderSidebar(){
    var host = $("domains");
    while (host.firstChild) host.removeChild(host.firstChild);

    var results = searchResults();
    var counts = results ? null : domainCounts();

    function entry(label, value, value2, key, current){
      var b = el("button");
      b.type = "button";
      b.appendChild(el("span","nm", label));
      if (value != null) b.appendChild(el("span","ct", String(value)));
      if (current) b.setAttribute("aria-current","true");
      b.addEventListener("click", function(){
        state.domain = key;
        state.focus = null;
        render({ push:true });
      });
      return b;
    }

    host.appendChild(entry("Overview", null, null, "overview", state.domain === "overview"));

    var filtered = results ? byDomain(results) : null;
    var total = results ? results.length
      : Object.keys(counts).reduce(function(a, k){ return a + counts[k]; }, 0);
    host.appendChild(entry("All " + LABEL[state.kind].toLowerCase(), total, null, "all", state.domain === "all"));

    var names = Object.keys(DATA.meta.counts.byDomain).sort(function(a, b){
      var av = results ? (filtered.map[a] ? filtered.map[a].length : 0) : (counts[a] || 0);
      var bv = results ? (filtered.map[b] ? filtered.map[b].length : 0) : (counts[b] || 0);
      return bv - av || a.localeCompare(b);
    });

    var shown = 0;
    for (var n = 0; n < names.length; n++){
      var d = names[n];
      var value = results ? (filtered.map[d] ? filtered.map[d].length : 0) : (counts[d] || 0);
      if (!value) continue;
      host.appendChild(entry(d, value, null, d, state.domain === d));
      shown++;
    }
    if (!shown) host.appendChild(el("div","empty","Nothing matches the current filters"));
  }

  function renderOverview(){
    var host = $("tree"), title = $("paneTitle");
    title.innerHTML = "";
    title.appendChild(el("strong", null, "Overview"));
    title.appendChild(document.createTextNode(" · the shape of this API version"));

    var c = DATA.meta.counts;
    var tiles = el("div","tiles");
    function tile(value, label){
      var t = el("div","tile");
      t.appendChild(el("div","v", String(value)));
      t.appendChild(el("div","l", label));
      tiles.appendChild(t);
    }
    tile(DATA.meta.version, "API version");
    tile(c.total.queries, "Queries");
    tile(c.total.mutations, "Mutations");
    tile(c.total.types, "Types");
    tile(DATA.meta.domains, "Domains");
    tile(c.deprecated.queries + c.deprecated.mutations, "Deprecated ops");
    tile(c.deprecated.fields, "Deprecated fields");
    if (DATA.meta.compare) tile(DATA.meta.compare.version, "Compared with");
    host.appendChild(tiles);

    if (DATA.meta.compare){
      var card = el("div","card");
      card.appendChild(el("h2", null, "Changes since " + DATA.meta.compare.version));
      var km = el("div","kinds");
      var t2 = DATA.meta.compare.totals || {};
      ["added","removed","changed","deprecated"].forEach(function(k){
        var s = el("span");
        s.appendChild(document.createTextNode(CHANGE_LABELS[k] + ": "));
        s.appendChild(el("b", null, String(t2[k] || 0)));
        km.appendChild(s);
      });
      card.appendChild(km);
      card.appendChild(el("div","hint","Use the filter chips in the sidebar to show only one kind of change."));
      host.appendChild(card);
    }

    var kinds = el("div","card");
    kinds.appendChild(el("h2", null, "Type kinds"));
    var kk = el("div","kinds");
    Object.keys(c.byKind).sort(function(a,b){ return c.byKind[b] - c.byKind[a]; }).forEach(function(k){
      var s = el("span");
      s.appendChild(document.createTextNode(k.toLowerCase() + " "));
      s.appendChild(el("b", null, String(c.byKind[k])));
      kk.appendChild(s);
    });
    kinds.appendChild(kk);
    host.appendChild(kinds);

    var barCard = el("div","card");
    barCard.appendChild(el("h2", null, "Busiest domains"));
    var bars = el("div","bars");
    var rows = Object.keys(c.byDomain).map(function(d){
      var b = c.byDomain[d];
      return { d: d, n: b.queries + b.mutations + b.types, q: b.queries, m: b.mutations, t: b.types };
    }).sort(function(a, b){ return b.n - a.n; }).slice(0, 14);
    var max = rows.length ? rows[0].n : 1;
    rows.forEach(function(r){
      var row = el("div","bar");
      row.appendChild(el("div","bl", r.d));
      var track = el("div","bt");
      var fill = el("div","bf");
      fill.style.width = Math.max(2, Math.round((r.n / max) * 100)) + "%";
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el("div","bv", r.q + "q / " + r.m + "m / " + r.t + "t"));
      row.title = r.d + ": " + r.q + " queries, " + r.m + " mutations, " + r.t + " types";
      bars.appendChild(row);
    });
    barCard.appendChild(bars);
    host.appendChild(barCard);

    var help = el("div","card");
    help.appendChild(el("h2", null, "Keyboard"));
    var hk = el("div","kinds");
    [["/","focus search"],["j / ↓","next entry"],["k / ↑","previous entry"],["Enter","expand"],["Esc","clear search"]].forEach(function(p){
      var s = el("span");
      s.appendChild(el("kbd", null, p[0]));
      s.appendChild(document.createTextNode(" " + p[1]));
      hk.appendChild(s);
    });
    help.appendChild(hk);
    host.appendChild(help);
  }

  function renderPane(){
    var host = $("tree"), title = $("paneTitle");
    while (host.firstChild) host.removeChild(host.firstChild);
    groups = [];

    if (state.domain === "overview" && !state.q.trim()){
      renderOverview();
      return;
    }

    var results = searchResults();
    var suffix = filtersActive() ? " · filtered" : "";

    if (results){
      var grouped = byDomain(results);
      title.innerHTML = "";
      title.appendChild(el("strong", null, results.length + " match" + (results.length === 1 ? "" : "es")));
      title.appendChild(document.createTextNode(" for “" + state.q.trim() + "” in " + LABEL[state.kind].toLowerCase() + suffix));
      if (!results.length){
        host.appendChild(el("div","empty-state","Nothing matched. Try a shorter term, or clear a filter."));
        return;
      }
      var shownCount = 0;
      for (var i = 0; i < grouped.order.length && shownCount < RESULT_CAP; i++){
        var d = grouped.order[i];
        var items = grouped.map[d];
        if (state.domain !== "all" && state.domain !== "overview" && state.domain !== d) continue;
        var slice = items.slice(0, RESULT_CAP - shownCount).map(function(e){ return e.item; });
        shownCount += slice.length;
        host.appendChild(makeGroupFor(d, slice, true, true));
      }
      if (results.length > shownCount){
        host.appendChild(el("div","empty-state","Showing the first " + shownCount + " of " + results.length + " matches — refine the search to see more."));
      }
      return;
    }

    if (state.domain === "all"){
      title.innerHTML = "";
      title.appendChild(el("strong", null, "All " + LABEL[state.kind].toLowerCase()));
      title.appendChild(document.createTextNode(" · grouped by domain" + suffix));
      var any = false;
      var names = Object.keys(DATA.meta.counts.byDomain).sort();
      for (var n = 0; n < names.length; n++){
        var dom = names[n];
        var list = (DATA.domains[dom][state.kind] || []).filter(passesFilters);
        if (!list.length) continue;
        any = true;
        host.appendChild(makeGroupFor(dom, list, false, false));
      }
      if (!any) host.appendChild(el("div","empty-state","Nothing matches the current filters."));
      return;
    }

    var items2 = ((DATA.domains[state.domain] || {})[state.kind] || []).filter(passesFilters);
    title.innerHTML = "";
    title.appendChild(el("strong", null, state.domain));
    title.appendChild(document.createTextNode(" · " + items2.length + " " + LABEL[state.kind].toLowerCase() + suffix));
    if (!items2.length){
      host.appendChild(el("div","empty-state","Nothing here for " + LABEL[state.kind].toLowerCase() + " with the current filters."));
      return;
    }
    host.appendChild(makeGroupFor(state.domain, items2, true, true));
  }

  function makeGroupFor(domain, items, forcedOpen, fromSearch){
    var key = "g:" + state.kind + ":" + domain;
    var open = fromSearch ? true : (expansion[key] !== undefined ? expansion[key] : false);
    if (state.focus) open = true;
    var q = fromSearch ? state.q : "";
    return buildGroup(domain, items.length, key, function(body){
      for (var i = 0; i < items.length; i++){
        body.appendChild(fieldNode(items[i], domain, q));
      }
    }, open);
  }

  function applyFocus(){
    if (!state.focus) return;
    var nodes = document.querySelectorAll('.node[data-key="' + state.focus + '"]');
    if (!nodes.length) return;
    var node = nodes[0];
    node.classList.add("flash");
    if (node.scrollIntoView) node.scrollIntoView({ block:"center" });
    state.focus = null;
  }

  function hashFor(){
    var bits = ["kind=" + state.kind];
    if (state.domain !== "all") bits.push("domain=" + encodeURIComponent(state.domain));
    if (state.q.trim()) bits.push("q=" + encodeURIComponent(state.q.trim()));
    if (state.typeKind) bits.push("typeKind=" + state.typeKind);
    if (state.change) bits.push("change=" + state.change);
    if (state.deprecatedOnly) bits.push("deprecated=1");
    if (state.connectionsOnly) bits.push("connections=1");
    return "#" + bits.join("&");
  }

  function render(opts){
    var push = !!(opts && opts.push);
    // The seg and the filter chips both depend on state.kind, so rebuild them
    // on every render rather than only on the code paths that remember to.
    renderSeg();
    renderFilters();
    renderSidebar();
    renderPane();
    var hash = hashFor();
    if (location.hash !== hash){
      if (push) history.pushState(null, "", hash);
      else history.replaceState(null, "", hash);
    }
    applyFocus();
  }

  function readHash(){
    var raw = location.hash.replace(/^#/, "");
    // Reset first: a hash can also change in place (a shared link, or the
    // browser back button) without reloading the document, and state left over
    // from the previous hash must not leak into the new one.
    state.kind = "queries";
    state.domain = "all";
    state.q = "";
    state.focus = null;
    state.typeKind = "";
    state.change = "";
    state.deprecatedOnly = false;
    state.connectionsOnly = false;
    $("q").value = "";
    if (!raw) return;
    var params = {};
    raw.split("&").forEach(function(pair){
      var i = pair.indexOf("=");
      if (i > 0) params[decodeURIComponent(pair.slice(0,i))] = decodeURIComponent(pair.slice(i+1));
    });
    if (params.kind && KINDS.indexOf(params.kind) !== -1) state.kind = params.kind;
    if (params.domain) state.domain = params.domain;
    if (params.q){ state.q = params.q; $("q").value = params.q; }
    if (params.typeKind) state.typeKind = params.typeKind;
    if (params.change) state.change = params.change;
    state.deprecatedOnly = params.deprecated === "1";
    state.connectionsOnly = params.connections === "1";
    if (params.focus){
      state.focus = params.focus;
      var bar = params.focus.indexOf("|");
      if (bar > 0) state.domain = params.focus.slice(0, bar);
    }
  }

  function renderMeta(){
    var m = DATA.meta, host = $("meta");
    host.innerHTML = "";
    function chip(text, cls, title){
      var c = el("span","chip" + (cls ? " " + cls : ""), text);
      if (title) c.title = title;
      host.appendChild(c);
      return c;
    }
    chip("API " + m.version);
    chip(m.counts.total.queries + " queries");
    chip(m.counts.total.mutations + " mutations");
    chip(m.counts.total.types + " types");
    chip(m.domains + " domains");
    if (m.compare){
      var t = m.compare.totals || {};
      chip("vs " + m.compare.version + ": " + (t.added||0) + " new, " + (t.changed||0) + " changed, " + (t.removed||0) + " removed", "n",
           "Compared against the " + m.compare.version + " schema");
    }
    chip("source: " + m.source);
    chip("generated " + m.generatedAt);

    var vhost = $("versions");
    vhost.innerHTML = "";
    var versions = [
      { label: "2026-10", file: "shopify-admin-graphql-tree-2026-10.html", compare: "vs 2026-07" },
      { label: "2026-07", file: "shopify-admin-graphql-tree.html", compare: "vs 2026-04" }
    ];
    for (var vi = 0; vi < versions.length; vi++){
      (function(v){
        var a = document.createElement("a");
        a.href = v.file;
        a.textContent = v.label;
        if (v.label === m.version){
          a.className = "current";
          a.title = "You are viewing " + v.label + " (" + v.compare + ")";
        } else {
          a.title = "Switch to the " + v.label + " explorer";
        }
        vhost.appendChild(a);
      })(versions[vi]);
    }
  }

  /* --------------------------- keyboard --------------------------------- */

  var kbdIndex = -1;
  function kbdTargets(){
    return Array.prototype.slice.call(document.querySelectorAll("#tree .group-head, #tree .row"));
  }
  function moveKbd(delta){
    var list = kbdTargets();
    if (!list.length) return;
    if (kbdIndex >= 0 && list[kbdIndex]) list[kbdIndex].classList.remove("kbd");
    kbdIndex = kbdIndex < 0 ? 0 : Math.max(0, Math.min(list.length - 1, kbdIndex + delta));
    var node = list[kbdIndex];
    node.classList.add("kbd");
    if (node.scrollIntoView) node.scrollIntoView({ block:"nearest" });
  }

  /* --------------------------- wiring ----------------------------------- */

  var input = $("q"), timer = null;
  input.addEventListener("input", function(){
    if (timer) clearTimeout(timer);
    timer = setTimeout(function(){
      state.q = input.value;
      state.focus = null;
      kbdIndex = -1;
      render();
    }, 120);
  });
  input.addEventListener("keydown", function(e){
    if (e.key === "Escape"){ input.value = ""; state.q = ""; render(); }
    if (e.key === "Enter"){ state.q = input.value; render(); }
  });
  document.addEventListener("keydown", function(e){
    var typing = document.activeElement === input || /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === "/" && !typing){ e.preventDefault(); input.focus(); return; }
    if (typing) return;
    if (e.key === "j" || e.key === "ArrowDown"){ e.preventDefault(); moveKbd(1); }
    else if (e.key === "k" || e.key === "ArrowUp"){ e.preventDefault(); moveKbd(-1); }
    else if (e.key === "Enter" || e.key === " "){
      var list = kbdTargets();
      if (list[kbdIndex]){ e.preventDefault(); list[kbdIndex].click(); }
    } else if (e.key === "Escape"){
      state.q = ""; input.value = ""; kbdIndex = -1; render();
    }
  });
  $("expandAll").addEventListener("click", function(){ groups.slice().forEach(function(g){ g.setOpen(true); }); });
  $("collapseAll").addEventListener("click", function(){ groups.slice().forEach(function(g){ g.setOpen(false); }); });
  window.addEventListener("hashchange", function(){ readHash(); render(); });
  window.addEventListener("popstate", function(){ readHash(); render(); });

  buildIndices();
  readHash();
  renderMeta();
  render();

  // Exposed for tests and console poking.
  window.__tree = {
    state: state, index: index, typeIndex: typeIndex, typeByName: typeByName,
    opFor: opFor, curlFor: curlFor, selectionFor: selectionFor,
    render: render, drillTo: drillTo, readHash: readHash
  };
})();
</script>
</body>
</html>
`;

function buildPage(payload) {
  // Escape "<" so the data can never terminate the surrounding script tag, and
  // use a replacer function because "$" sequences in a replacement string are
  // interpreted specially by String.prototype.replace.
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return PAGE.replace('"__SHOPIFY_TREE_DATA__"', () => json);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

function inferVersionLabel(file) {
  const m = String(file).match(/\d{4}-\d{2}/);
  return m ? m[0] : `previous (${basename(file)})`;
}

async function readSchemaFile(file) {
  const raw = await readFile(file, 'utf8');
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON. --schema and --compare expect introspection JSON, not SDL.`);
  }
  return extractSchema(json);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n\n${HELP}\n`);
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    process.stdout.write(HELP + '\n');
    return;
  }

  const version = args.version || process.env.SHOPIFY_API_VERSION || DEFAULT_VERSION;
  const outPath = resolvePath(args.out || DEFAULT_OUT);

  let surface;
  let source;

  if (args.schema) {
    process.stdout.write(`Reading schema from ${args.schema}\n`);
    surface = extractSurface(await readSchemaFile(args.schema));
    source = 'file';
  } else {
    const shopEnv = process.env.SHOPIFY_SHOP;
    if (!shopEnv) {
      throw new Error(
        'SHOPIFY_SHOP is not set (e.g. "mystore" or "mystore.myshopify.com").\n' +
          'Alternatively pass --schema <file> to generate from a saved schema.',
      );
    }
    const shop = normalizeShop(shopEnv);
    const tokenInfo = await resolveToken(shop);
    const secrets = tokenInfo.secrets || [];
    process.stdout.write(`Introspecting ${shop} · ${version} · auth: ${tokenInfo.tokenSource}\n`);
    const json = await adminGraphql(shop, version, tokenInfo.token, INTROSPECTION_QUERY, secrets);
    surface = extractSurface(extractSchema(json));
    source = 'live';
  }

  let before = null;
  let changes = null;
  let compareVersion = null;

  if (args.compare) {
    before = extractSurface(await readSchemaFile(args.compare));
    compareVersion = args.compareVersion || inferVersionLabel(args.compare);
    changes = diffSurfaces(before, surface);
    process.stdout.write(`Comparing against ${compareVersion} (${args.compare})\n`);
  }

  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const payload = buildPayload(surface, { version, generatedAt, source, compareVersion }, before, changes);
  const html = buildPage(payload);
  await writeFile(outPath, html, 'utf8');

  const { total, changes: changeTotals, deprecated } = payload.meta.counts;
  process.stdout.write(
    `\n  queries    ${total.queries}\n` +
      `  mutations  ${total.mutations}\n` +
      `  types      ${total.types}\n` +
      `  domains    ${payload.meta.domains}\n` +
      `  deprecated ${deprecated.queries + deprecated.mutations} operations, ${deprecated.fields} fields\n`,
  );
  if (changeTotals) {
    process.stdout.write(
      `  vs ${compareVersion}: ${changeTotals.added} added, ${changeTotals.changed} changed, ` +
        `${changeTotals.removed} removed, ${changeTotals.deprecated} newly deprecated\n`,
    );
  }
  process.stdout.write(`\nWrote ${outPath} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)\n`);

  if (payload.warnings) {
    const w = payload.warnings;
    const lines = [];
    if (w.queries.length) lines.push(`  queries:    ${w.queries.join(', ')}`);
    if (w.mutations.length) lines.push(`  mutations:  ${w.mutations.join(', ')}`);
    if (w.types.length) lines.push(`  types:      ${w.types.slice(0, 40).join(', ')}${w.types.length > 40 ? `, +${w.types.length - 40} more` : ''}`);
    process.stderr.write(
      `\nnote: some entries landed in "${UNCLASSIFIED}" — add rules to DOMAIN_RULES to group them:\n${lines.join('\n')}\n`,
    );
  }
}

main().catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  const secrets = [process.env.SHOPIFY_ADMIN_ACCESS_TOKEN, process.env.SHOPIFY_CLIENT_SECRET].filter(Boolean);
  process.stderr.write(`\nerror: ${redact(msg, secrets)}\n`);
  process.exitCode = 1;
});
