import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";

import type { RuntimeParentChannel } from "../../packages/runtime-node/src/runner.js";
import { inProcessRuntimeRequested, startInProcessRuntime } from "./in-process.js";

test("OPEN_ORANGE_IN_PROCESS turns the in-process runtime on", () => {
	assert.equal(inProcessRuntimeRequested({}), false);
	assert.equal(inProcessRuntimeRequested({ OPEN_ORANGE_IN_PROCESS: "0" }), false);
	assert.equal(inProcessRuntimeRequested({ OPEN_ORANGE_IN_PROCESS: "1" }), true);
	assert.equal(inProcessRuntimeRequested({ OPEN_ORANGE_IN_PROCESS: "true" }), true);
});

test("the in-process channel carries messages both ways as IPC would", async () => {
	let runtimeChannel: RuntimeParentChannel | undefined;
	const received: unknown[] = [];
	const child = startInProcessRuntime({
		environment: { OPEN_ORANGE_IN_PROCESS_TEST: "set" },
		importRunner: async () => ({
			async runRuntimeProcess(channel) {
				assert.ok(channel);
				runtimeChannel = channel;
				assert.equal(channel.ownsProcess, false);
				await new Promise<void>((resolveStop) => {
					channel.onMessage((message) => {
						received.push(message);
						if (Reflect.get(message as object, "type") === "shutdown") resolveStop();
						else channel.send({ cronNextRuns: [], host: "127.0.0.1", port: 1, type: "ready" });
					});
				});
				channel.send({ reason: "parent", type: "stopped" });
			},
		}),
	});
	assert.equal(process.env.OPEN_ORANGE_IN_PROCESS_TEST, "set");
	const messages: unknown[] = [];
	child.on("message", (message) => messages.push(message));
	// JSON IPC drops undefined fields and turns a Date into a string.
	const sent = { at: new Date(0), dropped: undefined, type: "start" };
	child.send(sent);
	const [ready] = (await once(child as never, "message")) as [unknown];
	assert.deepEqual(ready, { cronNextRuns: [], host: "127.0.0.1", port: 1, type: "ready" });
	assert.deepEqual(received[0], { at: "1970-01-01T00:00:00.000Z", type: "start" });
	assert.ok(runtimeChannel);
	child.send({ type: "shutdown" });
	const [code, signal] = (await once(child as never, "exit")) as [number | null, NodeJS.Signals | null];
	assert.equal(code, 0);
	assert.equal(signal, null);
	assert.deepEqual(messages.at(-1), { reason: "parent", type: "stopped" });
	assert.equal(child.connected, false);
	delete process.env.OPEN_ORANGE_IN_PROCESS_TEST;
});

test("a fatal message makes the in-process runtime exit with code 1", async () => {
	const child = startInProcessRuntime({
		environment: {},
		importRunner: async () => ({
			async runRuntimeProcess(channel) {
				channel?.send({ message: "boom", type: "fatal" });
			},
		}),
	});
	const [code] = (await once(child as never, "exit")) as [number | null];
	assert.equal(code, 1);
});

test("SIGKILL ends the wait for an in-process runtime that does not stop", async () => {
	const child = startInProcessRuntime({
		environment: {},
		importRunner: async () => ({
			runRuntimeProcess: () => new Promise<void>(() => {}),
		}),
	});
	assert.equal(child.kill("SIGKILL"), true);
	const [code, signal] = (await once(child as never, "exit")) as [number | null, NodeJS.Signals | null];
	assert.equal(code, null);
	assert.equal(signal, "SIGKILL");
});

test("messages sent before the runner listens wait for it", async () => {
	let finishImport: (() => void) | undefined;
	const imported = new Promise<void>((resolveImport) => (finishImport = resolveImport));
	const received: unknown[] = [];
	const child = startInProcessRuntime({
		environment: {},
		importRunner: async () => {
			await imported;
			return {
				async runRuntimeProcess(channel) {
					await new Promise<void>((resolveStop) =>
						channel?.onMessage((message) => {
							received.push(message);
							if (Reflect.get(message as object, "type") === "shutdown") resolveStop();
						}),
					);
				},
			};
		},
	});
	child.send({ type: "start" });
	child.send({ type: "shutdown" });
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	finishImport?.();
	await once(child as never, "exit");
	assert.deepEqual(received, [{ type: "start" }, { type: "shutdown" }]);
});
