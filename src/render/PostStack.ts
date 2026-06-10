/**
 * Post-processing stack (HDR, in order):
 *   scene pass (MRT: color, view normal, velocity, depth)
 *   → aerial perspective (Hillaire in-scatter from depth — Pillar D haze)
 *   → GTAO multiply (Phase-3 refines to indirect-only)
 *   → TRAA (temporal AA — the geometric density shimmers without it)
 *   → bloom (HDR threshold)
 *   → auto-exposure (GPU histogram-free log-average, smoothed, no readback)
 *   → filmic grade (per-ToD color script: white balance, teal–orange split
 *     toning, saturation, contrast) → AgX via renderer.toneMapping
 */

import { AgXToneMapping } from 'three';
import type { Renderer, StorageBufferNode } from 'three/webgpu';
import { RenderPipeline } from 'three/webgpu';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import {
  Fn,
  If,
  Return,
  cameraPosition,
  cameraProjectionMatrixInverse,
  cameraWorldMatrix,
  clamp,
  dot,
  float,
  getViewPosition,
  instanceIndex,
  instancedArray,
  log2,
  exp2,
  luminance,
  mix,
  mrt,
  output,
  pass,
  screenUV,
  smoothstep,
  texture,
  normalView,
  uniform,
  vec2,
  vec3,
  vec4,
  velocity,
} from 'three/tsl';
import type { Engine } from '../core/Engine';
import { hash12 } from '../gpu/noise/NoiseTSL';
import type { NV3, NV4 } from '../gpu/TSLTypes';
import type { Atmosphere } from '../sky/Atmosphere';
import type { Clouds } from '../sky/Clouds';
import { GradeUniforms, gradeParamsAt } from './ColorScript';

export class PostStack {
  readonly post: RenderPipeline;
  private grade = new GradeUniforms();
  private exposureBuf: StorageBufferNode<'float'>;
  private exposureKernel: Parameters<Renderer['compute']>[0];

