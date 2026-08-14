#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static int check_bytes(int fd, off_t offset, const char *expected, size_t length) {
  char buffer[32] = {0};
  ssize_t read_count = pread(fd, buffer, length, offset);
  if (read_count != (ssize_t)length || memcmp(buffer, expected, length) != 0) {
    fprintf(stderr, "read mismatch at %lld: read=%zd errno=%d\n",
            (long long)offset, read_count, errno);
    return -1;
  }
  return 0;
}

int main(void) {
  const off_t marker_offset = (off_t)1024 * 1024 + 17;
  const off_t write_offset = (off_t)3 * 1024 * 1024 + 29;
  const char original[] = "ORIGINAL";
  const char changed[] = "CHANGED!";
  const char zeroes[8] = {0};

  int fd = open("/pack/disk.bin", O_RDWR);
  if (fd < 0) {
    perror("open");
    return 2;
  }

  if (check_bytes(fd, marker_offset, original, sizeof(original) - 1) != 0) return 3;
  if (check_bytes(fd, write_offset, zeroes, sizeof(zeroes)) != 0) return 4;
  if (pwrite(fd, changed, sizeof(changed) - 1, write_offset) != (ssize_t)(sizeof(changed) - 1)) {
    perror("pwrite");
    return 5;
  }
  if (check_bytes(fd, write_offset, changed, sizeof(changed) - 1) != 0) return 6;
  if (check_bytes(fd, marker_offset, original, sizeof(original) - 1) != 0) return 7;

  close(fd);
  puts("LAZY_COW_PASS");
  return 0;
}

