// Viewport backdrops.
//
// A near-white part on a near-white ground has no silhouette, and a
// machined face reads by its silhouette before anything else. So the
// default is a cool grey that a light aluminium part stands off, and the
// rest are here because different work wants different contrast: a dark
// ground for inspecting a bright finish, a flat one for screenshots that
// have to sit on a page.
//
// Each entry carries the CSS for the backdrop, a single `haze` colour for
// the distance fog and screenshots to match it, and whether the grid should
// switch to light lines.

export const BACKGROUNDS = {
  studio: {
    label: 'Studio',
    dark: false,
    haze: 0xa9b2c2,
    // Darker at the top, where the part is, and lighter toward the floor.
    // The other way round put the brightest part of the backdrop directly
    // behind a pale aluminium block, which is how you lose an edge.
    css: 'linear-gradient(180deg, #939eb2 0%, #b6bfcd 42%, #e4e8ef 100%)',
  },
  slate: {
    label: 'Slate',
    dark: true,
    haze: 0x2b3240,
    css: 'radial-gradient(120% 95% at 50% 4%, #46506a 0%, #2d3442 52%, #1c212c 100%)',
  },
  graphite: {
    label: 'Graphite',
    dark: true,
    haze: 0x1b1d22,
    css: 'radial-gradient(120% 95% at 50% 4%, #33373f 0%, #1f2229 55%, #131519 100%)',
  },
  blueprint: {
    label: 'Blueprint',
    dark: true,
    haze: 0x123a63,
    css: 'radial-gradient(120% 95% at 50% 4%, #1d5a96 0%, #12406e 52%, #0b2b4b 100%)',
  },
  paper: {
    label: 'Paper',
    dark: false,
    haze: 0xe7e4dc,
    css: 'linear-gradient(180deg, #f7f5f0 0%, #e6e2d9 100%)',
  },
  white: {
    label: 'Plain white',
    dark: false,
    haze: 0xffffff,
    css: '#ffffff',
  },
};

export const DEFAULT_BACKGROUND = 'studio';

/** Resolve a stored setting into something the viewer can apply. */
export function resolveBackground(name, custom) {
  if (name === 'custom') {
    const hex = /^#[0-9a-f]{6}$/i.test(custom || '') ? custom : '#8b93a3';
    const n = parseInt(hex.slice(1), 16);
    const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    return { label: 'Custom', dark: lum < 0.5, haze: n, css: hex };
  }
  return BACKGROUNDS[name] || BACKGROUNDS[DEFAULT_BACKGROUND];
}
