"""Apply the narrow set of Blueprint node edits exposed by built-in UE Python."""

import json
import os
import traceback
from datetime import datetime, timezone

import unreal


SOURCE_ENV = "UE_UASSET_INSPECT_FILE"
PACKAGE_ENV = "UE_UASSET_INSPECT_PACKAGE"
OUTPUT_ENV = "UE_UASSET_INSPECT_OUTPUT"
ACTION_ENV = "UE_BP_PY_ACTION"
OLD_VARIABLE_ENV = "UE_BP_PY_OLD_VARIABLE"
NEW_VARIABLE_ENV = "UE_BP_PY_NEW_VARIABLE"
SUPPORTED_ACTIONS = {
    "replace_variable_references",
    "upgrade_operator_nodes",
    "remove_unused_nodes",
}
MAX_TEXT = 4096


def _required_environment(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError("Missing required environment variable: {}".format(name))
    return value


def _text(value):
    result = str(value)
    if len(result) > MAX_TEXT:
        return result[:MAX_TEXT] + "...<truncated>"
    return result


def _write_report(path, report):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2, sort_keys=True)


def _graph_snapshot(blueprint):
    """Best-effort diagnostics only; editing never depends on private graph access."""
    result = {"graph_count": 0, "node_count": 0, "node_classes": {}}
    seen = set()
    for property_name in (
        "ubergraph_pages",
        "function_graphs",
        "macro_graphs",
        "delegate_signature_graphs",
    ):
        try:
            graphs = list(blueprint.get_editor_property(property_name) or [])
        except Exception:
            continue
        for graph in graphs:
            if graph is None:
                continue
            graph_path = graph.get_path_name()
            if graph_path in seen:
                continue
            seen.add(graph_path)
            result["graph_count"] += 1
            try:
                nodes = list(graph.get_editor_property("nodes") or [])
            except Exception:
                continue
            result["node_count"] += len(nodes)
            for node in nodes:
                try:
                    class_name = node.get_class().get_name()
                except Exception:
                    class_name = type(node).__name__
                result["node_classes"][class_name] = (
                    result["node_classes"].get(class_name, 0) + 1
                )
    result["node_classes"] = dict(sorted(result["node_classes"].items()))
    return result


def _load_blueprint(package_name):
    asset = unreal.load_asset(package_name)
    if asset is None:
        raise RuntimeError("Could not load asset: {}".format(package_name))
    blueprint = unreal.BlueprintEditorLibrary.get_blueprint_asset(asset)
    if blueprint is None:
        raise RuntimeError(
            "Target is not a Blueprint asset: {} ({})".format(
                package_name, asset.get_class().get_path_name()
            )
        )
    return blueprint


def _apply_action(blueprint, action):
    details = {}
    if action == "replace_variable_references":
        old_name = _required_environment(OLD_VARIABLE_ENV)
        new_name = _required_environment(NEW_VARIABLE_ENV)
        if old_name == new_name:
            raise RuntimeError("Old and new variable names must be different")
        unreal.BlueprintEditorLibrary.replace_variable_references(
            blueprint, old_name, new_name
        )
        details["old_variable_name"] = old_name
        details["new_variable_name"] = new_name
    elif action == "upgrade_operator_nodes":
        unreal.BlueprintEditorLibrary.upgrade_operator_nodes(blueprint)
    elif action == "remove_unused_nodes":
        unreal.BlueprintEditorLibrary.remove_unused_nodes(blueprint)
    else:
        raise RuntimeError("Unsupported Blueprint Python action: {}".format(action))
    return details


def _compile_and_save(blueprint):
    unreal.BlueprintEditorLibrary.compile_blueprint(blueprint)
    try:
        status = blueprint.get_editor_property("status")
        status_text = _text(status)
    except Exception:
        status_text = "unavailable"
    if "ERROR" in status_text.upper():
        raise RuntimeError(
            "Blueprint compilation failed with status {}; asset was not saved".format(
                status_text
            )
        )

    subsystem = unreal.get_editor_subsystem(unreal.EditorAssetSubsystem)
    if subsystem is None or not subsystem.save_loaded_asset(blueprint, False):
        raise RuntimeError("Blueprint compiled, but saving the target asset failed")
    return status_text


def main():
    source_file = _required_environment(SOURCE_ENV)
    package_name = _required_environment(PACKAGE_ENV)
    output_file = _required_environment(OUTPUT_ENV)
    action = _required_environment(ACTION_ENV)
    report = {
        "schema_version": 1,
        "success": False,
        "supported": action in SUPPORTED_ACTIONS,
        "changed": None,
        "saved": False,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "request": {
            "source_file": source_file,
            "package_name": package_name,
            "action": action,
        },
        "engine": {
            "version": unreal.SystemLibrary.get_engine_version(),
            "project_file": unreal.Paths.get_project_file_path(),
        },
        "warnings": [],
    }

    try:
        if action not in SUPPORTED_ACTIONS:
            raise RuntimeError(
                "Built-in Unreal Python cannot perform Blueprint action: {}".format(action)
            )
        blueprint = _load_blueprint(package_name)
        report["blueprint_object_path"] = blueprint.get_path_name()
        report["before"] = _graph_snapshot(blueprint)
        report["operation"] = _apply_action(blueprint, action)
        report["after"] = _graph_snapshot(blueprint)
        report["compile_status"] = _compile_and_save(blueprint)
        report["operation_invoked"] = True
        report["structural_change_detected"] = report["before"] != report["after"]
        if action == "remove_unused_nodes":
            report["changed"] = (
                report["before"]["node_count"] != report["after"]["node_count"]
            )
        else:
            report["warnings"].append(
                "Built-in Python does not expose a reliable per-node change result for this operation; null changed means unknown, not success or failure."
            )
        report["saved"] = True
        report["success"] = True
    except Exception as error:
        report["error"] = _text(error)
        report["traceback"] = traceback.format_exc(limit=20)
        _write_report(output_file, report)
        unreal.log_error("UE Blueprint Python edit failed: {}".format(error))
        raise

    _write_report(output_file, report)
    unreal.log("UE Blueprint Python edit report: {}".format(output_file))


if __name__ == "__main__":
    main()
