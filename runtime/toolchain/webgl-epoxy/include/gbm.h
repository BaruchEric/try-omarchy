#ifndef OMARCHY_WEBGL_GBM_STUB_H
#define OMARCHY_WEBGL_GBM_STUB_H

/*
 * The pure WebGL build never enables VirGL's EGL/GBM allocation backend;
 * QEMU supplies every GL context.  VirGL's public renderer structures still
 * mention opaque GBM types, so provide only the declarations needed to
 * compile that callback-backed path.
 */
#include <stdint.h>

struct gbm_device;
struct gbm_bo;

union gbm_bo_handle {
    void *ptr;
    int32_t s32;
    uint32_t u32;
    int64_t s64;
    uint64_t u64;
};

#define GBM_MAX_PLANES 4
#define GBM_BO_USE_SCANOUT (1u << 0)
#define GBM_BO_USE_LINEAR (1u << 4)
#define GBM_FORMAT_R8 0x20203852u

#endif
