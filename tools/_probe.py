import json,math
d=json.load(open("tools/data/london_inner.slice.geojson"))
feats=d["features"]
def to_m(c): return (c[0]*111320*math.cos(math.radians(51.5)), c[1]*110574)
def area_ring(r):
    a=0.0
    for i in range(1,len(r)):
        a += r[i-1][0]*r[i][1]-r[i][1-1][0]*r[i][0]
    return abs(a)/2
wat=[f for f in feats if f.get("geometry") and f["geometry"]["type"]=="MultiPolygon" and (f["properties"].get("waterway")=="riverbank" or f["properties"].get("natural")=="water")]
res=[]
for w in wat:
    tot=0.0
    for poly in w["geometry"]["coordinates"]:
        if not poly: continue
        ring=poly[0]
        pts=[to_m(c) for c in ring if isinstance(c,(list,tuple)) and len(c)>=2]
        if len(pts)>2: tot+=area_ring(pts)
    res.append((round(tot), w["properties"].get("name"), w["properties"].get("water")))
res.sort(reverse=True)
print(res[:8])
