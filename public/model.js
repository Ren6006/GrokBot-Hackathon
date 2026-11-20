(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RoadModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const KM_PER_LAT = 110.574;
  const HORIZON_H = 36;
  const BUFFER_KM = 0.8;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function kmPerLon(lat) {
    return 111.32 * Math.cos((lat * Math.PI) / 180);
  }

  function project(lat, lon, origin) {
    return {
      x: (lon - origin.lon) * kmPerLon(origin.lat),
      y: (lat - origin.lat) * KM_PER_LAT,
    };
  }

  function unproject(point, origin) {
    return {
      lat: origin.lat + point.y / KM_PER_LAT,
      lon: origin.lon + point.x / kmPerLon(origin.lat),
    };
  }

  function distance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  function headingDeg(dx, dy) {
    return (Math.atan2(dx, dy) * 180) / Math.PI;
  }

  function compass(deg) {
    const names = [
      "north",
      "northeast",
      "east",
      "southeast",
      "south",
      "southwest",
      "west",
      "northwest",
    ];
    const index = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
    return names[index];
  }

  function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const index = clamp((sorted.length - 1) * p, 0, sorted.length - 1);
    const low = Math.floor(index);
    const high = Math.ceil(index);
    if (low === high) return sorted[low];
    return sorted[low] * (high - index) + sorted[high] * (index - low);
  }

  function orient(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  function inCircle(a, b, c, d) {
    const adx = a.x - d.x;
    const ady = a.y - d.y;
    const bdx = b.x - d.x;
    const bdy = b.y - d.y;
    const cdx = c.x - d.x;
    const cdy = c.y - d.y;
    return (
      (adx * adx + ady * ady) * (bdx * cdy - cdx * bdy) -
        (bdx * bdx + bdy * bdy) * (adx * cdy - cdx * ady) +
        (cdx * cdx + cdy * cdy) * (adx * bdy - bdx * ady) >
      0
    );
  }

  function delaunay(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    points.forEach((point) => {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    });
    const span = Math.max(maxX - minX, maxY - minY, 1);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const vertices = points.concat([
      { x: cx - span * 20, y: cy - span * 20 },
      { x: cx, y: cy + span * 20 },
      { x: cx + span * 20, y: cy - span * 20 },
    ]);
    const superA = points.length;
    let triangles = [[superA, superA + 1, superA + 2]];

    points.forEach((_, index) => {
      const bad = [];
      const next = [];
      triangles.forEach((triangle) => {
        const [a, b, c] = triangle;
        const ordered = orderTriangle(vertices, a, b, c);
        if (inCircle(vertices[ordered[0]], vertices[ordered[1]], vertices[ordered[2]], vertices[index])) {
          bad.push(ordered);
        } else {
          next.push(triangle);
        }
      });
      const edgeCount = new Map();
      bad.forEach(([a, b, c]) => {
        countEdge(edgeCount, a, b);
        countEdge(edgeCount, b, c);
        countEdge(edgeCount, c, a);
      });
      edgeCount.forEach((count, key) => {
        if (count !== 1) return;
        const [a, b] = key.split(":").map(Number);
        next.push([a, b, index]);
      });
      triangles = next;
    });

    return triangles.filter((triangle) => triangle.every((index) => index < superA));
  }

  function orderTriangle(vertices, a, b, c) {
    return orient(vertices[a], vertices[b], vertices[c]) >= 0 ? [a, b, c] : [a, c, b];
  }

  function countEdge(map, a, b) {
    const key = a < b ? a + ":" + b : b + ":" + a;
    map.set(key, (map.get(key) || 0) + 1);
  }

  function circumradius(a, b, c) {
    const ab = distance(a, b);
    const bc = distance(b, c);
    const ca = distance(c, a);
    const area = Math.abs(orient(a, b, c)) / 2;
    if (area < 1e-8) return Infinity;
    return (ab * bc * ca) / (4 * area);
  }

  function alphaSegments(points, alphaKm) {
    if (points.length < 3) return [];
    const triangles = delaunay(points).filter((triangle) => {
      const [a, b, c] = triangle;
      return circumradius(points[a], points[b], points[c]) <= alphaKm;
    });
    const edgeCount = new Map();
    triangles.forEach(([a, b, c]) => {
      countEdge(edgeCount, a, b);
      countEdge(edgeCount, b, c);
      countEdge(edgeCount, c, a);
    });
    const segments = [];
    edgeCount.forEach((count, key) => {
      if (count !== 1) return;
      const [a, b] = key.split(":").map(Number);
      segments.push([points[a], points[b]]);
    });
    return segments;
  }

  function nearestDistance(points, target) {
    let best = Infinity;
    points.forEach((point) => {
      best = Math.min(best, distance(point, target));
    });
    return best;
  }

  function segmentDistance(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    if (length2 === 0) return distance(point, a);
    const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / length2, 0, 1);
    return distance(point, { x: a.x + dx * t, y: a.y + dy * t });
  }

  function perimeterPoints(points) {
    try {
      const segments = alphaSegments(points, 1.6);
      if (segments.length >= 3) {
        const unique = [];
        segments.forEach(([a, b]) => {
          unique.push(a, b);
        });
        return unique;
      }
    } catch (error) {
      return points;
    }
    return points;
  }

  function advanceKm(older, newer) {
    const edge = perimeterPoints(older);
    const front = perimeterPoints(newer);
    const distances = front.map((point) => {
      let best = nearestDistance(edge, point);
      return best;
    });
    return Math.max(0, percentile(distances, 0.8) - 0.4);
  }

  function centroid(points) {
    const total = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
    return { x: total.x / points.length, y: total.y / points.length };
  }

  function dbscan(points, epsKm) {
    const seen = new Array(points.length).fill(false);
    const clusters = [];
    for (let i = 0; i < points.length; i++) {
      if (seen[i]) continue;
      const cluster = [];
      const queue = [i];
      seen[i] = true;
      while (queue.length) {
        const current = queue.pop();
        cluster.push(points[current]);
        for (let j = 0; j < points.length; j++) {
          if (seen[j]) continue;
          if (distance(points[current], points[j]) <= epsKm) {
            seen[j] = true;
            queue.push(j);
          }
        }
      }
      clusters.push(cluster);
    }
    return clusters;
  }

  function groupPasses(points) {
    const buckets = new Map();
    points.forEach((point) => {
      const key = Math.floor(point.time / (30 * 60 * 1000));
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(point);
    });
    return Array.from(buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1]);
  }

  function dedupe(points) {
    const seen = new Set();
    const unique = [];
    points.forEach((point) => {
      const key = Math.round(point.x * 20) + ":" + Math.round(point.y * 20);
      if (seen.has(key)) return;
      seen.add(key);
      unique.push(point);
    });
    return unique;
  }

  function windFactor(heading, downwind, windMs) {
    const align = Math.cos(((heading - downwind) * Math.PI) / 180);
    const directional = 0.4 + 0.85 * ((align + 1) / 2);
    const speed = 0.75 + 0.06 * windMs;
    return directional * speed;
  }

  function measureSpread(passes, downwind) {
    for (let i = passes.length - 1; i > 0; i--) {
      const newer = passes[i];
      const older = passes[i - 1];
      const hours = (newer[0].time - older[0].time) / 3600000;
      if (hours < 0.5 || hours > 30) continue;
      const moved = advanceKm(older, newer);
      const from = centroid(older);
      const to = centroid(newer);
      const shift = distance(from, to);
      const heading = shift >= 0.4 ? headingDeg(to.x - from.x, to.y - from.y) : downwind;
      return {
        rateKmH: moved / hours,
        heading,
        source: "observed",
        passCount: passes.length,
      };
    }
    return null;
  }

  class Heap {
    constructor() {
      this.items = [];
    }
    push(item) {
      this.items.push(item);
      let index = this.items.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (this.items[parent].time <= this.items[index].time) break;
        const swap = this.items[parent];
        this.items[parent] = this.items[index];
        this.items[index] = swap;
        index = parent;
      }
    }
    pop() {
      const top = this.items[0];
      const last = this.items.pop();
      if (this.items.length && last) {
        this.items[0] = last;
        let index = 0;
        while (true) {
          const left = index * 2 + 1;
          const right = left + 1;
          let smallest = index;
          if (left < this.items.length && this.items[left].time < this.items[smallest].time) smallest = left;
          if (right < this.items.length && this.items[right].time < this.items[smallest].time) smallest = right;
          if (smallest === index) break;
          const swap = this.items[smallest];
          this.items[smallest] = this.items[index];
          this.items[index] = swap;
          index = smallest;
        }
      }
      return top;
    }
    get size() {
      return this.items.length;
    }
  }

  function buildElevation(samples, origin) {
    if (!samples || samples.length < 4) return null;
    const points = samples.map((sample) => ({
      ...project(sample.lat, sample.lon, origin),
      elevation: sample.elevation,
    }));
    return function gradient(point) {
      let west = null;
      let east = null;
      let south = null;
      let north = null;
      points.forEach((sample) => {
        if (sample.x <= point.x && (!west || sample.x > west.x || (sample.x === west.x && Math.abs(sample.y - point.y) < Math.abs(west.y - point.y)))) {
          west = sample;
        }
        if (sample.x >= point.x && (!east || sample.x < east.x || (sample.x === east.x && Math.abs(sample.y - point.y) < Math.abs(east.y - point.y)))) {
          east = sample;
        }
        if (sample.y <= point.y && (!south || sample.y > south.y || (sample.y === south.y && Math.abs(sample.x - point.x) < Math.abs(south.x - point.x)))) {
          south = sample;
        }
        if (sample.y >= point.y && (!north || sample.y < north.y || (sample.y === north.y && Math.abs(sample.x - point.x) < Math.abs(north.x - point.x)))) {
          north = sample;
        }
      });
      const dzdx = west && east && east.x !== west.x ? (east.elevation - west.elevation) / (east.x - west.x) : 0;
      const dzdy = south && north && north.y !== south.y ? (north.elevation - south.elevation) / (north.y - south.y) : 0;
      return { dzdx, dzdy };
    };
  }

  function spreadGrid(options) {
    const { cols, rows, cell, minX, minY, sources, rateKmH, heading, downwind, windMs, windScale, spreadScale, slopeAt } = options;
    const total = cols * rows;
    const best = new Float64Array(total);
    best.fill(Infinity);
    const heap = new Heap();
    sources.forEach((index) => {
      best[index] = 0;
      heap.push({ index, time: 0 });
    });
    const reference = Math.max(windFactor(heading, downwind, windMs * windScale), 0.05);
    const base = (rateKmH * spreadScale) / reference;
    const neighbors = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];

    while (heap.size) {
      const current = heap.pop();
      if (current.time !== best[current.index] || current.time > HORIZON_H) continue;
      const cx = current.index % cols;
      const cy = Math.floor(current.index / cols);
      neighbors.forEach(([sx, sy]) => {
        const nx = cx + sx;
        const ny = cy + sy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) return;
        const step = cell * Math.hypot(sx, sy);
        const direction = headingDeg(sx, sy);
        const mid = {
          x: minX + (nx + 0.5) * cell,
          y: minY + (ny + 0.5) * cell,
        };
        let slope = 1;
        if (slopeAt) {
          const grade = slopeAt(mid);
          const risePerRun = (grade.dzdx * Math.sin((direction * Math.PI) / 180) + grade.dzdy * Math.cos((direction * Math.PI) / 180)) / 1000;
          slope = clamp(1 + 3.5 * risePerRun, 0.55, 2.2);
        }
        const speed = base * windFactor(direction, downwind, windMs * windScale) * slope;
        if (speed < 0.02) return;
        const nextTime = current.time + step / speed;
        const nextIndex = ny * cols + nx;
        if (nextTime < best[nextIndex] && nextTime <= HORIZON_H) {
          best[nextIndex] = nextTime;
          heap.push({ index: nextIndex, time: nextTime });
        }
      });
    }
    return best;
  }

  function buildRoutes(roads, town, origin) {
    const nodes = new Map();
    const edges = [];

    function nodeId(point) {
      const key = Math.round(point.lat * 10000) + ":" + Math.round(point.lon * 10000);
      if (!nodes.has(key)) {
        const projected = project(point.lat, point.lon, origin);
        nodes.set(key, {
          id: key,
          lat: point.lat,
          lon: point.lon,
          ...projected,
          fromTown: distance(projected, town),
        });
      }
      return key;
    }

    roads.forEach((road) => {
      const name = road.name || road.ref || "Unnamed road";
      for (let i = 1; i < road.points.length; i++) {
        const a = nodeId(road.points[i - 1]);
        const b = nodeId(road.points[i]);
        if (a === b) continue;
        const km = distance(nodes.get(a), nodes.get(b));
        if (km > 15) continue;
        edges.push([a, b, km, name]);
      }
    });

    if (!nodes.size) return [];
    let start = null;
    nodes.forEach((node) => {
      if (!start || node.fromTown < start.fromTown) start = node;
    });
    if (!start || start.fromTown > 3) return [];

    const adjacency = new Map();
    edges.forEach(([a, b, km, name]) => {
      if (!adjacency.has(a)) adjacency.set(a, []);
      if (!adjacency.has(b)) adjacency.set(b, []);
      adjacency.get(a).push({ to: b, km, name });
      adjacency.get(b).push({ to: a, km, name });
    });

    const roadTime = new Map();
    const parent = new Map();
    const heap = new Heap();
    roadTime.set(start.id, 0);
    heap.push({ index: start.id, time: 0 });
    while (heap.size) {
      const current = heap.pop();
      if (current.time !== roadTime.get(current.index)) continue;
      (adjacency.get(current.index) || []).forEach((edge) => {
        const next = current.time + edge.km;
        if (next < (roadTime.get(edge.to) ?? Infinity)) {
          roadTime.set(edge.to, next);
          parent.set(edge.to, { from: current.index, name: edge.name, km: edge.km });
          heap.push({ index: edge.to, time: next });
        }
      });
    }

    let farthest = 0;
    nodes.forEach((node) => {
      if (roadTime.has(node.id)) farthest = Math.max(farthest, node.fromTown);
    });
    const radius = clamp(farthest * 0.82, 4, 14);
    const sectors = Array.from({ length: 8 }, () => null);
    nodes.forEach((node) => {
      if (!roadTime.has(node.id)) return;
      if (Math.abs(node.fromTown - radius) > 2.2) return;
      const bearing = (headingDeg(node.x - town.x, node.y - town.y) + 360) % 360;
      const sector = Math.floor(bearing / 45) % 8;
      const travel = roadTime.get(node.id);
      if (!sectors[sector] || travel < sectors[sector].travel) {
        sectors[sector] = { node, bearing, travel };
      }
    });

    const routes = [];
    sectors.forEach((sector) => {
      if (!sector) return;
      const line = [];
      const names = new Map();
      let cursor = sector.node.id;
      let guard = 0;
      while (cursor && guard < 10000) {
        const node = nodes.get(cursor);
        line.push({ lat: node.lat, lon: node.lon, x: node.x, y: node.y });
        const step = parent.get(cursor);
        if (!step) break;
        names.set(step.name, (names.get(step.name) || 0) + step.km);
        cursor = step.from;
        guard += 1;
      }
      line.reverse();
      let name = "Unnamed road";
      let bestKm = -1;
      names.forEach((km, label) => {
        if (km > bestKm && label !== "Unnamed road") {
          bestKm = km;
          name = label;
        }
      });
      const direction = compass(sector.bearing);
      const duplicate = routes.some((route) => route.name === name && route.direction === direction);
      if (!duplicate) routes.push({ name, direction, line });
    });
    return routes;
  }

  function sampleLine(line) {
    if (line.length < 2) return line.slice();
    const samples = [line[0]];
    let carried = 0;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      const length = distance(a, b);
      let pos = 0.4 - carried;
      while (pos < length) {
        const t = pos / length;
        samples.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        pos += 0.4;
      }
      carried = length - (pos - 0.4);
      if (carried < 0) carried = 0;
    }
    samples.push(line[line.length - 1]);
    return samples;
  }

  function arrivalAt(samples, grid) {
    let best = Infinity;
    samples.forEach((sample) => {
      const col = Math.floor((sample.x - grid.minX) / grid.cell);
      const row = Math.floor((sample.y - grid.minY) / grid.cell);
      const reach = Math.ceil(BUFFER_KM / grid.cell);
      for (let y = row - reach; y <= row + reach; y++) {
        for (let x = col - reach; x <= col + reach; x++) {
          if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) continue;
          const center = { x: grid.minX + (x + 0.5) * grid.cell, y: grid.minY + (y + 0.5) * grid.cell };
          if (distance(sample, center) > BUFFER_KM) continue;
          best = Math.min(best, grid.times[y * grid.cols + x]);
        }
      }
    });
    return best;
  }

  function median(values) {
    return percentile(values, 0.5);
  }

  function analyze(input) {
    const origin = { lat: input.town.lat, lon: input.town.lon };
    const town = { x: 0, y: 0 };
    const detections = dedupe(
      input.detections.map((detection) => ({
        ...project(detection.lat, detection.lon, origin),
        time: detection.time,
      }))
    );
    let nearby = detections.filter((point) => distance(point, town) <= 45);
    if (nearby.length > 1500) {
      nearby.sort((a, b) => distance(a, town) - distance(b, town));
      nearby = nearby.slice(0, 1500);
    }
    if (!nearby.length) {
      return { fire: false, routes: [] };
    }

    const clusters = dbscan(nearby, 2.5);
    let cluster = clusters[0];
    let closest = Infinity;
    clusters.forEach((candidate) => {
      const gap = nearestDistance(candidate, town);
      if (gap < closest) {
        closest = gap;
        cluster = candidate;
      }
    });

    const passes = groupPasses(cluster).map(dedupe).filter((pass) => pass.length);
    const latest = passes[passes.length - 1];
    const latestTime = latest.reduce((max, point) => Math.max(max, point.time), 0);
    const elapsedHours = Number.isFinite(input.asOf) ? Math.max(0, (input.asOf - latestTime) / 3600000) : 0;
    const downwind = (input.wind.directionFrom + 180) % 360;
    const measured = measureSpread(passes, downwind);
    const windRate = Math.max(0.15, 0.08 * input.wind.speedMs);
    const spread = measured || {
      rateKmH: windRate,
      heading: downwind,
      source: "wind",
      passCount: passes.length,
    };

    const projectedRoads = input.roads || [];
    const roadPoints = [];
    projectedRoads.forEach((road) => {
      road.points.forEach((point) => {
        const projected = project(point.lat, point.lon, origin);
        if (distance(projected, town) <= 16) roadPoints.push(projected);
      });
    });

    let minX = -18;
    let minY = -18;
    let maxX = 18;
    let maxY = 18;
    cluster.concat(roadPoints).forEach((point) => {
      minX = Math.min(minX, point.x - 3);
      minY = Math.min(minY, point.y - 3);
      maxX = Math.max(maxX, point.x + 3);
      maxY = Math.max(maxY, point.y + 3);
    });
    minX = Math.max(minX, -55);
    minY = Math.max(minY, -55);
    maxX = Math.min(maxX, 55);
    maxY = Math.min(maxY, 55);
    let cell = 0.75;
    let cols = Math.ceil((maxX - minX) / cell);
    let rows = Math.ceil((maxY - minY) / cell);
    if (cols > 90) {
      cell = (maxX - minX) / 90;
      cols = 90;
    }
    if (rows > 90) {
      cell = Math.max(cell, (maxY - minY) / 90);
      rows = Math.ceil((maxY - minY) / cell);
      cols = Math.ceil((maxX - minX) / cell);
    }

    const sources = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const center = { x: minX + (x + 0.5) * cell, y: minY + (y + 0.5) * cell };
        if (nearestDistance(latest, center) <= 0.5) sources.push(y * cols + x);
      }
    }
    if (!sources.length) {
      const center = centroid(latest);
      const x = clamp(Math.floor((center.x - minX) / cell), 0, cols - 1);
      const y = clamp(Math.floor((center.y - minY) / cell), 0, rows - 1);
      sources.push(y * cols + x);
    }

    const slopeAt = buildElevation(input.elevation, origin);
    const times = spreadGrid({
      cols,
      rows,
      cell,
      minX,
      minY,
      sources,
      rateKmH: spread.rateKmH,
      heading: spread.heading,
      downwind,
      windMs: input.wind.speedMs,
      windScale: 1,
      spreadScale: 1,
      slopeAt,
    });
    const grid = { times, cols, rows, cell, minX, minY };
    const segments = classifyRoads(projectedRoads, town, origin, grid, elapsedHours);
    const blockedCount = segments.filter((segment) => segment.blocked).length;

    function hoursUntilFire(lat, lon) {
      const point = project(lat, lon, origin);
      const raw = arrivalAt([point], grid);
      if (!Number.isFinite(raw)) return Infinity;
      return raw - elapsedHours;
    }

    return {
      fire: true,
      detectionCount: cluster.length,
      passCount: passes.length,
      rateSource: spread.source,
      spreadKmH: spread.rateKmH,
      closestKm: closest,
      slopeUsed: Boolean(slopeAt),
      segments,
      blockedCount,
      hoursUntilFire,
    };
  }

  const LEAVE_DELAY_H = 0.5;

  function roadSpeed(road) {
    const raw = road.maxspeed == null ? "" : String(road.maxspeed);
    const value = parseFloat(raw);
    if (Number.isFinite(value) && value > 0) return /mph/i.test(raw) ? value * 1.609 : value;
    const speeds = { motorway: 105, trunk: 90, primary: 70, secondary: 55, tertiary: 40 };
    return speeds[road.highway] || 50;
  }

  function classifyRoads(roads, town, origin, grid, elapsedHours) {
    const nodes = new Map();
    const adjacency = new Map();

    function nodeId(point) {
      const key = Math.round(point.lat * 10000) + ":" + Math.round(point.lon * 10000);
      if (!nodes.has(key)) {
        const projected = project(point.lat, point.lon, origin);
        nodes.set(key, { id: key, lat: point.lat, lon: point.lon, ...projected, fromTown: distance(projected, town) });
      }
      return key;
    }

    roads.forEach((road) => {
      const speed = roadSpeed(road);
      for (let i = 1; i < road.points.length; i++) {
        const a = nodeId(road.points[i - 1]);
        const b = nodeId(road.points[i]);
        if (a === b) continue;
        const km = distance(nodes.get(a), nodes.get(b));
        if (km > 15 || speed <= 0) continue;
        const hours = km / speed;
        if (!adjacency.has(a)) adjacency.set(a, []);
        if (!adjacency.has(b)) adjacency.set(b, []);
        adjacency.get(a).push({ to: b, hours });
        adjacency.get(b).push({ to: a, hours });
      }
    });

    if (!nodes.size) return [];
    let start = null;
    nodes.forEach((node) => {
      if (!start || node.fromTown < start.fromTown) start = node;
    });
    const approach = start.fromTown / 15;
    const drive = new Map();
    const heap = new Heap();
    drive.set(start.id, approach);
    heap.push({ index: start.id, time: approach });
    while (heap.size) {
      const current = heap.pop();
      if (current.time !== drive.get(current.index)) continue;
      (adjacency.get(current.index) || []).forEach((edge) => {
        const next = current.time + edge.hours;
        if (next < (drive.get(edge.to) ?? Infinity)) {
          drive.set(edge.to, next);
          heap.push({ index: edge.to, time: next });
        }
      });
    }

    const segments = [];
    roads.forEach((road) => {
      const speed = roadSpeed(road);
      let current = null;
      for (let i = 1; i < road.points.length; i++) {
        const from = road.points[i - 1];
        const to = road.points[i];
        const a = project(from.lat, from.lon, origin);
        const b = project(to.lat, to.lon, origin);
        const km = distance(a, b);
        if (km > 15) {
          if (current) segments.push(current);
          current = null;
          continue;
        }
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const fireHours = arrivalAt([mid], grid);
        const fireFromNow = Number.isFinite(fireHours) ? fireHours - elapsedHours : Infinity;
        const idA = Math.round(from.lat * 10000) + ":" + Math.round(from.lon * 10000);
        const idB = Math.round(to.lat * 10000) + ":" + Math.round(to.lon * 10000);
        const reached = Math.min(drive.get(idA) ?? Infinity, drive.get(idB) ?? Infinity);
        const driveHours = Number.isFinite(reached) ? reached + km / 2 / speed : Infinity;
        const blocked = Number.isFinite(driveHours) && driveHours + LEAVE_DELAY_H > fireFromNow;
        if (current && current.blocked === blocked) {
          current.positions.push([to.lat, to.lon]);
        } else {
          if (current) segments.push(current);
          current = { positions: [[from.lat, from.lon], [to.lat, to.lon]], blocked };
        }
      }
      if (current) segments.push(current);
    });
    return segments;
  }

  return { analyze, compass };
});
