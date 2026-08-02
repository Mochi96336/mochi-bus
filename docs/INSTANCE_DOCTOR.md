# Instance doctor

`instance:doctor` checks whether the selected Mochi Bus instance is ready to operate before a deployment or snapshot workflow is attempted.

```sh
npm run instance:doctor
```

The local report checks:

- the selected instance manifest and profile
- whether the generated runtime, Wrangler and operations files are current
- generated Cloudflare resource identity and any environment overrides
- required GitHub/local environment names for deploy, snapshot publication, public probe and watchdog operations
- fixed public origins and operator rate-limit namespace identity

Secret values are never included in terminal, JSON or GitHub step-summary output. Only missing variable names and safe resource identity are reported.

## Remote verification

Add `--remote` to make read-only Cloudflare API requests for the generated D1 database and R2 bucket:

```sh
npm run instance:doctor -- --remote
```

Remote verification requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. It does not create, modify or delete Cloudflare resources.

## Alternate instance files

The command follows the same manifest precedence as the instance compiler. Explicit paths may also be supplied:

```sh
npm run instance:doctor -- \
  --config instances/starter.example.json \
  --out-dir .generated/starter
```

Machine-readable output is available through `--json`.

## GitHub Actions

Run the **Instance doctor** workflow manually from GitHub Actions. The workflow compiles the selected instance, writes a Markdown report to the run summary and optionally performs remote verification.

A fork may set the repository variable `MOCHI_BUS_INSTANCE_CONFIG` to select its committed manifest. The diagnostic step reads these secrets when the corresponding operation needs them:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `TDX_CLIENT_ID`
- `TDX_CLIENT_SECRET`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

Request-derived instances may additionally set `SNAPSHOT_SMOKE_BASE_URL` and `RELEASE_SMOKE_ORIGIN` as repository variables.
