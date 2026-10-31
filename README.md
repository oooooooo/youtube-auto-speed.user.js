# YouTube Auto Speed

A userscript that automatically plays YouTube videos at high speed, except for music.

## Features

- **Fast playback (3.0x by default)** for regular videos
- **Normal playback (1.0x)** for music content
- **Manual override buttons** in the YouTube header for quick speed adjustment
- **Setlist button** that lists the timestamps from a setlist comment

## How It Works

### Speed Selection

| Content Type   | Speed                |
| -------------- | -------------------- |
| Regular videos | Default speed (3.0x) |
| YouTube Shorts | Default speed (3.0x) |
| Music          | 1.0x                 |

### Music Detection

A video is considered music if it meets **any** of the following criteria:

1. **Title contains music-related keywords:**
   - MV
   - カラオケ / karaoke
   - 歌ってみた
   - 歌枠

2. **Duration is 6 minutes or less**
   - Short videos are often music content
   - Exception: YouTube Shorts are always played at the default speed

### Manual Override

Since automatic detection isn't perfect, speed buttons
(`x1.0`, `x2.5`, `x3.0` and `x3.5`) are displayed next to the YouTube logo
in the top-left corner of the page.
Click them to manually adjust the playback speed when needed.

Right-click a button to make its speed the default.
The default is remembered across visits and its button is underlined.

### Setlist

When a top comment has three or more lines starting with a timestamp
(e.g. `00:22:32 都落ち / ヨルシカ`), a `SET LIST` button appears next to the
speed buttons. The comment with the most timestamps is used.
Click the button to open the list, and click a line to jump to that time
and close the list.

The comments are fetched from YouTube's internal API,
so this feature may stop working if YouTube changes it.

## Installation

1. Install a userscript manager (e.g., [Tampermonkey](https://www.tampermonkey.net/))
2. Click on
   [youtube-auto-speed.user.js](https://github.com/oooooooo/youtube-auto-speed/raw/main/youtube-auto-speed.user.js)
   or create a new script and paste the code
3. Save and enjoy!

## License

MIT
