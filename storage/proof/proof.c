#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define BULK_BYTES (1024 * 1024)

static int expect_at(int fd, off_t offset, const char *expected) {
  char buffer[32] = {0};
  size_t length = strlen(expected);
  ssize_t count = pread(fd, buffer, length, offset);
  if (count != (ssize_t)length || memcmp(buffer, expected, length) != 0) {
    fprintf(stderr, "read mismatch at %lld: count=%zd errno=%d\n",
            (long long)offset, count, errno);
    return -1;
  }
  return 0;
}

static int expect_zero_bulk_read(int fd) {
  unsigned char *buffer = malloc(BULK_BYTES);
  if (buffer == NULL) {
    perror("malloc bulk read");
    return -1;
  }

  ssize_t count = pread(fd, buffer, BULK_BYTES, (off_t)1024 * 1024);
  if (count != BULK_BYTES) {
    fprintf(stderr, "bulk read mismatch: count=%zd errno=%d\n", count, errno);
    free(buffer);
    return -1;
  }
  for (size_t index = 0; index < BULK_BYTES; index += 1) {
    if (buffer[index] != 0) {
      fprintf(stderr, "bulk read byte mismatch at %zu: value=%u\n", index, buffer[index]);
      free(buffer);
      return -1;
    }
  }

  free(buffer);
  return 0;
}

int main(void) {
  int fd = open("/pack/rootfs.ext4", O_RDONLY);
  if (fd < 0) {
    perror("open /pack/rootfs.ext4");
    return 2;
  }
  if (expect_at(fd, 17, "OMARCHY_RANGE_ZERO") != 0) return 3;
  if (expect_zero_bulk_read(fd) != 0) return 4;
  if (expect_at(fd, (off_t)2 * 1024 * 1024 + 31, "OMARCHY_RANGE_TWO") != 0) return 5;
  close(fd);
  puts("PAGED_DISK_EMSCRIPTEN_PASS");
  return 0;
}
