# PROJECT LAAS — STATUS (source of truth)

> **Rehydration protocol** (for an agent resuming with no context): read this file fully, then
> `PROJECT_LAAS_v2.md` (the spec — binding), then `docs/THREE-NOTES.md` (API gotchas for the
> pinned three.js), then the **Current focus** section below. Reference images: `reference/`.
> Never re-plan from scratch; continue from "Next actions". Update this file after every
> meaningful step. Commit per milestone with descriptive messages.

## Mission (1 paragraph)

Fully procedural 4×4 km open world in the browser. WebGPU only (three.js WebGPURenderer + TSL +
raw WGSL compute), TypeScript strict, zero `any`, zero external assets, deterministic by
`?seed=N`. Visual bar: the four UE5-class reference images in `reference/` (noon forest ravine
w/ cobbled streambed; gully close-up; karst tower forest in haze; golden-hour serrated alpine
vista w/ snow + cloud sea below summits — "Witcher" frame). 8 gated phases; verification by
Playwright screenshots compared against references; `DELTA.md` loop each phase. Must ALSO be
smooth + explorable interactively by the user (fly camera, ToD control, bookmarks) — user
feedback comes in chat; the two-frame test is the agent-side acceptance only.

## Hard rules digest (full text = spec §)

- No black/gray shadows (Pillar B); no bare terrain within 10 m (Pillar A/§9); no cloned trees;
  no smooth silhouettes on hero rock/tree; no fog-as-cover; no `MeshBasicMaterial`; no CPU
  per-instance updates; no one-file architecture; never ask user to lower the bar.
- Floors (§2): ≥5M tris forest hero / ≥3M vista post-culling; 4096² heightfield sim; erosion
  ≥500 iters @ ≥2048²; ≥6 tree species w/ per-instance uniqueness; hero tree ≥100k tris; hero
  rock ≥200k tris; grass ≥800k blades; debris ≥80k; particles ≥100k; visible range ≥4 km;
  ≥5 biomes incl. alpine snow; probes ≥24×24×6 per chunk; CSM 4×≥2048² + PCSS + contact
  shadows; raymarched 2-layer clouds + cloud shadows; Hillaire atmosphere; 60 fps @ 1440p
  target hardware class.
- Infeasible item → nearest feasible alternative + entry in `DEVIATIONS.md`. A closed phase has
  zero TODOs in its code.

## Verified environment facts

- macOS 26.4 (Darwin 25.4.0), Apple **M1 Max 32-core GPU**, Metal 4, 3456×2234 display.
- Node v22.12.0, npm 10.9.0. Git repo initialized on `main` (no remote).
- three.js pinned: **0.184.0** (latest on npm as of 2026-06-10). VERIFY APIs against
  `node_modules/three/` source before use — do not trust memory for TSL surface.
- **Playwright WebGPU recipe (SOLVED)**: `chromium.launch({ headless: true, channel: 'chromium' })`
  → apple/metal-3 adapter. Two traps: (1) WebGPU only exists on secure contexts — probe on
  http://localhost:5173, never about:blank; (2) default Playwright headless = GPU-less
  "headless shell"; `channel:'chromium'` selects full Chromium new-headless. Cached in
  `.cache/webgpu-flags.json` by tools/launch.ts.
- Dev server: `npm run dev` (background, port 5173 strict). Shots:
  `npx tsx tools/shoot.ts --scene X --cam "..." --out shots/x.png [--hud 1] [--stats f.json]`.
  Compare: `npx tsx tools/compare.ts --a ours.png --b reference/sceneN.png --out cmp.png`.
  Pixel sampling (shadow-color test): `--sample img.png --px "x,y;x,y"`.
- Sanity scene measured (1080p, M1 Max): 3.1M tris @ 117 fps, render 7.2 ms — lots of headroom.

## Phase checklist

- [x] **Phase 0** — DONE 2026-06-10. Scaffold, WebGPU init + fail-loud diagnostics, HUD, fly
      camera, params, Playwright shot harness (headless WebGPU working), compare tool. Gate
      passed: `shots/phase-0/cmp_sanity_vs_scene1.png`. Proven: compute→storage→instanced draw,
      compute→StorageTexture→sampling, TSL vertex displacement, CPU procedural geometry,
      GPU timestamps, deterministic seeding.
