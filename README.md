# One-Click Save Image

A Brave / Chrome / Firefox extension (Manifest V3). Right-click → **One-click save image**, or
press your shortcut key (configurable) while the mouse is over an image, and the image is saved straight to your
folder — no ask dialog (configurable), highest resolution available, even on sites that block "Save image as…".

notice: on Windows, Chrome-based browsers refuse to install a .crx that didn’t come from the Chrome Web Store. Thus no .crx file for now. 


## Install — Brave / Chrome / Edge

1. Open `brave://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder (or `dist\chrome`).
4. Click the extension's toolbar icon to open the settings.

After editing any file here, press the reload ↻ button on the extension's card.

## Install — Firefox (128 or newer)


1. Download **one-click-save-image-firefox-v1.1-signed.xpi** 
2. Open it in Firefox: drag the file into a Firefox window, or open `about:addons` → ⚙️ → **Install Add-on From File…** and pick it.
3. Click **Add** when Firefox asks, then **Okay**.
4. Click the extension's toolbar icon (or `about:addons` → One-Click Save Image → **Options**) to set your shortcut and save folder.

Notes for Firefox:

- Images save to your Downloads folder, into the subfolder set in the extension's options. To save
  somewhere else, change Firefox's **Settings → General → Downloads → Save files to**.
- If the options page shows **Allow on all websites**, click it — the extension can't find images without site access.


## Settings

| Setting | What it does |
|---|---|
| Keyboard shortcut | Modifier dropdown (Ctrl / Alt / Shift and combinations) + any key. Default **Alt+Shift+S**. Same as clicking the menu item. |
| A folder I choose | **Browse…** to any folder; images are written there directly. |
| A subfolder of my Downloads folder | Saves through the browser's download manager into `Downloads/<subfolder>`. |
| Find the highest-resolution version | Tries linked images, `srcset`, lazy-load attributes and full-size CDN URLs; keeps the largest. |
| Stop sites from blocking the right-click menu | Over images only, so custom menus elsewhere on a page keep working. |
| Show a "Saved" message | Small toast in the bottom-right corner. Errors are always shown. |

"A folder I choose" is Brave / Chrome only; in Firefox only the Downloads option is available.

### Brave: folder picker

Brave ships with the folder picker (File System Access API) turned off. If the settings page says
it's unavailable, open `brave://flags/#file-system-access-api`, set it to **Enabled**, and restart
Brave. Until then use the Downloads option.

The browser sometimes asks again for permission to the folder (for example after a restart). A
small popup appears; choose **Allow on every visit** if offered. The image waits until you answer,
or goes to Downloads if you choose that instead.

Files saved to "A folder I choose" don't appear in the browser's download list — they're written
to disk directly, not downloaded.

## How it picks the image

1. Every element under the cursor is checked, top to bottom, including inside shadow DOM — so
   transparent overlays and 1×1 spacer images are skipped. `<img>`, `<picture>`, CSS backgrounds
   (also `::before`/`::after`), `<video>` frames/posters, `<canvas>` and SVG `<image>` all count.
2. Candidates: an image file the picture links to, the largest `srcset` / `<picture>` source,
   full-size attributes (`data-full`, `data-original`, `data-zoom-image`, …), the displayed file,
   and full-size guesses for known sites (X/Twitter, Pinterest, Reddit, Imgur, Wikimedia,
   Google/Blogger, WordPress, Amazon, Etsy, Flickr, ArtStation, Shopify, `?w=`/`?quality=` params).
3. All candidates are downloaded in parallel. The one with the **most pixels** wins; on a tie, the
   **larger file** (the server's original rather than a recompressed copy).

## How it gets past save-blocking

- Right-click blocking: the extension's listener runs before any page script and stops the page
  from cancelling the menu over images. The shortcut works even where the menu can't.
- Downloads run from the extension with your cookies and the page as Referer, so CORS and
  hotlink protection don't apply.
- If the server still refuses, the image is fetched from inside the page; if that fails too, it's
  cropped out of a screenshot of the visible tab (the toast says so).

## Limits

- Doesn't run on `brave://` / `chrome://` pages, the Web Store, or the built-in PDF viewer.
- Screenshot fallback only for images in the top frame, and only the visible part.
- DRM-protected video frames can't be captured.

## Files

| File | Role |
|---|---|
| `manifest.json` | Manifest for Brave / Chrome / Edge |
| `firefox/manifest.json` | Manifest for Firefox (event-page background, no offscreen, gecko id) |
| `build.ps1` | Builds both packages into `dist\` |
| `sign-firefox.ps1` | Builds, then gets the Firefox package signed by Mozilla (unlisted) |
| `background.js` | Menu, shortcut routing, candidate download + ranking, saving |
| `content.js` | Runs in every page: cursor tracking, image finding, right-click unblocking, toast |
| `offscreen.html/js` | Writes to the chosen folder; makes blob URLs for downloads |
| `options.html/js`, `style.css` | Settings page |
| `grant.html/js` | Popup that re-grants folder access |
| `shared.js`, `defaults.js` | IndexedDB helpers, folder writer, default settings, `EXT` API alias (`browser` in Firefox, `chrome` elsewhere) |
