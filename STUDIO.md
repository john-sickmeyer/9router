# Studio fork

This branch preserves explicit speed and reasoning choices while rotating between eligible accounts. The dashboard's **Studio controls** page builds model names and shows the final outbound controls and provider confirmations. The core upstream project is `decolua/9router`, branch `master`; custom releases come from `john-sickmeyer/9router`, branch `studio`.

## Choose controls

Use the native request fields where the client exposes them:

| Provider | Speed | Effort |
|---|---|---|
| Codex | `service_tier: "fast"` (sent as `priority`), `"ultrafast"`, or `"default"` | `reasoning.effort` or `reasoning_effort` |
| Claude | `speed: "fast"` or `"standard"` | `output_config.effort` |

Clients without separate controls can select a model alias from `/v1/models`, or enter it as a custom model:

```
cx/gpt-6-astra@ultrafast(max)
cx/gpt-6.1-sol@fast(high)
cx/gpt-6-sol@standard(ultra)
cc/claude-opus-5@fast(xhigh)
```

An alias without parentheses selects speed while leaving effort to the client's request. This is useful with `/effort`. An alias with parentheses pins effort: a conflicting client field returns HTTP 400. Unsupported effort is rejected rather than reduced. `ultra` effort is distinct from `ultrafast` speed. Claude does not have an Ultrafast mode.

Fast/Ultrafast choices depend on model and account eligibility. The fork reads Codex's account-specific model catalog and usage plan, caches that metadata for six hours, and refreshes stale metadata before accelerated requests. A manual **Refresh capabilities** button is also available. A catalog refresh does not purchase credits or change subscriptions. Failed/stale capability checks exclude the account from accelerated requests until refreshed.

Claude Fast requires a supported model and provider-side eligibility/usage credits. It is not confirmed merely because an OAuth account is connected. The provider must return `usage.speed: "fast"`. Current supported Fast models are Opus 5.5, Opus 5, and Opus 4.8. Extend the central configuration when Anthropic changes eligibility.

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

## Review and keep upstream updates

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

Activation puts the running fork into maintenance mode, waits up to 60 seconds for active controlled requests, makes a consistent SQLite backup, switches the build symlink, restarts only its LaunchAgent, and verifies the new release ID. Failure restores the prior build and pre-activation database before reopening traffic. A timeout leaves the running release unchanged. The first migration uses the explicit `--migrate-stock` flag because stock 9Router lacks this maintenance endpoint.

For a later code rollback, activate the previous full SHA recorded in `last-activation.json` using the same command. This preserves current data and makes another backup. Database schema rollback across incompatible upstream migrations requires stopping the service and restoring the matching saved SQLite backup; do not restore a live database or discard refreshed credentials without review.

## Checks

`npm --prefix tests run test:studio` covers request/alias validation, both Responses and Chat input paths, account rotation after a simulated 429, capability exclusion, tool-stream preservation, speed/effort mismatch, incomplete streams, and existing Codex/access-control regressions. Live account eligibility and tiny provider requests are separate acceptance checks; timing alone does not prove a speed tier.

Sources: [Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed), [Claude Fast](https://platform.claude.com/docs/en/build-with-claude/fast-mode), [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort).
