# mirk logo

Files (all SVG):

| File | Use |
| --- | --- |
| `mirk-mark-light.svg`, `mirk-mark-dark.svg` | The mark alone. Favicon, avatar, small places. |
| `mirk-mark-mono.svg` | The mark in one colour, for print or a single-ink place. |
| `mirk-lockup-light.svg`, `mirk-lockup-dark.svg` | Mark and name together, for a README header. |
| `alternates/` | The other directions that were drawn: pillars, well. |

Light files are for light backgrounds and dark files for dark ones. In a README, a `<picture>` element picks the right one:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo/mirk-lockup-dark.svg">
  <img src="docs/logo/mirk-lockup-light.svg" alt="mirk" height="64">
</picture>
```

Only SVG is kept in git. A PNG at any size comes from `rsvg-convert -w 32 <file>.svg -o <file>.png`.

The README banner (`docs/banner.png`) stays the header. These files add what it lacked: a mark for small places, and light and dark versions. The mark is a shelf of cells seen at an angle, the far ones fading into the dark, one cell lit, in the banner's colours. The wordmark is Figtree (SIL Open Font License), converted to outlines.