- [x] **Phase 1** — DONE 2026-06-11. 4096² synth (macro layout: NE massif/valley/karst/lake w/
      outlet), pipe erosion 640 it @2048 (hardness-aware thermal), multigrid lake fill, particle
      flow accumulation → carved rivers, moisture, biome+snow classify (coarse-slope hold +
      couloirs + ledges + dither), CDLOD instanced tiles + far shell w/ analytic normals +
      far-detail normal synthesis, PBR splat material (strata/iron bands/lichen/macro variation/
      wet darkening/snow), erosion split view, ground-clamped camera (`x/z/alt/yaw`), CPU height
      readback. Gates passed; see docs/DELTA.md Phase 1. Artifacts: shots/phase-1/.
- [ ] **Phase 2** — Hillaire LUT atmosphere + aerial perspective; EV auto-exposure; IBL from sky;
      CSM×4 + PCSS + screen-space contact shadows; volumetric clouds + temporal reproj + cloud
      shadows; TAA, GTAO, bloom, per-ToD filmic grade (teal-orange golden). Gate: golden vista vs
      Witcher ref; shadow-color test.
- [ ] **Phase 3** — irradiance probe clipmap (GPU, time-sliced, sky+sun+bounce), GTAO tuning,
      screen-space bounce, foliage translucency. Gate: forest interior vs scene1; no-black-shadows.
- [ ] **Phase 4** — generators: 6+ tree species (per-instance growth), rocks/cliffs, grass, ferns,
      shrubs×3, flowers×4 (incl. pink shrub), deadfall, debris classes, procedural texture arrays,
      dressing systems (moss/vines/ledge ferns/root flare/fungi/staining), octahedral impostors,
      `?scene=gallery`. Gate: gallery sheet + macro-meso-micro audit.
- [ ] **Phase 5** — GPU scatter (clustered Poisson, density fns), chunk streaming, meshlet/cluster
      culling + Hi-Z + indirect, LOD/impostor transitions (dithered), far forests as canopy
      shells. Gate: repetition flight; throughput floors (HUD-verified).
- [ ] **Phase 6** — stream water (refraction/caustics/foam/wet margins), lakes (planar refl),
      hierarchical wind, froxel volumetrics (canopy shafts, valley fog), GPU particles
      (snow/pollen/leaves). Gate: streambed close-up vs scene1/2.
- [ ] **Phase 7** — perf pass (60fps@1440p / reduced preset), HUD full (per-pass GPU timings),
      9 bookmarks, 90s flythrough, full battery, final two-frame test, self-score rubric.
- [ ] **Tier 3** — only after battery passes (see spec §11).

## Current focus

**Phase 2 — atmosphere, shadows, clouds, post.** STATE AS OF 2026-06-11 (checkpoint for
context compaction — everything below is BUILT, COMPILING, and RENDERING unless noted):

1. [x] `src/sky/Atmosphere.ts` — Hillaire LUTs (transmittance 256×64, multiscatter 32²,
       sky-view 192×108 w/ ground-lit horizon term), sun disc, SUN_E=8 unit contract
       (LUT samples ×SUN_E; sun light = SUN_E·CPU-transmittance), aerial() = analytic
       atmosphere + boundary-layer height fog (FOG_K 0.22, H0 0.16 km, HF 0.38 km).
2. [x] `src/sky/SunSky.ts` — ToD sun model (sunDirection static fn), transmittance-tinted
       DirectionalLight, sky backgroundNode, CubeCamera IBL (NOT visibly contributing —
       hemisphere ambient stopgap added; Phase 3 probes replace it), `[`/`]` keys step ToD.
3. [x] `src/render/ShadowSetup.ts` — CSMShadowNode 4×2048 + custom PCSS filterNode
       (blocker search → penumbra Vogel PCF) + optional cloudShadow multiplier (gates sun
       only). VERIFIED: cast shadows + blue ambient fill in shots/wip/shadows-v4.png.
4. [x] `src/sky/Clouds.ts` — perlin-worley 96³ + detail 32³ noise baked, layer 1250–1900 m,
       march() with Beer–Powder + dual-HG, top-down cloud shadow map (768²) sampled via
       shadowAt() in the PCSS filter. INTEGRATED into post; **NOT YET VISIBLE in test shot**
       (shots/wip/clouds-v1.png) — next step: tune coverage/density/weather mapping, verify
       the slab intersection math, possibly raise coverage 0.46→0.6 to debug.
