// Runs a Worker as a Unikraft unikernel on this machine, with a Rivet Engine beside it.
//
//   pnpm unikraft:local [--project examples/hello-durable-object] [--port 8080] [--memory 3Gi]
//                       [--engine-port 6420] [--skip-image] [--keep-engine]
//
// 1. `orange deploy --unikraft` writes the image, its rootfs Dockerfile and a Kraftfile.
// 2. Docker builds the image and packs its file system into rootfs.cpio.
// 3. The Rivet Engine starts on this machine, unless one already answers on --engine-port.
// 4. `kraft run` boots the unikernel on QEMU. It reaches the Engine through QEMU's host address,
//    10.0.2.2, and serves the Worker on --port.
//
// Needs Docker, KraftKit and QEMU: `brew install unikraft/cli/kraftkit qemu` on macOS.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { arch } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { discoverInstalledRivetKitBuild } from "../../packages/runtime-node/src/internal/rivetkit-build.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// QEMU's user-mode network answers this address with the host's loopback.
const qemuHostAddress = "10.0.2.2";
// The Engine's admin token, which `RIVET_ENDPOINT` carries as its password.
const engineToken = "dev";
const namespace = "default";

const { values } = parseArgs({
	options: {
		project: { type: "string", default: join(repositoryRoot, "examples", "hello-durable-object") },
		config: { type: "string" },
		port: { type: "string", default: "8080" },
		memory: { type: "string", default: "3Gi" },
		"engine-port": { type: "string", default: "6420" },
		"skip-image": { type: "boolean", default: false },
		"keep-engine": { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
	strict: true,
});

if (values.help) {
	process.stdout.write(
		[
			"pnpm unikraft:local [options]",
			"",
			"  --project <dir>      Worker project with a wrangler.jsonc. Default examples/hello-durable-object",
			"  --config <path>      Wrangler configuration inside the project",
			"  --port <port>        Host port the Worker answers on. Default 8080",
			"  --memory <size>      Unikernel memory, such as 3Gi. The rootfs lives in it. Default 3Gi",
			"  --engine-port <port> Rivet Engine port on this machine. Default 6420",
			"  --skip-image         Reuse the rootfs.cpio from the last run",
			"  --keep-engine        Leave the Engine running when the unikernel stops",
			"",
		].join("\n"),
	);
	process.exit(0);
}

const project = resolve(values.project);
const port = Number(values.port);
const enginePort = Number(values["engine-port"]);
const outDirectory = join(project, ".open-orange", "unikraft");
const engineDirectory = join(project, ".open-orange", "unikraft-engine");
const image = `open-orange-unikraft-${project.split("/").at(-1)?.toLowerCase().replaceAll(/[^a-z0-9._-]/g, "-") ?? "worker"}:local`;

function step(message: string): void {
	process.stdout.write(`\n\u001b[1m▸ ${message}\u001b[0m\n`);
}

function run(command: string, args: readonly string[], options: { cwd?: string } = {}): void {
	process.stdout.write(`  $ ${[command, ...args].join(" ")}\n`);
	const result = spawnSync(command, args, { cwd: options.cwd ?? repositoryRoot, stdio: "inherit" });
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} exited with ${result.status ?? result.signal}`);
	}
}

function hasCommand(command: string): boolean {
	return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function preflight(): void {
	const missing: string[] = [];
	if (!hasCommand("docker")) missing.push("docker (Docker Desktop, OrbStack or colima)");
	if (!hasCommand("kraft")) missing.push("kraft (brew install unikraft/cli/kraftkit)");
	if (!hasCommand("qemu-system-x86_64")) missing.push("qemu-system-x86_64 (brew install qemu)");
	if (missing.length > 0) {
		throw new Error(`Install these first:\n${missing.map((entry) => `  - ${entry}`).join("\n")}`);
	}
	if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
		throw new Error("Docker does not answer. Start Docker Desktop, OrbStack or colima.");
	}
	if (!existsSync(join(project, "wrangler.jsonc")) && !existsSync(join(project, "wrangler.json")) && !existsSync(join(project, "wrangler.toml")) && values.config === undefined) {
		throw new Error(`${project} has no Wrangler configuration`);
	}
}

async function engineIsHealthy(): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${enginePort}/health`, { signal: AbortSignal.timeout(1_000) });
		return response.ok;
	} catch {
		return false;
	}
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
	}
	throw new Error(`Timed out waiting for ${what}`);
}

