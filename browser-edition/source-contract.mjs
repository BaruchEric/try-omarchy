export const QUATTRO_BROWSER_IDENTITY = Object.freeze({
  product: "Omarchy Quattro Browser Edition",
  channel: "quattro",
  version: "4.0.0.alpha",
  repository: "https://github.com/basecamp/omarchy",
  commit: "f0020448ca87329199de7cb12f2015ebc4a3e5e7",
  tree: "19fba2114c162be330337f8a7f1e109e2a1f8384",
  normalizedTreeSha256:
    "7c053841c0b43df796cb002441f3e0cccad4a32288769f499c86b509b4f86980",
  license: "MIT",
});

export const QUATTRO_BROWSER_EXPERIENCE = Object.freeze({
  authority: Object.freeze({
    menu: "default/omarchy/omarchy-menu.jsonc",
    shell: "shell/shell.qml",
    bar: "shell/plugins/bar/Bar.qml",
    theme: "themes/tokyo-night/colors.toml",
    bindings: "default/hypr/bindings.lua",
    tilingBindings: "default/hypr/bindings/tiling.lua",
  }),
  requiredExperiences: Object.freeze([
    "keyboard-first-launcher",
    "dynamic-window-tiling",
    "workspaces",
    "terminal",
    "files",
    "theme-switching",
    "quattro-menu-hierarchy",
    "persistent-local-home",
  ]),
  permittedSubstitutions: Object.freeze({
    compositor: "browser-native-window-manager",
    shellRenderer: "browser-native-quattro-shell",
    graphics: "browser-css-webgl-webgpu",
    processRuntime: "client-side-wasm-userspace",
    filesystem: "browser-origin-private-storage",
    unavailableHardware: "clearly-labelled-demo-actions",
  }),
  prohibitedClaims: Object.freeze([
    "full-omarchy-installation",
    "hyprland-process-running",
    "arch-kernel-running",
    "hardware-virtualization",
  ]),
});

export function validateQuattroBrowserContract(identity, experience) {
  const errors = [];

  if (identity?.repository !== QUATTRO_BROWSER_IDENTITY.repository) {
    errors.push("untrusted upstream repository");
  }
  if (identity?.commit !== QUATTRO_BROWSER_IDENTITY.commit) {
    errors.push("untrusted upstream commit");
  }
  if (identity?.normalizedTreeSha256 !== QUATTRO_BROWSER_IDENTITY.normalizedTreeSha256) {
    errors.push("untrusted normalized source tree");
  }
  if (identity?.channel !== "quattro" || identity?.license !== "MIT") {
    errors.push("invalid Quattro channel or license identity");
  }

  const requirements = new Set(experience?.requiredExperiences ?? []);
  for (const requirement of QUATTRO_BROWSER_EXPERIENCE.requiredExperiences) {
    if (!requirements.has(requirement)) {
      errors.push(`missing required experience: ${requirement}`);
    }
  }

  for (const [layer, implementation] of Object.entries(
    QUATTRO_BROWSER_EXPERIENCE.permittedSubstitutions,
  )) {
    if (experience?.permittedSubstitutions?.[layer] !== implementation) {
      errors.push(`invalid ${layer} substitution`);
    }
  }

  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}
