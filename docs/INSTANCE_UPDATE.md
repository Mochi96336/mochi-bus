# Instance manifest updater

`instance:update` changes an existing Mochi Bus instance manifest without hand-editing deployment identity or operation settings.

The command previews a JSON-path diff by default. It does not write the manifest unless `--write` is supplied.

```sh
npm run instance:update -- \
  --config instances/south.json \
  --add-city Kaohsiung
```

Example preview:

```text
Mochi Bus instance update preview
Config: instances/south.json
State: valid instance manifest

Changes (1):
~ transit.enabledCities
  before: ["Tainan"]
  after:  ["Tainan","Kaohsiung"]

NO FILE WAS CHANGED
Re-run the same command with --write to apply this exact update.
```

Apply the same update explicitly:

```sh
npm run instance:update -- \
  --config instances/south.json \
  --add-city Kaohsiung \
  --write
```

## What remains unchanged

Only fields named by the command are changed, except when a profile change requires its documented operation defaults.

By default:

- the instance ID is immutable
- the D1 database ID is preserved when the D1 name changes
- both rate-limit namespace IDs are preserved
- the demo query is preserved
- `$schema`, schema version and unrelated manifest fields are preserved
- no Cloudflare or GitHub resource is created, renamed, copied or deleted

Changing a D1 name while preserving its ID produces a warning and should be followed by `npm run instance:doctor -- --remote`. Changing an R2 bucket name does not copy any existing bucket content.

The instance ID is deliberately not editable through this command. Renaming it can affect Worker identity, Cloudflare resources, deployment URLs and external automation. Create a new manifest with `instance:init` when that migration is intentional.

## City updates

Replace the complete enabled city set:

```sh
npm run instance:update -- \
  --config instances/south.json \
  --cities Tainan,Kaohsiung
```

Append cities while preserving the existing order:

```sh
npm run instance:update -- \
  --config instances/south.json \
  --add-city Kaohsiung,PingtungCounty
```

Remove a city:

```sh
npm run instance:update -- \
  --config instances/south.json \
  --remove-city Tainan \
  --default-city Kaohsiung
```

The updater does not silently select a new default city. Removing the current default requires an explicit `--default-city` that remains enabled.

The demo query is also preserved. If a city update would remove the demo query's city, the command stops instead of deleting or rewriting the query. Clearing it must be explicit:

```sh
npm run instance:update -- \
  --config instances/south.json \
  --cities Kaohsiung \
  --default-city Kaohsiung \
  --clear-demo-query
```

`--cities` cannot be combined with `--add-city` or `--remove-city`; choose replacement or incremental editing for one invocation.

## Profile changes

Change a profile:

```sh
npm run instance:update -- \
  --config instances/south.json \
  --profile managed
```

Supplying `--profile` reapplies that profile's deterministic operation defaults:

| Profile | workers.dev | Snapshot schedule | Release smoke | Public probe | Watchdog |
| --- | --- | --- | --- | --- | --- |
| `starter` | enabled | manual | enabled | disabled | disabled |
| `managed` | enabled | daily | enabled | enabled | enabled |
| `operator` | disabled | daily | enabled | enabled | enabled |

Explicit operation flags in the same command are applied after the profile defaults.

An operator profile still requires a fixed HTTPS origin:

```sh
npm run instance:update -- \
  --config instances/south.json \
  --profile operator \
  --origin https://bus.example.com
```

When the manifest does not yet contain a D1 ID or both rate-limit namespace IDs, the result is an operator provisioning draft. This is the only strict-validation failure accepted as a draft. Origin, workers.dev, verification-check and schedule violations are rejected.

Finish an operator draft with:

```sh
npm run instance:provision-plan -- --config instances/south.json
```

## Resource identity

Change names while preserving provisioned IDs:

```sh
npm run instance:update -- \
  --config instances/operator.json \
  --worker-name new-worker \
  --d1-name new-data \
  --r2-name new-shapes
```

The command reports that:

- a Worker rename was not deployed
- the D1 ID/name pair needs remote verification
- R2 content was not copied to the new bucket name

IDs may be deliberately changed or cleared:

```sh
npm run instance:update -- \
  --config instances/operator.json \
  --database-id 123e4567-e89b-42d3-a456-426614174000 \
  --standard-rate-limit-id 41001 \
  --expensive-rate-limit-id 41002
```

Use the literal value `null` to clear one:

```sh
npm run instance:update -- \
  --config instances/operator.json \
  --database-id null
```

Clearing required operator identities creates a provisioning draft; it does not invent replacement values.

## Operation overrides

The following fields may be changed explicitly:

```sh
npm run instance:update -- \
  --config instances/managed.json \
  --workers-dev false \
  --snapshot-schedule taipei-weekly-sharded \
  --release-smoke true \
  --public-probe true \
  --window-watchdog true
```

Every proposed result passes the shared instance validator before it can be written. Starter restrictions, operator requirements and the automatic-watchdog schedule constraint therefore remain enforced.

## Optimistic and atomic writes

`--write` does not blindly overwrite the file that was read.

The updater records the source file identity, mode and exact content while building the preview. Immediately before writing, it checks them again. If another process changed or replaced the manifest, the write stops with:

```text
Instance manifest changed after preview; rebuild the update before writing
```

A successful update is written to a temporary file in the same directory and then renamed over the original. The original indentation, line-ending style, trailing-newline choice and permission mode are retained.

An explicit update that already matches the manifest is a no-op and does not rewrite the file.

## Path safety

The selected manifest must:

- be a regular `.json` file
- remain physically and logically inside the repository
- not be a symbolic link
- not be inside `.git`, `.generated` or `node_modules`

The same config resolution used elsewhere applies when `--config` is omitted:

1. `MOCHI_BUS_INSTANCE_CONFIG`
2. repository-root `instance.json`
3. `instances/mochi-production.json`

## Machine-readable output

```sh
npm run instance:update -- \
  --config instances/south.json \
  --add-city Kaohsiung \
  --json
```

The result includes:

- whether a file was written
- whether the proposal contains effective changes
- strict validation or operator-draft status
- path-based before/after changes
- warnings
- the complete proposed manifest

It contains no TDX, Cloudflare API or R2 secret values.

## Help

```sh
npm run instance:update -- --help
```

The help output lists all editable fields and every supported TDX city code.