// Starts the Engine as `orange dev` does, with its data under the project's .open-orange.
// https://github.com/rivet-dev/open-orange/blob/00bdf6a0a5172df6a636d12de7540b4c7070ddb1/packages/runtime-node/src/internal/ports.ts#L520-L545
async function startEngine(): Promise<ChildProcess | undefined> {
	if (await engineIsHealthy()) {
		process.stdout.write(`  An Engine already answers on 127.0.0.1:${enginePort}. Using it.\n`);
		return undefined;
	}
	const binary = discoverInstalledRivetKitBuild().engineBinaryPath;
	const data = join(engineDirectory, "depot");
	for (const directory of [join(data, "log"), join(data, "objects")]) mkdirSync(directory, { recursive: true });
	const configPath = join(engineDirectory, "config.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			topology: {
				datacenter_label: 1,
				datacenters: {
					default: {
						datacenter_label: 1,
						is_leader: true,
						peer_url: `http://127.0.0.1:${enginePort + 1}`,
						public_url: `http://${qemuHostAddress}:${enginePort}`,
					},
				},
			},
		}),
	);
	const log = openSync(join(engineDirectory, "engine.log"), "a");
	process.stdout.write(`  $ ${relative(repositoryRoot, binary)} --config ${configPath}\n`);
	const child = spawn(binary, ["--config", configPath], {
		env: {
			...process.env,
			RIVET__AUTH__ADMIN_TOKEN: engineToken,
			RIVET__GUARD__HOST: "127.0.0.1",
			RIVET__GUARD__PORT: String(enginePort),
			RIVET__API_PEER__HOST: "127.0.0.1",
			RIVET__API_PEER__PORT: String(enginePort + 1),
			RIVET__METRICS__HOST: "127.0.0.1",
			RIVET__METRICS__PORT: String(enginePort + 10),
			RIVET__STORAGE__LOG_DIRECTORY: join(data, "log"),
			RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH: join(data, "objects"),
			RIVET__STORAGE__BALANCING__ENABLED: "false",
			RIVET__STORAGE__AUTO_PROVISION_PARTITIONS: "1",
			RIVET__STORAGE__COLD_STORE__DISK_CACHE_BYTES: "0",
		},
		stdio: ["ignore", log, log],
	});
	closeSync(log);
	const exited = new Promise<never>((_, rejectExit) =>
		child.once("exit", (code, signal) =>
			rejectExit(new Error(`The Engine exited (${code ?? signal}). See ${join(engineDirectory, "engine.log")}`)),
		),
	);
	await Promise.race([waitFor(engineIsHealthy, 60_000, "the Rivet Engine"), exited]);
	process.stdout.write(`  Engine ready on http://127.0.0.1:${enginePort} (log: ${join(engineDirectory, "engine.log")})\n`);
	return child;
}

function buildRootfs(): void {
	const bin = join(repositoryRoot, "dist", "bin.js");
	if (!existsSync(bin)) {
		step("Building OpenOrange");
		run("pnpm", ["build"]);
	}
	step("Writing the Unikraft build");
	run(
		process.execPath,
		[bin, "deploy", "--unikraft", "--outdir", outDirectory, ...(values.config === undefined ? [] : ["--config", values.config])],
		{ cwd: project },
	);
	step("Building the image (linux/amd64; Unikraft's ELF loader runs x86_64)");
	run("docker", ["build", "--platform", "linux/amd64", "-f", join(outDirectory, "Dockerfile"), "-t", image, join(outDirectory, "context")]);
	step("Packing the image into rootfs.cpio");
	run("docker", [
		"build", "--platform", "linux/amd64", "--build-arg", `IMAGE=${image}`,
		"-f", join(outDirectory, "Dockerfile.rootfs"), "--output", `type=local,dest=${join(outDirectory, "rootfs")}`, outDirectory,
	]);
}

async function main(): Promise<void> {
	preflight();
	if (!values["skip-image"] || !existsSync(join(outDirectory, "rootfs", "rootfs.cpio"))) buildRootfs();
	step("Starting the Rivet Engine");
	const engine = await startEngine();
	const stopEngine = (): void => {
		if (engine !== undefined && !values["keep-engine"] && engine.exitCode === null) engine.kill("SIGTERM");
	};
	process.once("exit", stopEngine);

	step("Booting the unikernel");
	const endpoint = `http://${namespace}:${engineToken}@${qemuHostAddress}:${enginePort}`;
	const args = [
		"run", "--rm", "--plat", "qemu", "--arch", "x86_64",
		// An x86_64 guest on an Apple silicon host has no hardware acceleration.
		...(arch() === "x64" ? [] : ["--disable-acceleration"]),
		"-M", values.memory,
		"-p", `${port}:8080`,
		"-e", `RIVET_ENDPOINT=${endpoint}`,
		outDirectory,
	];
	process.stdout.write(`  $ kraft ${args.join(" ")}\n`);
	process.stdout.write(`  The Worker answers on http://127.0.0.1:${port} once it logs "orange serve listening". Ctrl-C stops it.\n\n`);
	const kraft = spawn("kraft", args, { cwd: outDirectory, stdio: "inherit" });
	const forward = (signal: NodeJS.Signals): void => {
		kraft.kill(signal);
	};
	process.on("SIGINT", forward);
	process.on("SIGTERM", forward);
	const code = await new Promise<number>((resolveExit) => kraft.once("exit", (exitCode) => resolveExit(exitCode ?? 1)));
	stopEngine();
	process.exit(code);
}

main().catch((error: unknown) => {
	process.stderr.write(`\n\u001b[31m${error instanceof Error ? error.message : String(error)}\u001b[0m\n`);
	process.exit(1);
});
