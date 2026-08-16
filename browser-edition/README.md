# Omarchy Quattro Browser Edition

This is a client-side distribution of the pinned, MIT-licensed Omarchy Quattro
source. It is not an Alpine desktop with an Omarchy skin, and it is not the
full hardware-oriented Arch installation running in a virtual machine.

The official Quattro source remains the authority for the menu hierarchy,
keyboard workflow, workspace and tiling behavior, theme tokens, terminology,
shell layout, and bundled demo content. Browser Edition replaces only layers
that browsers cannot execute efficiently: Hyprland composition, Quickshell's
Qt renderer, physical hardware services, and native application processes.

Those layers are implemented with browser-native rendering and a small
client-side userspace so the experience can start quickly and remain smooth on
both ARM and x86 hosts. The UI must identify itself as **Browser Edition** and
must never claim that a Hyprland process, Arch kernel, or complete Omarchy
installation is running.

## Pinned authority

- repository: `https://github.com/basecamp/omarchy`
- channel: `quattro`
- version: `4.0.0.alpha`
- commit: `f0020448ca87329199de7cb12f2015ebc4a3e5e7`
- normalized source SHA-256:
  `7c053841c0b43df796cb002441f3e0cccad4a32288769f499c86b509b4f86980`

The binding and substitution rules are machine-readable in
`source-contract.mjs`. Omarchy's copyright and MIT grant are preserved in
`LICENSE.omarchy`.

## Generated source pack

The Browser Edition does not maintain a separate hand-written menu or theme
catalog. `generate-source-pack.mjs` reads the exact pinned checkout and emits
`generated/quattro-source-pack.mjs`, containing the official root menu, six
shipped demo themes, source keybindings, and SHA-256 bindings for every
authority file used by the browser shell.

```bash
node browser-edition/generate-source-pack.mjs --check
```

The generated module is committed so production builds do not need a Git
checkout or network access. Regeneration fails unless the source checkout is
at the exact pinned commit.
