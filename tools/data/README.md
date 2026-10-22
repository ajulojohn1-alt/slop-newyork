# Geodata

This folder holds all raw and baked geographic data for the simulation.

## Handling large local files (e.g. the 97 MB London GeoJSON)

GitHub's hard file limit is 100 MB and its warning limit is 50 MB, so a single
97 MB export is impractical to push (and impossible once zipped variants or
updates are added). The workflow here keeps big files **local only** and
commits small, sliced outputs instead:

1. Drop your raw export into this folder, e.g.:
   `tools/data/london.geojson` (any of these names work; `.geojson`,
   `.osm.pbf` and `raw/` are git-ignored — see repo root `.gitignore`).
2. Slice it down to Inner London with the slicer:

   ```sh
   python3 tools/slice-london.py \
       --in tools/data/london.geojson \
       --out tools/data/london_inner.slice.geojson
   ```

   The default bounding box covers Inner London (Zone 1–2 core):
   `(-0.24, 51.46) – (0.02, 51.56)` in lon/lat WGS84. Override with
   `--bbox minlon,minlat,maxlon,maxlat` if needed.
3. The slice is written as standard GeoJSON (`*.slice.geojson` is explicitly
   *un-ignored* in `.gitignore`) and is small enough (~1–5 MB depending on
   source density) to commit normally.

If you'd rather track the raw file in Git anyway, use Git LFS:

```sh
git lfs install
git lfs track "tools/data/*.geojson"
```

(Requires the `git-lfs` GitHub app/quota on the remote.)

## Alternative: fetch directly from Overpass

You don't strictly need the 97 MB export at all. `tools/overpass.sh` queries
OpenStreetMap for just the bounding box we care about, mirroring how the NYC
data was baked. See `tools/data/q_*.overpassql` for query examples; London
queries will live in `q_ldn_*.overpassql`.

## Files

| File | Description | Tracked |
| --- | --- | --- |
| `cscl_manhattan.json` | NYC community districts (reference) | yes |
| `dcp_boroughs.json` | NYC boroughs (reference) | yes |
| `nycparks_manhattan.json` | NYC parks (reference) | yes |
| `osm_centralpark.json` | Central Park OSM extract | yes |
| `osm_coastline.json` | Manhattan coastline | yes |
| `osm_landmarks.json` | Landmark buildings | yes |
| `osm_piers.json` | Hudson/East River piers | yes |
| `london.geojson` | **your raw 97 MB export — local only** | no |
| `london_inner.slice.geojson` | Sliced Inner London features | yes |

Data © OpenStreetMap contributors (ODbL).
