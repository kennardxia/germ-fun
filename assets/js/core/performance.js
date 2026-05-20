/**
 * germ.fun — Performance Detection
 * Detects device capability and returns a quality preset.
 * Sets window.QUALITY for all games to use.
 */

export function detectQuality() {
  const cores = navigator.hardwareConcurrency ?? 2;
  const mem   = navigator.deviceMemory ?? 2; // GB, may be undefined

  // WebGL renderer string — identifies GPU tier
  let gpuTier = 2; // 0=software, 1=integrated-weak, 2=integrated-ok, 3=dedicated
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL).toLowerCase();
        if (/swiftshader|llvmpipe|softpipe|microsoft basic/.test(renderer)) {
          gpuTier = 0;
        } else if (/intel hd 3|intel hd 4|intel hd 5|gma |mali-4|powervr sgx|adreno [23][0-9][0-9]/.test(renderer)) {
          gpuTier = 1;
        } else if (/intel|mali|adreno|apple a[0-9]|apple gpu/.test(renderer)) {
          gpuTier = 2;
        } else {
          gpuTier = 3; // NVIDIA, AMD, etc.
        }
      }
    }
  } catch (_) { /* silently ignore */ }

  // Clamp inputs
  const clampedCores = Math.max(1, Math.min(cores, 32));
  const clampedMem   = Math.max(0.5, Math.min(mem, 32));

  // Score 0-10
  const score = (gpuTier * 3) + (clampedCores >= 8 ? 2 : clampedCores >= 4 ? 1 : 0) +
                (clampedMem >= 8 ? 2 : clampedMem >= 4 ? 1 : 0);

  let preset;
  if      (score <= 2)  preset = 'POTATO';
  else if (score <= 4)  preset = 'LOW';
  else if (score <= 7)  preset = 'MEDIUM';
  else                  preset = 'HIGH';

  const presets = {
    POTATO: { pixelRatio: 0.5,  maxParticles:  50, useShadows: false, materialTier: 'basic',    targetFPS: 30, fogDensity: 0 },
    LOW:    { pixelRatio: 0.75, maxParticles: 200, useShadows: false, materialTier: 'lambert',  targetFPS: 60, fogDensity: 0.01 },
    MEDIUM: { pixelRatio: 1.0,  maxParticles: 500, useShadows: true,  materialTier: 'phong',    targetFPS: 60, fogDensity: 0.015 },
    HIGH:   { pixelRatio: Math.min(window.devicePixelRatio ?? 1, 2),
                                maxParticles:1000, useShadows: true,  materialTier: 'standard', targetFPS: 60, fogDensity: 0.02 },
  };

  return { preset, score, gpuTier, ...presets[preset] };
}

// Run immediately and expose globally
const quality = detectQuality();
window.QUALITY = quality;

// Debug info (non-production)
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  console.log('[germ.fun] Quality preset:', quality.preset, quality);
}

export default quality;
