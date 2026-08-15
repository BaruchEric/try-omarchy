#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int contains_casefold(const char *text, const char *needle)
{
    size_t needle_length = strlen(needle);
    if (!needle_length) {
        return 1;
    }
    for (const char *start = text; *start; start++) {
        size_t index = 0;
        while (index < needle_length && start[index] &&
               tolower((unsigned char)start[index]) ==
                   tolower((unsigned char)needle[index])) {
            index++;
        }
        if (index == needle_length) {
            return 1;
        }
    }
    return 0;
}

static void json_string(const char *value)
{
    putchar('"');
    for (const unsigned char *cursor = (const unsigned char *)value; *cursor; cursor++) {
        switch (*cursor) {
        case '"': fputs("\\\"", stdout); break;
        case '\\': fputs("\\\\", stdout); break;
        case '\b': fputs("\\b", stdout); break;
        case '\f': fputs("\\f", stdout); break;
        case '\n': fputs("\\n", stdout); break;
        case '\r': fputs("\\r", stdout); break;
        case '\t': fputs("\\t", stdout); break;
        default:
            if (*cursor < 0x20) {
                printf("\\u%04x", *cursor);
            } else {
                putchar(*cursor);
            }
        }
    }
    putchar('"');
}

int main(void)
{
    PFNEGLQUERYDEVICESEXTPROC query_devices =
        (PFNEGLQUERYDEVICESEXTPROC)eglGetProcAddress("eglQueryDevicesEXT");
    PFNEGLQUERYDEVICESTRINGEXTPROC query_device_string =
        (PFNEGLQUERYDEVICESTRINGEXTPROC)eglGetProcAddress("eglQueryDeviceStringEXT");
    PFNEGLGETPLATFORMDISPLAYEXTPROC get_platform_display =
        (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
    EGLDeviceEXT devices[16];
    EGLint device_count = 0;
    EGLDisplay display = EGL_NO_DISPLAY;

    if (!query_devices || !query_device_string || !get_platform_display ||
        !query_devices(16, devices, &device_count)) {
        fputs("EGL device enumeration is unavailable\n", stderr);
        return 2;
    }
    for (EGLint index = 0; index < device_count; index++) {
        const char *node = query_device_string(devices[index], EGL_DRM_RENDER_NODE_FILE_EXT);
        if (node && strcmp(node, "/dev/dri/renderD128") == 0) {
            display = get_platform_display(EGL_PLATFORM_DEVICE_EXT, devices[index], NULL);
            break;
        }
    }
    if (display == EGL_NO_DISPLAY) {
        fputs("no EGL device owns /dev/dri/renderD128\n", stderr);
        return 3;
    }

    EGLint major = 0;
    EGLint minor = 0;
    if (!eglInitialize(display, &major, &minor) || !eglBindAPI(EGL_OPENGL_ES_API)) {
        fputs("EGL initialization failed\n", stderr);
        return 4;
    }
    const EGLint config_attributes[] = {
        EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE, 8,
        EGL_GREEN_SIZE, 8,
        EGL_BLUE_SIZE, 8,
        EGL_NONE,
    };
    EGLConfig config;
    EGLint config_count = 0;
    if (!eglChooseConfig(display, config_attributes, &config, 1, &config_count) ||
        config_count != 1) {
        fputs("EGL config selection failed\n", stderr);
        return 5;
    }
    const EGLint context_attributes[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
    const EGLint surface_attributes[] = { EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE };
    EGLContext context = eglCreateContext(display, config, EGL_NO_CONTEXT, context_attributes);
    EGLSurface surface = eglCreatePbufferSurface(display, config, surface_attributes);
    if (context == EGL_NO_CONTEXT || surface == EGL_NO_SURFACE ||
        !eglMakeCurrent(display, surface, surface, context)) {
        fputs("fresh EGL context creation failed\n", stderr);
        return 6;
    }

    const char *renderer = (const char *)glGetString(GL_RENDERER);
    const char *vendor = (const char *)glGetString(GL_VENDOR);
    const char *version = (const char *)glGetString(GL_VERSION);
    if (!renderer || !vendor || !version) {
        fputs("GL renderer identity is unavailable\n", stderr);
        return 7;
    }
    /* A software native host can legitimately yield "virgl (llvmpipe ...)".
     * What matters here is that the guest selected virgl rather than directly
     * selecting llvmpipe.  The browser proof separately gates the WebGL host. */
    if (!contains_casefold(renderer, "virgl")) {
        fprintf(stderr, "guest renderer did not select VirGL: %s\n", renderer);
        return 8;
    }

    fputs("{\"schemaVersion\":1,\"renderNode\":\"/dev/dri/renderD128\",\"renderer\":", stdout);
    json_string(renderer);
    fputs(",\"vendor\":", stdout);
    json_string(vendor);
    fputs(",\"version\":", stdout);
    json_string(version);
    fputs("}\n", stdout);

    eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    eglDestroySurface(display, surface);
    eglDestroyContext(display, context);
    eglTerminate(display);
    return 0;
}
