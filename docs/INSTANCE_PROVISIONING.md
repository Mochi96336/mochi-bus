# Instance provisioning plan

`instance:provision-plan` converts the current instance doctor findings into a concrete, non-destructive setup plan.

```sh
npm run instance:provision-plan
```

The command never executes the commands it prints. It does not create Cloudflare resources, set Worker secrets, write GitHub secrets or change repository variables.

## What the plan covers

The report groups actions into these areas:

1. instance manifest validation
2. generated runtime, Wrangler and operations artifacts
3. Cloudflare D1, R2 and operator rate-limit identity
4. Worker runtime TDX secrets
5. GitHub Actions secrets and repository variables
6. final `instance:doctor` verification

The planner can still read a syntactically valid draft manifest when strict profile validation fails. For example, an operator draft that has not received its D1 database ID or rate-limit namespace IDs will still receive specific provisioning steps instead of only a generic validation failure.

## Status meanings

- **Complete**: the current execution context or an optional remote check confirms the item.
- **Action required**: a required resource, secret, variable or manifest value is absent.
- **Blocked**: another repair must happen before this item can be verified safely.
- **Verify**: the planner cannot prove remote state without mutating or exposing secret data.
- **Optional**: the item is not required by the selected profile. Starter snapshots, for example, may use the slower Wrangler fallback without R2 S3 credentials.

A plan may be marked ready while still containing **Verify** items. This means there are no known blocking setup actions, but Cloudflare Worker secret values or other intentionally opaque state should still be confirmed by the operator.

## Remote verification

Add `--remote` to reuse the instance doctor read-only Cloudflare checks:

```sh
npm run instance:provision-plan -- --remote
```

Remote mode only reads generated D1 and R2 identity. It does not create, update or delete resources. It requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the current environment.

## Alternate instance files

```sh
npm run instance:provision-plan -- \
  --config instances/my-instance.json \
  --out-dir .generated/my-instance
```

The generated commands use these explicit paths, including the Wrangler config path for suggested Worker secret setup.

Machine-readable output is available through `--json`:

```sh
npm run instance:provision-plan -- --json
```

## Commands in the report

Depending on the selected profile and current state, the plan may print commands such as:

```sh
npx wrangler d1 create <database-name>
npx wrangler r2 bucket create <bucket-name>
npx wrangler secret put TDX_CLIENT_ID --config <generated-wrangler-config>
gh secret set CLOUDFLARE_DEPLOY_API_TOKEN
gh variable set MOCHI_BUS_INSTANCE_CONFIG --body <manifest-path>
npm run instance:doctor -- --remote
```

These are suggestions only. The report always includes the message `NO CHANGES WERE APPLIED`.

For R2, run the create command only after remote verification confirms the bucket is absent. For Worker secrets, run the `wrangler secret put` commands only during initial provisioning or credential rotation.

## GitHub Actions

Run the **Instance provisioning plan** workflow manually from GitHub Actions. It writes the complete Markdown plan to the run summary.

The workflow deliberately does not run `npm ci`, `prepare` or `instance:compile`. This allows it to diagnose an invalid manifest or missing generated artifacts instead of failing before the planner starts.

Secrets are scoped only to the final planning step. Selecting `remote=true` enables the read-only D1/R2 verification; the workflow never runs any generated provisioning command.

Forks may set `MOCHI_BUS_INSTANCE_CONFIG` as a repository variable to select their committed manifest. Request-derived instances may additionally need:

- `RELEASE_SMOKE_ORIGIN`
- `SNAPSHOT_SMOKE_BASE_URL`

The plan lists the exact GitHub secret and variable names required by the selected operations without printing their values.
