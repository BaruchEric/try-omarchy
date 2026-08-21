.DEFAULT_GOAL := test

.PHONY: audit build build-arm64-browser-experiment package-arm64-browser-experiment serve-full-arm64-browser-experiment build-tcg-threshold-250 build-tcg-baseline-metrics build-webgl2-present build-virgl-webgl2 build-virgl-webgl2-tcg-baseline-metrics build-virgl-webgl2-tcg-bounded-clock build-virgl-webgl2-tcg-fill-120k build-virgl-webgl2-tcg-batch32 build-virgl-webgl2-tcg-threshold-750-4vcpu package package-tcg-threshold-250 package-tcg-baseline-metrics package-webgl2-present package-virgl-webgl2 package-virgl-webgl2-tcg-baseline-metrics package-virgl-webgl2-tcg-bounded-clock package-virgl-webgl2-tcg-fill-120k package-virgl-webgl2-tcg-batch32 package-virgl-webgl2-tcg-threshold-750-4vcpu serve serve-webrtc-poc serve-full serve-full-tcg-threshold-250 serve-full-tcg-baseline-metrics serve-full-webgl2-present serve-full-virgl-webgl2 serve-full-virgl-webgl2-tcg-baseline-metrics serve-full-virgl-webgl2-tcg-fill-120k serve-full-virgl-webgl2-tcg-batch32 serve-full-virgl-webgl2-tcg-threshold-750-4vcpu smoke test verify-dist

TCG_THRESHOLD_250_OUTPUT ?= $(CURDIR)/experiments/tcg-threshold-250/dist
TCG_BASELINE_METRICS_OUTPUT ?= $(CURDIR)/experiments/tcg-baseline-1500-metrics/dist
WEBGL2_PRESENT_OUTPUT ?= $(CURDIR)/experiments/webgl2-present-checkpoint/dist
VIRGL_WEBGL2_OUTPUT ?= $(CURDIR)/experiments/virgl-webgl2/dist
VIRGL_WEBGL2_TCG_BASELINE_OUTPUT ?= $(CURDIR)/experiments/virgl-webgl2-tcg-baseline-1500-metrics/dist
VIRGL_WEBGL2_TCG_CLOCK_OUTPUT ?= $(CURDIR)/experiments/virgl-webgl2-tcg-bounded-clock/dist
VIRGL_WEBGL2_TCG_FILL_120K_OUTPUT ?= $(CURDIR)/experiments/virgl-webgl2-tcg-fill-120k/dist
VIRGL_WEBGL2_TCG_BATCH32_OUTPUT ?= $(CURDIR)/experiments/virgl-webgl2-tcg-batch32/dist
VIRGL_WEBGL2_TCG_750_4VCPU_OUTPUT ?= $(CURDIR)/experiments/virgl-webgl2-tcg-threshold-750-4vcpu/dist
ARM64_BROWSER_OUTPUT ?= $(CURDIR)/experiments/arm64-browser/dist

audit:
	./scripts/audit-upstreams.sh

build:
	./scripts/build-qemu-wasm.sh

build-arm64-browser-experiment:
	OMARCHY_QEMU_ARCHITECTURE=aarch64 \
	QEMU_WASM_OUTPUT="$(ARM64_BROWSER_OUTPUT)" \
	./scripts/build-qemu-wasm.sh

package-arm64-browser-experiment:
	@test -n "$(GUEST_DIR)" || (echo "usage: make package-arm64-browser-experiment GUEST_DIR=/absolute/path/to/arm64/assets" >&2; exit 2)
	./scripts/package-arm64-browser.sh "$(GUEST_DIR)" "$(ARM64_BROWSER_OUTPUT)"

serve-full-arm64-browser-experiment:
	node ./scripts/serve-full-guest.mjs --runtime-root "$(ARM64_BROWSER_OUTPUT)" --guest-root ../guest/dist-aarch64 --port 8100

build-tcg-threshold-250:
	OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT=250 \
	QEMU_WASM_OUTPUT="$(TCG_THRESHOLD_250_OUTPUT)" \
	./scripts/build-qemu-wasm.sh

build-tcg-baseline-metrics:
	OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT=1500-metrics \
	QEMU_WASM_OUTPUT="$(TCG_BASELINE_METRICS_OUTPUT)" \
	./scripts/build-qemu-wasm.sh

build-webgl2-present:
	OMARCHY_GRAPHICS_EXPERIMENT=webgl2-present \
	QEMU_WASM_OUTPUT="$(WEBGL2_PRESENT_OUTPUT)" \
	./scripts/build-qemu-wasm.sh

