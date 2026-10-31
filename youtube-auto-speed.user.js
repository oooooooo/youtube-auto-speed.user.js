// ==UserScript==
// @name         YouTube Auto Speed
// @namespace    https://github.com/oooooooo/youtube-auto-speed
// @version      1.1.0
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

	let defaultRate = loadDefaultRate();
	let currentRate = defaultRate;
	let manualOverride = false;
	let enforceUntil = 0;
	let lastVideoId = null;
	let observer = null;
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

	function durationSecondsTrusted() {
		const v = document.querySelector("ytd-player video.video-stream, video");
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

	function isTitleSlow() {
		const title = getWatchTitle();
		if (!title) return false;
		const lower = title.toLowerCase();
		if (KEYWORDS.some((k) => lower.includes(k.toLowerCase()))) return true;
		return MV_RE.test(title);
	}

	function getVideoId() {
		const params = new URLSearchParams(location.search);
		return params.get("v") || location.pathname;
	}

	function computeAutoRate() {
		if (isShorts()) return defaultRate;

		const titleSlow = isTitleSlow();
		const sec = durationSecondsTrusted();

		if (titleSlow) return RATE_SLOW;
		if (sec != null && sec <= MAX_SLOW_DURATION_SEC) return RATE_SLOW;
		return defaultRate;
	}

	function autoSetSpeed(retryCount = 0) {
		const videoId = getVideoId();
		if (videoId !== lastVideoId) {
			lastVideoId = videoId;
			manualOverride = false;
		}
		if (manualOverride) return;

		const titleSlow = isTitleSlow();
		const titleReadyStrict = TITLE_SELECTORS.slice(0, 3).some((sel) =>
			document.querySelector(sel)?.textContent?.trim(),
		);

		// Always retry up to 15 times: title element may still show the previous
		// video's text at navigation time (titleReadyStrict=true but stale content).
		if (!titleSlow && retryCount < AUTO_RETRY_COUNT) {
			if (!titleReadyStrict) setPlaybackRate(defaultRate, false);
			setTimeout(() => autoSetSpeed(retryCount + 1), AUTO_RETRY_INTERVAL_MS);
			return;
		}

		setPlaybackRate(computeAutoRate(), false);
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
		if (isManual) manualOverride = true;
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

		logo.parentElement.insertBefore(container, logo.nextSibling);
		setPlaybackRate(currentRate, false);
	}

	function hookVideo(video) {
		video.playbackRate = currentRate;
		if (hooked.has(video)) return;
		hooked.add(video);
		const onMeta = () => autoSetSpeed();
		video.addEventListener("loadedmetadata", onMeta);
		video.addEventListener("durationchange", onMeta);
	}

	function observeVideos() {
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
		});
		observer.observe(document.documentElement, {
			childList: true,
			subtree: true,
		});
	}

	function init() {
		injectStyle();
		createButtons();
		observeVideos();

		for (const v of document.querySelectorAll("video")) hookVideo(v);

		autoSetSpeed();

		// YouTube が再生直後に倍速を戻すことがあるため、設定後 2 秒間だけ強制する
		window.setInterval(() => {
			const now = Date.now();
			for (const v of document.querySelectorAll("video")) {
				if (!Number.isFinite(v.duration) || v.paused || v.ended) continue;
				if (Math.abs(v.playbackRate - currentRate) > 0.001) {
					if (now < enforceUntil) {
						v.playbackRate = currentRate;
					} else {
						// 強制期間外はユーザーの変更として受け入れる
						manualOverride = true;
						currentRate = v.playbackRate;
						updateButtonStates(currentRate);
					}
				}
			}
		}, 450);

		document.addEventListener(
			"play",
			(e) => {
				if (e.target instanceof HTMLVideoElement) hookVideo(e.target);
				syncVideosFromCurrentRate();
			},
			true,
		);

		window.addEventListener("yt-navigate-finish", () => {
			createButtons();
			autoSetSpeed();
		});
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
})();
