"""Run inside Unreal Editor Python and emit a read-only asset inspection report."""

import json
import os
import traceback
from datetime import datetime, timezone

import unreal


SOURCE_ENV = "UE_UASSET_INSPECT_FILE"
PACKAGE_ENV = "UE_UASSET_INSPECT_PACKAGE"
OUTPUT_ENV = "UE_UASSET_INSPECT_OUTPUT"
LOAD_ENV = "UE_UASSET_INSPECT_LOAD"
MAX_ITEMS = 256
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


def _map_items(value):
    if value is None:
        return None
    for method_name in ("items", "iteritems"):
        method = getattr(value, method_name, None)
        if callable(method):
            return list(method())
    try:
        return list(dict(value).items())
    except Exception:
        return None


def _json_value(value, depth=0):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if depth >= 3:
        return _text(value)
    if isinstance(value, (list, tuple, set)):
        items = list(value)
        result = [_json_value(item, depth + 1) for item in items[:MAX_ITEMS]]
        if len(items) > MAX_ITEMS:
            result.append("<{} more items>".format(len(items) - MAX_ITEMS))
        return result
    mapped = _map_items(value)
    if mapped is not None:
        result = {}
        for key, item in mapped[:MAX_ITEMS]:
            result[_text(key)] = _json_value(item, depth + 1)
        if len(mapped) > MAX_ITEMS:
            result["<truncated>"] = len(mapped) - MAX_ITEMS
        return result
    get_path_name = getattr(value, "get_path_name", None)
    if callable(get_path_name):
        try:
            class_name = value.get_class().get_path_name()
        except Exception:
            class_name = type(value).__name__
        try:
            path_name = get_path_name()
        except Exception:
            path_name = _text(value)
        return {"class": _text(class_name), "path": _text(path_name)}
    return _text(value)


def _call_bool(target, method_name):
    method = getattr(target, method_name, None)
    if not callable(method):
        return None
    try:
        return bool(method())
    except Exception:
        return None


def _source_file_details(source_file):
    details = {
        "path": source_file,
        "exists": os.path.isfile(source_file),
    }
    if details["exists"]:
        details["size_bytes"] = os.path.getsize(source_file)
    base, _ = os.path.splitext(source_file)
    sidecars = []
    for extension in (".uexp", ".ubulk", ".uptnl"):
        candidate = base + extension
        if os.path.isfile(candidate):
            sidecars.append({"path": candidate, "size_bytes": os.path.getsize(candidate)})
    details["sidecars"] = sidecars
    return details


def _dependency_options():
    options = unreal.AssetRegistryDependencyOptions()
    for property_name in (
        "include_soft_package_references",
        "include_hard_package_references",
        "include_game_package_references",
        "include_editor_only_package_references",
        "include_searchable_names",
        "include_soft_management_references",
        "include_hard_management_references",
    ):
        try:
            options.set_editor_property(property_name, True)
        except Exception:
            pass
    return options


def _editor_asset_subsystem(warnings):
    subsystem_class = getattr(unreal, "EditorAssetSubsystem", None)
    if subsystem_class is None:
        warnings.append("EditorAssetSubsystem is unavailable; registry tags and metadata may be limited.")
        return None
    try:
        return unreal.get_editor_subsystem(subsystem_class)
    except Exception as error:
        warnings.append("Could not initialize EditorAssetSubsystem: {}".format(error))
        return None


PROPERTY_CANDIDATES = (
    "blueprint_type",
    "parent_class",
    "generated_class",
    "skeleton_generated_class",
    "lod_group",
    "compression_settings",
    "compression_quality",
    "srgb",
    "filter",
    "address_x",
    "address_y",
    "address_z",
    "virtual_texture_streaming",
    "never_stream",
    "duration",
    "num_channels",
    "sample_rate",
    "sound_group",
    "loading_behavior",
    "row_struct",
    "preview_mesh",
    "skeleton",
    "physics_asset",
    "nanite_settings",
    "light_map_coordinate_index",
    "light_map_resolution",
    "allow_cpu_access",
    "material_domain",
    "blend_mode",
    "shading_model",
    "two_sided",
    "use_material_attributes",
)

METHOD_CANDIDATES = (
    "get_num_lods",
    "get_lod_num",
    "blueprint_get_size_x",
    "blueprint_get_size_y",
    "get_row_names",
)


