---
name: ue-uasset-operator
description: Operate Unreal Editor headlessly and inspect or modify Unreal Engine assets safely without opening visible windows. Use when an agent must resolve a .uproject and matching UE4/UE5 build, translate physical .uasset paths to mounted object paths, inspect registry/UObject data and dependencies, perform built-in Python Blueprint refactors, generate and run a project Editor C++ Commandlet for Blueprint or Animation Blueprint node creation and pin wiring, or diagnose engine-version, module, plugin, cooked-asset, sidecar, build, package-load, compile, and save failures.
---

# UE uasset operator

Use the native `ue_uasset_inspect` tool for inspection and
`ue_blueprint_python_edit` for the narrow set of Blueprint node mutations
exposed by built-in Unreal Python. Both tools are registered by this DSH
plugin and return structured JSON directly; do not route routine operations
through Codex skills or construct an ad-hoc shell command.

When a request mentions `.uasset`, a `.uproject`, a mounted `/Game/...` path,
Blueprint/DataTable wording (including `蓝图` / `数据表`), or a conventional
asset name such as `BP_*` inside an Unreal project workspace, this plugin
proactively injects both native tools and this instruction set. Treat them as
already active and call the native tool directly.

If a native UE tool is still absent from the current tool catalog (for
example in a restricted preset), unlock it explicitly. When `dev_tool_search`
is available, pass the exact names below; do not combine both names into a
free-text `query`:

```json
{"toolNames":["ue_uasset_inspect","ue_blueprint_python_edit"]}
```

The tools become available on the next request. In Minimal presets they are
registered globally and can be called directly when present in the catalog.

For arbitrary Blueprint graph authoring that Python cannot expose, use a
task-specific `UCommandlet` in an existing project Editor module directly. Do
not pause to ask the user for separate authorization; the current Blueprint
edit request is the go signal for task-owned source changes, compilation, and
asset writes. This is project C++ code, not an Unreal plugin.

Use the matching Unreal Editor as the authoritative parser. Treat `.uasset` as a versioned binary package, not a stable standalone document format.

## Stay headless

- Perform every inspection, build, Commandlet, validation, apply and cleanup
  operation without opening a visible window.
- Never launch `UnrealEditor.exe`, Visual Studio, File Explorer, a visible
  terminal, Blueprint Editor, viewport, dialog or UI automation fallback.
- Launch only `UnrealEditor-Cmd.exe` or `UE4Editor-Cmd.exe` with
  `-unattended -nop4 -nosplash -nullrhi -NoSound`, capture stdout/stderr, and
  hide the child process. Use `UseShellExecute=false` plus
  `CreateNoWindow=true` for `ProcessStartInfo`, or the equivalent hidden-process
  options in the active runtime.
- Treat a modal prompt, crash reporter, source-control login, plugin-enable
  request, compiler UI, window creation, or unattended timeout as a failure.
  Stop safely and explain the requirement; do not retry through an interactive
  executable.

## Inspect an asset

1. Locate the `.uproject`, target `.uasset`, and adjacent `.uexp`, `.ubulk`, or `.uptnl` files. Preserve sidecars as one unit.
2. Call `ue_uasset_inspect` with `mode: "resolve"` first when the project,
   engine association, or virtual package path is uncertain.
3. Call it with the default `registry` mode for normal inspection. This scans
   package headers through Asset Registry without loading the UObject.
4. Use `mode: "load"` only when registry tags are insufficient and the user
   needs UObject metadata or selected safe properties. Loading may initialize
   project plugins and is slower.
5. Pass `project`, `engine`, or `asset_path` when automatic resolution is
   ambiguous. `engine` accepts an engine root, command-editor executable,
   registered version such as `5.7`, or a custom build GUID.
6. Summarize `assets`, `registry_tags`, `dependencies`, `referencers`,
   `loaded_object`, `warnings`, and sidecar presence. Distinguish Asset Registry
   facts from values obtained after loading.

For manual diagnosis outside the DSH tool, resolve this skill's resource base
and invoke `scripts/Invoke-UAssetInspection.ps1` by absolute path. Do not assume
the skill is the current directory. To resolve paths only:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File <skill-root>\scripts\Invoke-UAssetInspection.ps1 -UAsset <file.uasset> -ResolveOnly
   ```

Run the default registry-only inspection:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File <skill-root>\scripts\Invoke-UAssetInspection.ps1 -UAsset <file.uasset> -Output <report.json>
   ```

## Edit Blueprint nodes with built-in Python

Map the user's request only to one of these supported actions:

| Action | Effect |
|---|---|
| `replace_variable_references` | Redirect existing Blueprint variable get/set references from one named variable to another. |
| `upgrade_operator_nodes` | Upgrade legacy arithmetic/operator nodes using Unreal's built-in migration routine. |
| `remove_unused_nodes` | Remove user-deletable nodes that have no connections. This can affect every editable graph in the Blueprint. |

For a supported write, identify the exact Blueprint `.uasset`, call
`ue_blueprint_python_edit` with `confirm_write: true`, and pass both variable
names for `replace_variable_references`. The wrapper copies the `.uasset` and
sidecars to `Saved/DSHUEAssetsOperator/Backups`, compiles the Blueprint, and
saves only when compilation is not in an error state. Report the backup path,
compile status, save result, and whether the returned change signal is exact or
best-effort.

