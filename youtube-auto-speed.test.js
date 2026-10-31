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

function stubPlayer() {
	const player = document.createElement("div");
	player.id = "movie_player";
	player.seekTo = vi.fn();
	document.body.appendChild(player);
	return player;
}

// A stand-in for YouTube's #movie_player: the player API reports the video it
// has loaded, and the <video> inside it is playing.
function stubWatchPlayer({ videoId, title, duration }) {
	const player = document.getElementById("movie_player") ?? stubPlayer();
	player.videoData = { video_id: videoId, title };
	player.duration = duration;
	player.getVideoData = () => player.videoData;
	player.getDuration = () => player.duration;
	let video = player.querySelector("video");
	if (!video) {
		video = document.createElement("video");
		player.appendChild(video);
	}
	Object.defineProperty(video, "duration", {
		get: () => player.duration,
		configurable: true,
	});
	setPaused(video, false);
	return { player, video };
}

function setPaused(video, paused) {
	Object.defineProperty(video, "paused", {
		value: paused,
		configurable: true,
	});
}

// The title YouTube renders on the watch page. It can still show the previous
// video's title for a moment after navigation.
function renderTitle(title) {
	let el = document.querySelector("#title h1 yt-formatted-string");
	if (!el) {
		const box = document.createElement("div");
		box.id = "title";
		box.innerHTML = "<h1><yt-formatted-string></yt-formatted-string></h1>";
		document.body.appendChild(box);
		el = box.querySelector("yt-formatted-string");
	}
	el.textContent = title;
}

function navigate(url) {
	history.replaceState(null, "", url);
	window.dispatchEvent(new Event("yt-navigate-finish"));
}

function okResponse(json) {
	return { ok: true, status: 200, json: async () => json };
}

function timestampsButton() {
	return button("TIMESTAMPS");
}

function timestampRows() {
	return [...document.querySelectorAll("#yt-speed-timestamps-panel button")];
}

function timestampLabels() {
	return timestampRows().map((r) => r.textContent);
}

