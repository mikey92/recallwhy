# US state outlines

`us-states.json`: one SVG path per state for the report's "Where to pull" map (`src/store-map.ts`).
Built by `scripts/build-us-map.ts` from **us-atlas 3.0.1** `states-albers-10m.json`
(https://github.com/topojson/us-atlas, ISC licence, Copyright 2013-2019 Michael Bostock), which is
derived from the US Census Bureau's cartographic boundary files (public domain). Already projected
with `d3.geoAlbersUsa()` (scale 1300, translate [487.5, 305]); points within 1.2 px dropped.

ISC licence: Permission to use, copy, modify, and/or distribute this software for any purpose with
or without fee is hereby granted, provided that the above copyright notice and this permission
notice appear in all copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL
DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
