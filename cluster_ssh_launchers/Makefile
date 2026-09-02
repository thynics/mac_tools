CC ?= clang
CFLAGS ?= -Os -Wall -Wextra -Werror
PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin
BUILD_DIR := build
PROGRAM := $(BUILD_DIR)/cluster-ssh
LAUNCHERS := $(BUILD_DIR)/dlcluster $(BUILD_DIR)/computelab

.PHONY: all clean install test

all: $(LAUNCHERS)

$(PROGRAM): cluster_ssh.c
	@mkdir -p $(BUILD_DIR)
	$(CC) $(CFLAGS) $< -o $@
	strip -x $@

$(LAUNCHERS): $(PROGRAM)
	cp $(PROGRAM) $@

install: $(LAUNCHERS)
	install -d $(BINDIR)
	install -m 0755 $(BUILD_DIR)/dlcluster $(BINDIR)/dlcluster
	install -m 0755 $(BUILD_DIR)/computelab $(BINDIR)/computelab

test: $(LAUNCHERS)
	test -x $(BUILD_DIR)/dlcluster
	test -x $(BUILD_DIR)/computelab

clean:
	rm -f $(PROGRAM) $(LAUNCHERS)
