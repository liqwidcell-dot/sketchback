# Screenshots

The demo page (`docs/index.html`) looks for these four files. Drop yours in with
these exact names and they appear — no code change. Any that are missing are
skipped: the figure removes itself, and if all four are missing the page shows a
short placeholder instead. So it is correct before and after you add them.

| File | What it should show |
| --- | --- |
| `idea-list.png` | The sidebar listing ideas, with one idea open. |
| `text-block.png` | Text blocks being edited, ideally showing a markdown shortcut or the block menu. |
| `command-palette.png` | The palette open on `Ctrl+K`, listing markdown commands. |
| `export.png` | The export notice reporting the written folder and file count. |

Guidelines:

- **Window only, please.** A full-screen grab would publish the panel, the
  wallpaper and whatever else was on screen. Raise the app first, because `grim`
  captures the screen — an overlapping window is what ends up in the file. This
  targets the app by class, so it works even when it is not the focused window:

  ```sh
  hyprctl dispatch focuswindow class:sketchback
  grim -g "$(hyprctl clients -j \
    | jq -r '.[] | select(.class=="sketchback") | "\(.at[0]),\(.at[1]) \(.size[0]),\(.size[1])"')" \
    docs/screenshots/idea-list.png
  ```

  `slurp` is installed too, if you would rather drag the region by hand:
  `grim -g "$(slurp)" docs/screenshots/idea-list.png`.
- Width around 1300px+ reads well in the two-column grid; the page scales images
  down, so larger is fine.
- PNG is fine, but if the file gets large, JPEGs at quality ~85 are smaller and
  indistinguishable at this size. Keep any single file under ~500 KB.
- Light theme is the shipped default, so light screenshots match the page's own
  default look. Dark ones are welcome too, but the page won't switch for them.
- Alt text and captions live in `docs/index.html`. If you add an image with a
  different name, add its `<figure>` block there and write a real `alt`.
