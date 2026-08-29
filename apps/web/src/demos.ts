/**
 * Demo gallery — curated public-domain works from The Met Open Access (CC0).
 * Files live in public/demos/ (see public/demos/CREDITS.md for full attribution).
 * URLs are built against import.meta.env.BASE_URL so they resolve both in dev
 * (/) and under the GitHub Pages base (/sick-af-ascii-art/).
 */

export interface Demo {
  readonly file: string;
  readonly label: string;
}

export const DEMOS: readonly Demo[] = [
  { file: 'john-singer-sargent-madame-x-virginie-am.jpg', label: 'Madame X' },
  { file: 'vincent-van-gogh-wheat-field-with-cypres.jpg', label: 'Van Gogh' },
  { file: 'rembrandt-rembrandt-van-rijn-flora.jpg', label: 'Rembrandt' },
  { file: 'utagawa-hiroshige-six-jewel-rivers-from-.jpg', label: 'Hiroshige' },
  { file: 'jean-antoine-houdon-sabine-houdon-1787-1.jpg', label: 'Houdon' },
  { file: 'paul-gauguin-ia-orana-maria-hail-mary.jpg', label: 'Gauguin' },
  { file: 'michiel-sweerts-clothing-the-naked.jpg', label: 'Sweerts' },
  { file: 'william-michael-harnett-still-life-violi.jpg', label: 'Still Life' },
  { file: 'jos-guadalupe-posada-in-proof-of-true-lo.jpg', label: 'Posada' },
  { file: 'anon-book-of-the-dead-of-the-priest-of-h.jpg', label: 'Papyrus' },
];

export const demoUrl = (d: Demo): string => `${import.meta.env.BASE_URL}demos/${d.file}`;
