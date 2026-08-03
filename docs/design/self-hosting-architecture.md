# Portable instance architecture

Mochi Bus is intended to be a deployable public-transit service, not a single website whose only production home is `bus.moc96336.com`.

The repository currently contains both the reusable application and the concrete configuration of the Mochi-operated public instance. This document defines the boundary needed to let other people run an independent Mochi Bus without editing application source files.

## Goal

The same source tree must be able to produce multiple independent instances with their own:

- public origin and canonical URLs;
- enabled city set and default city;
- Cloudflare Worker, D1, R2 and rate-limit resources;
- snapshot schedule and operational checks;
- TDX and Cloudflare credentials.

`bus.moc96336.com` remains the reference instance maintained by the project author. It is not a runtime dependency of another deployment.

The first supported self-hosting path is deliberately narrow:

> A new operator can deploy one city without changing source code, then publish its first transit snapshot and verify the public service.

Nationwide scheduling, watchdog evidence and all-city drift probes remain an advanced operator profile.

## Architectural boundary

### Core

The reusable core contains:

- Worker and browser application code;
- migrations and snapshot format;
- snapshot validation, activation and rollback gates;
- city capability metadata;
- deployment and public-surface verification logic.

Core code must not contain an account-specific resource identifier or assume a particular public origin, city, route or stop.

### Instance configuration

An instance configuration is public, non-secret and safe to commit. It describes:

- instance identity;
- site name and canonical-origin policy;
- enabled cities, default city and optional demonstration query;
- Cloudflare resource names and provisioned IDs;
- operational profile and enabled checks.

The canonical examples are:

- `instances/mochi-production.json`: the current reference production instance;
- `instances/starter-chiayi.example.json`: an unprovisioned single-city starter.

A fork may add a root `instance.json`. Resolution order is:

1. explicit `--config` argument;
2. `MOCHI_BUS_INSTANCE_CONFIG` environment variable;
3. root `instance.json` when present;
4. `instances/mochi-production.json` as the upstream-repository fallback.

The fallback preserves current repository behavior while the runtime is migrated in later changes.

### Secrets

Secrets never belong in instance configuration or generated files. They continue to use environment variables, local ignored files or GitHub Actions secrets:

- `TDX_CLIENT_ID`;
- `TDX_CLIENT_SECRET`;
- `CLOUDFLARE_ACCOUNT_ID`;
- `CLOUDFLARE_API_TOKEN`;
- `CLOUDFLARE_DEPLOY_API_TOKEN`;
- `R2_ACCESS_KEY_ID`;
- `R2_SECRET_ACCESS_KEY`.

A future provisioning command may test whether these are available, but it must not copy them into JSON.

## Configuration compilation

`npm run instance:compile` is a deterministic, offline compilation step. It validates one manifest and atomically writes generated artifacts under `.generated/instance/`:

- `instance-runtime.json`: public identity and enabled-city data for Worker and browser builds;
- `wrangler.instance.jsonc`: Cloudflare bindings and resource names;
- `operations-plan.json`: enabled cities, schedule mode and verification checks.

Generated files are disposable and ignored by Git. The manifest is the source of truth.

Compilation must have no cloud side effects. Resource creation, migration, deployment and snapshot publication remain separate commands so failures are attributable and testable.

## Supported and enabled cities

Mochi Bus supports all TDX city codes listed in the schema. That capability list is different from the cities enabled by one instance.

Later runtime work must make `enabledCities` authoritative for:

- `/api/v1/map/cities`;
- map and setup city selectors;
- IP-based initial city selection;
- API validation for city-scoped routes;
- snapshot scheduling;
- public probes and watchdog expectations;
- dynamic release-smoke samples.

A request for a supported but disabled city should return an explicit `city_not_enabled` error rather than an empty catalogue.

A single-city instance may skip the nationwide selector and enter its city directly.

## Operational profiles

### Starter

For first-time and single-city deployments:

- manual snapshot publication;
- `workers.dev` may remain enabled;
- release smoke may run;
- no scheduled public probe or window watchdog;
- Cloudflare IDs may be null until provisioning completes.

Starter still uses the same immutable snapshot validation and activation gate as production. It is operationally smaller, not less safe.

### Managed

For a small long-running public deployment:

- automatic snapshot schedule;
- selected-city release and public checks;
- GitHub Actions deployment;
- explicit custom origin when desired.

The exact managed schedule will be defined with portable workflows.

### Operator

For the Mochi reference instance and equivalent nationwide operators:

- fixed canonical origin;
- custom domain with `workers.dev` disabled;
- provisioned D1 and rate-limit resources;
- release smoke, public probe and snapshot-window watchdog;
- sharded Taipei-time snapshot schedule;
- rollback and observation evidence.

The operator profile intentionally rejects incomplete resource configuration.

## Migration sequence

The portability work is staged to keep production behavior stable.

1. **Contract and compiler** — add schema, examples, validator and deterministic compiler without changing runtime behavior.
2. **Runtime identity** — derive canonical origin, structured data, reporting endpoints and rate-limit keys from compiled config.
3. **Enabled-city scope** — separate supported cities from the cities served by an instance.
4. **Cloudflare resources** — replace account-specific constants with compiled bindings and environment values.
5. **Dynamic verification** — choose smoke-test routes and stops from each instance's enabled catalogue.
6. **Provisioning** — add doctor, provision, deploy and verify commands.
7. **Portable workflows** — make deploy, snapshot, probe and watchdog workflows consume the operations plan.
8. **Self-hosting guide** — publish starter, managed, custom-domain, upgrade and troubleshooting documentation.

Each stage must preserve the reference instance's existing output and checks until the relevant production manifest becomes authoritative.

## Non-goals for the first release

This architecture does not initially provide:

- arbitrary logos, themes or complete white-label branding;
- a hosted control panel;
- multi-tenant Worker or database sharing;
- automatic TDX registration;
- automatic DNS changes;
- a separate self-hosting repository;
- a second, simplified snapshot publisher.

Keeping one application and one publication gate avoids security and data-integrity fixes diverging between the reference site and self-hosted deployments.

## Contract tests

The first implementation must prove that:

- the production and starter examples validate;
- unknown properties and unsupported city codes fail closed;
- enabled cities are unique and contain the default and demo city;
- starter and operator profile invariants are enforced;
- compilation is deterministic and writes no secrets;
- generated Wrangler configuration omits unprovisioned optional IDs rather than inventing placeholders;
- configuration resolution follows the documented precedence.

Later migration stages add a stronger repository contract: production account IDs and `bus.moc96336.com` may appear only in the production manifest, production documentation and explicit fixtures.
