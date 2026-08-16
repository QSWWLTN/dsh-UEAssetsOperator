import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  BLUEPRINT_EDIT_TOOL_NAME,
  TOOL_NAME,
  apply,
  createBlueprintPythonEditTool,
  createSkillRegistration,
  createUAssetTool,
  inject
} from '../lib/index.js';

test('loads without DSH packages and only requires the tools service', () => {
  assert.deepEqual(inject, ['tools']);

  const registeredTools = [];
  apply({
    tools: { register: (tool) => registeredTools.push(tool) }
  });

  assert.deepEqual(registeredTools.map((tool) => tool.name), [
    TOOL_NAME,
    BLUEPRINT_EDIT_TOOL_NAME
  ]);
});

test('registers the bundled skill through an optional service injection', () => {
  const registeredSkills = [];
  const requestedServices = [];
  apply({
    tools: { register() {} },
    inject(services, callback) {
      requestedServices.push(services);
      callback({
        skills: { register: (skill) => registeredSkills.push(skill) }
      });
    }
  });

  assert.deepEqual(requestedServices, [['skills']]);
  assert.equal(registeredSkills[0].name, 'ue-uasset-operator');
});

test('emits registry-ready JSON schemas without the DSH tools package', async () => {
  const inspect = createUAssetTool();
  const edit = createBlueprintPythonEditTool();

  assert.equal(inspect.parameters.type, 'object');
  assert.deepEqual(inspect.parameters.required, ['uasset']);
  assert.deepEqual(inspect.output.schema, {});
  assert.deepEqual(edit.parameters.required, ['uasset', 'action']);

  await assert.rejects(
    inspect.execute({ uasset: 42 }, {}),
    (error) => error.name === 'ToolArgsError' && error.code === 'INVALID_ARGS'
  );
  const unsupported = await edit.execute({
    uasset: 'X:\\Project\\Content\\BP_Test.uasset',
    action: 'create_logic_nodes'
  });
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.changed, false);
});

test('validates required fields, enums, optional types, and write confirmation', async () => {
  const inspect = createUAssetTool();
  const edit = createBlueprintPythonEditTool();
  const invalidArgs = (error) => (
    error.name === 'ToolArgsError'
    && error.code === 'INVALID_ARGS'
    && Array.isArray(error.violations)
  );

  await assert.rejects(inspect.execute({}, {}), invalidArgs);
  await assert.rejects(
    inspect.execute({ uasset: 'Asset.uasset', mode: 'deep' }, {}),
    invalidArgs
  );
  await assert.rejects(
    inspect.execute({ uasset: 'Asset.uasset', project: 42 }, {}),
    invalidArgs
  );
  await assert.rejects(
    inspect.execute({ uasset: 'Asset.uasset', timeout_seconds: 29 }, {}),
    /timeout_seconds must be an integer between 30 and 3600/
  );
  await assert.rejects(
    edit.execute({
      uasset: 'Blueprint.uasset',
      action: 'remove_unused_nodes',
      confirm_write: false
    }, {}),
    /confirm_write must be true/
  );
  await assert.rejects(
    edit.execute({
      uasset: 'Blueprint.uasset',
      action: 'create_logic_nodes',
      confirm_write: 'yes'
    }, {}),
    invalidArgs
  );
});

test('bundled skill explains the Anchored Standard exact-name unlock', () => {
  const skill = createSkillRegistration();
  assert.match(skill.content, /Anchored Standard/);
  assert.match(
    skill.content,
    /\{"toolNames":\["ue_uasset_inspect","ue_blueprint_python_edit"\]\}/
  );
});

test('package exposes a DSH bundle patch', async () => {
  const packageJson = JSON.parse(await readFile(
    new URL('../package.json', import.meta.url),
    'utf8'
  ));
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');

  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(packageJson.exports['./cordis.patch.yml'], './cordis.patch.yml');
  assert.match(patch, /id: ue-uasset-operator/);
  assert.match(patch, /@deepseek-dsh-desktop\/dsh-ue-uasset-operator/);
});