Do not claim that built-in Python can translate arbitrary logic into K2 nodes.
For requests to create event, branch, function-call, macro, cast, variable, or
other arbitrary nodes; set pin defaults; or connect pins, use the
`create_logic_nodes` action only to obtain the structured limitation report, or
explain directly that no asset was changed. State that UE's built-in
`BlueprintEditorLibrary` lacks generic node construction and pin-link APIs.
Then proceed directly to the project Commandlet workflow below when the project
has an existing Editor module. Do not ask the user for separate source, build,
or asset-write authorization first. If no existing Editor module exists,
report that prerequisite as the blocking failure and stop.

Read [references/blueprint-python-limits.md](references/blueprint-python-limits.md)
before handling any Blueprint graph mutation.

## Author Blueprint graphs with a project Commandlet

Use this route for arbitrary node creation, pin defaults and connections,
Animation Blueprint state machines or transitions, and type-specific graph APIs
that built-in Python cannot reach.

1. Read
   [references/blueprint-commandlet-workflow.md](references/blueprint-commandlet-workflow.md)
   and
   [references/blueprint-graph-rule-presets.md](references/blueprint-graph-rule-presets.md)
   completely before editing project source.
2. Resolve the exact project, engine, Editor target/module, Blueprint object
   path, related assets, and intended package save set.
3. Proceed without a separate user-confirmation step: treat the current
   Blueprint-edit request as authorization for task-owned project C++ source
   and `Build.cs` edits, an Editor-target build, and the named asset writes.
   Do not use that request as permission to restructure the project's modules.
4. Require an existing Editor module. If none exists, explain that a project
   Editor module is required; do not create one or add a plugin implicitly.
5. Generate a minimal task-specific `UCommandlet` scaffold under the existing
   Editor module with `scripts/New-BlueprintCommandlet.ps1`. The generated
   `-Apply` path is intentionally inert. Fill it using the two required
   references above; keep detailed node and conversion rules out of the
   scaffold itself. Require `-ValidateOnly`/`-Apply`, an exact asset argument, a
   validation path with no UObject mutations, an explicit package save set,
   Blueprint compile checks, and nonzero failure returns.
6. Treat the target graph's actual Schema as authoritative. Inspect
   `CanCreateConnection` before `TryCreateConnection`; reject break-existing,
   conversion-node, and promotion responses unless the approved task explicitly
   expects them. Never hardcode a universal numeric/object conversion table.
7. Patch only required Editor-module dependencies, build the exact Editor
   target, and run `-ValidateOnly`. Validation must not mutate UObjects.
8. Back up every package and sidecar named by validation outside `Content`, then
   run `-Apply` only after validation succeeds.
9. Verify graph structure, Blueprint compile status, saved packages, source and
   binary diffs, and report every change and backup.
10. Unless the user explicitly asks to retain the generated Commandlet, attempt
    the cleanup procedure in the workflow reference after success or terminal
    failure. Remove only files created for this run, revert only task-owned
    `Build.cs` edits, rebuild the Editor target, and report any residue. Preserve
    asset backups, validation reports and logs; never broadly delete
    `Binaries`, `Intermediate`, `Saved`, or source-control data.

If code generation, UHT/UBT, module loading, schema validation, compilation, or
saving fails, state the exact failure and whether any package was saved. Never
fall back to raw package editing or unreliable UI automation.


## Operate Unreal Editor

- Use `UnrealEditor-Cmd.exe <project> -run=pythonscript -script=<script>` for deterministic headless asset work, with every flag required by **Stay headless**.
- If an operation requires interactive UI, a viewport, modal dialog, IDE, or visual verification, explain that it cannot be completed under the no-window requirement and stop.
- Enable `PythonScriptPlugin` before Python automation. Do not edit the `.uproject` to enable it unless the user authorized that project change.
- For mutations, create a narrowly scoped Unreal Python script or project Editor Commandlet, name every target asset explicitly, use Unreal APIs rather than raw package bytes, save only intended packages, and report changed source, binaries, `.uasset` files, and sidecars.
- Before destructive operations, confirm source-control or backup state. Never delete, rename, resave, migrate, redirect, or bulk-edit assets merely to inspect them.
- Never hex-edit `.uasset`. Never silently substitute a different engine version when the project's `EngineAssociation` cannot be resolved.

## Handle limits

- If the package is cooked, encrypted, containerized, or from a custom engine fork, report the limitation and request the exact engine/build context or authorized keys; do not claim a complete decode.
- If Blueprint graph work is not exposed to built-in Python, use the project Editor Commandlet route directly. For other asset types, use a type-specific built-in API when one exists; otherwise explain the limitation and do not imply that an edit succeeded.
- If the asset sits outside project or plugin `Content`, require an explicit virtual `-AssetPath` and verify that its mount point exists.
- Read [references/ue-workflows.md](references/ue-workflows.md) before enabling plugins, exporting payloads, editing assets, or diagnosing a failed commandlet.

## Verify work

- Require a fresh JSON report with `success: true`. Surface a nonzero `wrapper_process.exit_code`; accept it only when the matching report succeeded, because UE can return 1 after a read-only commandlet when its DDC memory fallback logs a nonfatal error.
- Inspect the Unreal log tail on failure; preserve the original package and retry only after resolving the stated engine, plugin, class, mount, or sidecar issue.
- After mutation, compare project changes and reopen or re-inspect the exact asset. Do not treat a successful process launch as proof that an asset was saved correctly.

