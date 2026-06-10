/**
 * Volumetric clouds — 2-layer raymarched Worley–Perlin density field:
 *  - 3D noise textures baked by compute (base 96³ perlin-worley, detail 32³)
 *  - cumulus layer in an altitude band that sits BELOW the high summits so
 *    vistas can look across/down onto cloud tops (reference: Witcher frame)
 *  - half-res raymarch in the post chain with temporal blue-noise jitter,
 *    Beer–Powder lighting, HG phase toward the sun, ambient from the sky LUT
 *  - cloud shadows: a top-down transmittance map sampled by the terrain
 *    material and the light shaft pass
 */

import { HalfFloatType, RedFormat } from 'three';
import type { Renderer } from 'three/webgpu';
import { Storage3DTexture, StorageTexture } from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  Return,
  clamp,
  exp,
  float,
  instanceIndex,
  mix,
  mx_fractal_noise_float,
  mx_worley_noise_float,
  pow,
  smoothstep,
  texture,
  texture3D,
  textureStore,
  uniform,
  uvec2,
  uvec3,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { NF, NI, NV2, NV3 } from '../gpu/TSLTypes';
import { WORLD_SIZE } from '../world/WorldConst';
import type { Atmosphere } from './Atmosphere';
import { SUN_E } from './Atmosphere';

const BASE_RES = 96;
const DETAIL_RES = 32;
const SHADOW_RES = 768;
/** cloud layer altitudes (m) — below the ~2000 m summits */
export const CLOUD_BOTTOM = 1250;
export const CLOUD_TOP = 1900;
const SHADOW_WORLD = WORLD_SIZE * 1.6;

export class Clouds {
  readonly baseNoise: Storage3DTexture;
  readonly detailNoise: Storage3DTexture;
  /** r: transmittance toward the sun through the layer, top-down */
  readonly shadowMap: StorageTexture;
  readonly coverage = uniform(0.46);
  readonly density = uniform(0.85);
  private atmosphere: Atmosphere;
  private shadowKernel: Parameters<Renderer['computeAsync']>[0] | null = null;

  constructor(atmosphere: Atmosphere) {
    this.atmosphere = atmosphere;
    this.baseNoise = new Storage3DTexture(BASE_RES, BASE_RES, BASE_RES);
    this.baseNoise.type = HalfFloatType;
    this.baseNoise.format = RedFormat;
    this.detailNoise = new Storage3DTexture(DETAIL_RES, DETAIL_RES, DETAIL_RES);
    this.detailNoise.type = HalfFloatType;
    this.detailNoise.format = RedFormat;
    this.shadowMap = new StorageTexture(SHADOW_RES, SHADOW_RES);
    this.shadowMap.type = HalfFloatType;
    this.shadowMap.generateMipmaps = false;
  }

