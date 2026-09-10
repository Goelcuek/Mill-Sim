// A small stroked icon set.
//
// Drawn here rather than pulled from a font so the app stays self-contained
// and the single-file build has nothing to fetch. Every glyph is a 24x24
// stroke path that inherits currentColor, so one icon works on a light
// button and on a pressed blue one.

const PATHS = {
  open: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  save: 'M5 3h11l3 3v15H5zM8 3v6h8V3M8 14h8v7H8z',
  play: 'M8 5l11 7-11 7z',
  pause: 'M9 5v14M15 5v14',
  step: 'M6 5l9 7-9 7zM18 5v14',
  rewind: 'M18 5l-9 7 9 7zM6 5v14',
  end: 'M4 5l7 7-7 7zM12 5l7 7-7 7z',
  reset: 'M4 12a8 8 0 1 0 2.6-5.9M4 4v4h4',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  target: 'M12 3v6M12 15v6M3 12h6M15 12h6M12 12h.01',
  move: 'M5 9l-2 3 2 3M19 9l2 3-2 3M9 5l3-2 3 2M9 19l3 2 3-2M3 12h18M12 3v18',
  point: 'M12 4v7l6 3-6 7z',
  import: 'M12 3v11M8 10l4 4 4-4M4 18v2h16v-2',
  vice: 'M3 8h5v8H3zM16 8h5v8h-5zM8 11h8v2H8z',
  clamp: 'M4 6h10a4 4 0 0 1 0 8H8M8 18v-8M4 18h8',
  cutter: 'M9 3h6v9l-3 9-3-9zM9 6h6M9 9h6',
  holder: 'M8 3h8v5l3 3v10H5V11l3-3z',
  assembly: 'M10 3h4v6h-4zM7 9h10v5H7zM11 14h2v7h-2z',
  library: 'M4 4h4v16H4zM10 4h4v16h-4zM17 5l3 15',
  export: 'M12 14V3M8 7l4-4 4 4M4 18v2h16v-2',
  camera: 'M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 15a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  report: 'M6 3h9l4 4v14H6zM9 12h7M9 16h7M9 8h4',
  grid: 'M3 9h18M3 15h18M9 3v18M15 3v18',
  axes: 'M5 19V5M5 19h14M5 19l-2-2M5 19l2 2',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  machine: 'M4 20h16M6 20V9h5v11M13 20V4h5v16M8 12h1M15 8h1',
  section: 'M4 14h16M4 14l4-8h8l4 8M8 14v6M16 14v6',
  gauge: 'M12 20a8 8 0 1 1 8-8M12 12l5-3',
  ruler: 'M3 8h18v8H3zM7 8v3M11 8v4M15 8v3M19 8v4',
  plus: 'M12 5v14M5 12h14',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  edit: 'M4 20h4L20 8l-4-4L4 16z',
  view: 'M12 3l9 5v8l-9 5-9-5V8z',
  gouge: 'M4 8h16M4 8v8M20 8v8M9 8v5l3 3 3-3V8',
};

/**
 * @param {string} name key from the set above
 * @param {number} [size]
 */
export function icon(name, size = 20) {
  const d = PATHS[name] || PATHS.point;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}

export const ICON_NAMES = Object.keys(PATHS);
