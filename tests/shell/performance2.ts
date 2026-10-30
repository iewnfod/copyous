import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

import type CopyousExtension from '../../src/extension.js';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */

export const METRICS = {
	copyousLatencyLoaded: {
		description: 'Time to open copyous with fully loaded history',
		units: 'ms',
		value: 0,
	},
	copyousFirstFrame: {
		description: 'Time from open() to the first painted frame (interactivity)',
		units: 'ms',
		value: 0,
	},
};

const UUID = 'copyous@boerdereinar.dev';

async function waitForExtensionState(): Promise<CopyousExtension> {
	for (let i = 0; i < 50; i++) {
		const extension = Main.extensionManager.lookup(UUID);
		if (extension) {
			if (extension.state === ExtensionState.ERROR)
				throw new Error(`Extension ${UUID} failed: ${extension.error}`);

			// ExtensionState.ENABLED
			if (extension.state === (1 as ExtensionState)) {
				return extension.stateObj as CopyousExtension;
			}
		}

		// eslint-disable-next-line no-await-in-loop
		await Scripting.sleep(1000);
	}

	throw new Error(`Timed out waiting for ${UUID}`);
}

async function waitForHistoryLoaded(extension: CopyousExtension, minCount: number): Promise<number> {
	let lastCount = -1;
	let stableCount = 0;
	for (let i = 0; i < 120; i++) {
		const tracker = (extension as any).entryTracker;
		const count = tracker?._entries?.size ?? 0;
		if (count !== lastCount) {
			print(`[PERF2] history loaded: ${count}`);
			lastCount = count;
			stableCount = 0;
		} else {
			stableCount++;
		}

		if (count >= minCount) return count;

		// Continue once the count has been stable for a few seconds (small
		// test databases never reach minCount)
		if (count > 0 && stableCount >= 6) return count;

		// eslint-disable-next-line no-await-in-loop
		await Scripting.sleep(500);
	}

	return lastCount;
}

export async function run() {
	Scripting.defineScriptEvent('copyousOpenStart', 'Starting to open copyous');
	Scripting.defineScriptEvent('copyousOpenDone', 'Copyous finished opening');
	Scripting.defineScriptEvent('copyousFirstFrame', 'First frame painted after open');

	const extension = await waitForExtensionState();

	// Wait until the full history has been loaded and turned into items,
	// which is the state a real user is in when opening the dialog
	const loaded = await waitForHistoryLoaded(extension, 330);
	print(`[PERF2] final loaded count: ${loaded}`);

	// Warm-up open/close cycle (mirrors the original test measuring the second open)
	extension.clipboardDialog?.open();
	await Scripting.waitLeisure();
	extension.clipboardDialog?.close();
	await Scripting.waitLeisure();
	await Scripting.sleep(1000);
	await Scripting.waitLeisure();

	// Measure the time from open() to the first painted frame
	const stage = global.stage;
	const afterPaintId = stage.connect('after-paint', () => {
		stage.disconnect(afterPaintId);
		Scripting.scriptEvent('copyousFirstFrame');
		return undefined;
	});

	Scripting.scriptEvent('copyousOpenStart');
	extension.clipboardDialog?.open();
	await Scripting.waitLeisure();
	Scripting.scriptEvent('copyousOpenDone');

	print(`[PERF2] done`);
}

let copyousOpenStart = 0;

export function script_copyousOpenStart(time: number) {
	copyousOpenStart = time;
}

export function script_copyousOpenDone(time: number) {
	METRICS.copyousLatencyLoaded.value = (time - copyousOpenStart) / 1000;
}

export function script_copyousFirstFrame(time: number) {
	METRICS.copyousFirstFrame.value = (time - copyousOpenStart) / 1000;
}
