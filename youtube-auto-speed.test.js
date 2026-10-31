// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SCRIPT = readFileSync(
	join(import.meta.dirname, "youtube-auto-speed.user.js"),
	"utf8",
);
const STORAGE_KEY = "yt-auto-speed-default-rate";

function loadScript() {
	new Function(SCRIPT)();
	// Let autoSetSpeed finish its retries and pick the auto rate.
	vi.advanceTimersByTime(5000);
}

function button(label) {
	return [...document.querySelectorAll("button")].find(
		(b) => b.textContent === label,
	);
}

function activeLabel() {
	return document.querySelector("button.active")?.textContent;
}

function defaultLabel() {
	return document.querySelector("button.default")?.textContent;
}

function rightClick(el) {
	const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
	el.dispatchEvent(e);
	return e;
}

beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
	document.head.innerHTML = "";
	document.body.innerHTML = '<div><a id="logo"></a></div>';
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("default rate", () => {
	it("uses x3.0 when nothing is stored", () => {
		loadScript();

		expect(activeLabel()).toBe("x3.0");
		expect(defaultLabel()).toBe("x3.0");
	});

	it("uses the stored rate for regular videos", () => {
		localStorage.setItem(STORAGE_KEY, "3.5");

		loadScript();

		expect(activeLabel()).toBe("x3.5");
		expect(defaultLabel()).toBe("x3.5");
	});

	it("falls back to x3.0 when the stored value is not a button rate", () => {
		localStorage.setItem(STORAGE_KEY, "abc");

		loadScript();

		expect(activeLabel()).toBe("x3.0");
	});

	it("stores the rate of a right-clicked button and applies it", () => {
		loadScript();

		const e = rightClick(button("x2.5"));

		expect(e.defaultPrevented).toBe(true);
		expect(localStorage.getItem(STORAGE_KEY)).toBe("2.5");
		expect(activeLabel()).toBe("x2.5");
		expect(defaultLabel()).toBe("x2.5");
	});

	it("does not change the stored rate on a normal click", () => {
		loadScript();

		button("x2.5").click();

		expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
		expect(activeLabel()).toBe("x2.5");
		expect(defaultLabel()).toBe("x3.0");
	});
});
