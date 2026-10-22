#!/usr/bin/env python3
"""Slice a large GeoJSON export down to Inner London.

The raw OpenStreetMap / OS-Vector-Tile exports for Greater London are far too
big for GitHub (the current one is ~97 MB). This tool keeps only the features
that intersect the Inner London bounding box, rewrites their coordinates into
a compact form, and emits a small standard GeoJSON that can be committed.

Usage:
    python3 tools/slice-london.py \
        --in tools/data/london.geojson \
        --out tools/data/london_inner.slice.geojson

    # custom bbox (minlon,minlat,maxlon,maxlat)
    python3 tools/slice-london.py --in big.geojson --out slice.geojson \
        --bbox -0.30,51.44,0.06,51.60

Notes:
    * Input may be a FeatureCollection, a bare list of features, or a
      newline-delimited GeoJSON stream (one feature per line).
    * Geometry kinds handled: Point, MultiPoint, LineString, MultiLineString,
      Polygon, MultiPolygon, GeometryCollection. Unknown/other types pass
      through if their centroid falls inside the bbox.
    * Coordinates are rounded to 6 decimals (~0.1 m) to shrink output size.
    * Rings/polygons are kept if ANY vertex falls inside the bbox; boundary
      clipping is intentionally not performed (the bake step tolerates
      overhanging edges).
    * Properties are stripped down to the handful of OSM tags the Three.js
      bake actually consumes (building type, height/levels, name, highway
      class, width, surface, ...). Raw exports carry dozens of useless tags
      (@id, timestamp, changeset, import artefacts); dropping them plus
      compact JSON encoding typically shrinks the slice well under 50 MB.
      Use --no-strip-properties to keep every tag.
"""

import argparse
import json
import re
import sys

# Default: Inner London (Zone 1-2 core), lon/lat WGS84.
DEFAULT_BBOX = (-0.24, 51.46, 0.02, 51.56)

NDigits = 6

# ---------------------------------------------------------------------------
# Property whitelist: the only OSM tags the Three.js bake reads.
# ---------------------------------------------------------------------------

# Exact-match keys kept for any feature with a geometry we care about.
KEEP_KEYS = {
    # identity / classification
    "name", "layer",
    # buildings
    "building", "building:levels", "height", "min_height", "roof:shape",
    # land use / green space
    "landuse", "leisure", "amenity", "shop", "natural", "man_made",
    "historic", "railway", "waterway", "water", "boundary", "place",
    # roads / paths
    "highway", "cycleway", "oneway", "junction",
    # physical attributes used for extrusion widths and materials
    "width", "maxwidth", "est_width", "surface", "bridge", "tunnel",
}

# Prefix matches (namespaced tags): building:*, amenity:*, historic:*, ...
KEEP_PREFIXES = ("building:", "amenity:", "shop:", "leisure:", "historic:")

# Drop these exact keys even if they'd otherwise match (OSM/import metadata).
DROP_KEYS = {
    "id", "@id", "type", "version", "timestamp", "changeset", "uid", "user",
    "created_by", "converted_by", "source", "source:name", "note",
    "fixme", "todo", "wikipedia", "wikidata", "wiki_commons",
    "operator", "brand", "brand:wikidata", "phone", "email", "website",
    "facebook", "twitter", "opening_hours", "payment_types", "cuisine",
    "diet", "stars", "addr:city", "addr:postcode", "addr:state",
    "addr:country", "is_in", "admin_level",
}

# Drop namespaced junk wholesale.
DROP_PREFIXES = ("addr:", "tax", "ref:", "int_ref", "old_name", "alt_name",
                 "loc_name", "official_name", "short_name", "genus", "species",
                 "leaf_", "tree_", "artwork_", "image", "photo")

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_.:-]*$")


def keep_property(key):
    """True if an OSM tag key should survive into the baked slice."""
    if key in DROP_KEYS:
        return False
    if key.startswith(DROP_PREFIXES):
        return False
    if key in KEEP_KEYS or key.startswith(KEEP_PREFIXES):
        return True
    return False


