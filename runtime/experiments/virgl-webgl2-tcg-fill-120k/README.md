# VirGL/WebGL2 threshold-6000 fill-only TCG diagnostic

This isolated, non-promotable A/B profile tests the measured browser bottleneck:
the current bounded-CLOCK candidate fills its 60,000 active nested-Wasm slots,
fails to reclaim the 4,096 retired wrappers, and forces hundreds of millions of
hot executions back through TCI.

The diagnostic deliberately changes only TCG admission and lifetime:

- compile a translation block after 6,000 executions instead of 1,500;
- retain at most 120,000 compiled blocks across the two vCPUs;
- never evict a compiled block or ask nondeterministic browser GC for capacity;
- fall directly back to TCI at the hard cap;
- retain the existing compile, execution, hotness, frame, input, and VirGL
  telemetry, adding the 3,000 and 6,000 hotness crossings.

It reuses the existing VirGL performance build cache so the test does not leave
another multi-gigabyte Docker build volume. Its 14 MB runtime output remains
separate from the 60k baseline.

```sh
make -C runtime build-virgl-webgl2-tcg-fill-120k
make -C runtime package-virgl-webgl2-tcg-fill-120k GUEST_DIR=../guest/dist
make -C runtime serve-full-virgl-webgl2-tcg-fill-120k
```

For the bounded four-vCPU resource-allocation diagnostic, repackage the same
Wasm bytes with `OMARCHY_VCPU_EXPERIMENT=4`. This changes only the guest SMP
topology and Worker identity, so it can be compared without another QEMU build.

The server listens on `127.0.0.1:8101`. This profile is useful only as a
diagnostic bridge: the durable design must batch many TBs into one Wasm module
or ship a profile-guided/AOT hot module so module lifetime is not the cache
policy.
