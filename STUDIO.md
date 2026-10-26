# Studio fork

This branch preserves explicit speed and reasoning choices while rotating between eligible accounts. The dashboard's **Studio controls** page builds model names and shows the final outbound controls and provider confirmations. The core upstream project is `decolua/9router`, branch `master`; custom releases come from `john-sickmeyer/9router`, branch `studio`.

## Choose controls

Use the native request fields where the client exposes them:

| Provider | Speed | Effort |
|---|---|---|
| Codex | `service_tier: "fast"` (sent as `priority`), `"ultrafast"`, or `"default"` | `reasoning.effort` or `reasoning_effort` |
| Claude | Standard; Fast is disabled on this Studio | `output_config.effort` |

Clients without separate speed controls can enter a custom model alias:

```
cx/gpt-6-astra@ultrafast(max)
cx/gpt-6.1-sol@fast(high)
cx/gpt-6-sol@standard(max)
cc/claude-opus-5-5@standard(xhigh)
```

An alias without parentheses selects speed while leaving effort to the client's request. This is useful with `/effort`. An alias with parentheses pins effort: a conflicting client field returns HTTP 400. Unsupported effort is rejected rather than reduced. Claude does not have an Ultrafast mode.

**Ultra effort is not an API reasoning level.** It enables orchestration in a compatible Codex runtime, which [resolves it to the model's ordinary inference effort](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models/reasoning_effort.rs). Select that mode in the native client; 9Router cannot create the client-side orchestration merely by forwarding the word `ultra`. Raw Ultra effort and aliases such as `(ultra)` return an explanatory 400. For these router aliases, GPT-6 efforts are Low, Medium, High, Xhigh, and Max. **Ultrafast speed works independently of this distinction.**

Fast/Ultrafast choices depend on model and account eligibility. The fork reads Codex's account-specific model catalog and usage plan, caches that metadata for six hours, and refreshes stale metadata before accelerated requests. A manual **Refresh capabilities** button is also available. A catalog refresh does not purchase credits or change subscriptions. Failed/stale capability checks exclude the account from accelerated requests until refreshed.

Claude Fast spends extra-usage credits immediately, so it is disabled by default. Native Fast fields and saved Fast aliases return a clear 400 before inference. The transport support remains available only for an operator who deliberately starts a worker with `STUDIO_CLAUDE_FAST_ENABLED=1`; ordinary Studio activation does not set that flag.

## Happier model discovery

Studio activation sets `STUDIO_CURATED_CATALOG=1`. `/v1/models` advertises GPT-6.1 Sol and GPT-6 Astra in three speed variants each, plus Claude Opus 5.5 and Claude Fable 5.1. The Codex labels are the base name, the base name plus **Fast**, and the base name plus **Ultrafast**. Their IDs explicitly end in `@standard`, `@fast`, and `@ultrafast`. Each alias selects only speed; effort remains independent in Happier's Thinking selector. No effort permutations are advertised.

Requests bearing `anthropic-version` receive only the two Claude models with Anthropic-compatible `display_name` and `capabilities.effort` metadata. API-key access restrictions still apply, including to individual speed aliases. This controls discovery, not routing: older sessions and explicit model aliases remain supported. Speed eligibility and account switching are enforced at request time; unavailable accelerated capacity never silently becomes Standard.

Happier's Codex picker uses Codex `model/list`, not `/v1/models`. Generate a matching native catalog with `python3 scripts/studio-codex-catalog.py VERSION /absolute/path/models.json`, then reference it with `model_catalog_json` in the Codex configuration used by the Happier profile. The generator clones the matching release's full model instructions, tools, context and effort metadata for all six aliases. Only identity/display fields and the independent speed controls change: the alias owns speed, so a second speed toggle is not exposed. Set the isolated profile's default model to `gpt-6.1-sol@standard`. Regenerate after upgrading the Codex CLI, and refresh Happier's model list. Existing sessions may retain their original selection.

This uses the stock Happier apps and their existing model/Thinking picker. It requires no Happier fork or custom iPhone distribution. Validate selections through an actual Happier session and the Studio outbound audit. Do not infer runtime support from a model label alone.

Claude discovery uses canonical model IDs so the runtime's reported ID matches the picker row. In curated mode those two canonical IDs resolve to the Claude OAuth account pool; explicit operator aliases take precedence. To keep Claude's running-session SDK catalog equally small, configure its user-level `modelPicker` with `replaceBuiltInOptions: true` and two `options` rows (`model`/`label`) for `claude-opus-5-5` and `claude-fable-5-1`. This is a display preference; it does not restrict subagent routing as `availableModels` would.

## Account switching and verification

The normal 9Router account strategy remains available. With fill-first, a quota/rate/capacity failure locks that account/model and retries the next eligible account with the same conversation, model, speed, and effort. Accelerated requests never fall back to Standard. Once output has started, interrupted streams fail visibly; they are not replayed automatically because replaying tool calls can duplicate effects.

`x-9router-request-id` identifies the request in Studio controls. The audit distinguishes **sent** controls from **reported** controls. Effort is checked in the final outbound body; when the provider echoes effort it must match. An absent provider echo is shown as absent, not inferred. The native Codex model/tier routing header is also generated from the final request, after custom header overrides.

Codex's ChatGPT endpoint can return `service_tier: default` for accelerated requests. This also occurs outside 9Router and has been [reported upstream](https://github.com/openai/codex/issues/32191) and [measured by another gateway user](https://github.com/yetone/magpie/issues/3077). In that case, useful output is preserved and the audit explicitly says **served speed unconfirmed**. It never rewrites the provider's report or claims the billed tier. A conflicting explicit accelerated tier still fails. Claude Fast requires `usage.speed: fast` before successful completion.

The audit stores only request IDs, account IDs, model/control metadata, status, and timestamps at `~/.9router/studio-controls.jsonl` (0600, rotates at 5 MiB with one previous file). It excludes prompts, model output, tools, and credentials. Existing upstream request-history settings remain separate.

The fork does not add native Codex/Claude app features to Happier or make Happier's picker render a new control automatically. Refresh its model list or enter the custom alias. Client-level UI behavior needs a real client session check.

## Service layout

On the Studio:

- Source: `~/Library/Application Support/9router-studio/source`
- Immutable builds: `~/Library/Application Support/9router-studio/releases/<commit>`
- Active build: `~/Library/Application Support/9router-studio/current`
- Data: `~/.9router` (outside Dropbox/Google Drive)
- Listener: `127.0.0.1:20128`
- LaunchAgent: `com.sickmeyer.9router-studio`
- Log: `~/Library/Logs/9router-studio.log`
- Backups/activation receipts: under the service directory

The LaunchAgent restarts a crashed process and works while the logged-in desktop is locked. After a reboot, macOS/FileVault may require login/unlock before a user LaunchAgent can run.

The old stock autostart and watchdog plists are retained with `.studio-disabled` suffixes. They must stay disabled: the old watchdog restarts the globally installed stock package. The global npm package is retained for recovery.

From the laptop, a tunnel keeps the dashboard private:

```sh
ssh -N -L 20128:127.0.0.1:20128 mac-studio
```

Then open `http://127.0.0.1:20128/dashboard/studio` and use the existing dashboard login. Tailscale supplies the encrypted network path; SSH supplies authentication and forwarding.

## Automatic upstream updates

The Studio runs `scripts/studio-autoupdate.py` hourly through the user LaunchAgent `com.sickmeyer.9router-autoupdate`, and once when that agent loads. It runs independently of the laptop, Codex, and Happier. The logged-in Studio may be locked. A sleeping/offline Studio catches up after it wakes/reconnects; a full Mac restart still requires the normal macOS login before user LaunchAgents can run. Updates restart **9Router**, not macOS.

The updater follows stable `vMAJOR.MINOR.PATCH` tags on `decolua/9router`'s `master`, verifies the tag's package version, and pins the exact commit. It ignores prerelease tags. GitHub's latest-release record is not the release source because it can lag the project's version tags. It never force-updates a fetched tag, resets the fork, or force-pushes.

For a new version it:

1. Merges into a private candidate worktree based on the exact deployed `studio` commit. The fork's speed, effort, catalog, and account-switching changes stay in Git history.
2. If upstream changed dependency manifests, resolves and commits the corresponding lockfiles inside the candidate, without running install scripts during resolution. Then installs locked dependencies, runs `test:studio`, and builds with a temporary data directory. A conflict, dependency-resolution failure, failed test, or build error leaves the live release intact.
3. Boots the candidate on an unused loopback port with an empty temporary database. Checks cover both model catalogs, Claude effort metadata, dashboard/auth, disabled Claude Fast, blocked stock updater, and maintenance admission. This uses no real account credentials or paid inference.
4. Defers activation if requests are active. A validated candidate is reused on the next hourly check. Activation also closes admission and drains any requests that started during the final checks; it never clears pending requests by age or forcibly restarts a busy worker.
5. Backs up SQLite, changes the immutable release symlink, restarts the service, and checks the served revision, catalog, efforts, Claude Fast restriction, and unchanged account identities before reopening traffic. Failed activation restores the previous code and database. A journal allows the next run to recover an interrupted activation.
6. Pushes the successful merge to `origin/studio` using a repository-scoped deploy key, then fast-forwards the source checkout. A network failure after activation is retried without restarting the working release. Independently changed source/remote branches require reconciliation; they are never overwritten.

Failed candidates retry after six hours, or immediately when a different upstream version becomes available. Merge conflicts and incompatible upstream changes may still need a code fix; automation preserves the last working release while those are unresolved. The regression suite verifies controls and simulated account fallback, but cannot promise a provider's throughput or prevent external API changes.

State and logs are in `~/Library/Application Support/9router-studio/autoupdate/`: `status.json`, `run-*.log`, `candidate.log`, and `launchd.log`. The candidate worktree is disposable and replaced only by this updater; immutable releases and database backups are retained. The deploy key is confined to this repository and its private half stays on the Studio. GitHub's published SSH host keys are pinned in that directory's `known_hosts`.

Initial installation, after the committed source has been tested and deployed:

```sh
cd "$HOME/Library/Application Support/9router-studio/source"
python3 scripts/studio-autoupdate.py --install
```

Run a check immediately with `python3 scripts/studio-autoupdate.py`. An exclusive lock prevents overlapping checks. To pause checks for manual maintenance, create `autoupdate/paused` under the service directory; remove that file to resume. This does not interrupt an update already running: wait for that run to finish before changing the source or live release.

This schedule upgrades only the 9Router fork. It does not upgrade Happier, Codex, or Claude Code, and does not alter their native model catalogs/configurations. Review and regenerate the Codex native catalog separately when upgrading its CLI.

## Manual upstream review and recovery

Never run the stock npm updater against this service. The dashboard update action is disabled in the fork. Do not reset `studio` to upstream's branch. Merge upstream changes into a candidate instead:

```sh
cd "$HOME/Library/Application Support/9router-studio/source"
bash scripts/studio-update.sh
```

This fetches both remotes, creates an isolated worktree/branch from `origin/studio`, merges `upstream/master`, and runs the pinned dependency install, regression checks, and production build. Conflicts stop the process. Nothing in the running service changes. If upstream changes package manifests, deliberately regenerate/review lockfiles; `npm ci` must not silently resolve new dependency versions.

Review the candidate diff, resolve failures, push its branch, and open a PR into `studio`. Merge only after review. Then fast-forward the source checkout to the reviewed `origin/studio`, install/build, and stage the exact commit:

```sh
git switch studio
git pull --ff-only origin studio
npm ci --no-audit --no-fund
npm --prefix tests ci --no-audit --no-fund
npm --prefix tests run test:studio
bash scripts/studio-build.sh
python3 scripts/studio-release.py stage .
python3 scripts/studio-release.py activate FULL_40_CHARACTER_COMMIT_SHA
```

The build wrapper verifies that the source stays clean and on the same commit throughout the build. Staging refuses an old build from another revision. Before activation, validate the staged build on an unused loopback port with an isolated data directory. Use credential-free health tests first. Do not run two copies of the same refresh token through independent refresh schedulers.

Activation puts the running fork into maintenance mode, waits up to 60 seconds for active controlled requests, makes a consistent SQLite backup, switches the build symlink, restarts only its LaunchAgent, and verifies the new release and Studio contract. Failure restores the prior build and pre-activation database before reopening traffic. A timeout leaves the running release unchanged. The first migration uses the explicit `--migrate-stock` flag because stock 9Router lacks this maintenance endpoint.

For a later code rollback, activate the previous full SHA recorded in `last-activation.json` using the same command. This preserves current data and makes another backup. Database schema rollback across incompatible upstream migrations requires stopping the service and restoring the matching saved SQLite backup; do not restore a live database or discard refreshed credentials without review.

## Checks

`npm --prefix tests run test:studio` covers request/alias validation, both Responses and Chat input paths, account rotation after a simulated 429, capability exclusion, tool-stream preservation, speed/effort mismatch, incomplete streams, and existing Codex/access-control regressions. Python tests use real temporary Git repositories to exercise merge/publish, conflicts, prerelease exclusion, failed validation, busy deferral/reuse, publication retry, and overlap protection. Separate SQLite recovery tests verify code/database rollback and retained maintenance if recovery is unhealthy. Live account eligibility and tiny provider requests are separate acceptance checks; timing alone does not prove a speed tier.

Sources: [Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed), [Claude Fast](https://platform.claude.com/docs/en/build-with-claude/fast-mode), [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort).
