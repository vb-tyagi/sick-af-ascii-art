/**
 * Application entry — W7.A1.
 *
 * The composition root: the one place every module built in isolation is wired
 * into a running app. It owns no rendering logic of its own — it instantiates
 * the Renderer, registers all 15 style modes into its registry, mounts the UI
 * shell (topbar, sidebar, dropzone, loading, toasts), and connects the
 * SourceLoader so a dropped/pasted/picked file reaches renderer.setSource().
 *
 * SEAM STATUS (updated at renderer-pipeline integration):
 *   - Renderer.render() now runs the full pipeline: source-stage advanced blur
 *     (sampler preRead) → lights on the sample buffer → masked glyph layer →
 *     PostFxChain composite over the Backdrop image layer → tint. The chain
 *     instance below is shared by the renderer AND the sidebar's
 *     Post-Processing section, so toggles reach the output.
 *   - The mask's drawing surface is mounted here: an overlay canvas over the
 *     preview, driven by MaskOverlay, enabled from the sidebar's Mask toggle.
 *   - REMAINING (feature work, not broken seams): the sidebar has no Dither
 *     section yet (the dither mode renders with its built-in algorithm/palette
 *     defaults), and crop/export are topbar stubs.
 */

import './styles/fonts.css';
import './styles/tokens.css';
import './styles/shell.css';
import './styles/sidebar.css';
import './styles/crop.css';

import { Renderer, type ModeRenderer } from '@sick-af/engine/renderer';
import { glyphModes } from '@sick-af/engine/modes/glyph';
import { ditherModes } from '@sick-af/engine/modes/dither';
import { shapeModes } from '@sick-af/engine/modes/shape';
import { blockModes } from '@sick-af/engine/modes/block';
import { voxelModes } from '@sick-af/engine/modes/voxel';
import { brailleModes } from '@sick-af/engine/modes/braille';
import { discoModes } from '@sick-af/engine/modes/disco';
import { animatedModes } from '@sick-af/engine/animate';
import { PostFxChain } from '@sick-af/engine/postfx/chain';
import { MaskOverlay, EMPTY_MASK, type MaskState } from '@sick-af/engine/mask';
import type { SourceMedia, SamplerTransform } from '@sick-af/engine/sample';
import { createCropModal } from './ui/crop-modal';
import { SourceLoader } from './io/source-loader';
import { createSidebar, type SidebarState } from './ui/sidebar';
import {
  RECIPE_PRESETS,
  findPreset,
  applyRecipe,
  captureRecipe,
  recipeShareUrl,
  loadRecipeFromHashOnBoot,
} from './ui/recipes';
import { createTopbar } from './ui/topbar';
import { createDropZone, createLoadingIndicator } from './ui/dropzone';
import { DEMOS, demoUrl } from './demos';
import { createToaster } from './ui/toast';

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`main: missing #${id} in index.html`);
  return node as T;
}

// Every mode module exposes a { registryKey: renderer } record; merged, these
// are the 15 style modes of TEARDOWN §3.1.
const ALL_MODES: Record<string, ModeRenderer> = {
  ...glyphModes,
  ...ditherModes,
  ...shapeModes,
  ...blockModes,
  ...voxelModes,
  ...brailleModes,
  ...discoModes,
  // matrix / shimmer / wave / typewriter. Each declares animated:true, which
  // keeps the renderer's rAF loop running instead of parking on the dirty flag.
  ...animatedModes,
};

const topbarMount = must('topbar-mount');
const sidebarMount = must('sidebar-mount');
const previewArea = must('preview-area');
const canvas = must<HTMLCanvasElement>('output-canvas');

// Hidden picker driven by both the topbar Upload button and the dropzone.
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = 'image/*,video/*';
fileInput.style.display = 'none';
document.body.appendChild(fileInput);

// One chain, shared: the renderer composites through it and the sidebar's
// Post-Processing section mutates its entries. Two instances would mean
// toggles that never reach a pixel.
const postfx = new PostFxChain();
const renderer = new Renderer({ container: previewArea, canvas, postfx });

for (const [id, mode] of Object.entries(ALL_MODES)) {
  renderer.registerMode(id, mode);
}

// The core style set of TEARDOWN §3.1. Asserting the NAMES rather than a count
// means adding a mode never trips this, while a mode module that failed to load
// still fails loudly — a UI whose pills dispatch to nothing is worse than a
// blank page, because it looks like it works.
const REQUIRED_MODES = [
  'characters', 'dither', 'block-chars', 'dots', 'mixed', 'pixel', 'mosaic',
  'lego', 'cross', 'diamond', 'lines', 'diagonal', 'braille', '3d', 'disco',
] as const;
const missing = REQUIRED_MODES.filter((id) => !(id in ALL_MODES));
if (missing.length > 0) {
  throw new Error(`main: mode modules failed to load — missing: ${missing.join(', ')}`);
}

