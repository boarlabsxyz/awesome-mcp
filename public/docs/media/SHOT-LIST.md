# Docs screencasts — shot list

Every entry here corresponds to one `docs-media--pending` placeholder in the docs pages.
Find them with:

    grep -rn "docs-media--pending" public/docs/

## Recording settings

- 1280×720, browser window only (no desktop, no bookmarks bar, no notifications).
- Sign in as a throwaway account. **Nothing in frame may show a real MCP URL, API key or
  token** — those are credentials. Blur or use a fake value if one is unavoidable.
- Silent. Do not record audio; there is no audio track and the captions say so.
- 15–25 seconds. Move deliberately; pause ~1s on each click target so the viewer can follow.

## Encoding

    ffmpeg -i raw.mov -vf "fps=15,scale=1280:-2" -c:v libx264 -profile:v high \
      -crf 25 -pix_fmt yuv420p -an -movflags +faststart out.mp4

    ffmpeg -i out.mp4 -vframes 1 -q:v 4 out.jpg     # poster, first frame

Budget: ≤2 MB per clip, ≤25 MB for this directory in total. Check with `du -sh public/docs/media`.

## Swapping a placeholder for a real clip

Replace the `<figure class="docs-media docs-media--pending">` block with the `<video>` form
already documented in the plan. The placeholder reserves a 16:9 box, so the layout does not
move. Keep the `figcaption`, and keep it stating the duration and that the clip is silent —
that sentence is the accessibility substitute for having no audio.

Re-recording? Ship the same filename. Nothing caches these aggressively, and a new name means
editing every page that references it.

---

## 1. `quickstart-connect.mp4` — public/docs/index.html

The whole quickstart in one take.

1. Signed-out `/dashboard`, "Sign in to continue" dialog visible.
2. Click **Sign in with Google**, pick the account (cut the Google consent screen short — it is
   a Google UI, it changes, and it is not ours to document frame by frame).
3. Land on the dashboard, empty state visible.
4. Click **+ Add Your First Tool**, pick **Google Calendar MCP**.
5. Through consent, back to the dashboard with the new row.
6. Click **Copy URL**; hold on the "Copied!" label for a beat, then end.

Caption: "The whole quickstart, end to end. NN seconds, silent."

## 2. `add-tool-modal.mp4` — public/docs/connect-a-connector.html

The Add Tool modal itself, in more detail than clip 1 has room for.

1. Dashboard with at least one connection already present.
2. Click **+ Add Tool** — hold on the full service list so it is readable.
3. Pick **Outline Wiki MCP** — deliberately a paste-token provider, so the second step is
   visible. Clip 1 already covers the OAuth path.
4. Show the URL field and the API-key field with the hint copy beneath them.
5. Type a fake wiki URL and a fake key. End before submitting.

Caption: "Adding a connector from the dashboard. NN seconds, silent."

## 3. `add-to-claude.mp4` — public/docs/add-to-claude.html

1. Start on the dashboard with the **Copy URL** button just clicked ("Copied!" showing).
2. Switch to Claude.ai → **Settings → Connectors**.
3. **Add custom connector**, paste, save.
4. New chat, ask "What's on my calendar tomorrow?", show a real answer coming back.

The pasted URL will be on screen — use a throwaway account and blur the `apiKey` value, or
overwrite it in post.

Caption: "Pasting the MCP URL into Claude.ai's connector settings. NN seconds, silent."
