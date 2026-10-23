---
name: image
description: Raster image processing with libvips. Use when converting images to AVIF/WebP/JPEG, resizing or cropping, generating thumbnails, or batch-optimising images for the web.
---

The container has the libvips CLI (`vips`, `vipsthumbnail`, `vipsheader`), version 8.14. There is no ImageMagick and no `pyvips`. Use the CLI.

## Options and formats

Save options go in brackets after the output filename, and the suffix picks the format: `out.avif[Q=50,strip]`. Quote the filename in the shell. To list a saver's options, run `vips heifsave`, `vips webpsave` or `vips jpegsave` with no arguments.

| Target | Command | Notes |
|---|---|---|
| AVIF | `vips copy in.png 'out.avif[Q=50,effort=4]'` | Q 45–60 suits photos. `effort` (0–9) costs CPU time: effort 4 on a 4 MP image takes about 3 s, effort 2 about 0.5 s. |
| WebP | `vips copy in.png 'out.webp[Q=80]'` | Use `[lossless]` for UI art or screenshots, `preset=drawing` for flat colour. |
| JPEG | `vips copy in.png 'out.jpg[Q=85,strip]'` | |

Loaders also cover PNG, GIF, TIFF, HEIC, JXL, SVG and PDF. For PDFs and animations, pick a page or frame with `in.pdf[page=0,dpi=150]`.

## Resizing

- Use `vips thumbnail in.jpg 'out.webp[Q=80]' 800`. The number is the target width. Add `--height 600` to bound both sides, `--crop attention` to fill the box exactly, and `--size down` so smaller images are never upscaled.
- `thumbnail` applies the EXIF orientation. `copy` does not, so camera photos come out sideways. For a format conversion without resizing, run `vips autorot in.jpg rotated.v` first, then `vips copy rotated.v 'out.avif[Q=50]'`.
- `strip` drops EXIF and GPS data. Use it for anything you publish.

## Batches

To process many files, use `vipsthumbnail -s 1200x -o '%s.avif[Q=50,strip]' *.jpg`. In the `-o` pattern, `%s` is the input file's base name, and a relative output path is resolved against **each input's directory**, not the working directory. For a separate output directory, give an absolute path such as `-o '/abs/out/%s.webp[Q=80]'`.

After a batch, check one result with `vipsheader -a out.avif` and compare file sizes with `ls -l`. A result larger than its source means Q is too high or lossless is on.
