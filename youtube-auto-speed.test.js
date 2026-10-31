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

const SETLIST_COMMENT = [
	"00:09:18 START",
	"",
	":_glasslight:セトリ:_glasslight:",
	"00:22:32 都落ち / ヨルシカ",
	"",
	"00:28:54 rain stops, good-bye / におP",
	"",
	"1:00:56 怪獣の花唄 / Vaundy",
].join("\r\n");

function nextResponse() {
	return {
		contents: {
			twoColumnWatchNextResults: {
				results: {
					results: {
						contents: [
							{ itemSectionRenderer: { contents: [] } },
							{
								itemSectionRenderer: {
									sectionIdentifier: "comment-item-section",
									contents: [
										{
											continuationItemRenderer: {
												continuationEndpoint: {
													continuationCommand: { token: "COMMENTS_TOKEN" },
												},
											},
										},
									],
								},
							},
						],
					},
				},
			},
		},
	};
}

function continuationItem(token) {
	return {
		continuationItemRenderer: {
			continuationEndpoint: { continuationCommand: { token } },
		},
	};
}

// nextToken is the token for the next page of comments, or null on the last
// page. Each thread also carries a replies token, which must not be followed.
function commentsResponse(texts, nextToken = null) {
	const threads = texts.map(() => ({
		commentThreadRenderer: {
			replies: { contents: [continuationItem("REPLIES_TOKEN")] },
		},
	}));
	return {
		onResponseReceivedEndpoints: [
			{
				reloadContinuationItemsCommand: {
					continuationItems: nextToken
						? [...threads, continuationItem(nextToken)]
						: threads,
				},
			},
		],
		frameworkUpdates: {
			entityBatchUpdate: {
				mutations: texts.map((content) => ({
					payload: {
						commentEntityPayload: { properties: { content: { content } } },
					},
				})),
			},
		},
	};
}

function stubInnertube(commentTexts) {
	return stubInnertubePages([commentTexts]);
}