build-virgl-webgl2:
	OMARCHY_GRAPHICS_EXPERIMENT=virgl-webgl2 \
	QEMU_WASM_OUTPUT="$(VIRGL_WEBGL2_OUTPUT)" \
	./scripts/build-qemu-wasm.sh

build-virgl-webgl2-tcg-baseline-metrics:
	OMARCHY_GRAPHICS_EXPERIMENT=virgl-webgl2 \
	OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT=1500-metrics \
	QEMU_WASM_OUTPUT="$(VIRGL_WEBGL2_TCG_BASELINE_OUTPUT)" \
	./scripts/build-qemu-wasm.sh

build-virgl-webgl2-tcg-bounded-clock:
	OMARCHY_GRAPHICS_EXPERIMENT=virgl-webgl2 \
	OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT=1500-clock \
	QEMU_WASM_OUTPUT="$(VIRGL_WEBGL2_TCG_CLOCK_OUTPUT)" \
	./scripts/build-qemu-wasm.sh

build-virgl-webgl2-tcg-fill-120k:
	OMARCHY_GRAPHICS_EXPERIMENT=virgl-webgl2 \
	OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT=6000-fill \
	QEMU_WASM_OUTPUT="$(VIRGL_WEBGL2_TCG_FILL_120K_OUTPUT)" \
	./scripts/build-qemu-wasm.sh

build-virgl-webgl2-tcg-batch32:
	OMARCHY_GRAPHICS_EXPERIMENT=virgl-webgl2 \
	OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT=6000-batch32 \
	QEMU_WASM_OUTPUT="$(VIRGL_WEBGL2_TCG_BATCH32_OUTPUT)" \
	./scripts/build-qemu-wasm.sh

build-virgl-webgl2-tcg-threshold-750-4vcpu:
	OMARCHY_GRAPHICS_EXPERIMENT=virgl-webgl2 \
	OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT=750 \
	QEMU_WASM_OUTPUT="$(VIRGL_WEBGL2_TCG_750_4VCPU_OUTPUT)" \
	./scripts/build-qemu-wasm.sh

package:
	@test -n "$(GUEST_DIR)" || (echo "usage: make package GUEST_DIR=/absolute/path/to/assets" >&2; exit 2)
	./scripts/package-guest.sh "$(GUEST_DIR)"

package-tcg-threshold-250:
	@test -n "$(GUEST_DIR)" || (echo "usage: make package-tcg-threshold-250 GUEST_DIR=/absolute/path/to/assets" >&2; exit 2)
	OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT=250 \
	./scripts/package-guest.sh "$(GUEST_DIR)" "$(TCG_THRESHOLD_250_OUTPUT)"

package-tcg-baseline-metrics:
	@test -n "$(GUEST_DIR)" || (echo "usage: make package-tcg-baseline-metrics GUEST_DIR=/absolute/path/to/assets" >&2; exit 2)
	OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT=1500-metrics \
	./scripts/package-guest.sh "$(GUEST_DIR)" "$(TCG_BASELINE_METRICS_OUTPUT)"

package-webgl2-present:
	@test -n "$(GUEST_DIR)" || (echo "usage: make package-webgl2-present GUEST_DIR=/absolute/path/to/assets" >&2; exit 2)
	OMARCHY_GRAPHICS_EXPERIMENT=webgl2-present \
	./scripts/package-guest.sh "$(GUEST_DIR)" "$(WEBGL2_PRESENT_OUTPUT)"

package-virgl-webgl2:
	@test -n "$(GUEST_DIR)" || (echo "usage: make package-virgl-webgl2 GUEST_DIR=/absolute/path/to/assets" >&2; exit 2)
	OMARCHY_GRAPHICS_EXPERIMENT=virgl-webgl2 \
	./scripts/package-guest.sh "$(GUEST_DIR)" "$(VIRGL_WEBGL2_OUTPUT)"

package-virgl-webgl2-tcg-baseline-metrics:
	@test -n "$(GUEST_DIR)" || (echo "usage: make package-virgl-webgl2-tcg-baseline-metrics GUEST_DIR=/absolute/path/to/assets" >&2; exit 2)
	OMARCHY_GRAPHICS_EXPERIMENT=virgl-webgl2 \
	OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT=1500-metrics \
	./scripts/package-guest.sh "$(GUEST_DIR)" "$(VIRGL_WEBGL2_TCG_BASELINE_OUTPUT)"

