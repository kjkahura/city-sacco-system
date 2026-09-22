# City SACCO System

Multi-tenant core banking for SACCOs. The live system is **[`platform/`](platform/)**.
Everything else in this repository is specification.

```bash
cd platform
cp .env.example .env          # set PGDATABASE and JWT_SECRET
npm install
npm run migrate               # platform schema, then every tenant
npm test                      # 240 assertions across five suites
npm start
```

[`platform/README.md`](platform/README.md) is the real documentation: why one Postgres
schema per tenant, how a request is routed to its tenant, what the database enforces
rather than the application, migrations and drift at fleet scale, lending, savings,
shares and dividends, penalties, MFA and sessions, rate limiting, encrypted offsite
backups and key rotation, reporting, and what is deliberately not done yet.

## What is in this repository

| Path | What it is |
|---|---|
| `platform/` | The system. Node + Postgres, schema per tenant. Serves the API, the back office at `/console` and the member portal at `/portal`. |
| `*.md` at the root | Requirements and specifications: AML, guarantees, the Qona MBS requirement and technical specs, the Wakandi signup spec, the implementation overview and roadmap. |

## What moved, and where to find it

An earlier version of this project was a different thing: an in-memory Express server
with a dashboard UI, plus a second Sequelize-based server under `Qona-MBS/server/`.
Both are superseded by `platform/`, which persists to Postgres, isolates tenants, and
is tested.

Nothing was thrown away. The complete tree as it stood before this cleanup is on the
**`archive/pre-platform`** branch:

```bash
git switch archive/pre-platform      # the whole thing, exactly as it was
git show archive/pre-platform:server.js
```

Removed from `main`, still on that branch:

- `server.js`, `api-init.js`, `app.js`, `index.html`, `style.css`, `claude-build.js`,
  `guarantee-mockup.html` — the legacy dashboard API and its UI, all in-memory
- `src/`, `scripts/`, `API_V2.md` — a 400-route Mambu-shaped API surface at `/api/v2`,
  also in-memory. The API *conventions* survived into `platform/`; the code did not.
- `Qona-MBS/server/` — a separate Sequelize/SQLite server with its own models
- `Qona-MBS/client/` — the vanilla JS member app. Its screens live on as
  `platform/portal/`, rewired to the platform API; the original is on the branch.

If a local `Qona-MBS/` directory still exists on your machine, it holds only
untracked files (`node_modules`, `.env`, a dev SQLite database) and can be deleted
by hand.

## Status

Not production. It has never been run against real member data, and
`platform/README.md` lists what has to happen first — including prudential thresholds
that are stored as data marked UNVERIFIED rather than as regulatory fact.