5. [x] `src/render/PostStack.ts` — RenderPipeline: scene MRT pass (output/normal/velocity/
       depth) → aerial+clouds (depth-reconstructed world pos) → GTAO ×mul → TRAA → bloom →
       GPU auto-exposure (12×12 log-avg into storage buffer, no readback; meter() each
       frame) → ColorScript grade (per-ToD keyframes in `src/render/ColorScript.ts`,
       teal-orange at golden) → AgX. Engine renders via `engine.post`.
6. [ ] REMAINING for Phase 2 close: clouds visible + tuned (incl. shots with cloud sea below
       summits per Witcher ref), screen-space contact shadows in post, golden-hour gate shot
       vs reference + shadow-color test (sample 16 shadowed px, chroma must not be gray),
       DELTA + fix top 3, commit, mark task #3 done.

## Next actions (always keep current)

- Debug cloud visibility: shoot with coverage uniform pushed up (e.g. 0.75); check march()
  slab intersection (camera ABOVE layer looking down = tEnter/tExit both behind? handled),
  weather field sign, density scale. Then golden-hour vista with clouds among peaks.
- Then: contact shadows post node; gate battery; close Phase 2.
- KNOWN visual debts: scene still washy/low-contrast (tune exposure key/grade at gate);
  IBL env-map path dead (hemisphere covers it); snow on south hero face sparse (gate call).

## Key decisions log

- **D1** Pin three@0.184.0; mitigation for API drift: read installed source, keep notes in
  docs/THREE-NOTES.md. Downgrade to 0.180.x only if 0.184 breaks something structural.
