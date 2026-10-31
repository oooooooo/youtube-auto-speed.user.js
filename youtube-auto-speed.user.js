// ==UserScript==
// @name         YouTube Auto Speed
// @namespace    https://github.com/oooooooo/youtube-auto-speed
// @version      1.5.1
// @description  Speeds up videos except for music. You can also adjust the speed manually.
// @author       ooooooooo
// @match        https://www.youtube.com/*
// @run-at       document-start
// @updateURL    https://github.com/oooooooo/youtube-auto-speed/raw/main/youtube-auto-speed.user.js
// @downloadURL  https://github.com/oooooooo/youtube-auto-speed/raw/main/youtube-auto-speed.user.js
// @supportURL   https://github.com/oooooooo/youtube-auto-speed
// @grant        none
// ==/UserScript==

(() => {
	const KEYWORDS = ["カラオケ", "karaoke", "歌枠", "歌ってみた"];
	const MV_RE = /【\s*MV\s*】|\(\s*MV\s*\)|「\s*MV\s*」|\bMV\b/i;

	const MAX_SLOW_DURATION_SEC = 6 * 60;
	const RATE_SLOW = 1.0;
	const RATE_MID = 2.5;
	const RATE_FAST = 3.0;
	const RATE_FASTER = 3.5;
	const BUTTON_RATES = [RATE_SLOW, RATE_MID, RATE_FAST, RATE_FASTER];
	const STORAGE_KEY = "yt-auto-speed-default-rate";
	const CONTAINER_ID = "yt-speed-buttons-container-v4";
	const BTN_CLASS = "yt-speed-btn-v5";
	const AUTO_RETRY_COUNT = 15;
	const AUTO_RETRY_INTERVAL_MS = 120;
	const ENFORCE_MS = 2000;
	const TIMESTAMPS_BTN_ID = "yt-speed-timestamps-btn";
	const TIMESTAMPS_PANEL_ID = "yt-speed-timestamps-panel";
	const TIME_CLASS = "yt-speed-time";
	const MIN_SETLIST_ENTRIES = 3;
	// Top comments come back in a slightly different order on every request,
	// so the setlist is not always on the first page.
	const MAX_COMMENT_PAGES = 5;
	// Setlist comments put the time at the start ("00:22:32 Song / Artist") or
	// in a tab-separated column ("1\tSong\tArtist\t0:10:21").
	// Minutes and seconds must be below 60, except for minutes without hours
	// ("75:30"), which some viewers write for long streams.
	const TIMESTAMP_RE =
		/(?<![\d:])((?:\d{1,2}:[0-5]\d|\d{1,3}):[0-5]\d)(?![\d:])/;
	const TRACK_NUMBER_RE = /^\d+[.)]?$/;
	// Viewers often post just the start time ("0:17") as a comment.
	const TIMESTAMP_ONLY_RE = new RegExp(`^${TIMESTAMP_RE.source}$`);
	// A time next to a date ("5/20(水) 18:00", "2026/6/11", "6月17日") is a clock
	// time, e.g. in pasted news headlines, not a position in the video. A bare
	// "1/2" is not a date because it can be a song title.
	const DATE_RE =
		/\d{1,2}\/\d{1,2}\s*[(（][日月火水木金土]|\d{4}\/\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日/;
	// Lines such as "00:09:18 START" or "00:01:05 配信開始" mark the start.
	const START_TITLE_RE = /start|開始|スタート/i;
	// Used only when the page has no ytcfg, e.g. before YouTube finishes booting.
	const SOURCE_LOCATION_RE = /([^\s()/]+:\d+):\d+/;
	const FALLBACK_INNERTUBE_CONTEXT = {
		client: { clientName: "WEB", clientVersion: "2.20261029.11.00" },
	};

	let defaultRate = loadDefaultRate();
	let currentRate = defaultRate;
	let manualOverride = false;
	let enforceUntil = 0;
	// True from a navigation until the auto rate for the new video is chosen.
	// Rate changes in that window come from YouTube loading the video.
	let autoPending = false;
	let autoTimer = null;
	let lastVideoId = null;
	let observer = null;
	let timestampsVideoId = null;
	let timestampsRequest = 0;
	let timestampEntries = [];
	const hooked = new WeakSet();

	const style = `
    #${CONTAINER_ID} {
      display: flex;
      gap: 6px;
      align-items: center;
      margin-left: 10px;
    }
    .${BTN_CLASS} {
      font-family: "Roboto", Arial, sans-serif;
      font-size: 13px;
      padding: 6px 8px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.08);
      color: #fff;
      cursor: pointer;
      user-select: none;
    }
    .${BTN_CLASS}:hover { background: rgba(255,255,255,0.15); }
    .${BTN_CLASS}.active {
      background: rgba(255,255,255,0.22);
      border-color: rgba(255,255,255,0.25);
      font-weight: bold;
    }
    .${BTN_CLASS}.default { text-decoration: underline; }
    #${CONTAINER_ID} { position: relative; }
    #${TIMESTAMPS_PANEL_ID} {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 9999;
      width: max-content;
      min-width: 280px;
      max-width: min(720px, calc(100vw - 32px));
      max-height: 70vh;
      overflow-y: auto;
      padding: 6px;
      border-radius: 12px;
      background: #212121;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    }
    #${TIMESTAMPS_PANEL_ID}[hidden] { display: none; }
    #${TIMESTAMPS_PANEL_ID} button {
      display: block;
      width: 100%;
      padding: 6px 8px;
      border: none;
      border-radius: 8px;
      background: transparent;
      color: #fff;
      font-family: "Roboto", Arial, sans-serif;
      font-size: 13px;
      text-align: left;
      cursor: pointer;
    }
    #${TIMESTAMPS_PANEL_ID} button:hover { background: rgba(255,255,255,0.15); }
    #${TIMESTAMPS_PANEL_ID} .${TIME_CLASS} { color: rgba(255,255,255,0.5); }
  `;

	function loadDefaultRate() {
		try {
			const rate = Number.parseFloat(localStorage.getItem(STORAGE_KEY));
			if (BUTTON_RATES.includes(rate)) return rate;
		} catch {
			// localStorage can be blocked; fall back to the built-in default.
		}
		return RATE_FAST;
	}

	function saveDefaultRate(rate) {
		defaultRate = rate;
		try {
			localStorage.setItem(STORAGE_KEY, String(rate));
		} catch {
			// Keep the default for this page even if it cannot be persisted.
		}
	}

	function injectStyle() {
		if (!document.getElementById("yt-speed-buttons-style")) {
			const s = document.createElement("style");
			s.id = "yt-speed-buttons-style";
			s.textContent = style;
			document.head.appendChild(s);
		}
	}

	function isShorts() {
		return location.pathname.startsWith("/shorts/");
	}

	function parseDuration(text) {
		if (!text) return null;
		const parts = text.trim().split(":").map(Number);
		if (parts.length === 2) return parts[0] * 60 + parts[1];
		if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
		return null;
	}

	// On Shorts the watch player stays in the page, hidden, so the Shorts
	// player is looked up first there.
	function mainVideo() {
		const selector = isShorts()
			? "#shorts-player video"
			: "#movie_player video";
		return document.querySelector(selector) ?? document.querySelector("video");
	}

	// The player API knows which video it has loaded, unlike the page title,
	// which can still show the previous video right after navigation.
	function loadedVideoInfo() {
		const player = document.getElementById("movie_player");
		const data = player?.getVideoData?.();
		if (!data?.video_id || data.video_id !== getVideoId()) return null;
		const duration = player.getDuration?.();
		return {
			title: data.title ?? "",
			duration: duration > 0 ? duration : null,
		};
	}

	function durationSecondsTrusted() {
		const v = mainVideo();
		if (v?.duration > 0) return v.duration;

		const ui = parseDuration(
			document.querySelector(".ytp-time-duration")?.textContent ?? "",
		);
		return ui != null && ui > 0 ? ui : null;
	}

	const TITLE_SELECTORS = [
		"#title h1 yt-formatted-string",
		"ytd-watch-metadata h1 yt-formatted-string",
		"#above-the-fold #title yt-formatted-string",
		"h1.title yt-formatted-string",
		"#title h1",
		"h1.title",
	];

	function getWatchTitle() {
		for (const sel of TITLE_SELECTORS) {
			const el = document.querySelector(sel);
			const t = el?.textContent?.trim();
			if (t) return el.textContent;
		}
		return "";
	}

	function isMusicTitle(title) {
		if (!title) return false;
		const lower = title.toLowerCase();
		if (KEYWORDS.some((k) => lower.includes(k.toLowerCase()))) return true;
		return MV_RE.test(title);
	}

	function getVideoId() {
		const params = new URLSearchParams(location.search);
		return params.get("v") || location.pathname;
	}

	// info comes from the player API; without it, fall back to the page.
	function computeAutoRate(info) {
		if (isShorts()) return defaultRate;

		const title = info ? info.title : getWatchTitle();
		const sec = info?.duration ?? durationSecondsTrusted();

		if (isMusicTitle(title)) return RATE_SLOW;
		if (sec != null && sec <= MAX_SLOW_DURATION_SEC) return RATE_SLOW;
		return defaultRate;
	}

	function autoSetSpeed(retryCount = 0) {
		clearTimeout(autoTimer);
		const videoId = getVideoId();
		if (videoId !== lastVideoId) {
			lastVideoId = videoId;
			manualOverride = false;
			autoPending = true;
		}
		if (manualOverride) return;

		const info = isShorts() ? null : loadedVideoInfo();
		// Wait until the player reports this video and its duration. If the
		// player API never does, the page title is used after the retries.
		const ready = isShorts() || info?.duration != null;
		if (!ready && retryCount < AUTO_RETRY_COUNT) {
			autoTimer = setTimeout(
				() => autoSetSpeed(retryCount + 1),
				AUTO_RETRY_INTERVAL_MS,
			);
			return;
		}

		autoPending = false;
		setPlaybackRate(computeAutoRate(info), false);
	}

	function syncVideosFromCurrentRate() {
		for (const v of document.querySelectorAll("video")) {
			if (Math.abs(v.playbackRate - currentRate) > 0.001) {
				v.playbackRate = currentRate;
			}
		}
	}

	function updateButtonStates(rate) {
		for (const b of document.querySelectorAll(`.${BTN_CLASS}`)) {
			const r = Number.parseFloat(b.dataset.rate);
			b.classList.toggle("active", r === rate);
			b.classList.toggle("default", r === defaultRate);
		}
	}

	function setPlaybackRate(rate, isManual = true) {
		if (isManual) {
			manualOverride = true;
			autoPending = false;
		}
		currentRate = rate;
		enforceUntil = Date.now() + ENFORCE_MS;
		syncVideosFromCurrentRate();
		queueMicrotask(syncVideosFromCurrentRate);
		updateButtonStates(rate);
	}

	function createButtons() {
		if (document.getElementById(CONTAINER_ID)) return;

		const logo = document.querySelector("#logo");
		if (!logo?.parentElement) return;

		const container = document.createElement("div");
		container.id = CONTAINER_ID;

		function mk(label, rate) {
			const b = document.createElement("button");
			b.className = BTN_CLASS;
			b.textContent = label;
			b.dataset.rate = String(rate);
			b.onclick = () => setPlaybackRate(rate);
			b.oncontextmenu = (e) => {
				e.preventDefault();
				saveDefaultRate(rate);
				setPlaybackRate(rate);
			};
			return b;
		}

		for (const rate of BUTTON_RATES) {
			container.appendChild(mk(`x${rate.toFixed(1)}`, rate));
		}

		const timestampsBtn = document.createElement("button");
		timestampsBtn.id = TIMESTAMPS_BTN_ID;
		timestampsBtn.className = BTN_CLASS;
		timestampsBtn.textContent = "TIMESTAMPS";
		timestampsBtn.hidden = true;
		timestampsBtn.onclick = () => {
			const panel = document.getElementById(TIMESTAMPS_PANEL_ID);
			panel.hidden = !panel.hidden;
		};
		container.appendChild(timestampsBtn);

		const panel = document.createElement("div");
		panel.id = TIMESTAMPS_PANEL_ID;
		panel.hidden = true;
		container.appendChild(panel);

		logo.parentElement.insertBefore(container, logo.nextSibling);
		renderTimestamps();
		setPlaybackRate(currentRate, false);
	}

	function parseTimestamp(text) {
		return text.split(":").reduce((sec, part) => sec * 60 + Number(part), 0);
	}

	function setlistTitle(fields) {
		const rest = fields.filter(Boolean);
		if (rest.length > 1 && TRACK_NUMBER_RE.test(rest[0])) rest.shift();
		return rest.join(" / ");
	}

	// In a tab-separated line the song title can look like a time ("4:33"),
	// so a time that fills the first or last column wins over one found
	// elsewhere in the line.
	function splitSetlistLine(line) {
		const fields = line.split("\t").map((f) => f.trim());
		for (const i of [0, fields.length - 1]) {
			const m = fields[i].match(TIMESTAMP_ONLY_RE);
			if (m) return { time: m[1], rest: fields.filter((_, j) => j !== i) };
		}
		const m = line.match(TIMESTAMP_RE);
		if (!m) return null;
		const rest = line.replace(TIMESTAMP_RE, "\t").split("\t");
		return { time: m[1], rest: rest.map((f) => f.trim()) };
	}

	// Some comments put a summary (e.g. one line per guest) before the full
	// list and repeat its lines there, so the lines are sorted by time and a
	// line that repeats an earlier one is dropped.
	function parseSetlist(text) {
		const entries = [];
		const seen = new Set();
		for (const line of text.split(/\r?\n/)) {
			if (DATE_RE.test(line)) continue;
			const parts = splitSetlistLine(line);
			if (!parts) continue;
			const seconds = parseTimestamp(parts.time);
			// 0:00 marks the waiting screen, not a song or the stream start.
			if (seconds === 0) continue;
			const title = setlistTitle(parts.rest);
			const key = `${seconds}\t${title}`;
			if (seen.has(key)) continue;
			seen.add(key);
			entries.push({ time: parts.time, seconds, title });
		}
		return entries.sort((a, b) => a.seconds - b.seconds);
	}

	function pickSetlist(commentTexts) {
		let best = [];
		for (const text of commentTexts) {
			const entries = parseSetlist(text);
			if (entries.length > best.length) best = entries;
		}
		return best.length >= MIN_SETLIST_ENTRIES ? best : [];
	}

	function* walk(node) {
		if (node == null || typeof node !== "object") return;
		yield node;
		for (const child of Object.values(node)) yield* walk(child);
	}

	function findCommentsToken(json) {
		for (const node of walk(json)) {
			if (node.sectionIdentifier !== "comment-item-section") continue;
			for (const inner of walk(node)) {
				const token = inner.continuationCommand?.token;
				if (token) return token;
			}
		}
		return null;
	}

	function commentTexts(json) {
		const texts = [];
		for (const node of walk(json)) {
			const text = node.commentEntityPayload?.properties?.content?.content;
			if (text) texts.push(text);
		}
		return texts;
	}

	// Uses YouTube's internal API because comments are loaded lazily and are
	// not in the DOM until the user scrolls down to them.
	async function innertubeNext(body) {
		const url = "/youtubei/v1/next?prettyPrint=false";
		const context =
			window.ytcfg?.get?.("INNERTUBE_CONTEXT") ?? FALLBACK_INNERTUBE_CONTEXT;
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ context, ...body }),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
		return res.json();
	}

	// The earliest comment that is only a timestamp, which marks the start.
	function pickStart(commentTexts) {
		let start = null;
		for (const text of commentTexts) {
			const m = text.trim().match(TIMESTAMP_ONLY_RE);
			if (!m) continue;
			const seconds = parseTimestamp(m[1]);
			if (seconds > 0 && (start == null || seconds < start.seconds)) {
				start = { time: m[1], seconds, title: "START" };
			}
		}
		return start;
	}

	// Setlists often list only the songs, so the start time is put in front
	// unless the setlist already begins at or before it.
	function pickTimestamps(commentTexts) {
		const setlist = pickSetlist(commentTexts);
		const start = pickStart(commentTexts);
		if (!start) return setlist;
		if (setlist.some((e) => e.seconds <= start.seconds)) return setlist;
		return [start, ...setlist];
	}

	// Only top-level continuation items are checked: comment threads hold the
	// token for their replies, and the header holds the sort menu's tokens.
	// The item comes as continuationItemRenderer or continuationItemViewModel.
	function findNextPageToken(json) {
		for (const endpoint of json.onResponseReceivedEndpoints ?? []) {
			for (const action of Object.values(endpoint)) {
				for (const item of action?.continuationItems ?? []) {
					const [kind] = Object.keys(item);
					if (!kind?.startsWith("continuationItem")) continue;
					for (const node of walk(item)) {
						const token = node.continuationCommand?.token;
						if (token) return token;
					}
				}
			}
		}
		return null;
	}

	// Yields the comment texts page by page so the buttons can show up as soon
	// as the first page arrives.
	async function* fetchCommentPages(videoId) {
		let token = findCommentsToken(await innertubeNext({ videoId }));
		for (let page = 0; token && page < MAX_COMMENT_PAGES; page++) {
			const json = await innertubeNext({ continuation: token });
			yield commentTexts(json);
			token = findNextPageToken(json);
		}
	}

	function reportProblem(title, err) {
		// Some errors, such as Firefox's fetch failures, carry no stack, so the
		// place that reports the problem is used instead.
		const at =
			err?.stack?.match(SOURCE_LOCATION_RE)?.[1] ??
			new Error().stack?.match(SOURCE_LOCATION_RE)?.[1] ??
			"youtube-auto-speed.user.js";
		console.warn({
			type: "about:blank",
			title,
			detail: `${at}: ${err?.message ?? err}`,
		});
	}

	function seekTo(seconds) {
		const player = document.getElementById("movie_player");
		if (typeof player?.seekTo === "function") {
			player.seekTo(seconds, true);
			return;
		}
		const v = document.querySelector("ytd-player video.video-stream, video");
		if (v) v.currentTime = seconds;
	}

	function streamStart(entries) {
		let start = null;
		for (const entry of entries) {
			if (!START_TITLE_RE.test(entry.title)) continue;
			if (start == null || entry.seconds < start.seconds) start = entry;
		}
		return start;
	}

	// Jumps once per load. It stays put when the URL asks for a position
	// (&t=) or the video is already past the start, e.g. when resuming.
	function autoSeekToStart(entries) {
		const start = streamStart(entries);
		if (!start) return false;
		if (new URLSearchParams(location.search).has("t")) return true;
		const video = mainVideo();
		if (!video) return false;
		if (video.currentTime < start.seconds) seekTo(start.seconds);
		return true;
	}

	function setTimestamps(entries) {
		timestampEntries = entries;
		renderTimestamps();
	}

	function renderTimestamps() {
		const btn = document.getElementById(TIMESTAMPS_BTN_ID);
		const panel = document.getElementById(TIMESTAMPS_PANEL_ID);
		if (!btn || !panel) return;

		// Keep the list open while later pages refine it.
		if (timestampEntries.length === 0) panel.hidden = true;
		panel.replaceChildren(
			...timestampEntries.map((entry) => {
				const row = document.createElement("button");
				// The time is faint so the titles stand out.
				const time = document.createElement("span");
				time.className = TIME_CLASS;
				time.textContent = entry.time;
				row.append(time);
				if (entry.title) row.append(` ${entry.title}`);
				row.onclick = () => {
					seekTo(entry.seconds);
					panel.hidden = true;
				};
				return row;
			}),
		);
		btn.hidden = timestampEntries.length === 0;
	}

	async function loadTimestamps() {
		const videoId = location.pathname === "/watch" ? getVideoId() : null;
		if (videoId === timestampsVideoId) return;
		timestampsVideoId = videoId;
		const request = ++timestampsRequest;
		setTimestamps([]);
		if (!videoId) return;

		try {
			const texts = [];
			let seekDone = false;
			for await (const pageTexts of fetchCommentPages(videoId)) {
				// Stop if another load started, even for the same video after
				// navigating away and back.
				if (request !== timestampsRequest) return;
				texts.push(...pageTexts);
				const entries = pickTimestamps(texts);
				setTimestamps(entries);
				if (!seekDone) seekDone = autoSeekToStart(entries);
			}
		} catch (err) {
			if (request !== timestampsRequest) return;
			// Forget the video so the next navigation event tries again.
			timestampsVideoId = null;
			reportProblem("Failed to load timestamps", err);
		}
	}

	// YouTube resets the rate when it loads a video, so changes right after the
	// script sets a rate are undone. Later changes on the main video come from
	// the user, e.g. YouTube's speed menu, even while paused or live.
	function onRateChange(e) {
		const video = e.target;
		if (Math.abs(video.playbackRate - currentRate) <= 0.001) return;
		if (autoPending || Date.now() < enforceUntil) {
			video.playbackRate = currentRate;
			return;
		}
		if (video !== mainVideo()) return;
		manualOverride = true;
		currentRate = video.playbackRate;
		updateButtonStates(currentRate);
	}

	function hookVideo(video) {
		if (hooked.has(video)) return;
		hooked.add(video);
		video.playbackRate = currentRate;
		video.addEventListener("ratechange", onRateChange);
		const onMeta = () => autoSetSpeed();
		video.addEventListener("loadedmetadata", onMeta);
		video.addEventListener("durationchange", onMeta);
	}

	function observePage() {
		if (observer) return;
		observer = new MutationObserver((mutations) => {
			for (const m of mutations) {
				for (const node of m.addedNodes) {
					if (node.nodeName === "VIDEO") hookVideo(node);
					else if (node.querySelectorAll) {
						for (const v of node.querySelectorAll("video")) hookVideo(v);
					}
				}
			}
			// The masthead can be rendered, or re-rendered, after init.
			if (!document.getElementById(CONTAINER_ID)) createButtons();
		});
		observer.observe(document.documentElement, {
			childList: true,
			subtree: true,
		});
	}

	function init() {
		injectStyle();
		createButtons();
		observePage();

		for (const v of document.querySelectorAll("video")) hookVideo(v);

		autoSetSpeed();

		document.addEventListener(
			"play",
			(e) => {
				if (e.target instanceof HTMLVideoElement) hookVideo(e.target);
				syncVideosFromCurrentRate();
			},
			true,
		);

		document.addEventListener("click", (e) => {
			const panel = document.getElementById(TIMESTAMPS_PANEL_ID);
			if (!panel || panel.hidden) return;
			if (panel.contains(e.target)) return;
			if (document.getElementById(TIMESTAMPS_BTN_ID)?.contains(e.target))
				return;
			panel.hidden = true;
		});

		loadTimestamps();

		window.addEventListener("yt-navigate-finish", () => {
			createButtons();
			autoSetSpeed();
			loadTimestamps();
		});
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
})();