function timestampsPanelOpen() {
	const panel = document.getElementById("yt-speed-timestamps-panel");
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

// Observers from earlier loads must be disconnected for the same reason.
const OriginalMutationObserver = globalThis.MutationObserver;
let observers = [];

class TrackedMutationObserver extends OriginalMutationObserver {
	constructor(callback) {
		super(callback);
		observers.push(this);
	}
}

beforeEach(() => {
	untrack = [trackListeners(window), trackListeners(document)];
	vi.stubGlobal("MutationObserver", TrackedMutationObserver);
	vi.useFakeTimers();
	localStorage.clear();
	history.replaceState(null, "", "/");
	document.head.innerHTML = "";
	document.body.innerHTML = '<div><a id="logo"></a></div>';
});

afterEach(() => {
	for (const observer of observers) observer.disconnect();
	observers = [];
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

describe("playback", () => {
	beforeEach(() => {
		history.replaceState(null, "", "/watch?v=abc");
		stubInnertube([]);
	});

	it("plays a regular video at the default rate", () => {
		const { video } = stubWatchPlayer({
			videoId: "abc",
			title: "Talk",
			duration: 1200,
		});

		loadScript();

		expect(video.playbackRate).toBe(3);
	});

	it("plays a video with a music keyword at 1.0x", () => {
		const { video } = stubWatchPlayer({
			videoId: "abc",
			title: "【歌枠】Sing",
			duration: 3600,
		});

		loadScript();

		expect(video.playbackRate).toBe(1);
	});

	it("treats videos of 6 minutes or less as music", () => {
		const { player, video } = stubWatchPlayer({
			videoId: "abc",
			title: "Song",
			duration: 360,
		});
		loadScript();
		expect(video.playbackRate).toBe(1);

		player.videoData = { video_id: "def", title: "Talk" };
		player.duration = 361;
		navigate("/watch?v=def");
		vi.advanceTimersByTime(5000);

		expect(video.playbackRate).toBe(3);
	});

	it("plays Shorts at the default rate", () => {
		history.replaceState(null, "", "/shorts/xyz");
		document.body.insertAdjacentHTML(
			"beforeend",
			'<div id="shorts-player"><video></video></div>',
		);
		const video = document.querySelector("#shorts-player video");

		loadScript();

		expect(video.playbackRate).toBe(3);
	});

	it("reads the duration from the main player, not from a preview video", () => {
		const preview = document.createElement("video");
		Object.defineProperty(preview, "duration", { value: 15 });
		document.body.prepend(preview);
		const { video } = stubWatchPlayer({
			videoId: "abc",
			title: "Talk",
			duration: 1200,
		});

		loadScript();

		expect(video.playbackRate).toBe(3);
	});

	it("ignores rate changes on a preview video", () => {
		const preview = document.createElement("video");
		document.body.prepend(preview);
		const { video } = stubWatchPlayer({
			videoId: "abc",
			title: "Talk",
			duration: 1200,
		});
		loadScript();

		preview.playbackRate = 1;
		vi.advanceTimersByTime(500);

		expect(activeLabel()).toBe("x3.0");
		expect(video.playbackRate).toBe(3);
	});

	it("puts the rate back when YouTube resets it right after setting", () => {
		const { player, video } = stubWatchPlayer({
			videoId: "abc",
			title: "Talk",
			duration: 1200,
		});
		loadScript();
		player.videoData = { video_id: "def", title: "Talk 2" };
		navigate("/watch?v=def");

		video.playbackRate = 1;
		vi.advanceTimersByTime(500);

		expect(video.playbackRate).toBe(3);
	});

	it("keeps auto speed when YouTube resets the rate while the next video loads", () => {
		renderTitle("Old talk");
		const { player, video } = stubWatchPlayer({
			videoId: "abc",
			title: "Old talk",
			duration: 1200,
		});
		loadScript();

		// The player still reports the previous video for a moment.
		navigate("/watch?v=def");
		video.playbackRate = 1;
		vi.advanceTimersByTime(500);
		player.videoData = { video_id: "def", title: "New talk" };
		renderTitle("New talk");
		video.dispatchEvent(new Event("loadedmetadata"));
		vi.advanceTimersByTime(5000);

		expect(video.playbackRate).toBe(3);
		expect(activeLabel()).toBe("x3.0");
	});

	it("waits for the player to report the new video before choosing", () => {
		const { player, video } = stubWatchPlayer({
			videoId: "abc",
			title: "Talk",
			duration: 1200,
		});
		loadScript();

		// The player keeps reporting the previous video, then YouTube resets
		// the rate while loading the new one.
		navigate("/watch?v=def");
		vi.advanceTimersByTime(2500);
		video.playbackRate = 1;
		vi.advanceTimersByTime(500);
		player.videoData = { video_id: "def", title: "Talk 2" };
		video.dispatchEvent(new Event("loadedmetadata"));
		vi.advanceTimersByTime(5000);

		expect(video.playbackRate).toBe(3);
	});

	it("does not use the previous video's music title after navigation", () => {
		renderTitle("【歌枠】Sing");
		const { player, video } = stubWatchPlayer({
			videoId: "abc",
			title: "【歌枠】Sing",
			duration: 3600,
		});
		loadScript();
		expect(video.playbackRate).toBe(1);

		// The page title still shows the music video, but the player has
		// already loaded the next one.
		player.videoData = { video_id: "def", title: "Talk" };
		navigate("/watch?v=def");
		video.dispatchEvent(new Event("loadedmetadata"));
		vi.advanceTimersByTime(5000);

		expect(video.playbackRate).toBe(3);
	});

	it("keeps a rate the user chose in YouTube's menu while paused", () => {
		const { video } = stubWatchPlayer({
			videoId: "abc",
			title: "Talk",
			duration: 1200,
		});
		loadScript();

		setPaused(video, true);
		video.playbackRate = 2;
		vi.advanceTimersByTime(500);
		setPaused(video, false);
		video.dispatchEvent(new Event("play"));
		vi.advanceTimersByTime(5000);

		expect(video.playbackRate).toBe(2);
	});

	it("keeps a rate the user chose during a live stream", () => {
		const { video } = stubWatchPlayer({
			videoId: "abc",
			title: "Live",
			duration: Number.POSITIVE_INFINITY,
		});
		loadScript();

		video.playbackRate = 1.5;
		vi.advanceTimersByTime(500);
		video.dispatchEvent(new Event("play"));
		vi.advanceTimersByTime(5000);

		expect(video.playbackRate).toBe(1.5);
	});

	it("keeps a clicked rate until the next video", () => {
		const { player, video } = stubWatchPlayer({
			videoId: "abc",
			title: "Talk",
			duration: 1200,
		});
		loadScript();

		button("x2.5").click();
		video.dispatchEvent(new Event("durationchange"));
		vi.advanceTimersByTime(5000);
		expect(video.playbackRate).toBe(2.5);

		player.videoData = { video_id: "def", title: "Talk 2" };
		navigate("/watch?v=def");
		vi.advanceTimersByTime(5000);
		expect(video.playbackRate).toBe(3);
	});
});

describe("timestamps", () => {
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

	it("shows the TIMESTAMPS button when a setlist comment is found", async () => {
		stubInnertube(["配信お疲れ様でした", SETLIST_COMMENT]);

		loadScript();

		await vi.waitFor(() => expect(timestampsButton().hidden).toBe(false));
	});

	it("keeps the TIMESTAMPS button hidden when no comment has timestamps", async () => {
		const fetchMock = stubInnertube([
			"配信お疲れ様でした",
			"01:23 ここ好き\n02:34 ここも",
		]);

		loadScript();

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await vi.advanceTimersByTimeAsync(100);
		expect(timestampsButton().hidden).toBe(true);
	});

	it("does not request comments outside watch pages", () => {
		history.replaceState(null, "", "/");
		const fetchMock = stubInnertube([SETLIST_COMMENT]);

		loadScript();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(timestampsButton().hidden).toBe(true);
	});

	it("lists the timestamped lines of the comment with the most timestamps", async () => {
		stubInnertube(["00:01:00 a\n00:02:00 b\n00:03:00 c", SETLIST_COMMENT]);
		loadScript();
		await vi.waitFor(() => expect(timestampsButton().hidden).toBe(false));

		timestampsButton().click();

		expect(timestampsPanelOpen()).toBe(true);
		expect(timestampRows().map((r) => r.textContent)).toEqual([
			"00:09:18 START",
			"00:22:32 都落ち / ヨルシカ",
			"00:28:54 rain stops, good-bye / におP",
			"1:00:56 怪獣の花唄 / Vaundy",
		]);
	});

	it("puts the time in its own element so it can be shown faintly", async () => {
		stubInnertube([SETLIST_COMMENT]);
		loadScript();
		await vi.waitFor(() => expect(timestampsButton().hidden).toBe(false));
		timestampsButton().click();

		const row = timestampRows()[1];
		expect(row.querySelector(".yt-speed-time").textContent).toBe("00:22:32");
		expect(row.textContent).toBe("00:22:32 都落ち / ヨルシカ");
	});

	it("ignores times next to a date, such as pasted news headlines", async () => {
		const news = [
			"ホロライブ・大空スバル、チャンネル登録者が200万人を突破",
			"エンタメ総合",
			"5/20(水) 18:00",
			"エンタメ総合",
			"5/28(木) 18:00",
			"2026/6/11 18:00",
			"6月17日 18:00",
		].join("\n");
		const talk = [
			"タイムスタンプ🍮",
			"2:30 あじまる屋さん",
			"13:00 鼻ドスの話",
			"20:31 サインの話",
			"25:30 1/2 / 川本真琴",
		].join("\r\n");
		stubInnertube([news, talk]);
		loadScript();
		await vi.waitFor(() => expect(timestampsButton().hidden).toBe(false));
		timestampsButton().click();

		expect(timestampLabels()).toEqual([
			"2:30 あじまる屋さん",
			"13:00 鼻ドスの話",
			"20:31 サインの話",
			"25:30 1/2 / 川本真琴",
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
		await vi.waitFor(() => expect(timestampsButton().hidden).toBe(false));

		timestampsButton().click();

		expect(timestampRows().map((r) => r.textContent)).toEqual([
			"0:10:21 Happy Halloween / Junky",
			"0:17:27 モニタリング / DECO*27",
			"1:35:22 蜜月アン・ドゥ・トロワ / DATEKEN",
		]);
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
		await vi.waitFor(() => expect(timestampsButton().hidden).toBe(false));

		timestampsButton().click();

		expect(timestampRows().map((r) => r.textContent)).toEqual([
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
		expect(timestampsButton().hidden).toBe(true);
	});

	it("has no START button", async () => {
		stubInnertube([SETLIST_COMMENT, "5:00"]);
		loadScript();
		await vi.waitFor(() => expect(timestampsButton().hidden).toBe(false));

		expect(button("START")).toBeUndefined();
	});

	it("lists a timestamp-only comment as START when no setlist exists", async () => {
		stubInnertube(["配信お疲れ様でした", " 0:17 \n", "0:00"]);
		const player = stubPlayer();
		loadScript();
		await vi.waitFor(() => expect(timestampsButton().hidden).toBe(false));
		timestampsButton().click();

		expect(timestampLabels()).toEqual(["0:17 START"]);
		timestampRows()[0].click();
		expect(player.seekTo).toHaveBeenCalledWith(17, true);
	});

	it("puts the start time before a setlist that has no start", async () => {
		stubInnertube([
			[
				"0:10:21 Song A / Artist",
				"0:17:27 Song B / Artist",
				"0:24:32 Song C",
			].join("\n"),
			"9:00",
			"5:00",
		]);
		loadScript();
		await vi.waitFor(() => expect(timestampsButton().hidden).toBe(false));
		timestampsButton().click();

		expect(timestampLabels()).toEqual([
			"5:00 START",
			"0:10:21 Song A / Artist",
			"0:17:27 Song B / Artist",
			"0:24:32 Song C",
		]);
	});

	it("does not add START when the setlist already starts earlier", async () => {
		stubInnertube([SETLIST_COMMENT, "10:00"]);
		loadScript();
		await vi.waitFor(() => expect(timestampsButton().hidden).toBe(false));
		timestampsButton().click();

		expect(timestampLabels()[0]).toBe("00:09:18 START");
		expect(timestampLabels()).toHaveLength(4);
	});

	it("does not use a single timestamp with other text as the start", async () => {
		const fetchMock = stubInnertube(["0:17 ここ好き", "0:00"]);

		loadScript();

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await vi.advanceTimersByTimeAsync(100);
		expect(timestampsButton().hidden).toBe(true);
	});

	it("finds a setlist on a later page of comments", async () => {
		const fetchMock = stubInnertubePages([
			["配信お疲れ様でした"],
			["楽しかった"],
			[SETLIST_COMMENT],
		]);

		loadScript();

		await vi.waitFor(() => expect(timestampsButton().hidden).toBe(false));
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

		await vi.waitFor(() => expect(timestampsButton().hidden).toBe(false));
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
		loadScript();
		await vi.waitFor(() => expect(timestampsButton().hidden).toBe(false));
		timestampsButton().click();
		expect(timestampRows()).toHaveLength(3);

		releasePage2();

		await vi.waitFor(() => expect(timestampRows()).toHaveLength(4));
		expect(timestampsPanelOpen()).toBe(true);
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
		const player = stubPlayer();
		loadScript();
		await vi.waitFor(() => expect(timestampsButton().hidden).toBe(false));
		timestampsButton().click();

		timestampRows()[1].click();

		expect(player.seekTo).toHaveBeenCalledWith(22 * 60 + 32, true);
		expect(timestampsPanelOpen()).toBe(false);
	});

	it("closes the list on a click outside it or on the TIMESTAMPS button", async () => {
		stubInnertube([SETLIST_COMMENT]);
		loadScript();
		await vi.waitFor(() => expect(timestampsButton().hidden).toBe(false));

		timestampsButton().click();
		document.body.click();
		expect(timestampsPanelOpen()).toBe(false);

		timestampsButton().click();
		timestampsButton().click();
		expect(timestampsPanelOpen()).toBe(false);
	});

	it("shows a setlist that arrived before the buttons were created", async () => {
		document.body.innerHTML = "";
		const fetchMock = stubInnertube([SETLIST_COMMENT]);
		loadScript();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await vi.advanceTimersByTimeAsync(100);

		document.body.innerHTML = '<div><a id="logo"></a></div>';
		window.dispatchEvent(new Event("yt-navigate-finish"));

		expect(timestampsButton().hidden).toBe(false);
	});

	it("uses the time column, not a time-like song title, in a tab-separated line", async () => {
		stubInnertube([
			[
				"1\t4:33\tJohn Cage\t0:10:21",
				"2\tSong B\tArtist\t0:17:27",
				"3\tSong C\tArtist\t0:24:32",
			].join("\n"),
		]);
		loadScript();
		await vi.waitFor(() => expect(timestampsButton().hidden).toBe(false));
		timestampsButton().click();

		expect(timestampLabels()).toEqual([
			"0:10:21 4:33 / John Cage",
			"0:17:27 Song B / Artist",
			"0:24:32 Song C / Artist",
		]);
	});

	it("does not treat out-of-range minutes or seconds as timestamps", async () => {
		const fetchMock = stubInnertube(["1:75 a\n1:99 b\n1:61:00 c"]);

		loadScript();

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await vi.advanceTimersByTimeAsync(100);
		expect(timestampsButton().hidden).toBe(true);
	});

	it("follows a view-model continuation to the next page", async () => {
		const fetchMock = vi.fn(async (_url, init) => {
			const body = JSON.parse(init.body);
			if (!body.continuation) return okResponse(nextResponse());
			if (body.continuation === "PAGE_2") {
				return okResponse(commentsResponse([SETLIST_COMMENT]));
			}
			const page1 = commentsResponse(["楽しかった"]);
			page1.onResponseReceivedEndpoints[0].reloadContinuationItemsCommand.continuationItems.push(
				{
					continuationItemViewModel: {
						continuationCommand: {
							innertubeCommand: { continuationCommand: { token: "PAGE_2" } },
						},
					},
				},
			);
			return okResponse(page1);
		});
		vi.stubGlobal("fetch", fetchMock);

		loadScript();

		await vi.waitFor(() => expect(timestampsButton().hidden).toBe(false));
		expect(requestedTokens(fetchMock)).toEqual(["COMMENTS_TOKEN", "PAGE_2"]);
	});

	it("ignores an older request for the same video after navigating back", async () => {
		let releaseFirst;
		const firstHeld = new Promise((resolve) => {
			releaseFirst = resolve;
		});
		let commentRequests = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url, init) => {
				const body = JSON.parse(init.body);
				if (!body.continuation) return okResponse(nextResponse());
				commentRequests++;
				if (commentRequests === 1) {
					await firstHeld;
					return okResponse(
						commentsResponse(["0:01:00 old\n0:02:00 old\n0:03:00 old"]),
					);
				}
				return okResponse(commentsResponse([SETLIST_COMMENT]));
			}),
		);
		loadScript();
		navigate("/watch?v=def");
		navigate("/watch?v=abc");
		await vi.waitFor(() => expect(timestampsButton().hidden).toBe(false));

		releaseFirst();
		await vi.advanceTimersByTimeAsync(100);
		timestampsButton().click();

		expect(timestampLabels()[0]).toBe("00:09:18 START");
	});

	it("tries again on the next navigation after a failed request", async () => {
		let fail = true;
		const fetchMock = vi.fn(async (_url, init) => {
			if (fail) return { ok: false, status: 503, json: async () => ({}) };
			const body = JSON.parse(init.body);
			return okResponse(
				body.continuation
					? commentsResponse([SETLIST_COMMENT])
					: nextResponse(),
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		loadScript();
		await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());

		fail = false;
		window.dispatchEvent(new Event("yt-navigate-finish"));

		await vi.waitFor(() => expect(timestampsButton().hidden).toBe(false));
	});

	it("creates the buttons when the logo appears later", async () => {
		document.body.innerHTML = "";
		stubInnertube([]);
		loadScript();
		expect(button("x3.0")).toBeUndefined();

		document.body.innerHTML = '<div><a id="logo"></a></div>';
		await vi.advanceTimersByTimeAsync(0);

		expect(button("x3.0")).toBeDefined();
	});

	it("puts a source line in the problem detail even without a stack", async () => {
		const err = new Error("Network offline");
		err.stack = undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw err;
			}),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		loadScript();

		await vi.waitFor(() => expect(warn).toHaveBeenCalled());
		expect(warn.mock.calls[0][0].detail).toMatch(/^\S+:\d+: Network offline$/);
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
		expect(problem.title).toBe("Failed to load timestamps");
		expect(problem.detail).toContain("503");
		expect(timestampsButton().hidden).toBe(true);
	});
});

describe("auto seek to the start", () => {
	beforeEach(() => {
		history.replaceState(null, "", "/watch?v=abc");
	});

	function stubPlayingVideo(currentTime = 0) {
		const { player, video } = stubWatchPlayer({
			videoId: "abc",
			title: "Talk",
			duration: 7200,
		});
		Object.defineProperty(video, "currentTime", {
			value: currentTime,
			configurable: true,
		});
		return player;
	}

	it("jumps to a START line in the setlist", async () => {
		stubInnertube([SETLIST_COMMENT]);
		const player = stubPlayingVideo();

		loadScript();

		await vi.waitFor(() =>
			expect(player.seekTo).toHaveBeenCalledWith(9 * 60 + 18, true),
		);
	});

	it("jumps to a line that says the stream started", async () => {
		stubInnertube([
			["00:01:05 配信開始", "00:03:42 大会開始", "00:11:31 でんせつ"].join(
				"\n",
			),
		]);
		const player = stubPlayingVideo();

		loadScript();

		await vi.waitFor(() =>
			expect(player.seekTo).toHaveBeenCalledWith(65, true),
		);
		expect(player.seekTo).toHaveBeenCalledTimes(1);
	});

	it("jumps to a comment that is only a timestamp", async () => {
		stubInnertube(["0:17"]);
		const player = stubPlayingVideo();

		loadScript();

		await vi.waitFor(() =>
			expect(player.seekTo).toHaveBeenCalledWith(17, true),
		);
	});

	it("does not jump to the first song of a setlist without a start", async () => {
		const fetchMock = stubInnertube([
			[
				"1\tSong A\tArtist\t0:10:21",
				"2\tSong B\tArtist\t0:17:27",
				"3\tSong C\tArtist\t0:24:32",
			].join("\n"),
		]);
		const player = stubPlayingVideo();

		loadScript();

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await vi.advanceTimersByTimeAsync(100);
		expect(timestampsButton().hidden).toBe(false);
		expect(player.seekTo).not.toHaveBeenCalled();
	});

	it("does not jump when the URL has a start position", async () => {
		history.replaceState(null, "", "/watch?v=abc&t=100");
		const fetchMock = stubInnertube([SETLIST_COMMENT]);
		const player = stubPlayingVideo();

		loadScript();

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await vi.advanceTimersByTimeAsync(100);
		expect(player.seekTo).not.toHaveBeenCalled();
	});

	it("does not jump back when the video is already past the start", async () => {
		const fetchMock = stubInnertube([SETLIST_COMMENT]);
		const player = stubPlayingVideo(1200);

		loadScript();

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await vi.advanceTimersByTimeAsync(100);
		expect(player.seekTo).not.toHaveBeenCalled();
	});

	it("jumps only once even if a later page has an earlier start", async () => {
		const fetchMock = stubInnertubePages([[SETLIST_COMMENT], ["5:00"]]);
		const player = stubPlayingVideo();

		loadScript();

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
		await vi.advanceTimersByTimeAsync(100);
		expect(player.seekTo).toHaveBeenCalledTimes(1);
		expect(player.seekTo).toHaveBeenCalledWith(9 * 60 + 18, true);
	});
});
