#ifndef OMARCHY_WEBGL_EPOXY_EGL_H
#define OMARCHY_WEBGL_EPOXY_EGL_H

#include <EGL/egl.h>
#include <EGL/eglext.h>

#ifdef __cplusplus
extern "C" {
#endif

int epoxy_has_egl_extension(EGLDisplay display, const char *extension);

#ifdef __cplusplus
}
#endif

#endif
