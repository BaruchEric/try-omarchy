#ifndef OMARCHY_WEBGL_EPOXY_GL_H
#define OMARCHY_WEBGL_EPOXY_GL_H

/*
 * VirGL and QEMU use libepoxy for dispatch on native hosts.  Emscripten
 * already provides direct GLES/WebGL dispatch, so the browser build only
 * needs epoxy's small capability-query surface and the GLES declarations.
 */
/*
 * Emscripten's desktop declaration set is a compile-time superset.  Runtime
 * capability reporting below still identifies the context as GLES/WebGL2,
 * so VirGL never advertises desktop-only features to the guest.
 */
#ifndef GL_GLEXT_PROTOTYPES
#define GL_GLEXT_PROTOTYPES 1
#endif
#include <GL/gl.h>
#include <GL/glext.h>
#include <GLES3/gl32.h>
#include <GLES2/gl2ext.h>

/* VirGL's GLES path still uses these historical extension spellings for
 * operations that are core in WebGL 2 / GLES 3.0. */
#define glBindBufferARB glBindBuffer
#define glGenBuffersARB glGenBuffers
#define glDepthRangefOES glDepthRangef

#ifdef __cplusplus
extern "C" {
#endif

int epoxy_gl_version(void);
int epoxy_is_desktop_gl(void);
int epoxy_has_gl_extension(const char *extension);

#ifdef __cplusplus
}
#endif

/* QEMU/VirGL use the EXT spellings for APIs that are core in GLES 3.0. */
#ifndef glBindFramebufferEXT
#define glBindFramebufferEXT glBindFramebuffer
#endif
#ifndef glBlitFramebufferEXT
#define glBlitFramebufferEXT glBlitFramebuffer
#endif
#ifndef glDeleteFramebuffersEXT
#define glDeleteFramebuffersEXT glDeleteFramebuffers
#endif
#ifndef glFramebufferTexture2DEXT
#define glFramebufferTexture2DEXT glFramebufferTexture2D
#endif
#ifndef glGenFramebuffersEXT
#define glGenFramebuffersEXT glGenFramebuffers
#endif
#ifndef glRenderbufferStorageMultisampleEXT
#define glRenderbufferStorageMultisampleEXT glRenderbufferStorageMultisample
#endif
#ifndef glReadnPixelsKHR
#define glReadnPixelsKHR glReadnPixels
#endif
#ifndef glDebugMessageInsertKHR
#define glDebugMessageInsertKHR glDebugMessageInsert
#endif

#ifndef GL_BGRA
#define GL_BGRA GL_BGRA_EXT
#endif
#ifndef GL_COLOR_ATTACHMENT0_EXT
#define GL_COLOR_ATTACHMENT0_EXT GL_COLOR_ATTACHMENT0
#endif
#ifndef GL_DRAW_FRAMEBUFFER_EXT
#define GL_DRAW_FRAMEBUFFER_EXT GL_DRAW_FRAMEBUFFER
#endif
#ifndef GL_DEBUG_SEVERITY_NOTIFICATION_KHR
#define GL_DEBUG_SEVERITY_NOTIFICATION_KHR GL_DEBUG_SEVERITY_NOTIFICATION
#endif
#ifndef GL_DEBUG_SOURCE_APPLICATION_KHR
#define GL_DEBUG_SOURCE_APPLICATION_KHR GL_DEBUG_SOURCE_APPLICATION
#endif
#ifndef GL_DEBUG_TYPE_MARKER_KHR
#define GL_DEBUG_TYPE_MARKER_KHR GL_DEBUG_TYPE_MARKER
#endif
#ifndef GL_FRAMEBUFFER_EXT
#define GL_FRAMEBUFFER_EXT GL_FRAMEBUFFER
#endif
#ifndef GL_READ_FRAMEBUFFER_EXT
#define GL_READ_FRAMEBUFFER_EXT GL_READ_FRAMEBUFFER
#endif
#ifndef GL_TEXTURE_SWIZZLE_A_EXT
#define GL_TEXTURE_SWIZZLE_A_EXT GL_TEXTURE_SWIZZLE_A
#endif
#ifndef GL_UNPACK_ROW_LENGTH_EXT
#define GL_UNPACK_ROW_LENGTH_EXT GL_UNPACK_ROW_LENGTH
#endif

#endif
