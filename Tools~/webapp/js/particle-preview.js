/**
 * ParticlePreview
 * Reconstructs a Unity ParticleSystem in Three.js (r128).
 * Dual-layer rendering (bright core + soft outer halo) closely matches
 * Unity's default additive particle shaders.
 */
class ParticlePreview {
  constructor(canvas, metadata) {
    this.canvas  = canvas;
    this.meta    = metadata;
    this.running = false;
    this.rafId   = null;
    this._build();
  }

  _build() {
    const canvas = this.canvas;
    const w = canvas.clientWidth  || canvas.width  || 600;
    const h = canvas.clientHeight || canvas.height || 400;
    canvas.width  = w;
    canvas.height = h;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x080810);

    // Subtle grid for depth cues
    const grid = new THREE.GridHelper(12, 24, 0x181820, 0x181820);
    this.scene.add(grid);

    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.01, 500);
    this.camera.position.set(0, 2.5, 9);
    this.camera.lookAt(0, 2, 0);

    if (typeof THREE.OrbitControls !== 'undefined') {
      this.controls = new THREE.OrbitControls(this.camera, canvas);
      this.controls.target.set(0, 2, 0);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.07;
    }

    // ── CPU simulation arrays ─────────────────────────────────────────────
    const m     = this.meta;
    this.MAX    = Math.min(m.maxParticles || 500, 5000);
    this.pAge   = new Float32Array(this.MAX).fill(-1);  // -1 = dead
    this.pLife  = new Float32Array(this.MAX).fill(0);
    this.pVel   = new Float32Array(this.MAX * 3).fill(0);
    this.pSize0 = new Float32Array(this.MAX).fill(1);   // initial size

    // ── GPU attribute buffers (shared by both layers) ─────────────────────
    const pos    = new Float32Array(this.MAX * 3);
    const col    = new Float32Array(this.MAX * 4);   // rgba — alpha carries lifetime t
    const sizes  = new Float32Array(this.MAX);

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos,   3));
    this.geo.setAttribute('aColor',   new THREE.BufferAttribute(col,   4));
    this.geo.setAttribute('aSize',    new THREE.BufferAttribute(sizes, 1));

    // ── Vertex shader (shared) ─────────────────────────────────────────────
    const vert = `
      attribute vec4  aColor;
      attribute float aSize;
      varying   vec4  vColor;
      uniform   float uScale;
      void main() {
        vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(aSize * uScale * (400.0 / -mv.z), 1.0);
        gl_Position  = projectionMatrix * mv;
      }
    `;

    // ── LAYER 1 — Soft outer halo (large, very transparent) ───────────────
    // Mimics Unity's soft particle falloff / halo glow
    const haloMat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 2.8 } },
      vertexShader: vert,
      fragmentShader: `
        varying vec4 vColor;
        void main() {
          vec2  uv  = gl_PointCoord - 0.5;
          float r   = length(uv) * 2.0;         // 0 at centre, 1 at edge
          if (r > 1.0) discard;
          // Soft exponential falloff — matches Unity "Soft" particle shader
          float a = pow(1.0 - r, 2.5) * vColor.a * 0.45;
          gl_FragColor = vec4(vColor.rgb * 0.7, a);
        }
      `,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });

    // ── LAYER 2 — Bright core (small, solid centre) ────────────────────────
    // Mimics Unity's bright-core additive particle (fire, sparks, energy)
    const coreMat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 1.0 } },
      vertexShader: vert,
      fragmentShader: `
        varying vec4 vColor;
        void main() {
          vec2  uv  = gl_PointCoord - 0.5;
          float r   = length(uv) * 2.0;
          if (r > 1.0) discard;
          // Sharp-centre, rapid falloff — the "spark" look
          float core = pow(max(0.0, 1.0 - r * 1.4), 3.0);
          float ring = pow(max(0.0, 1.0 - r), 1.2) * 0.35;
          float a    = (core + ring) * vColor.a;
          // Slightly boost towards white at the core (overexposure sim)
          vec3  c    = mix(vColor.rgb, vec3(1.0), core * 0.5);
          gl_FragColor = vec4(c, a);
        }
      `,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });

    this.haloPoints = new THREE.Points(this.geo, haloMat);
    this.corePoints = new THREE.Points(this.geo, coreMat);
    this.scene.add(this.haloPoints);
    this.scene.add(this.corePoints);

    // ── Emission ──────────────────────────────────────────────────────────
    this.emitAccum    = 0;
    const rate        = (m.emission && m.emission.rateOverTime != null) ? m.emission.rateOverTime : 20;
    this.emitInterval = rate > 0 ? 1.0 / rate : 0.05;

    this.clock   = new THREE.Clock();
    this.running = true;
    this._loop();
  }

  // ── Main loop ─────────────────────────────────────────────────────────────
  _loop() {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(() => this._loop());

    const dt      = Math.min(this.clock.getDelta(), 0.05);
    const m       = this.meta;
    const gravity = this._constVal(m.gravityModifier, 0) * 9.81;

    // Emit new particles
    this.emitAccum += dt;
    while (this.emitAccum >= this.emitInterval) {
      this.emitAccum -= this.emitInterval;
      this._spawn(this._findDead());
    }

    const posAttr = this.geo.getAttribute('position');
    const colAttr = this.geo.getAttribute('aColor');
    const sizAttr = this.geo.getAttribute('aSize');
    const c0      = m.startColor || { r: 1, g: 0.5, b: 0, a: 1 };

    for (let i = 0; i < this.MAX; i++) {
      if (this.pAge[i] < 0) { sizAttr.array[i] = 0; continue; }

      this.pAge[i] += dt;
      const t = this.pAge[i] / this.pLife[i];

      if (t >= 1.0) { this.pAge[i] = -1; sizAttr.array[i] = 0; continue; }

      // Gravity
      this.pVel[i*3+1] -= gravity * dt;

      // Move
      posAttr.array[i*3]   += this.pVel[i*3]   * dt;
      posAttr.array[i*3+1] += this.pVel[i*3+1] * dt;
      posAttr.array[i*3+2] += this.pVel[i*3+2] * dt;

      // ── Unity-like colour over lifetime ──────────────────────────────────
      // Phase 1 (0→0.2): fade in
      // Phase 2 (0.2→0.7): full brightness
      // Phase 3 (0.7→1.0): fade + shift to darker/cooler colour
      let alpha;
      if      (t < 0.2)  alpha = t / 0.2;
      else if (t < 0.7)  alpha = 1.0;
      else               alpha = 1.0 - (t - 0.7) / 0.3;

      // Slight colour shift over life — white-hot core at birth, fades to base colour
      const heat = Math.max(0, 1 - t * 2.5);
      colAttr.array[i*4]   = Math.min(1, c0.r + heat * 0.4);
      colAttr.array[i*4+1] = Math.min(1, c0.g + heat * 0.2);
      colAttr.array[i*4+2] = Math.min(1, c0.b + heat * 0.1);
      colAttr.array[i*4+3] = alpha;

      // ── Size over lifetime ────────────────────────────────────────────────
      // Grow slightly then shrink — common in Unity fire/energy particles
      const grow   = t < 0.3 ? t / 0.3 : 1.0;
      const shrink = t > 0.6 ? 1.0 - (t - 0.6) / 0.4 : 1.0;
      sizAttr.array[i] = this.pSize0[i] * grow * shrink;
    }

    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    sizAttr.needsUpdate = true;

    if (this.controls) this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  // ── Spawn one particle at slot i ─────────────────────────────────────────
  _spawn(i) {
    const m    = this.meta;
    const pos  = this.geo.getAttribute('position');
    const col  = this.geo.getAttribute('aColor');
    const siz  = this.geo.getAttribute('aSize');

    const [px,py,pz, dx,dy,dz] = this._sampleShape(m.shape);
    const speed  = this._sampleVal(m.startSpeed,    3);
    const life   = this._sampleVal(m.startLifetime, 2);
    const sz     = this._sampleVal(m.startSize,    0.3);
    const c0     = m.startColor || { r: 1, g: 0.5, b: 0, a: 1 };

    pos.array[i*3]   = px;
    pos.array[i*3+1] = py;
    pos.array[i*3+2] = pz;

    // Initial colour (will be updated each frame)
    col.array[i*4]   = Math.min(1, c0.r + 0.4);
    col.array[i*4+1] = Math.min(1, c0.g + 0.2);
    col.array[i*4+2] = Math.min(1, c0.b + 0.1);
    col.array[i*4+3] = 0;  // start at alpha=0 (fade in)

    // Size in pixel units — calibrated to look good on a 600px canvas
    siz.array[i] = sz * 22;

    this.pVel[i*3]   = dx * speed;
    this.pVel[i*3+1] = dy * speed;
    this.pVel[i*3+2] = dz * speed;

    this.pLife[i]  = Math.max(life, 0.1);
    this.pAge[i]   = 0;
    this.pSize0[i] = sz * 22;
  }

  // ── Shape sampling ────────────────────────────────────────────────────────
  _sampleShape(shape) {
    const r = (shape && shape.radius != null) ? shape.radius : 0.5;
    const t = (shape && shape.type)           ? shape.type   : 'cone';

    if (t === 'sphere' || t === 'hemisphere') {
      const u   = Math.random(), v = Math.random();
      const th  = 2 * Math.PI * u;
      const ph  = Math.acos(t === 'hemisphere' ? v : 2*v-1);
      const x   = r * Math.sin(ph) * Math.cos(th);
      const y   = r * Math.sin(ph) * Math.sin(th);
      const z   = r * Math.cos(ph);
      const len = Math.sqrt(x*x+y*y+z*z) || 1;
      return [x, y, z, x/len, y/len, z/len];
    }
    if (t === 'box') {
      return [(Math.random()-.5)*2*r, 0, (Math.random()-.5)*2*r, 0, 1, 0];
    }
    if (t === 'circle' || t === 'edge') {
      const a = Math.random() * Math.PI * 2;
      return [Math.cos(a)*r, 0, Math.sin(a)*r, 0, 1, 0];
    }
    // Default: cone
    const angle = ((shape && shape.angle != null) ? shape.angle : 25) * Math.PI / 180;
    const a     = Math.random() * Math.PI * 2;
    const cr    = Math.random() * r;
    return [
      Math.cos(a)*cr, 0, Math.sin(a)*cr,
      Math.cos(a)*Math.sin(angle),
      Math.cos(angle),
      Math.sin(a)*Math.sin(angle)
    ];
  }

  _sampleVal(param, fallback) {
    if (!param) return fallback;
    if (param.type === 'randomBetweenTwoConstants')
      return param.min + Math.random() * (param.max - param.min);
    return (param.value != null) ? param.value : fallback;
  }
  _constVal(param, fallback) {
    if (!param) return fallback;
    return (param.value != null) ? param.value : fallback;
  }
  _findDead() {
    for (let i = 0; i < this.MAX; i++) if (this.pAge[i] < 0) return i;
    return Math.floor(Math.random() * this.MAX);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  resetCamera() {
    this.camera.position.set(0, 2.5, 9);
    this.camera.lookAt(0, 2, 0);
    if (this.controls) { this.controls.target.set(0, 2, 0); this.controls.update(); }
  }
  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.renderer.dispose();
    this.geo.dispose();
  }
}
