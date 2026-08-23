.DEFAULT_GOAL := test

.PHONY: audit build package serve smoke test verify browser-qemu verify-dist

audit:
	./scripts/audit-upstreams.sh

build:
	./scripts/build-qemu-wasm.sh

package:
	@test -n "$(GUEST_DIR)" || (echo "usage: make package GUEST_DIR=/absolute/path/to/assets" >&2; exit 2)
	./scripts/package-guest.sh "$(GUEST_DIR)"

serve:
	./scripts/run-browser-qemu.mjs

smoke:
	./scripts/package-smoke.sh

test:
	node --test ./tests/*.test.mjs

verify:
	node ./scripts/verify-runtime-artifacts.mjs ./dist

# Compatibility aliases used by the repository-level npm command and docs.
browser-qemu: serve

verify-dist: verify