const toaster = createToaster(document.body);
const loading = createLoadingIndicator(previewArea);

const topbar = createTopbar(topbarMount, {
  onUpload: () => fileInput.click(),
  onCrop: () => openCrop(),
  onExport: () => exportPng(),
});

const dropzone = createDropZone(previewArea, {
  onBrowse: () => fileInput.click(),
  demos: DEMOS.map((d) => ({ label: d.label, url: demoUrl(d) })),
  onPickDemo: (url) => void loadDemo(url),
});

const loader = new SourceLoader({ dropTarget: previewArea });
loader.bindFileInput(fileInput);

// SourceLoader emits no "decoding started" event; mirror the picker directly.
fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) loading.show();
});

loader.on('load', (event) => {
  currentSource = event.element;
  // A crop rect indexes the pixels of the image it was drawn on; carrying it
  // onto a different one would slice an arbitrary region. Reset on every load.
  currentTransform = {};
  renderer.setOptions({ transform: currentTransform });
  renderer.setSource(event.element);
  renderer.markDirty();
  loading.hide();
  dropzone.hide();
  topbar.setSourceLoaded(true);
});

loader.on('error', (event) => {
  loading.hide();
  toaster.error(event.message);
});

// Load a demo image (CC0 gallery) through the same unified path as a picked
// file, so setSource / hide-dropzone / setSourceLoaded all fire identically.
async function loadDemo(url: string): Promise<void> {
  loading.show('Loading demo…');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const name = url.split('/').pop() ?? 'demo.jpg';
    await loader.loadFile(new File([blob], name, { type: blob.type || 'image/jpeg' }));
  } catch (err) {
    loading.hide();
    toaster.error(`Could not load demo: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
}

// Export the current composited frame as a PNG. The renderer's output canvas
// already holds the full pipeline result (backdrop, glyphs, post-FX, tint), so
// this is full-fidelity — exactly what's on screen. Multi-scale re-render and
// JPG are the perfection-pass follow-up; PNG is the right format for the crisp,
// high-contrast glyphs anyway (JPEG would smear them).
function exportPng(): void {
  const canvas = renderer.canvas;
  if (!canvas.width || !canvas.height) {
    toaster.info('Load an image or demo first.');
    return;
  }
  canvas.toBlob((blob) => {
    if (!blob) {
      toaster.error('Export failed — could not encode the canvas.');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sick-af-ascii-art-${Date.now()}.png`;
    a.click();
    // Revoking synchronously races the browser's read of the object URL — some
    // engines have not started the download yet and it silently fails. Hand the
    // URL back on a later tick instead; the delay costs nothing.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toaster.success('Exported PNG.');
  }, 'image/png');
}

// --- crop & rotate ---------------------------------------------------------
// The modal emits a SamplerTransform (source-space crop + quarter turns), which
// is exactly what GridSampler.sample consumes — no parallel path, nothing baked
// into the renderer.
let currentSource: SourceMedia | null = null;
let currentTransform: SamplerTransform = {};

const cropModal = createCropModal({
  onApply: (transform) => {
    currentTransform = transform;
    renderer.setOptions({ transform });
    renderer.markDirty();
    toaster.success('Crop applied.');
  },
});

function openCrop(): void {
  if (!currentSource) {
    toaster.info('Load an image or demo first.');
    return;
  }
  // Seeded with the active transform so reopening edits the current crop
  // instead of starting over.
  cropModal.open(currentSource, currentTransform);
}

// Mask drawing surface: a transparent canvas over the preview. Pointer events
// are enabled only while masking so it never swallows dropzone clicks.
const maskCanvas = document.createElement('canvas');
maskCanvas.id = 'mask-overlay';
maskCanvas.style.position = 'absolute';
maskCanvas.style.pointerEvents = 'none';
previewArea.appendChild(maskCanvas);

