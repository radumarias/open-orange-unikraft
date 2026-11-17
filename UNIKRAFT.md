# Running OpenOrange on Unikraft

This fork runs an OpenOrange Worker as a [Unikraft](https://unikraft.org) unikernel: one VM with
one process (Node.js on Unikraft's ELF loader), next to a Rivet Engine that runs on the host.

## Quickstart (macOS or Linux)

You need Docker, KraftKit and QEMU:

```sh
brew install unikraft/cli/kraftkit qemu   # macOS
pnpm install
pnpm build
pnpm unikraft:local                        # boots examples/hello-durable-object
```

When the unikernel logs `orange serve listening`, call the Worker:

```sh
$ curl http://127.0.0.1:8080/Radu
{"greeting":"Hello, Radu!","visits":1}
```

To run your own Worker, pass `--project path/to/worker`. `pnpm unikraft:local --help` lists the
other options (port, memory, Engine port, reusing the last rootfs).

## What the script does

1. `orange deploy --unikraft --outdir <project>/.open-orange/unikraft` writes three files:
   - `Dockerfile`: the normal `orange deploy` image. It also bundles the Worker at build time and
     sets the single-process environment.
   - `Dockerfile.rootfs`: packs that image's file system into `rootfs.cpio`, the unikernel's initrd.
   - `Kraftfile`: `unikraft.org/base` (the ELF loader) runs
     `node /orange/dist/bin.js serve` from that initrd.
2. Docker builds both (`linux/amd64`).
3. The Rivet Engine from `@rivetkit/engine-cli` starts on `127.0.0.1:6420`, with its data in
   `<project>/.open-orange/unikraft-engine/`.
4. `kraft run` boots the unikernel on QEMU with `-p 8080:8080`. The guest reaches the Engine at
   `10.0.2.2`, QEMU's address for the host.

## What changed from upstream

A unikernel runs one process and cannot `fork()` or `exec()`. Upstream `orange serve` starts
three kinds of extra processes, and this fork removes each one when you ask it to:

| Upstream | This fork | Switch |
| --- | --- | --- |
| `orange serve` forks the runtime and talks to it over IPC | The runtime runs in the CLI's process over an in-memory channel with the same JSON messages | `OPEN_ORANGE_IN_PROCESS=1` |
| `orange serve` bundles the Worker with esbuild, a Go binary, at startup | `orange serve --prebuild <dir>` bundles at image build time, and `serve` loads that bundle | `OPEN_ORANGE_PREBUILT_BUNDLE=<dir>` |
| The runtime registers a dev session against an external Engine, and its exit handler runs `ps` | Only a local Engine gets a dev session | always on |

It also adds:

- `OPEN_ORANGE_CWD`: `orange` changes to this directory first, since a unikernel starts in `/`.
- `OPEN_ORANGE_LIBC=gnu|musl`: names the C library when `process.report.getReport()` fails,
  so the RivetKit native addon still loads.
- `Dockerfile.rootfs` empties the workerd and rivet-engine binaries in the initrd. Neither runs
  in `orange serve`, and dropping them saves about 200 MB of guest memory.

Without these variables, OpenOrange behaves exactly as upstream does.

## Known limits

- `unikraft.org/base` is x86_64 only. On Apple silicon, QEMU emulates the guest without
  acceleration, so the first boot takes a few minutes.
- The whole image (about 600 MB) lives in guest memory, so give it 3 GiB (`--memory`).
- One Worker per unikernel. Multi-Worker `orange serve` (several `--config`) still forks.
- Bindings that start processes don't work: the Sandbox/Containers binding, and the local
  Engine of `orange dev`.
- Unikraft implements a subset of Linux syscalls. If Node.js or the RivetKit addon hits a
  missing one, `kraft run` prints a warning for it. That warning is where to look first.

## Checking the single-process path without Unikraft

This replays what the unikernel runs, with a clean environment, from `/`, and counts processes:

```sh
env -i OPEN_ORANGE_IN_PROCESS=1 OPEN_ORANGE_LIBC=gnu OPEN_ORANGE_PREBUILT_BUNDLE=/orange-bundle \
  OPEN_ORANGE_CWD=/app PORT=8080 RIVET_ENDPOINT=http://default:dev@127.0.0.1:6420 \
  strace -f -e trace=execve,fork,vfork,clone,clone3 node /orange/dist/bin.js serve --config wrangler.jsonc
```

Expect exactly one `execve` (node itself), and every `clone` with `CLONE_THREAD`.
