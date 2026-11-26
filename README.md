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

1. Drop files or a folder onto the top area (or click it).
2. Drag to change the order in the list or on the timeline; `×` removes a clip.
3. Choose format, resolution, frame rate, quality and output folder, then press **Merge Videos**.

Quality **Original** joins without re-encoding. It is available when the clips have the same
parameters and resolution and frame rate are set to Keep Original. Existing files are never overwritten.

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