let maskShapes: MaskState = EMPTY_MASK;
const maskOverlay = new MaskOverlay({
  canvas: maskCanvas,
  onChange: (m) => {
    maskShapes = m;
    renderer.setOptions({ mask: m });
    renderer.markDirty();
  },
});
// The output canvas is fitted to the source's aspect ratio and centred, so it
// is usually smaller than the pane. The mask must track the CANVAS rect, not
// the pane, or drawn shapes land offset from the art they are meant to clip.
const syncMaskSize = () => {
  const c = renderer.canvas;
  const w = c.clientWidth || previewArea.clientWidth;
  const h = c.clientHeight || previewArea.clientHeight;
  maskCanvas.style.left = `${c.offsetLeft}px`;
  maskCanvas.style.top = `${c.offsetTop}px`;
  maskCanvas.style.width = `${w}px`;
  maskCanvas.style.height = `${h}px`;
  maskOverlay.resize(w, h);
};
new ResizeObserver(syncMaskSize).observe(previewArea);
new ResizeObserver(syncMaskSize).observe(renderer.canvas);
syncMaskSize();

// The sidebar holds the renderer and pushes render options through its own
// coalesced setOptions()/markDirty() on every control change. The onChange
// snapshot wires the one control whose state lives outside the sidebar: the
// mask toggle, which arms/disarms the overlay above.
const sidebar = createSidebar(sidebarMount, {
  renderer,
  postfx,
  presets: RECIPE_PRESETS.map((p) => ({ id: p.id, name: p.name, blurb: p.blurb })),
  onPickPreset: (id) => {
    const preset = findPreset(id);
    if (!preset) return;
    // applyRecipe mutates the draft and the shared chain; setState then rebuilds
    // the controls so they show what the canvas is actually rendering.
    const draft = { ...sidebar.getState() } as SidebarState;
    applyRecipe(draft, postfx, preset.build());
    sidebar.setState(draft);
    toaster.success(`Loaded “${preset.name}”.`);
  },
  onCopyShareLink: () => void copyShareLink(),
  onChange: (s) => {
    maskOverlay.setEnabled(s.maskEnabled);
    maskCanvas.style.pointerEvents = s.maskEnabled ? 'auto' : 'none';
    renderer.setOptions({ mask: { enabled: s.maskEnabled, shapes: maskShapes.shapes } });
  },
});

/**
 * Encode the whole look into the URL and copy it. The image itself is never
 * uploaded — a link carries settings only, so the recipient applies the look to
 * their own source.
 */
async function copyShareLink(): Promise<void> {
  const url = recipeShareUrl(captureRecipe(sidebar.getState(), postfx));
  try {
    await navigator.clipboard.writeText(url);
    toaster.success('Share link copied.');
  } catch {
    // Clipboard access needs a secure context and can be refused; putting the
    // link in the address bar still lets the user copy it by hand.
    location.hash = new URL(url).hash.slice(1);
    toaster.info('Link is in the address bar — copy it from there.');
  }
}

// A shared link boots straight into its look.
{
  const draft = { ...sidebar.getState() } as SidebarState;
  const loaded = loadRecipeFromHashOnBoot(draft, postfx);
  if (loaded) {
    sidebar.setState(draft);
    toaster.info('Loaded the shared look from this link.');
  }
}

renderer.start();

// Dev self-test: open /?selftest (optionally ?selftest=<mode>) and a synthetic
// fixture — gradient, discs, a colour wash — loads straight through
// renderer.setSource(). Lets a headless driver or a human smoke the LIVE
// pipeline without touching a file picker. Harmless in production: inert
// unless the param is present.
const selftest =
  new URLSearchParams(location.search).get('selftest') ??
  ((import.meta as { env?: Record<string, string> }).env?.VITE_SELFTEST ?? null);
if (selftest !== null) {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 400;
  const x = c.getContext('2d');
  if (x) {
    const g = x.createLinearGradient(0, 0, 640, 0);
    g.addColorStop(0, '#000');
    g.addColorStop(1, '#fff');
    x.fillStyle = g;
    x.fillRect(0, 0, 640, 400);
    const rg = x.createRadialGradient(320, 200, 10, 320, 200, 180);
    rg.addColorStop(0, 'rgba(255,64,64,0.9)');
    rg.addColorStop(1, 'rgba(255,64,64,0)');
    x.fillStyle = rg;
    x.fillRect(0, 0, 640, 400);
    x.fillStyle = '#fff';
    x.beginPath();
    x.arc(180, 120, 70, 0, 7);
    x.fill();
    x.fillStyle = '#000';
    x.beginPath();
    x.arc(460, 280, 60, 0, 7);
    x.fill();
    const img = new Image();
    img.onload = () => {
      renderer.setSource(img);
      renderer.markDirty();
      dropzone.hide();
      topbar.setSourceLoaded(true);
      if (selftest && selftest !== '1' && selftest !== 'true') {
        renderer.setOptions({ mode: selftest });
      }
    };
    img.src = c.toDataURL();
  }
}
