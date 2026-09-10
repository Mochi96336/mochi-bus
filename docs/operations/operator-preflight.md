# Operator resource preflight

Operational workflows run `npm run instance:preflight -- <operation>` before the first external write. The command reads the compiled instance runtime, Wrangler configuration and operations plan, validates operation-specific configuration and performs read-only Cloudflare resource identity checks.

## Workflow credential contract

| Workflow | Token secret | Required access |
| --- | --- | --- |
| Deploy | `CLOUDFLARE_DEPLOY_API_TOKEN` | Existing Worker deployment permissions, D1 database read access and R2 bucket read access |
| Snapshot publication | `CLOUDFLARE_API_TOKEN` | D1 migration/publication access plus D1 database and R2 bucket read access |
| Public probe | `CLOUDFLARE_API_TOKEN` | D1 migration/query access and D1 database read access |
| Snapshot watchdog | `CLOUDFLARE_API_TOKEN` | D1 migration/query access and D1 database read access |
| Workers Observability telemetry preflight | `CLOUDFLARE_OBSERVABILITY_API_TOKEN` (optional) | Account-level `Workers Observability Write`; absent token records `unconfigured` and does not call the telemetry API |
| D1 read insights | `CLOUDFLARE_ANALYTICS_API_TOKEN` (optional) | Cloudflare Account → Account Analytics → Read only; absent token records a skipped summary and does not call GraphQL |

The operational workflows above require `CLOUDFLARE_ACCOUNT_ID`. The optional Workers Observability telemetry preflight and D1 read insights also use the account ID when their dedicated token is configured. Snapshot publication additionally requires TDX credentials plus both R2 S3 credential fields (`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`) for every profile. Snapshot routing artifacts are R2-authoritative, so publication no longer has a supported Wrangler object-upload fallback when direct R2 credentials are absent.

D1 read insights is optional observability. If `CLOUDFLARE_ANALYTICS_API_TOKEN` is not configured, the workflow records a skipped summary and exits successfully without calling Cloudflare GraphQL. Once the dedicated token is configured, authentication, authorization, query, transport or payload failures remain hard failures.

Keep deployment, recurring operational, Workers Observability and Account Analytics tokens separate. The deploy token needs read access only for the D1/R2 identity checks in addition to its existing Worker deployment permissions; snapshot and monitoring workflows retain their own migration/query permissions. The optional observability token must not fall back to either operational token merely to satisfy telemetry access, and D1 read insights must not add Account Analytics access to the deploy, snapshot or observability token merely to satisfy attribution.

The preflight reports missing variable names, HTTP status classes and resource identity mismatches. It does not print secret values or Cloudflare response bodies. The Workers Observability telemetry preflight similarly emits only bounded authorization/key-presence evidence and never telemetry event values. D1 read insights uploads only its bounded sanitized attribution report and never raw query analytics.

## Ordering guarantees

The snapshot workflow resolves operation scope, validates a manually selected city, runs operator preflight, applies D1 migrations and only then starts publication. Disabled public-probe and watchdog operations stop before credential or resource checks. Missing direct R2 publisher credentials therefore stop the workflow before migrations and before any TDX acquisition.

Deployment validates D1 and R2 identity before repository validation or Worker deployment. Operator deployments also require two distinct positive rate-limit namespace IDs from the generated Wrangler configuration.

## Origin handling

Origin validation reuses the shared operational-resource contract. Fixed instance origins remain authoritative, a trailing slash is normalized, and request-derived snapshot/probe origins may use HTTP for controlled local environments. Release-smoke deployment origins remain HTTPS-only.