  constructor(
    engine: Engine,
    atmosphere: Atmosphere,
    tod: number,
    clouds: Clouds | null = null,
  ) {
    const { renderer, scene, camera } = engine;
    renderer.toneMapping = AgXToneMapping;
    renderer.toneMappingExposure = 1.0;
    const frameU = uniform(0);
    engine.onUpdate(() => {
      frameU.value = (frameU.value + 1) % 1024;
    });

    const scenePass = pass(scene, camera);
    scenePass.setMRT(
      mrt({
        output,
        normal: normalView,
        velocity,
      }),
    );
    const beauty = scenePass.getTextureNode('output');
    const depthTex = scenePass.getTextureNode('depth');
    const normalTex = scenePass.getTextureNode('normal');
    const velocityTex = scenePass.getTextureNode('velocity');

    // --- aerial perspective from depth -----------------------------------------
    const aerialNode = Fn((): NV3 => {
      const d = depthTex.x.toVar();
      const col = beauty.rgb.toVar();
      const viewPos = getViewPosition(screenUV, d, cameraProjectionMatrixInverse);
      const worldPos = cameraWorldMatrix.mul(vec4(viewPos, 1)).xyz;
      const rel = worldPos.sub(cameraPosition);
      const dist = rel.length();
      const dirW = rel.div(dist.max(1e-4));
      const distKm = dist.div(1000);
      const camAltKm = cameraPosition.y.div(1000).max(0.005);
      const isSky = d.lessThanEqual(1e-7);
      const hazed = atmosphere.aerial(col, dirW, camAltKm, distKm);
      // reversed-z: far plane clears to 0 → sky already carries the atmosphere
      const scenePart = isSky.select(col, hazed).toVar();

      if (clouds) {
        const maxD = isSky.select(float(1e9), dist);
        const jitter = hash12(
          screenUV.mul(vec2(911.3, 423.7)).add(float(frameU).mul(0.61803)),
        );
        const cl = clouds.march(cameraPosition, dirW, maxD, jitter);
        scenePart.assign(scenePart.mul(float(1).sub(cl.alpha)).add(cl.color));
      }
      return scenePart;
    })();

    // --- GTAO --------------------------------------------------------------------
    const aoPass = ao(depthTex, normalTex, camera);
    const withAO = aerialNode.mul(aoPass.getTextureNode().x);

    // --- TRAA ----------------------------------------------------------------------
    const taaed = traa(withAO, depthTex, velocityTex, camera);

    // --- bloom -----------------------------------------------------------------------
    const bloomNode = bloom(taaed, 0.28, 0.45, 1.5);
    const taaedRgb = (taaed as unknown as NV4).rgb;
    const withBloom = taaedRgb.add((bloomNode as unknown as NV4).rgb);

    // --- auto exposure (GPU-only feedback) ----------------------------------------------
    this.exposureBuf = instancedArray(2, 'float');
    const expInit = Fn(() => {
      this.exposureBuf.element(0).assign(1);
      this.exposureBuf.element(1).assign(1);
    })().compute(1);
    void renderer.computeAsync(expInit);

    const beautyForMeter = scenePass.getTextureNode('output');
    this.exposureKernel = Fn(() => {
      If(instanceIndex.greaterThanEqual(1), () => {
        Return();
      });
      const logSum = float(0).toVar();
      const N = 12;
      for (let gy = 0; gy < N; gy++) {
        for (let gx = 0; gx < N; gx++) {
          const u = (gx + 0.5) / N;
          const v = (gy + 0.5) / N;
          // center-weighted metering
          const w = 1 - 0.55 * Math.hypot(u - 0.5, (v - 0.5) * 0.9);
          const c = texture(beautyForMeter.value, vec2(u, v)).rgb;
          const lum = luminance(c).max(1e-4);
          logSum.addAssign(log2(lum).mul(w));
        }
      }
      let wTot = 0;
      for (let gy = 0; gy < N; gy++) {
        for (let gx = 0; gx < N; gx++) {
          wTot += 1 - 0.55 * Math.hypot((gx + 0.5) / N - 0.5, ((gy + 0.5) / N - 0.5) * 0.9);
        }
      }
      const avgLum = exp2(logSum.div(wTot));
      const target = clamp(float(0.16).div(avgLum), 0.18, 7.0);
      const prev = this.exposureBuf.element(0);
      this.exposureBuf.element(0).assign(mix(prev, target, 0.07));
    })().compute(1);
    this.exposureKernel.setName('autoExposure');

    // --- grade ------------------------------------------------------------------------------
    const uWB = uniform(this.grade.whiteBalance);
    const uShadowTint = uniform(this.grade.shadowTint);
    const uHighlightTint = uniform(this.grade.highlightTint);
    const uShadowAmt = uniform(0.3);
    const uHighlightAmt = uniform(0.2);
    const uSat = uniform(1.0);
    const uContrast = uniform(1.03);
    this.uniformsRefresh = (): void => {
      uShadowAmt.value = this.grade.shadowAmt;
      uHighlightAmt.value = this.grade.highlightAmt;
      uSat.value = this.grade.saturation;
      uContrast.value = this.grade.contrast;
    };

    const graded = Fn((): NV3 => {
      let c: NV3 = withBloom.mul(this.exposureBuf.element(0));
      c = c.mul(vec3(uWB));
      const lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      const shadowMask = smoothstep(0.45, 0.08, lum).mul(float(uShadowAmt));
      c = mix(c, c.mul(vec3(uShadowTint)), shadowMask);
      const hiMask = smoothstep(0.35, 0.95, lum).mul(float(uHighlightAmt));
      c = mix(c, c.mul(vec3(uHighlightTint)), hiMask);
      // saturation + gentle contrast around mid-gray
      c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, float(uSat));
      c = c.div(0.18).pow(vec3(float(uContrast))).mul(0.18);
      // restrained vignette + static grain (freeze-deterministic)
      const v = screenUV.sub(0.5);
      const vig = float(1).sub(dot(v, v).mul(0.42));
      const grain = hash12(screenUV.mul(vec2(1923.7, 1671.3))).sub(0.5).mul(0.012);
      return c.mul(vig).add(grain);
    })();

    this.post = new RenderPipeline(renderer);
    this.post.outputNode = graded;

    this.setTimeOfDay(tod);
  }

  private uniformsRefresh: () => void = () => undefined;

  setTimeOfDay(tod: number): void {
    this.grade.apply(gradeParamsAt(tod));
    this.uniformsRefresh();
  }

  /** call once per frame after render — updates exposure feedback */
  meter(renderer: Renderer): void {
    renderer.compute(this.exposureKernel);
  }

  render(): void {
    this.post.render();
  }
}