def strip_properties(props):
    """Return a compact dict containing only whitelisted, non-empty tags."""
    out = {}
    for k, v in props.items():
        if not isinstance(v, str):
            continue                      # skip nested objects/arrays
        if not v or v == "no" or v == "none":
            continue
        if not _NAME_RE.match(k):         # ignore weird/exotic keys
            continue
        if not keep_property(k):
            continue
        if len(v) > 120:                  # sanity cap on absurd values
            continue
        out[k] = v
    return out


def parse_bbox(text):
    try:
        parts = [float(p) for p in text.split(",")]
    except ValueError:
        raise argparse.ArgumentTypeError("bbox must be minlon,minlat,maxlon,maxlat")
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("bbox must have exactly 4 numbers")
    min_lon, min_lat, max_lon, max_lat = parts
    if min_lon >= max_lon or min_lat >= max_lat:
        raise argparse.ArgumentTypeError("bbox min values must be < max values")
    return (min_lon, min_lat, max_lon, max_lat)


def load_geojson(path):
    """Return a list of feature dicts from any of the accepted input shapes."""
    with open(path, "r", encoding="utf-8") as fh:
        head = fh.read(4096)
        fh.seek(0)

        stripped = head.lstrip()
        # A single JSON document is only assumed when the file *starts* with a
        # complete object; newline-delimited GeoJSON also starts with "{".
        if stripped.startswith("{"):
            try:
                data = json.load(fh)
                single_doc = True
            except json.JSONDecodeError:
                single_doc = False
                fh.seek(0)
            if single_doc:
                if isinstance(data, dict):
                    if data.get("type") == "FeatureCollection":
                        return data.get("features", [])
                    if data.get("type") == "Feature":
                        return [data]
                    # Some exports wrap in {"elements": [...]} (Overpass JSON).
                    if isinstance(data.get("elements"), list):
                        return overpass_to_features(data["elements"])
                elif isinstance(data, list):
                    return data
                raise ValueError("unrecognised top-level JSON shape")

        # Newline-delimited GeoJSON fallback (one feature per line).
        features = []
        for i, line in enumerate(fh):
            line = line.strip().rstrip(",")
            if not line or line in ("[", "]"):
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                print(f"warning: skipping unparseable line {i + 1}: {exc}",
                      file=sys.stderr)
                continue
            if isinstance(obj, dict) and obj.get("type") == "Feature":
                features.append(obj)
            elif isinstance(obj, dict) and obj.get("geometry"):
                features.append({"type": "Feature",
                                 "properties": obj.get("properties", {}),
                                 "geometry": obj["geometry"]})
        return features


def overpass_to_features(elements):
    """Minimal Overpass-JSON -> GeoJSON conversion (nodes + ways with tags)."""
    nodes = {e["id"]: e for e in elements if e.get("type") == "node"}
    features = []
    for e in elements:
        tags = e.get("tags", {})
        if e.get("type") == "node" and tags:
            features.append({
                "type": "Feature", "properties": tags,
                "geometry": {"type": "Point",
                             "coordinates": [e["lon"], e["lat"]]},
            })
        elif e.get("type") == "way" and tags:
            coords = [[nodes[n]["lon"], nodes[n]["lat"]]
                      for n in e.get("nodes", []) if n in nodes]
            if len(coords) < 2:
                continue
            closed = e["nodes"][0] == e["nodes"][-1]
            if closed and len(coords) >= 4:
                geom = {"type": "Polygon", "coordinates": [coords]}
            else:
                geom = {"type": "LineString", "coordinates": coords}
            features.append({"type": "Feature", "properties": tags,
                             "geometry": geom})
    return features


def round_coord(c):
    return [round(float(c[0]), NDigits), round(float(c[1]), NDigits)]


def point_in_bbox(xy, bbox):
    min_lon, min_lat, max_lon, max_lat = bbox
    return min_lon <= xy[0] <= max_lon and min_lat <= xy[1] <= max_lat


