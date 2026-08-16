import assert from "node:assert/strict";
import test from "node:test";

import {
  QUATTRO_BROWSER_EXPERIENCE,
  QUATTRO_BROWSER_IDENTITY,
  validateQuattroBrowserContract,
} from "../browser-edition/source-contract.mjs";

test("accepts the exact pinned Quattro Browser Edition contract", () => {
  assert.deepEqual(
    validateQuattroBrowserContract(
      QUATTRO_BROWSER_IDENTITY,
      QUATTRO_BROWSER_EXPERIENCE,
    ),
    { valid: true, errors: [] },
  );
});

test("rejects a generic distro, source drift, or missing Omarchy experience", () => {
  const result = validateQuattroBrowserContract(
    {
      ...QUATTRO_BROWSER_IDENTITY,
      repository: "https://example.com/generic-linux",
      commit: "0".repeat(40),
    },
    {
      ...QUATTRO_BROWSER_EXPERIENCE,
      requiredExperiences: ["terminal"],
      permittedSubstitutions: {
        ...QUATTRO_BROWSER_EXPERIENCE.permittedSubstitutions,
        compositor: "static-desktop-screenshot",
      },
    },
  );

  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /untrusted upstream repository/);
  assert.match(result.errors.join("\n"), /untrusted upstream commit/);
  assert.match(result.errors.join("\n"), /keyboard-first-launcher/);
  assert.match(result.errors.join("\n"), /invalid compositor substitution/);
});

test("records the official source files that define the browser experience", () => {
  assert.deepEqual(Object.keys(QUATTRO_BROWSER_EXPERIENCE.authority).sort(), [
    "bar",
    "bindings",
    "menu",
    "shell",
    "theme",
    "tilingBindings",
  ]);
  assert.equal(QUATTRO_BROWSER_EXPERIENCE.authority.menu, "default/omarchy/omarchy-menu.jsonc");
  assert.equal(QUATTRO_BROWSER_EXPERIENCE.authority.theme, "themes/tokyo-night/colors.toml");
});
