---
name: ue-uasset-operator
description: Operate Unreal Editor and inspect Unreal Engine asset packages safely. Use when an agent must locate the matching UE4/UE5 installation for a .uproject, translate a Content/*.uasset filename to a virtual /Game or plugin package path, read .uasset registry data and loaded UObject metadata, report dependencies or referencers, run Unreal Python automation, open or modify named project assets, or diagnose engine-version, plugin, cooked-asset, sidecar, and package-load failures.
---

# UE uasset operator

Use the native `ue_uasset_inspect` tool for inspection. The tool is registered
by this DSH plugin and returns structured JSON directly; do not route routine
inspection through Codex skills or construct an ad-hoc shell command.

Use the matching Unreal Editor as the authoritative parser. Treat `.uasset` as a versioned binary package, not a stable standalone document format.

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


## Operate Unreal Editor

- Prefer `UnrealEditor-Cmd.exe <project> -run=pythonscript -script=<script>` for deterministic headless asset work.
- Use `UnrealEditor.exe` only for operations requiring interactive UI, viewport, modal dialogs, or visual verification.
- Enable `PythonScriptPlugin` before Python automation. Do not edit the `.uproject` to enable it unless the user authorized that project change.
- For mutations, create a narrowly scoped Unreal Python script, name every target asset explicitly, use Unreal APIs rather than raw package bytes, save only intended packages, and report the changed `.uasset` plus sidecars.
- Before destructive operations, confirm source-control or backup state. Never delete, rename, resave, migrate, redirect, or bulk-edit assets merely to inspect them.
- Never hex-edit `.uasset`. Never silently substitute a different engine version when the project's `EngineAssociation` cannot be resolved.

## Handle limits

- If the package is cooked, encrypted, containerized, or from a custom engine fork, report the limitation and request the exact engine/build context or authorized keys; do not claim a complete decode.
- If Blueprint graphs, material graphs, mesh payloads, textures, audio, or custom plugin data are not exposed by generic registry/UObject metadata, use a type-specific Unreal API or exporter in the matching editor.
- If the asset sits outside project or plugin `Content`, require an explicit virtual `-AssetPath` and verify that its mount point exists.
- Read [references/ue-workflows.md](references/ue-workflows.md) before enabling plugins, exporting payloads, editing assets, or diagnosing a failed commandlet.

## Verify work

- Require a fresh JSON report with `success: true`. Surface a nonzero `wrapper_process.exit_code`; accept it only when the matching report succeeded, because UE can return 1 after a read-only commandlet when its DDC memory fallback logs a nonfatal error.
- Inspect the Unreal log tail on failure; preserve the original package and retry only after resolving the stated engine, plugin, class, mount, or sidecar issue.
- After mutation, compare project changes and reopen or re-inspect the exact asset. Do not treat a successful process launch as proof that an asset was saved correctly.

