import type { Coordinate } from "./types";

// Pure geometry helpers for the roof measurement tool - no React Native/
// PowerSync/Supabase imports, same "pure function" shape as money.ts, so
// these are trivially unit-testable and reusable from anywhere (the
// measurement screen while drawing, and the shopping-list-style summary
// text built at save time).

// WGS84 equatorial radius in metres - the same approximation Google's own
// tools use for small-area work. Roof facets are tens to a few hundred m²,
// vastly smaller than the scale where a true geodesic (ellipsoidal)
// algorithm would meaningfully differ from this - so rather than a full
// Vincenty/Karney-style geodesic library (a real dependency, for a
// difference in the 5th decimal place at this scale), each vertex is
// projected to local planar metres using an equirectangular approximation
// centred on the polygon's own mean latitude, then the standard shoelace
// formula gives the flat area. This is the same approach industry roof/
// solar measurement tools use at building scale - "geodesic" in the
// feature-request sense (accounts for real-world metres, not raw lat/lng
// degrees), not in the strict "ellipsoidal surface" sense.
const EARTH_RADIUS_M = 6378137;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function projectToMeters(coordinate: Coordinate, referenceLatDegrees: number): { x: number; y: number } {
  return {
    x: toRadians(coordinate.lng) * EARTH_RADIUS_M * Math.cos(toRadians(referenceLatDegrees)),
    y: toRadians(coordinate.lat) * EARTH_RADIUS_M,
  };
}

// Flat (plan-view) area of a polygon traced on the ground/satellite image -
// this is the area a facet's outline covers looking straight down, before
// pitch is accounted for. Needs at least 3 points to enclose any area.
export function polygonFlatAreaSqm(coordinates: Coordinate[]): number {
  if (coordinates.length < 3) return 0;
  const referenceLat = coordinates.reduce((sum, c) => sum + c.lat, 0) / coordinates.length;
  const points = coordinates.map((c) => projectToMeters(c, referenceLat));
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i]!;
    const next = points[(i + 1) % points.length]!;
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum) / 2;
}

// A pitched roof's actual surface area is larger than its flat/plan-view
// footprint by a factor of 1/cos(pitch) - a 45° roof has ~1.41x the
// footprint's flat area. Guards against pitch >= 90° (cos <= 0, which
// would divide by zero/go negative) even though the UI bounds pitch to
// 0-60° and should never produce one.
export function trueAreaSqm(flatAreaSqm: number, pitchDegrees: number): number {
  const cosPitch = Math.cos(toRadians(pitchDegrees));
  if (cosPitch <= 0) return flatAreaSqm;
  return flatAreaSqm / cosPitch;
}

// Total length of a drawn run (gutter, fencing, piping) - same
// equirectangular-projection approach as polygonFlatAreaSqm above (one
// shared reference latitude, planar distance between consecutive
// points) rather than a second, different distance algorithm (e.g.
// haversine) - at the scale a straight run on one job site spans, they
// agree to well under a millimetre, and reusing the same projection
// means desktop (which previously called Google's own
// geometry.spherical.computeLength()) and mobile (which has no such
// library available via react-native-maps) produce identical totals for
// identical coordinates, not two independently-rounded numbers.
export function polylineLengthMeters(coordinates: Coordinate[]): number {
  if (coordinates.length < 2) return 0;
  const referenceLat = coordinates.reduce((sum, c) => sum + c.lat, 0) / coordinates.length;
  const points = coordinates.map((c) => projectToMeters(c, referenceLat));
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}