  async init(renderer: Renderer): Promise<void> {
    // --- base: perlin-worley remap (tileable enough via domain fract) --------
    const N = BASE_RES;
    const baseK = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(N * N * N), () => {
        Return();
      });
      const x = i.mod(N);
      const y = i.div(N).mod(N);
      const z = i.div(N * N);
      const p = vec3(float(x), float(y), float(z)).add(0.5).div(N);
      const pw = p.mul(4);
      const perlin = mx_fractal_noise_float(pw.mul(2), 4, 2.0, 0.55, 1).mul(0.5).add(0.5);
      const w0 = float(1).sub(clamp(mx_worley_noise_float(pw, 1), 0, 1));
      const w1 = float(1).sub(clamp(mx_worley_noise_float(pw.mul(2.03).add(19.7), 1), 0, 1));
      const w2 = float(1).sub(clamp(mx_worley_noise_float(pw.mul(4.01).add(47.3), 1), 0, 1));
      const wfbm = w0.mul(0.625).add(w1.mul(0.25)).add(w2.mul(0.125));
      // remap perlin by worley (Schneider-style perlin-worley)
      const pwv = clamp(perlin.sub(wfbm.oneMinus()).div(wfbm.max(1e-3)), 0, 1);
      textureStore(this.baseNoise, uvec3(x.toUint(), y.toUint(), z.toUint()), vec4(pwv, 0, 0, 1)).toWriteOnly();
    })().compute(N * N * N);
    baseK.setName('cloudBaseNoise');
    await renderer.computeAsync(baseK);

    const M = DETAIL_RES;
    const detailK = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(M * M * M), () => {
        Return();
      });
      const x = i.mod(M);
      const y = i.div(M).mod(M);
      const z = i.div(M * M);
      const p = vec3(float(x), float(y), float(z)).add(0.5).div(M);
      const w0 = float(1).sub(clamp(mx_worley_noise_float(p.mul(3), 1), 0, 1));
      const w1 = float(1).sub(clamp(mx_worley_noise_float(p.mul(6.02).add(7.7), 1), 0, 1));
      const d = w0.mul(0.65).add(w1.mul(0.35));
      textureStore(this.detailNoise, uvec3(x.toUint(), y.toUint(), z.toUint()), vec4(d, 0, 0, 1)).toWriteOnly();
    })().compute(M * M * M);
    detailK.setName('cloudDetailNoise');
    await renderer.computeAsync(detailK);

    // --- cloud shadow map kernel (re-run on sun/ToD change) -------------------
    const S = SHADOW_RES;
    const shadowK = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(S * S), () => {
        Return();
      });
      const x = i.mod(S);
      const y = i.div(S);
      const wpos = vec2(float(x).add(0.5), float(y).add(0.5))
        .div(S)
        .sub(0.5)
        .mul(SHADOW_WORLD);
      // march vertically through the layer, accumulate optical depth; the
      // sun-angle offset is approximated by shifting with the sun direction
      const sunDir = this.atmosphere.sunDir;
      const STEPS = 20;
      const dh = (CLOUD_TOP - CLOUD_BOTTOM) / STEPS;
      const tau = float(0).toVar();
      Loop(STEPS, ({ i: si }: { readonly i: NI }) => {
        const h = float(si).add(0.5).mul(dh).add(CLOUD_BOTTOM);
        // shift sample along the sun's horizontal direction as we ascend
        const k = h.sub(CLOUD_BOTTOM).div(sunDir.y.abs().max(0.15));
        const sp = wpos.add(vec2(sunDir.x, sunDir.z).mul(k).negate());
        tau.addAssign(this.sampleDensity(vec3(sp.x, h, sp.y), false).mul(dh));
      });
      const trans = exp(tau.mul(-0.045));
      textureStore(this.shadowMap, uvec2(x.toUint(), y.toUint()), vec4(trans, 0, 0, 1)).toWriteOnly();
    })().compute(S * S);
    shadowK.setName('cloudShadowMap');
    this.shadowKernel = shadowK;
    await renderer.computeAsync(shadowK);
  }

  /** re-bake the shadow map (call after sun changes) */
  async refreshShadow(renderer: Renderer): Promise<void> {
    if (this.shadowKernel) await renderer.computeAsync(this.shadowKernel);
  }

  /** cloud density at a world position (m). detail=false for cheap shadow march */
  sampleDensity(wp: NV3, detail: boolean): NF {
    const hNorm = wp.y.sub(CLOUD_BOTTOM).div(CLOUD_TOP - CLOUD_BOTTOM);
    const inLayer = smoothstep(0, 0.12, hNorm).mul(smoothstep(1, 0.55, hNorm));
    // weather/coverage field: large-scale variation breaks the layer into
    // cumulus masses with clear lanes
    const wUv = wp.xz.div(5200);
    const weather = mx_fractal_noise_float(wUv, 3, 2.2, 0.5, 1).mul(0.5).add(0.5);
    const cov = clamp(weather.sub(float(1).sub(float(this.coverage))), 0, 1).mul(2.2);
    const base = texture3D(this.baseNoise, wp.div(3600).fract(), 0).x;
    let dens = clamp(base.mul(cov).sub(float(0.32).mul(hNorm.add(0.45))), 0, 1).mul(inLayer);
    if (detail) {
      const det = texture3D(this.detailNoise, wp.div(420).fract(), 0).x;
      dens = clamp(dens.sub(det.mul(0.22).mul(float(1).sub(dens))), 0, 1);
    }
    return dens.mul(float(this.density));
  }

  /** sample the top-down cloud shadow transmittance at a world xz */
  shadowAt(wxz: NV2): NF {
    const uv = wxz.div(SHADOW_WORLD).add(0.5);
    const inside = smoothstep(0.0, 0.02, uv.x)
      .mul(smoothstep(1.0, 0.98, uv.x))
      .mul(smoothstep(0.0, 0.02, uv.y))
      .mul(smoothstep(1.0, 0.98, uv.y));
    const t = texture(this.shadowMap, clamp(uv, 0, 1)).x;
    return mix(float(1), t, inside);
  }

  /**
   * Raymarch the cloud layer for a view ray; returns rgb radiance + alpha.
   * Designed to run in the post chain after the scene (composited by depth).
   */
  march(camPos: NV3, dir: NV3, maxDistM: NF, jitter: NF): { color: NV3; alpha: NF } {
    const sunDir = this.atmosphere.sunDir.normalize();

    // ray-layer intersection (horizontal slab)
    const t0 = float(CLOUD_BOTTOM).sub(camPos.y).div(dir.y);
    const t1 = float(CLOUD_TOP).sub(camPos.y).div(dir.y);
    const tEnterRaw = t0.min(t1);
    const tExitRaw = t0.max(t1);
    const inside = camPos.y.greaterThan(CLOUD_BOTTOM).and(camPos.y.lessThan(CLOUD_TOP));
    const tEnter = inside.select(float(0), tEnterRaw.max(0));
    const tExit = tExitRaw.min(maxDistM).min(26000);

    const valid = tExit.greaterThan(tEnter).and(dir.y.abs().greaterThan(1e-4));

    const STEPS = 40;
    const seg = tExit.sub(tEnter).div(STEPS);
    const trans = float(1).toVar();
    const light = vec3(0).toVar();
    const ambient = this.atmosphere
      .skyColor(vec3(dir.x, dir.y.abs().max(0.25), dir.z))
      .mul(0.5)
      .add(this.atmosphere.skyColor(dir).mul(0.5));
    const nu = dir.dot(sunDir);
    // dual-lobe HG
    const g1 = 0.62;
    const g2 = -0.18;
    const hg = (g: number): NF => {
      const gg = g * g;
      return float((1 - gg) / (4 * Math.PI)).div(
        pow(float(1 + gg).sub(nu.mul(2 * g)), 1.5),
      );
    };
    const phase = hg(g1).mul(0.75).add(hg(g2).mul(0.25));
    const sunT = this.atmosphere.sampleTransmittance(float(6360.35), clamp(sunDir.y, -1, 1));

    If(valid, () => {
      Loop(STEPS, ({ i: si }: { readonly i: NI }) => {
        const t = tEnter.add(float(si).add(jitter).mul(seg));
        const sp = camPos.add(dir.mul(t));
        const dens = this.sampleDensity(sp, true);
        If(dens.greaterThan(0.002), () => {
          // cheap sun occlusion: 4 coarse steps toward the sun
          const lTau = float(0).toVar();
          for (let ls = 1; ls <= 4; ls++) {
            const lp = sp.add(sunDir.mul(ls * 130));
            lTau.addAssign(this.sampleDensity(lp, false).mul(130));
          }
          const sunVis = exp(lTau.mul(-0.04));
          const powder = float(1).sub(exp(dens.mul(-22)));
          // source radiance: sun (phase-weighted, self-occluded) + sky ambient
          const S = sunT
            .mul(sunVis)
            .mul(phase)
            .mul(SUN_E * 2.6)
            .add(ambient.mul(0.22))
            .mul(powder.mul(0.75).add(0.25));
          const stepT = exp(dens.mul(seg).mul(-0.052));
          light.addAssign(S.mul(trans).mul(float(1).sub(stepT)));
          trans.mulAssign(stepT);
        });
      });
    });
    return { color: light, alpha: float(1).sub(trans) };
  }
}