- **D2** Tracking: STATUS.md (this file) = source of truth; harness task list mirrors phases
  (tasks #1–#8 = phases 0–7); git commit per milestone. DELTA.md / DEVIATIONS.md per spec.
- **D3** World macro-layout is code-guided for art direction (composed, per Pillar E): main
  glacial U-valley NE→SW with river → lake in SW low corner; serrated alpine massif N/NE
  (Witcher frame); tower-karst forest ravine biome center-S (scene1/3); meadows + rolling
  forest between; wetland margin at lake. Detail fully procedural + seed-driven.
- **D4** Verification screenshots: prefer headless Playwright Chromium with WebGPU/Metal flags;
  fall back to headed if headless adapter unavailable. (Resolved Phase 0 → record flags above.)
- **D5** Per-instance tree uniqueness strategy: K structural variants per species per LOD ring
  + continuous per-instance GPU deformation (lean/droop/crown asymmetry/age/hue) + bespoke
  unique meshes for nearest hero trees (background-generated, cached). Document in DEVIATIONS.
- **D6** Erosion default 2048² active grid (spec floor) on 4096² synth field; `?quality=ultra`
  runs 4096². Decide final default by measured load time (~budget ≤15 s gen).

## Architecture map (planned; update as built)

```
src/core/      Engine, Diagnostics, Params, Seed, Profiler, Quality presets
src/gpu/       passes/ (Heightfield, Erosion, Flow, Biome, Scatter, Cull, Probes, Clouds,
               Froxel, Wind, Particles, TexSynth), HiZ, indirect helpers, noise lib (TSL+WGSL)
src/world/     Heightfield(owner of terrain textures), TerrainTiles(quadtree+meshlets),
               Streaming, Biomes, Rivers, Lakes, Snow
src/vegetation/ TreeBuilder + species/, RockBuilder, GrassSystem, Shrubs, Flowers, Ferns,
               Debris, Deadfall, Dressing, Impostors
src/render/    Materials (terrain/bark/foliage/rock/water TSL), ShadowSetup(CSM+PCSS+contact),
               GIProbes, PostStack (TAA/GTAO/bloom/grade/DoF), AutoExposure
src/sky/       AtmosphereLUTs, SkyModel, SunIBL, Clouds
src/debug/     HUD, Scenes (gallery/terrain/...), Bookmarks, Flythrough, Compare overlay
tools/         shoot.ts, compare.ts, battery.ts (Playwright verification battery)
shots/         screenshot output (gitignored except curated phase closes → shots/phase-N/)
docs/          THREE-NOTES.md (API gotchas), DELTA.md, DEVIATIONS.md, COLOR-SCRIPT.md
```

## Reference image analysis (art targets)

- `scene1.png` 1920×1080-class, noon ravine: cobbled dry streambed w/ trickle, rounded mossy
  boulders, dark cliff overhangs framing top corners, lush karst towers midground, luminous
  white-blue haze bg. Shadows: blue-gray on rock, green-filled in foliage. Value structure:
  dark frame → lit mid → bright bg.
- `scene2.png` gully close-up: deadfall logs across cobbles, deep-green mossy overhang (shadowed
  but COLORFUL), sunlit tower behind.
- `scene3.png` karst forest vista: dozens of vegetated rock towers receding through 4+ haze
  layers; canopy sea between towers; soft broken-cloud toplight.
- `02_Silver_Demo_Wallpaper...png` (Witcher IV, 3840×2160): golden hour alpine; dark foreground
  outcrop + figure (silhouette framing); serrated rust-red peaks w/ slope-correct snow; conifer
  slopes down to huge hazy valley; cloud sea BELOW summits wrapping ridges; god rays from
  upper-left sun; teal-orange split (warm rock/lit conifers vs cool snow shadows/valley haze);
  scattered dead snags on right slope.
- Implied landforms: serrated ridged massif + vertical-walled tower karst + glacial valley.
  Terrain synthesis needs an explicit tower/mesa formation term, not just ridged fBm.

## Phase 1 progress snapshot (2026-06-10)

Done: synthesis (macro layout + karst towers + anisotropic ridges), pipe-model erosion
(hardness-aware thermal), multigrid lake fill, particle flow accumulation, river carve +
channel enforcement, lake w/ outlet, moisture; debug hillshade preview + `?view=hydro`.
Remaining for phase close: TerrainTiles (CDLOD quadtree + far shell), real PBR terrain
material (triplanar/splats/snow/macro variation), biome+snow classify pass, `?scene=terrain`
split view, ground-clamped camera helper, silhouette/tiling gate + DELTA.md.

## Gotchas / lessons learned (append-only)

- WebGPU secure-context + headless-shell traps → see "Verified environment facts".
- TSL `.assign()/.addAssign()/.toVar()` require an active stack (inside `Fn()`); material node
  graphs are NOT inside Fn → shared TSL helpers must be pure expression builders (NoiseTSL is).
- @types/three 0.184 types nodes generically: use `Node<'vec3'>` aliases from `src/gpu/TSLTypes.ts`
  (`NF/NV2/NV3/NV4…`); bare `Node` has no operators/swizzles.
- `three` and `three/webgpu` both re-export from `three.core.js` — safe to mix imports.
- `StorageTexture` defaults rgba8unorm + `mipmapsAutoUpdate=true` (auto mips after compute
  writes when generateMipmaps). For float data set `.type = FloatType` etc.
- Verify cast shadows w/ custom `positionNode` on instanced meshes when real shadows land
  (Phase 2) — sanity scene shadows looked absent; may need `material.shadowPositionNode`.
- Compute storage-buffer limit: default 8 per stage — request more via
  `requiredLimits` (done in Engine; adapter max here = 10) AND keep kernels lean.
- TSL atomics: `instancedArray(n,'uint').toAtomic()`; then ALL access via
  atomicStore/atomicAdd/atomicLoad; `float(atomicLoad(...) as unknown as NU)` for reads
  (AtomicFunctionNode lacks value-typed methods in @types).
- mx_noise/mx_fractal outputs are SIGNED — remap explicitly or lowlands sink below
  lake level ("puddle plague").
- Relaxation-style fills propagate ~1 cell/iter: ALWAYS multigrid them.
- A lake without an outlet river floods its valley to the spill saddle.
- Endless-loop debug rule: when iterating visual passes "with no effect", first verify the
  served code changed (curl the module), THEN check upstream state assumptions.
- Per-component Rng streams (seed.rng('x')): adding draws must never re-roll other systems.
- 1D dispatch >65535 workgroups: three auto-splits to 2D and instanceIndex stays linear —
  but pad-guard every kernel (`If(i >= N) Return()`).
