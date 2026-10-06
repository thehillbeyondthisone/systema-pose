// Capsule intersections use world coordinates, never projected screen overlap.
const clamp = value => Math.max(0, Math.min(1, value));
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const pointAt = (start, delta, fraction) => start.map((value, index) => value + delta[index] * fraction);

export function closestSegmentPoints(startA, endA, startB, endB) {
  const u = subtract(endA, startA), v = subtract(endB, startB), w = subtract(startA, startB);
  const a = dot(u, u), b = dot(u, v), c = dot(v, v), d = dot(u, w), e = dot(v, w);
  let s = 0, t = 0;
  const epsilon = 1e-12;
  if (a <= epsilon) {
    t = c > epsilon ? clamp(e / c) : 0;
  } else if (c <= epsilon) {
    s = clamp(-d / a);
  } else {
    const denominator = a * c - b * b;
    s = denominator > epsilon * a * c ? clamp((b * e - c * d) / denominator) : 0;
    t = (b * s + e) / c;
    if (t < 0) { t = 0; s = clamp(-d / a); }
    else if (t > 1) { t = 1; s = clamp((b - d) / a); }
  }
  const pointA = pointAt(startA, u, s), pointB = pointAt(startB, v, t);
  const difference = subtract(pointA, pointB);
  return {pointA, pointB, distanceSquared: dot(difference, difference)};
}

export function findBoneContacts(people, edges, radius) {
  if (!Number.isFinite(radius) || radius <= 0) return [];
  const contacts = [], limit = (2 * radius) ** 2;
  // Only distinct people: neighboring bones within one skeleton share joints.
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      for (let boneA = 0; boneA < edges.length; boneA++) {
        const [a, b] = edges[boneA];
        for (let boneB = 0; boneB < edges.length; boneB++) {
          const [c, d] = edges[boneB];
          const closest = closestSegmentPoints(people[i].xyz[a], people[i].xyz[b], people[j].xyz[c], people[j].xyz[d]);
          if (closest.distanceSquared <= limit) {
            contacts.push({personA: String(people[i].id), personB: String(people[j].id), boneA, boneB,
              point: closest.pointA.map((value, axis) => (value + closest.pointB[axis]) / 2)});
          }
        }
      }
    }
  }
  return contacts;
}
