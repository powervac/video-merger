# Video Merger

Join video files into one: drag and drop, arrange on a timeline, export. Windows and macOS.

Home page: https://altcom.cc/video-merger.html

## Windows

Download [VideoMergerPortable.exe](https://altcom.cc/downloads/VideoMergerPortable.exe). Nothing to install.

## macOS: build from source

Paste into Terminal:

```sh
curl -fsSL https://altcom.cc/videomac | bash
```

It runs [build-mac.sh](build-mac.sh), which builds the app on your Mac and puts it into `~/Applications`.
If Node.js is missing, a temporary copy is used and removed afterwards. Run the command again to update.

## How to use

Drag the dividers to resize the preview and the timeline (double-click resets them).

1. Drop files or a folder onto the top area (or click it).
2. Drag to change the order, or sort by date or name.
3. Cut: put the cursor on the timeline and press **Split** (S), then **Delete** the piece you do not need,
   or drag the edges of a clip. Undo with Ctrl+Z (Cmd+Z). Zoom with Ctrl + mouse wheel; arrows step by one frame.
4. If horizontal and vertical videos are mixed, the app warns you. The **Horizontal** / **Vertical** filter
   shows and merges only that kind.
5. Choose format, resolution, frame rate, quality and output folder, then press **Render Video** and give the file a name.

Quality **Original** joins without re-encoding. It is available when the clips have the same parameters and
resolution and frame rate are Keep Original. Cuts then move to the nearest keyframe; with High, Medium or Small
they are frame-exact. Source files are never overwritten; replacing another file asks first.

## FFmpeg

Looked up in this order: `FFMPEG_PATH` / `FFPROBE_PATH`, the system, the npm packages (development only),
the copy downloaded by the app. If there is none, the app downloads it on the first start
([ffmpeg-static b6.1.1](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1), SHA-256 checked).
FFmpeg is a separate program under the GPL.

## Development

Needs Node.js.

```
npm install
npm start
```

On Windows you can double-click `start.bat`. `npm run dist` builds the portable exe into `dist/`.

## Licence

[MIT](LICENSE)
