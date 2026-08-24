SHELL := /bin/bash

ROOT := $(CURDIR)
DIST := $(ROOT)/dist
GUEST_DIST := $(DIST)/guest
APP := $(DIST)/Try Omarchy.app
DMG := $(DIST)/Try Omarchy.dmg

.DEFAULT_GOAL := help
.PHONY: help doctor test guest runtime app build run run-ephemeral reset package clean clean-guest

help:
	@printf '%s\n' \
	  'Try Omarchy — native macOS build commands' \
	  '' \
	  '  make doctor         Check the local toolchain' \
	  '  make test           Run native and guest contract tests' \
	  '  make build          Build guest, runtime, and app' \
	  '  make run            Build the app from existing artifacts and open it' \
	  '  make package        Create dist/Try Omarchy.dmg' \
	  '' \
	  'Component builds:' \
	  '  make guest          Build dist/guest in Docker' \
	  '  make runtime        Build macos/.build/qemu-gpu-runtime' \
	  '  make app            Build dist/Try Omarchy.app from both artifacts' \
	  '' \
	  'Storage:' \
	  '  make run-ephemeral  Run without retaining VM changes' \
	  '  make reset          Reset the persistent VM disk, then run' \
	  '  make clean          Remove app, DMG, and native build cache' \
	  '  make clean-guest    Also remove the generated guest image'

doctor:
	@[[ "$$(uname -s)" == Darwin ]] || { echo 'error: macOS is required' >&2; exit 1; }
	@[[ "$$(uname -m)" == arm64 ]] || { echo 'error: an Apple Silicon Mac is required' >&2; exit 1; }
	@major=$$(sw_vers -productVersion | cut -d. -f1); (( major >= 15 )) || { echo 'error: macOS 15 or newer is required' >&2; exit 1; }
	@for tool in brew docker pkg-config swift xcrun zstd; do command -v "$$tool" >/dev/null || { echo "error: $$tool is required" >&2; exit 1; }; done
	@docker info >/dev/null 2>&1 || { echo 'error: Docker is installed but not running' >&2; exit 1; }
	@printf 'Toolchain ready: %s (%s)\n' "$$(sw_vers -productVersion)" "$$(uname -m)"

test:
	@$(ROOT)/guest/test
	@mkdir -p $(ROOT)/macos/.build/module-cache/swift $(ROOT)/macos/.build/module-cache/clang
	@cd $(ROOT)/macos && SWIFT_MODULECACHE_PATH=$(ROOT)/macos/.build/module-cache/swift CLANG_MODULE_CACHE_PATH=$(ROOT)/macos/.build/module-cache/clang swift test --disable-sandbox
	@$(ROOT)/macos/Tests/qemu-persistent-storage.test.sh

guest:
	@$(ROOT)/guest/build-container.sh --output $(GUEST_DIST)

runtime:
	@$(ROOT)/macos/build-qemu-gpu-runtime.sh

app:
	@$(ROOT)/macos/build-app.sh --guest-dir $(GUEST_DIST)

build: doctor guest runtime app

run: app
	@$(ROOT)/macos/open-qemu-gpu.sh

run-ephemeral: app
	@$(ROOT)/macos/open-qemu-gpu.sh --ephemeral

reset: app
	@$(ROOT)/macos/open-qemu-gpu.sh --reset-storage

package:
	@$(ROOT)/macos/build-app.sh --dmg --guest-dir $(GUEST_DIST)

clean:
	@rm -rf -- "$(APP)" "$(DMG)" "$(ROOT)/macos/.build"

clean-guest: clean
	@rm -rf -- "$(GUEST_DIST)"