// pages[i] holds the comment texts of page i + 1. Page n is requested with
// the token "COMMENTS_TOKEN" for n = 1 and "PAGE_<n>" after that.
// held maps a page number to a promise that the response waits for, so a
// test can look at the page before that comment page arrives.
function stubInnertubePages(pages, { endless = false, held = {} } = {}) {
	const fetchMock = vi.fn(async (_url, init) => {
		const body = JSON.parse(init.body);
		let json = nextResponse();
		if (body.continuation) {
			const page =
				body.continuation === "COMMENTS_TOKEN"
					? 1
					: Number(body.continuation.replace("PAGE_", ""));
			await held[page];
			const hasNext = endless || page < pages.length;
			json = commentsResponse(
				pages[page - 1] ?? [],
				hasNext ? `PAGE_${page + 1}` : null,
			);
		}
		return { ok: true, status: 200, json: async () => json };
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function requestedTokens(fetchMock) {
	return fetchMock.mock.calls
		.map(([, init]) => JSON.parse(init.body).continuation)
		.filter(Boolean);
}

function startButton() {
	return button("START");
}

function stubPlayer() {
	const player = document.createElement("div");
	player.id = "movie_player";
	player.seekTo = vi.fn();
	document.body.appendChild(player);
	return player;
}

function setlistButton() {
	return button("SET LIST");
}

function setlistRows() {
	return [...document.querySelectorAll("#yt-speed-setlist-panel button")];
}

function setlistPanelOpen() {
	const panel = document.getElementById("yt-speed-setlist-panel");
	return panel != null && !panel.hidden;
}

// Each test loads the script again, so listeners from earlier loads must be
// removed or they would react to events in later tests.
let listeners = [];

function trackListeners(target) {
	const original = target.addEventListener;
	target.addEventListener = function (...args) {
		listeners.push([target, args]);
		return original.apply(this, args);
	};
	return () => {
		target.addEventListener = original;
	};
}

let untrack = [];

beforeEach(() => {
	untrack = [trackListeners(window), trackListeners(document)];
	vi.useFakeTimers();
	localStorage.clear();
	history.replaceState(null, "", "/");
	document.head.innerHTML = "";
	document.body.innerHTML = '<div><a id="logo"></a></div>';
});

afterEach(() => {
	for (const [target, args] of listeners) target.removeEventListener(...args);
	listeners = [];
	for (const restore of untrack) restore();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
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

describe("setlist", () => {
	beforeEach(() => {
		history.replaceState(null, "", "/watch?v=abc");
	});

	it("requests the comments of the current video", async () => {
		const fetchMock = stubInnertube([SETLIST_COMMENT]);

		loadScript();

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		const [firstUrl, firstInit] = fetchMock.mock.calls[0];
		expect(firstUrl).toContain("/youtubei/v1/next");
		expect(JSON.parse(firstInit.body).videoId).toBe("abc");
		expect(JSON.parse(fetchMock.mock.calls[1][1].body).continuation).toBe(
			"COMMENTS_TOKEN",
		);
	});

	it("shows the setlist button when a setlist comment is found", async () => {
		stubInnertube(["配信お疲れ様でした", SETLIST_COMMENT]);

		loadScript();

		await vi.waitFor(() => expect(setlistButton().hidden).toBe(false));
	});

	it("keeps the setlist button hidden when no comment has a setlist", async () => {
		const fetchMock = stubInnertube([
			"配信お疲れ様でした",
			"01:23 ここ好き\n02:34 ここも",
		]);

		loadScript();

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await vi.advanceTimersByTimeAsync(100);
		expect(setlistButton().hidden).toBe(true);
		expect(startButton().hidden).toBe(true);
	});

	it("does not request comments outside watch pages", () => {
		history.replaceState(null, "", "/");
		const fetchMock = stubInnertube([SETLIST_COMMENT]);

		loadScript();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(setlistButton().hidden).toBe(true);
		expect(startButton().hidden).toBe(true);
	});

	it("lists the timestamped lines of the comment with the most timestamps", async () => {
		stubInnertube(["00:01:00 a\n00:02:00 b\n00:03:00 c", SETLIST_COMMENT]);
		loadScript();
		await vi.waitFor(() => expect(setlistButton().hidden).toBe(false));

		setlistButton().click();

		expect(setlistPanelOpen()).toBe(true);
		expect(setlistRows().map((r) => r.textContent)).toEqual([
			"00:09:18 START",
			"00:22:32 都落ち / ヨルシカ",
			"00:28:54 rain stops, good-bye / におP",
			"1:00:56 怪獣の花唄 / Vaundy",
		]);
	});

	it("reads a tab-separated setlist with the time at the end of each line", async () => {
		stubInnertube([
			[
				"セトリ",
				"1\tHappy Halloween\tJunky\t0:10:21",
				"2\tモニタリング\tDECO*27\t0:17:27",
				"12\t蜜月アン・ドゥ・トロワ\tDATEKEN\t1:35:22",
			].join("\r\n"),
		]);
		loadScript();
		await vi.waitFor(() => expect(setlistButton().hidden).toBe(false));

		setlistButton().click();

		expect(setlistRows().map((r) => r.textContent)).toEqual([
			"0:10:21 Happy Halloween / Junky",
			"0:17:27 モニタリング / DECO*27",
			"1:35:22 蜜月アン・ドゥ・トロワ / DATEKEN",
		]);
	});

	it("jumps to the earliest time in the setlist with the START button", async () => {
		stubInnertube([SETLIST_COMMENT]);
		const player = stubPlayer();
		loadScript();
		await vi.waitFor(() => expect(startButton().hidden).toBe(false));

		startButton().click();

		expect(player.seekTo).toHaveBeenCalledWith(9 * 60 + 18, true);
	});

	it("skips 0:00 and uses the earliest time even when it is not first", async () => {
		stubInnertube([
			[
				"0:00 待機画面",
				"0:20:00 Song B / Artist",
				"0:05:00 開始",
				"0:10:00 Song A / Artist",
			].join("\n"),
		]);
		const player = stubPlayer();
		loadScript();
		await vi.waitFor(() => expect(startButton().hidden).toBe(false));

		startButton().click();

		expect(player.seekTo).toHaveBeenCalledWith(5 * 60, true);
	});

	it("leaves 0:00 lines out of the setlist", async () => {
		stubInnertube([
			[
				"0:00 待機画面",
				"00:00:00 開始前",
				"0:05:00 開始",
				"0:10:00 Song A / Artist",
				"0:20:00 Song B / Artist",
			].join("\n"),
		]);
		loadScript();
		await vi.waitFor(() => expect(setlistButton().hidden).toBe(false));

		setlistButton().click();

		expect(setlistRows().map((r) => r.textContent)).toEqual([
			"0:05:00 開始",
			"0:10:00 Song A / Artist",
			"0:20:00 Song B / Artist",
		]);
	});

	it("does not count 0:00 lines as setlist lines", async () => {
		const fetchMock = stubInnertube([
			[
				"0:00 待機画面",
				"0:00 また待機",
				"0:10:00 Song A",
				"0:20:00 Song B",
			].join("\n"),
		]);

		loadScript();

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await vi.advanceTimersByTimeAsync(100);
		expect(setlistButton().hidden).toBe(true);
	});

	it("shows START for a comment that is only a timestamp", async () => {
		stubInnertube(["配信お疲れ様でした", " 0:17 \n"]);
		const player = stubPlayer();
		loadScript();
		await vi.waitFor(() => expect(startButton().hidden).toBe(false));

		startButton().click();

		expect(player.seekTo).toHaveBeenCalledWith(17, true);
		expect(setlistButton().hidden).toBe(true);
	});

	it("does not use a single timestamp with other text as the start", async () => {
		const fetchMock = stubInnertube(["0:17 ここ好き", "0:00"]);

		loadScript();

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await vi.advanceTimersByTimeAsync(100);
		expect(startButton().hidden).toBe(true);
	});

	it("uses a timestamp-only comment earlier than the setlist as the start", async () => {
		stubInnertube([SETLIST_COMMENT, "5:00"]);
		const player = stubPlayer();
		loadScript();
		await vi.waitFor(() => expect(startButton().hidden).toBe(false));

		startButton().click();

		expect(player.seekTo).toHaveBeenCalledWith(5 * 60, true);
	});

	it("finds a setlist on a later page of comments", async () => {
		const fetchMock = stubInnertubePages([
			["配信お疲れ様でした"],
			["楽しかった"],
			[SETLIST_COMMENT],
		]);

		loadScript();

		await vi.waitFor(() => expect(setlistButton().hidden).toBe(false));
		expect(requestedTokens(fetchMock)).toEqual([
			"COMMENTS_TOKEN",
			"PAGE_2",
			"PAGE_3",
		]);
	});

	it("shows the buttons from the first page before later pages arrive", async () => {
		stubInnertubePages([[SETLIST_COMMENT], ["楽しかった"]], {
			held: { 2: new Promise(() => {}) },
		});

		loadScript();

		await vi.waitFor(() => expect(setlistButton().hidden).toBe(false));
		expect(startButton().hidden).toBe(false);
	});

	it("updates the open list when a later page has a longer setlist", async () => {
		let releasePage2;
		const page2 = new Promise((resolve) => {
			releasePage2 = resolve;
		});
		stubInnertubePages(
			[["0:01:00 a\n0:02:00 b\n0:03:00 c"], [SETLIST_COMMENT]],
			{ held: { 2: page2 } },
		);
		const player = stubPlayer();
		loadScript();
		await vi.waitFor(() => expect(setlistButton().hidden).toBe(false));
		setlistButton().click();
		expect(setlistRows()).toHaveLength(3);

		releasePage2();

		await vi.waitFor(() => expect(setlistRows()).toHaveLength(4));
		expect(setlistPanelOpen()).toBe(true);
		startButton().click();
		expect(player.seekTo).toHaveBeenCalledWith(9 * 60 + 18, true);
	});

	it("stops after five pages of comments", async () => {
		const fetchMock = stubInnertubePages([], { endless: true });

		loadScript();

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
		await vi.advanceTimersByTimeAsync(100);
		expect(requestedTokens(fetchMock)).toEqual([
			"COMMENTS_TOKEN",
			"PAGE_2",
			"PAGE_3",
			"PAGE_4",
			"PAGE_5",
		]);
	});

	it("seeks to the clicked time and closes the list", async () => {
		stubInnertube([SETLIST_COMMENT]);
		const player = document.createElement("div");
		player.id = "movie_player";
		player.seekTo = vi.fn();
		document.body.appendChild(player);
		loadScript();
		await vi.waitFor(() => expect(setlistButton().hidden).toBe(false));
		setlistButton().click();

		setlistRows()[1].click();

		expect(player.seekTo).toHaveBeenCalledWith(22 * 60 + 32, true);
		expect(setlistPanelOpen()).toBe(false);
	});

	it("closes the list on a click outside it or on the setlist button", async () => {
		stubInnertube([SETLIST_COMMENT]);
		loadScript();
		await vi.waitFor(() => expect(setlistButton().hidden).toBe(false));

		setlistButton().click();
		document.body.click();
		expect(setlistPanelOpen()).toBe(false);

		setlistButton().click();
		setlistButton().click();
		expect(setlistPanelOpen()).toBe(false);
	});

	it("shows a setlist that arrived before the buttons were created", async () => {
		document.body.innerHTML = "";
		const fetchMock = stubInnertube([SETLIST_COMMENT]);
		loadScript();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await vi.advanceTimersByTimeAsync(100);

		document.body.innerHTML = '<div><a id="logo"></a></div>';
		window.dispatchEvent(new Event("yt-navigate-finish"));

		expect(setlistButton().hidden).toBe(false);
	});

	it("reports a failed request as an RFC 9457 problem", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		loadScript();

		await vi.waitFor(() => expect(warn).toHaveBeenCalled());
		const problem = warn.mock.calls[0][0];
		expect(problem.type).toBe("about:blank");
		expect(problem.title).toBe("Failed to load setlist");
		expect(problem.detail).toContain("503");
		expect(setlistButton().hidden).toBe(true);
		expect(startButton().hidden).toBe(true);
	});
});
