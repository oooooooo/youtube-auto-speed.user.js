# YouTube Auto Speed

A userscript that plays YouTube videos at 3.0x, except for music at 1.0x.

## Music Detection

A video is considered music if it meets **any** of the following criteria:

1. **Title contains one of these keywords:**
   - MV
   - カラオケ / karaoke
   - 歌ってみた
   - 歌枠

2. **Duration is 6 minutes or less**
   - Exception: YouTube Shorts are always played at the default speed

## Default Speed

Right-click a speed button to make its speed the default.
The default is remembered across visits and its button is underlined.

## Timestamps

When one of the top 100 or so comments has three or more lines with a
timestamp, a `TIMESTAMPS` button appears.
The timestamp can be at the start of the line (`00:22:32 Song / Artist`)
or in a tab-separated column (`1  Song  Artist  0:10:21`).
Lines at `0:00` are ignored because they usually mark the waiting screen.
Lines with a date (`5/20(水) 18:00`, `2026/6/11`, `6月17日`) are ignored
because their times are clock times, such as in pasted news headlines.
The comment with the most timestamps is used.
Its lines are sorted by time, and a line repeated with the same time and
title (e.g. in a summary before the full list) is shown once.

The earliest comment that is only a timestamp (e.g. `0:17`) is added as
`0:17 START` at the top of the list, unless the list already has an earlier
line. The button also appears when there is only such a comment.

When the list has a start line (a title with `START`, `開始` or `スタート`),
the video jumps there automatically once, unless the URL has a start
position (`&t=`) or the video is already past it.

The comments are fetched from YouTube's internal API,
so this feature may stop working if YouTube changes it.

## Installation

Install
[youtube-auto-speed.user.js](https://github.com/oooooooo/youtube-auto-speed/raw/main/youtube-auto-speed.user.js)
with a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/).

## License

MIT
