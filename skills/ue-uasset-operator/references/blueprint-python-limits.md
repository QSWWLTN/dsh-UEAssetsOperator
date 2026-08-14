# Blueprint editing through built-in Unreal Python

## Supported by this plugin

The plugin deliberately calls only reflected methods on Unreal's built-in
`BlueprintEditorLibrary`:

- `replace_variable_references`
- `upgrade_operator_nodes`
- `remove_unused_nodes`
- `compile_blueprint`

These operations modify existing Blueprint structures. They do not provide a
general graph authoring API. Every mutation requires explicit write
confirmation, a package backup, compilation, and an explicit save of the target
Blueprint only.

`remove_unused_nodes` is broad: Unreal examines every editable graph in the
Blueprint and removes user-deletable nodes with no connections. Use it only
when that whole-Blueprint cleanup is what the user requested.

For variable replacement and operator upgrades, Unreal Python does not return a
reliable count of changed nodes. A successful report means the operation was
invoked, compilation completed without an error status, and the target asset
was saved. Preserve `changed: null` as “unknown”; never rewrite it as “changed.”

## Not supported by built-in Python

Built-in Unreal Python does not expose generic equivalents of the Editor C++
node-spawn and schema-connection APIs. Therefore this plugin cannot reliably:

- create arbitrary K2 event, call, branch, sequence, cast, macro, or variable nodes;
- choose overloads and reconstruct all node pins;
- set arbitrary pin defaults;
- connect or disconnect execution/data pins;
- translate a free-form logic description into a complete executable graph.

When asked for one of these operations, confirm that the Python tool cannot do
it and that no asset was changed. If the project has an existing Editor module
and the user authorizes project C++ source changes, compilation, and asset
writes, follow
[blueprint-commandlet-workflow.md](blueprint-commandlet-workflow.md). Otherwise
offer a manual node construction plan and stop.

## Primary API references

- [BlueprintEditorLibrary Python API](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/BlueprintEditorLibrary?application_version=5.7)
- [BlueprintGraph Editor C++ API](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Editor/BlueprintGraph)
