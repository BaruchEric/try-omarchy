#include <ctype.h>
#include <stddef.h>
#include <string.h>

#include <epoxy/gl.h>
#include <epoxy/egl.h>

static int extension_list_contains(const char *list, const char *extension)
{
    size_t length;
    const char *cursor;

    if (!list || !extension || !*extension || strchr(extension, ' ')) {
        return 0;
    }
    length = strlen(extension);
    cursor = list;
    while ((cursor = strstr(cursor, extension))) {
        const char before = cursor == list ? ' ' : cursor[-1];
        const char after = cursor[length];
        if (isspace((unsigned char)before) &&
            (after == '\0' || isspace((unsigned char)after))) {
            return 1;
        }
        cursor += length;
    }
    return 0;
}

int epoxy_gl_version(void)
{
    GLint major = 0;
    GLint minor = 0;

    glGetIntegerv(GL_MAJOR_VERSION, &major);
    glGetIntegerv(GL_MINOR_VERSION, &minor);
    if (major <= 0) {
        return 0;
    }
    return major * 10 + minor;
}

int epoxy_is_desktop_gl(void)
{
    return 0;
}

int epoxy_has_gl_extension(const char *extension)
{
    /* WebGL extension objects are not interchangeable with desktop/GLES
     * extension entry points. Start from the strict WebGL 2 core contract;
     * individual extensions can be bridged later with dedicated semantics. */
    (void)extension;
    return 0;
}

int epoxy_has_egl_extension(EGLDisplay display, const char *extension)
{
    return extension_list_contains(eglQueryString(display, EGL_EXTENSIONS),
                                   extension);
}
