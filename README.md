# Shopify Admin GraphQL Explorer

A single-file, zero-dependency generator that introspects the Shopify Admin GraphQL
schema and renders a self-contained, browsable HTML explorer of the entire API.

## What you get

`shopify-admin-graphql-tree.html` — one self-contained page. No server, no build step,
no network requests; it opens straight from `file://`.

- **287 queries, 524 mutations, 3548 types** across 30 domains for API version `2026-07`
- A domain-grouped tree with real field signatures, e.g.
  `products(first: Int, after: String, …): ProductConnection!`
- **Drill-down** — click any type name inside a signature to jump to that type's own entry
- **Search** with match highlighting, plus filters for type kind, `Deprecated only`, and `Connections only`
- **Copy query / Copy curl** on any field. Connection-aware: connections expand to
  `edges { node { id } }`, and required arguments are emitted as real GraphQL variables
- **Overview dashboard** — totals, type-kind breakdown, busiest domains, deprecation counts
- **Version comparison** — `New` / `Changed` / `Removed` / `Deprecated` badges showing what
  moved between API releases, with filters to isolate one kind of change
- **Keyboard navigation** — `/` to search, `j`/`k` or arrows to move, `Enter` to expand, `Esc` to clear
- **Deep links** — the entire view state lives in the URL hash, so any view is shareable

## Requirements

Node.js 18+ (uses the global `fetch`). No dependencies and no install step.

## Usage

```bash
# Introspect a store
node scripts/shopify-admin-tree.mjs

# Pin a version and compare it against an older schema
node scripts/shopify-admin-tree.mjs --version 2026-07 --compare schema-2026-04.json

# Generate entirely offline from a saved introspection dump
node scripts/shopify-admin-tree.mjs --schema schema-2026-07.json
```

### Credentials

Set **one** of the following, plus `SHOPIFY_SHOP` (e.g. `mystore` or `mystore.myshopify.com`):

| Variable | Notes |
| - | - |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | An Admin API access token (`shpat_` / `shp_`). Works for any store or app. |
| `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` | Dev Dashboard app credentials. The script performs the client credentials grant to mint a fresh 24-hour token. Only works for stores inside your own Shopify organization. |

Apps created directly in the Shopify admin no longer expose a static token, so one of the
two options above is required.

### Flags

| Flag | Purpose |
| - | - |
| `--version <v>` | API version to introspect (default `2026-07`) |
| `--schema <file>` | Read introspection JSON from a file instead of the network |
| `--compare <file>` | Annotate every entry with what changed against this schema |
| `--compare-version <v>` | Label for the comparison schema (default: inferred from the filename) |
| `--out <path>` | Output page (default `shopify-admin-graphql-tree.html`) |
| `--help` | Usage |

## How it works

1. **Introspect** the Admin schema, or read a saved introspection dump.
2. **Normalize** into a comparable "surface" of operations and types, so the same
   structure can be diffed against another API version.
3. **Group** every field into a domain using ordered rules — precise anchored regexes
   first, then an unanchored keyword fallback that catches derived names like
   `CalculatedDraftOrderLineItem`. Anything unmatched lands in an explicit
   `Unclassified` bucket and is reported on stderr, so the output is always
   exhaustive and never silently drops a field.
4. **Diff** against a previous version when `--compare` is passed.
5. **Render** a single HTML page with the data embedded inline.

The data is embedded inline rather than written to a sidecar `.json` that the page
`fetch`es, because `fetch` is blocked by CORS on `file://` URLs. Inlining is what makes
the page work with no server at all.

## Notes

- Introspection is schema-only and requires no special access scope. If your store
  restricts it, pass `--schema` with a dump obtained elsewhere — the output is identical.
- The generated page contains **no credentials and no store-identifying data**.
- The page's data is generated at build time; only expand/collapse, search, and routing
  happen in the browser. Domains start collapsed and build their DOM on first expand,
  which is what keeps a 4.5 MB page responsive.

## License

No license has been chosen yet. Until one is added, the default is all rights reserved.