def coords_any_in(obj, bbox):
    """Recursively check nested coordinate lists for any point inside bbox."""
    if not obj:
        return False
    if isinstance(obj[0], (int, float)):
        return point_in_bbox(obj, bbox)
    return any(coords_any_in(part, bbox) for part in obj)


def filter_geometry(geom, bbox):
    """Return (kept: bool, new_geom or None)."""
    if not geom:
        return False, None
    gtype = geom.get("type")
    coords = geom.get("coordinates")

    if gtype in ("Point",):
        c = round_coord(coords)
        return point_in_bbox(c, bbox), ({"type": gtype, "coordinates": c}
                                        if point_in_bbox(c, bbox) else None)

    if gtype in ("LineString",):
        if not coords_any_in(coords, bbox):
            return False, None
        return True, {"type": gtype,
                      "coordinates": [round_coord(c) for c in coords]}

    if gtype in ("MultiLineString", "Polygon"):
        if not coords_any_in(coords, bbox):
            return False, None
        return True, {"type": gtype,
                      "coordinates": [[round_coord(c) for c in part]
                                      for part in coords]}

    if gtype == "MultiPolygon":
        if not coords_any_in(coords, bbox):
            return False, None
        return True, {"type": gtype,
                      "coordinates": [[[round_coord(c) for c in ring]
                                       for ring in poly] for poly in coords]}

    if gtype == "GeometryCollection":
        kept = []
        for sub in geom.get("geometries", []):
            ok, new_sub = filter_geometry(sub, bbox)
            if ok:
                kept.append(new_sub)
        if not kept:
            return False, None
        return True, {"type": "GeometryCollection", "geometries": kept}

    # Unknown geometry type: keep it (caller can decide downstream).
    return True, geom


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--in", dest="infile", required=True,
                    help="path to the large source GeoJSON")
    ap.add_argument("--out", dest="outfile", required=True,
                    help="path for the sliced output GeoJSON")
    ap.add_argument("--bbox", type=parse_bbox, default=DEFAULT_BBOX,
                    help="minlon,minlat,maxlon,maxlat "
                         f"(default: {','.join(map(str, DEFAULT_BBOX))})")
    ap.add_argument("--no-strip-properties", dest="strip_props",
                    action="store_false", default=True,
                    help="keep every input property (default: strip to the "
                         "tags the Three.js bake actually uses)")
    args = ap.parse_args(argv)

    print(f"loading {args.infile} ...", file=sys.stderr)
    features = load_geojson(args.infile)
    print(f"{len(features)} features loaded; slicing to bbox {args.bbox}"
          + ("" if args.strip_props else "; keeping all properties"),
          file=sys.stderr)

    kept = []
    skipped_bad = 0
    dropped_keys = 0
    for feat in features:
        geom = feat.get("geometry")
        if geom is None:
            skipped_bad += 1
            continue
        ok, new_geom = filter_geometry(geom, args.bbox)
        if ok:
            props = feat.get("properties") or {}
            if args.strip_props:
                stripped = strip_properties(props)
                dropped_keys += len(props) - len(stripped)
                props = stripped
            out_feat = {"type": "Feature",
                        "properties": props,
                        "geometry": new_geom}
            if feat.get("id") is not None:
                out_feat["id"] = feat["id"]
            kept.append(out_feat)

    collection = {"type": "FeatureCollection",
                  "name": "london_inner",
                  "bbox": list(args.bbox),
                  "features": kept}

    with open(args.outfile, "w", encoding="utf-8") as fh:
        json.dump(collection, fh, ensure_ascii=False, separators=(",", ":"))

    import os
    size_mb = os.path.getsize(args.outfile) / (1024 * 1024)
    print(f"wrote {len(kept)} features ({skipped_bad} without geometry, "
          f"{dropped_keys} non-essential properties dropped) "
          f"-> {args.outfile} [{size_mb:.2f} MB]", file=sys.stderr)
    if size_mb > 45:
        print("WARNING: output still exceeds GitHub's comfortable 50 MB "
              "limit; consider a tighter bbox.",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