package-virgl-webgl2-tcg-bounded-clock:
	@test -n "$(GUEST_DIR)" || (echo "usage: make package-virgl-webgl2-tcg-bounded-clock GUEST_DIR=/absolute/path/to/assets" >&2; exit 2)
	OMARCHY_GRAPHICS_EXPERIMENT=virgl-webgl2 \
	OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT=1500-clock \
	./scripts/package-guest.sh "$(GUEST_DIR)" "$(VIRGL_WEBGL2_TCG_CLOCK_OUTPUT)"

package-virgl-webgl2-tcg-fill-120k:
	@test -n "$(GUEST_DIR)" || (echo "usage: make package-virgl-webgl2-tcg-fill-120k GUEST_DIR=/absolute/path/to/assets" >&2; exit 2)
	OMARCHY_GRAPHICS_EXPERIMENT=virgl-webgl2 \
	OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT=6000-fill \
	./scripts/package-guest.sh "$(GUEST_DIR)" "$(VIRGL_WEBGL2_TCG_FILL_120K_OUTPUT)"

package-virgl-webgl2-tcg-batch32:
	@test -n "$(GUEST_DIR)" || (echo "usage: make package-virgl-webgl2-tcg-batch32 GUEST_DIR=/absolute/path/to/assets" >&2; exit 2)
	OMARCHY_GRAPHICS_EXPERIMENT=virgl-webgl2 \
	OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT=6000-batch32 \
	./scripts/package-guest.sh "$(GUEST_DIR)" "$(VIRGL_WEBGL2_TCG_BATCH32_OUTPUT)"

package-virgl-webgl2-tcg-threshold-750-4vcpu:
	@test -n "$(GUEST_DIR)" || (echo "usage: make package-virgl-webgl2-tcg-threshold-750-4vcpu GUEST_DIR=/absolute/path/to/assets" >&2; exit 2)
	OMARCHY_GRAPHICS_EXPERIMENT=virgl-webgl2 \
	OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT=750 \
	OMARCHY_VCPU_EXPERIMENT=4 \
	./scripts/package-guest.sh "$(GUEST_DIR)" "$(VIRGL_WEBGL2_TCG_750_4VCPU_OUTPUT)"

smoke:
	./scripts/package-smoke.sh

serve:
	node ./scripts/serve.mjs --root . --port 8088

serve-webrtc-poc:
	node ./scripts/serve-webrtc-poc.mjs --port 8110

serve-full:
	node ./scripts/serve-full-guest.mjs --runtime-root ./dist --guest-root ../guest/dist --port 8094

serve-full-tcg-threshold-250:
	node ./scripts/serve-full-guest.mjs --runtime-root "$(TCG_THRESHOLD_250_OUTPUT)" --guest-root ../guest/dist --port 8094

serve-full-tcg-baseline-metrics:
	node ./scripts/serve-full-guest.mjs --runtime-root "$(TCG_BASELINE_METRICS_OUTPUT)" --guest-root ../guest/dist --port 8094

serve-full-webgl2-present:
	node ./scripts/serve-full-guest.mjs --runtime-root "$(WEBGL2_PRESENT_OUTPUT)" --guest-root ../guest/dist --port 8098

serve-full-virgl-webgl2:
	node ./scripts/serve-full-guest.mjs --runtime-root "$(VIRGL_WEBGL2_OUTPUT)" --guest-root ../guest/dist --port 8095

serve-full-virgl-webgl2-tcg-baseline-metrics:
	node ./scripts/serve-full-guest.mjs --runtime-root "$(VIRGL_WEBGL2_TCG_BASELINE_OUTPUT)" --guest-root ../guest/dist --port 8096

serve-full-virgl-webgl2-tcg-bounded-clock:
	node ./scripts/serve-full-guest.mjs --runtime-root "$(VIRGL_WEBGL2_TCG_CLOCK_OUTPUT)" --guest-root ../guest/dist --port 8099

serve-full-virgl-webgl2-tcg-fill-120k:
	node ./scripts/serve-full-guest.mjs --runtime-root "$(VIRGL_WEBGL2_TCG_FILL_120K_OUTPUT)" --guest-root ../guest/dist --port 8101

serve-full-virgl-webgl2-tcg-batch32:
	node ./scripts/serve-full-guest.mjs --runtime-root "$(VIRGL_WEBGL2_TCG_BATCH32_OUTPUT)" --guest-root ../guest/dist --port 8102

serve-full-virgl-webgl2-tcg-threshold-750-4vcpu:
	node ./scripts/serve-full-guest.mjs --runtime-root "$(VIRGL_WEBGL2_TCG_750_4VCPU_OUTPUT)" --guest-root ../guest/dist --port 8097

test:
	node --test ./tests/*.test.mjs

verify-dist:
	node ./scripts/verify-runtime-artifacts.mjs ./dist