def _loaded_object_details(asset, subsystem):
    result = {
        "path": asset.get_path_name(),
        "class": asset.get_class().get_path_name(),
    }
    try:
        result["package"] = asset.get_outermost().get_path_name()
    except Exception:
        pass

    properties = {}
    for property_name in PROPERTY_CANDIDATES:
        try:
            properties[property_name] = _json_value(asset.get_editor_property(property_name))
        except Exception:
            pass
    if properties:
        result["selected_properties"] = properties

    measurements = {}
    for method_name in METHOD_CANDIDATES:
        method = getattr(asset, method_name, None)
        if not callable(method):
            continue
        try:
            measurements[method_name] = _json_value(method())
        except Exception:
            pass
    if measurements:
        result["measurements"] = measurements

    if subsystem is not None:
        try:
            result["metadata"] = _json_value(subsystem.get_metadata_tag_values(asset))
        except Exception:
            pass
    return result


def _asset_data_details(asset_data, load_asset, subsystem, warnings):
    asset_name = _text(asset_data.asset_name)
    package_name = _text(asset_data.package_name)
    object_path = "{}.{}".format(package_name, asset_name)
    class_path = getattr(asset_data, "asset_class_path", None)
    if class_path is None:
        class_path = getattr(asset_data, "asset_class", "")
    elif hasattr(class_path, "package_name") and hasattr(class_path, "asset_name"):
        class_path = "{}.{}".format(class_path.package_name, class_path.asset_name)

    result = {
        "asset_name": asset_name,
        "package_name": package_name,
        "package_path": _text(asset_data.package_path),
        "object_path": object_path,
        "asset_class": _text(class_path),
        "full_name": _text(asset_data.get_full_name()),
        "export_text_name": _text(asset_data.get_export_text_name()),
        "is_valid": _call_bool(asset_data, "is_valid"),
        "is_uasset": _call_bool(asset_data, "is_u_asset"),
        "is_cooked": _call_bool(asset_data, "is_cooked"),
        "is_redirector": _call_bool(asset_data, "is_redirector"),
        "has_editor_only_data": _call_bool(asset_data, "has_editor_only_data"),
    }

    if subsystem is not None:
        try:
            result["registry_tags"] = _json_value(subsystem.get_tag_values(object_path))
        except Exception as error:
            warnings.append("Could not read registry tags for {}: {}".format(object_path, error))

    if load_asset:
        try:
            asset = asset_data.get_asset()
            if asset is None:
                warnings.append("AssetData.get_asset returned None for {}".format(object_path))
            else:
                result["loaded_object"] = _loaded_object_details(asset, subsystem)
        except Exception as error:
            warnings.append("Could not load {}: {}".format(object_path, error))
    return result


def _write_report(path, report):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2, sort_keys=True)


def main():
    source_file = _required_environment(SOURCE_ENV)
    package_name = _required_environment(PACKAGE_ENV)
    output_file = _required_environment(OUTPUT_ENV)
    load_asset = os.environ.get(LOAD_ENV, "0").strip().lower() in ("1", "true", "yes", "on")
    warnings = []
    report = {
        "schema_version": 1,
        "success": False,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "request": {
            "source_file": source_file,
            "package_name": package_name,
            "load_asset": load_asset,
        },
        "engine": {
            "version": unreal.SystemLibrary.get_engine_version(),
            "project_file": unreal.Paths.get_project_file_path(),
        },
        "source": _source_file_details(source_file),
        "warnings": warnings,
    }

    try:
        registry = unreal.AssetRegistryHelpers.get_asset_registry()
        registry.scan_files_synchronous([source_file], True)
        wait_for_package = getattr(registry, "wait_for_package", None)
        if callable(wait_for_package):
            wait_for_package(package_name)

        asset_data = list(registry.get_assets_by_package_name(package_name, False) or [])
        if not asset_data:
            raise RuntimeError("Asset Registry returned no assets for package {}".format(package_name))

        subsystem = _editor_asset_subsystem(warnings)
        report["assets"] = [
            _asset_data_details(item, load_asset, subsystem, warnings) for item in asset_data
        ]

        options = _dependency_options()
        report["dependencies"] = sorted(
            _text(item) for item in (registry.get_dependencies(package_name, options) or [])
        )
        report["referencers"] = sorted(
            _text(item) for item in (registry.get_referencers(package_name, options) or [])
        )
        report["success"] = True
    except Exception as error:
        report["error"] = _text(error)
        report["traceback"] = traceback.format_exc(limit=20)
        _write_report(output_file, report)
        unreal.log_error("UE uasset inspection failed: {}".format(error))
        raise

    _write_report(output_file, report)
    unreal.log("UE uasset inspection report: {}".format(output_file))


if __name__ == "__main__":
    main()
