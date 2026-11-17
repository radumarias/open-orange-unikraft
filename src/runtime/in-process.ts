import { EventEmitter } from "node:events";

import type { RuntimeParentChannel } from "../../packages/runtime-node/src/runner.js";
import type { RuntimeChildMessage } from "../../packages/runtime-node/src/process-protocol.js";

/** OPEN_ORANGE_IN_PROCESS=1 runs the runtime in the CLI's process instead of forking it. */
export const inProcessRuntimeVariable = "OPEN_ORANGE_IN_PROCESS";

export function inProcessRuntimeRequested(environment: NodeJS.ProcessEnv = process.env): boolean {
	const value = environment[inProcessRuntimeVariable];
	return value === "1" || value === "true";
}

/**
 * The part of a forked `ChildProcess` that `spawnRuntime` uses. A forked runtime and an
 * in-process one both satisfy it, so the CLI drives either the same way.
 */
export interface RuntimeChild {
	readonly connected: boolean;
	readonly stdout?: NodeJS.ReadableStream | null;
	readonly stderr?: NodeJS.ReadableStream | null;
	send(message: unknown): boolean;
	kill(signal?: NodeJS.Signals): boolean;
	disconnect(): void;
	on(event: "message", listener: (message: unknown) => void): this;
	once(event: "error", listener: (error: Error) => void): this;
	once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

// Node's IPC channel serializes each message as JSON and delivers it on a later turn. The
// in-process channel does the same, so both peers see exactly what a forked runtime would.
function cloneAsIpc(message: unknown): unknown {
	return JSON.parse(JSON.stringify(message));
}

/**
 * Starts the runtime in this process. `importRunner` loads the runner module, which a host that
 * cannot `fork()` (a Unikraft unikernel runs one process) must share with the CLI.
 *
 * The environment a forked runtime would get is written to `process.env` before the import,
 * because RivetKit reads it while its modules load.
 */
export function startInProcessRuntime(options: {
	environment: Record<string, string | undefined>;
	importRunner(): Promise<{ runRuntimeProcess(channel?: RuntimeParentChannel): Promise<void> }>;
}): RuntimeChild {
	const child = new InProcessRuntimeChild();
	for (const [name, value] of Object.entries(options.environment)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	void (async () => {
		try {
			const runner = await options.importRunner();
			await runner.runRuntimeProcess(child.runtimeChannel());
			child.exited(child.fatal ? 1 : 0, null);
		} catch (error: unknown) {
			child.emit("error", error instanceof Error ? error : new Error(String(error)));
			child.exited(1, null);
		}
	})();
	return child;
}

class InProcessRuntimeChild extends EventEmitter implements RuntimeChild {
	readonly stdout = null;
	readonly stderr = null;
	fatal = false;
	#connected = true;
	#exited = false;
	readonly #toRuntime = new EventEmitter();
	#pending: unknown[] = [];
	readonly #runtimeDisconnect = new EventEmitter();

	get connected(): boolean {
		return this.#connected;
	}

	send(message: unknown): boolean {
		if (!this.#connected) return false;
		const cloned = cloneAsIpc(message);
		// The runner module can still be loading. IPC queues messages for a child that has not
		// listened yet, so this channel does too.
		if (this.#toRuntime.listenerCount("message") === 0) this.#pending.push(cloned);
		else setImmediate(() => this.#toRuntime.emit("message", cloned));
		return true;
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		if (this.#exited) return false;
		if (signal === "SIGKILL") {
			// Nothing can stop code in this process, so a forced stop only ends the wait.
			this.disconnect();
			this.exited(null, "SIGKILL");
			return true;
		}
		// The runtime stops gracefully on a lost parent, as a forked one does on SIGTERM.
		this.disconnect();
		return true;
	}

	disconnect(): void {
		if (!this.#connected) return;
		this.#connected = false;
		setImmediate(() => this.#runtimeDisconnect.emit("disconnect"));
	}

	exited(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.#exited) return;
		this.#exited = true;
		this.#connected = false;
		setImmediate(() => this.emit("exit", code, signal));
	}

	runtimeChannel(): RuntimeParentChannel {
		const child = this;
		return {
			get connected() {
				return child.#connected;
			},
			send(message: RuntimeChildMessage) {
				if (!child.#connected) return;
				if (message.type === "fatal") child.fatal = true;
				const cloned = cloneAsIpc(message);
				setImmediate(() => child.emit("message", cloned));
			},
			onMessage(listener) {
				child.#toRuntime.on("message", listener);
				const pending = child.#pending;
				child.#pending = [];
				for (const message of pending) setImmediate(() => child.#toRuntime.emit("message", message));
			},
			onDisconnect(listener) {
				child.#runtimeDisconnect.once("disconnect", listener);
			},
			disconnect() {
				child.#connected = false;
			},
			ownsProcess: false,
		};
	}
}
