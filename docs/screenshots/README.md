# Screenshots

The demo page (`docs/index.html`) looks for these four files. Drop yours in with
these exact names and they appear — no code change. Any that are missing are
skipped: the figure removes itself, and if all four are missing the page shows a
short placeholder instead. So it is correct before and after you add them.

| File | What it shows now |
| --- | --- |
| `blocks.png` | An idea open in the editor: a heading, a bulleted list, a numbered list and a quote. |
| `markdown.png` | The note that describes the app, open in the editor. |
| `sidebar.png` | The sidebar, listing the ideas. A crop is fine. |
| `theme.png` | The theme menu open, showing appearance and accent. |

Guidelines:

- **Window only, please.** A full-screen grab would publish the panel, the
  wallpaper and whatever else was on screen. Raise the app first, because `grim`
  captures the screen — an overlapping window is what ends up in the file. This
  targets the app by class, so it works even when it is not the focused window:

  ```sh
  hyprctl dispatch focuswindow class:sketchback
  grim -g "$(hyprctl clients -j \
    | jq -r '.[] | select(.class=="sketchback") | "\(.at[0]),\(.at[1]) \(.size[0]),\(.size[1])"')" \
    docs/screenshots/blocks.png
  ```

  `slurp` is installed too, if you would rather drag the region by hand:
  `grim -g "$(slurp)" docs/screenshots/sidebar.png`.
- Width around 1300px+ reads well in the two-column grid; the page scales images
  down, so larger is fine. Crops are welcome — the grid caps both width and
  height, so a tall narrow crop (like the current `sidebar.png`, 241×598) sits
  in its cell instead of stretching the row.
- PNG is fine, but if the file gets large, JPEGs at quality ~85 are smaller and
  indistinguishable at this size. Keep any single file under ~500 KB.
- Light theme is the shipped default, so light screenshots match the page's own
  default look. Dark ones are welcome too, but the page won't switch for them.
- Alt text and captions live in `docs/index.html`. **A caption must describe the
  frame it sits under.** If you swap an image for one showing something else, fix
  the `<figcaption>` and `alt` in the same commit — the gallery's honesty rule is
  the only thing it has.
