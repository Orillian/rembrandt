# What's changed since the HN post

When I posted Rembrandt on Hacker News, the most common complaint was speed, especially on Macs.
Opening a RAW was slow, sliders felt heavy, and the AI tools were slow when they ran at all. Most of
the work since then has gone into that. This page covers what changed, what's still rough, and what
I'd like to hear from you.

The current version is on the [releases page](https://github.com/thesnarkitecht/rembrandt/releases/latest).
The app updates itself from the button in Settings.

## Faster

- **RAW files are developed natively.** The desktop app used to run LibRaw as WebAssembly inside
  the web view. It now runs natively, split across CPU cores, with the same output.
- **Opening a photo you've already opened is quick.** Developed RAWs are kept on disk (up to 16 GB),
  so a second open skips the develop step. New imports are developed in the background while you
  aren't editing, so most photos are ready before you click on them.
- **The first look at a RAW comes sooner.** It shows the camera's built-in JPEG at screen size while
  the real develop runs.
- **Sliders are smoother.** While you drag, the expensive steps (noise reduction, fitting colours to
  the screen) run a cheaper version, and the exact result comes back when you let go. The histogram
  no longer updates mid-drag, which was causing most of the stutters.
- **Generative Remove is faster on Apple silicon Macs.** It runs natively through Core ML instead of a
  single WebAssembly thread, and the model loads when you open the Remove tool rather than on the
  first fill. Other systems still use the web version.

Something I learned along the way: with macOS Low Power Mode on, the system caps the app at 30
frames a second (anything built on Safari's engine gets the same cap). With it off, slider drags
run at 60.

## New

- **Tethered shooting** on macOS and Linux. Plug the camera in over USB and press F12 or the
  shutter. Each photo opens as it lands, with the previous photo's edit or a preset. I've only
  tested it with a few cameras, so tell me if yours doesn't work.
- **Point Color**: pick a colour in the photo and shift just that colour.
- **Snapshots**: named versions of an edit you can go back to.
- **Export presets**: built-in ones for Instagram, web and print, plus your own.
- **Content Credentials**: an optional signed record of the edits inside the exported file, with
  generative edits marked. The key is made on your machine, so verifiers show the record as intact
  but don't recognise the signer.
- **Typed and spoken edits understand more**: "sharpness +40 and masking +70" sets both, and the
  sub-sliders (masking, radius, feather, grain size and so on) work.
- **Opening photos from other apps** (Open With, Photo Mechanic's "Edit in…") goes straight to the
  editor.

## Still rough

- Windows and Intel Macs don't get the native Generative Remove yet, and Windows has no tethering.
- AI masking works, but refining a mask is awkward. That's next.
- Without a dedicated GPU some AI tools are slow, and some may refuse to run. I fixed one case on
  Intel graphics, but there may be others.
- On Linux, the installer could stop when it couldn't write the app icon. That's fixed: it now
  carries on, and falls back to the AppImage if the system package fails.

## What I'd like from you

Honest feedback, including "this is worse than X because Y". In particular:

- How long does it take to open a RAW from your camera, and which camera is it?
- Do the sliders keep up on your machine? If not, press Ctrl/Cmd + Alt/Option + Shift + P to copy a
  performance report and paste it into an issue. Nothing is sent anywhere unless you do that.
- Does tethering work with your camera?
- What's the one thing that stops you from using Rembrandt instead of what you use now?

Open an [issue](https://github.com/thesnarkitecht/rembrandt/issues/new) for any of these. Short ones
are fine.

Rembrandt is free and open source (GPL), with no account and no tracking.
