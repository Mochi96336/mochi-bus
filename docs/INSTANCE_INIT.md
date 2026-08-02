# Instance manifest initializer

`instance:init` creates a deterministic instance manifest from a small set of explicit deployment choices.

```sh
npm run instance:init -- \
  --instance-id chiayi-bus \
  --cities Chiayi
```

The default output is `instance.json`. The initializer never creates Cloudflare resources, contacts GitHub, reads secret values or runs the provisioning commands it suggests.

## Profiles

| Profile | Origin default | Worker URL | Snapshot schedule | Verification checks |
| --- | --- | --- | --- | --- |
| `starter` | `request` | `workers.dev` enabled | manual | release smoke only |
| `managed` | `request` | `workers.dev` enabled | daily | release smoke, public probe and watchdog |
| `operator` | fixed HTTPS origin required | `workers.dev` disabled | daily | all checks required |

Starter and managed manifests pass strict validation immediately. An operator manifest may be emitted as a **provisioning draft** while its D1 database ID and rate-limit namespace IDs are still unknown. That draft is intentionally handed to `instance:provision-plan`, which provides the next non-destructive setup steps.

## Starter example

```sh
npm run instance:init -- chiayi-bus --cities Chiayi
npm run instance:validate -- --config instance.json
npm run instance:provision-plan -- --config instance.json
```

This derives:

- site name: `Chiayi Bus`
- Worker: `chiayi-bus`
- D1 database: `chiayi-transit`
- R2 bucket: `chiayi-transit-shapes`
- default city: `Chiayi`

A trailing `-bus` is removed before deriving D1 and R2 names. Long derived names are deterministically shortened to stay within Cloudflare's 63-character name boundary.

## Managed example

```sh
npm run instance:init -- south-bus \
  --profile managed \
  --cities Tainan,Kaohsiung \
  --default-city Tainan \
  --site-name "South Bus" \
  --output instances/south.json
```

The first city becomes the default unless `--default-city` is supplied. Repeated `--cities` options and comma-separated values may be combined; duplicates are removed while preserving order.

## Operator bootstrap

```sh
npm run instance:init -- operator-bus \
  --profile operator \
  --cities Taipei,NewTaipei \
  --origin https://bus.example.com \
  --output instances/operator.json

npm run instance:provision-plan -- --config instances/operator.json
```

Without provisioned IDs, the generated operator draft contains:

```json
{
  "databaseId": null,
  "standardNamespaceId": null,
  "expensiveNamespaceId": null
}
```

No placeholder UUID or fake namespace identity is invented. The command exits successfully after writing the structurally valid draft and reports that strict operator validation is pending.

When the resources already exist, their IDs may be supplied directly:

```sh
npm run instance:init -- operator-bus \
  --profile operator \
  --cities Taipei \
  --origin https://bus.example.com \
  --database-id 123e4567-e89b-42d3-a456-426614174000 \
  --standard-rate-limit-id 41001 \
  --expensive-rate-limit-id 41002
```

The two rate-limit IDs must be positive integer strings and must be distinct.

## Resource-name overrides

```sh
npm run instance:init -- island-bus \
  --profile managed \
  --cities Chiayi,Tainan \
  --worker-name island-worker \
  --d1-name island-data \
  --r2-name island-shapes
```

All instance IDs and Cloudflare resource names are validated before any file is written.

## Preview and machine-readable output

Print the complete manifest without writing it:

```sh
npm run instance:init -- preview-bus --cities Chiayi --dry-run
```

Return a machine-readable result, including whether the output is a provisioning draft:

```sh
npm run instance:init -- preview-bus --cities Chiayi --dry-run --json
```

The JSON result contains only manifest and validation metadata. It never includes TDX, Cloudflare or R2 credential values.

## File safety

The initializer uses exclusive creation by default. It refuses to replace an existing file:

```text
instance.json already exists; pass --force to replace it
```

Replacement must be explicit and is performed through a temporary file followed by rename:

```sh
npm run instance:init -- replacement-bus --cities Chiayi --force
```

The output path must:

- remain inside the repository
- end in `.json`
- not target the repository root
- not be inside `.git`, `.generated` or `node_modules`

The `$schema` reference is calculated relative to the selected output path, so both `instance.json` and `instances/example.json` retain editor validation.

## Help

```sh
npm run instance:init -- --help
```

The help output lists every supported TDX city code and all available options.
