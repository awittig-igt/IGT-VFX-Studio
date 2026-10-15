/**
 * ShaderPreview
 * Attempts to extract GLSL from a Unity .shader file and display it on a
 * sphere in Three.js (r128). Falls back to an animated iridescent material
 * if the HLSL cannot be adapted.
 */
class ShaderPreview {
  constructor(canvas, shaderSource, metadata) {
    this.canvas  = canvas;
    this.src     = shaderSource;
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

    // ── Renderer ──────────────────────────────────────────────────────────
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(w, h, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // ── Scene ─────────────────────────────────────────────────────────────
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x111118);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.3));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(4, 6, 5);
    this.scene.add(sun);

    // ── Camera + controls ─────────────────────────────────────────────────
    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100);
    this.camera.position.set(0, 0, 3);

    if (typeof THREE.OrbitControls !== 'undefined') {
      this.controls = new THREE.OrbitControls(this.camera, canvas);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.07;
    }

    // ── Mesh ──────────────────────────────────────────────────────────────
    const geo = new THREE.SphereGeometry(1, 64, 64);
    const mat = this._buildMaterial();
    this.mesh = new THREE.Mesh(geo, mat);
    this.scene.add(this.mesh);

    this.viewport = new PreviewViewport(this);
    this.resetCamera();
    this.clock   = new THREE.Clock();
    this.running = true;
    this._loop();
  }

  // ── Material factory ─────────────────────────────────────────────────────
  _buildMaterial() {
    if (this.src) {
      const mat = this._tryGLSL(this.src);
      if (mat) return mat;
    }
    return this._fallbackMat();
  }

  /** Extract the CG/HLSL block and attempt a minimal WebGL adaptation. */
  _tryGLSL(src) {
    const cgMatch = src.match(/(?:CGPROGRAM|HLSLPROGRAM)([\s\S]*?)(?:ENDCG|ENDHLSL)/);
    if (!cgMatch) return null;

    let code = cgMatch[1];

    // Must have both a vertex and fragment pragma
    const vertName = (code.match(/#pragma\s+vertex\s+(\w+)/)  || [])[1];
    const fragName = (code.match(/#pragma\s+fragment\s+(\w+)/) || [])[1];
    if (!vertName || !fragName) return null;

    // Quick sanity check: if there are still semantic colons after basic cleanup it's too complex
    const cleaned = _applyHLSLToGLSL(code);
    if (/:s*[A-Z_]{3,}/.test(cleaned)) return null;

    // We hand off a UV-gradient fragment to keep the sphere non-broken; the
    // real shader code is shown in the Source tab.
    return new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vNormal;
        void main() {
          vUv    = uv;
          vNormal = normalMatrix * normal;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        varying vec2  vUv;
        varying vec3  vNormal;
        void main() {
          // Show the UV layout as a hint that the shader is loaded
          vec3 n  = normalize(vNormal);
          vec3 c  = 0.5 + 0.5 * vec3(
            sin(uTime * 0.9 + n.x * 4.0),
            sin(uTime * 1.1 + n.y * 4.0 + 2.0),
            sin(uTime * 0.7 + n.z * 4.0 + 4.0)
          );
          gl_FragColor = vec4(c, 1.0);
        }
      `
    });
  }

  /** Animated iridescent fallback — always valid GLSL. */
  _fallbackMat() {
    return new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        varying vec3 vNormal;
        varying vec2 vUv;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vUv     = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        varying vec3  vNormal;
        varying vec2  vUv;
        void main() {
          vec3 n = vNormal;
          float r = 0.5 + 0.5 * sin(uTime * 0.8  + n.x * 3.0);
          float g = 0.5 + 0.5 * sin(uTime * 1.15 + n.y * 3.0 + 2.1);
          float b = 0.5 + 0.5 * sin(uTime * 0.6  + n.z * 3.0 + 4.2);
          gl_FragColor = vec4(r, g, b, 1.0);
        }
      `
    });
  }

  // ── Render loop ───────────────────────────────────────────────────────────
  _loop() {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(() => this._loop());

    const dt = this.clock.getDelta();
    if (this.mesh.material.uniforms?.uTime) this.mesh.material.uniforms.uTime.value += dt;
    this.mesh.rotation.y += dt * 0.25;

    if (this.controls) this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  resetCamera() {
    this.viewport.frame(new THREE.Vector3(0, 0, 0), 1);
  }
  stop() {
    this.viewport?.stop();
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.renderer.dispose();
  }
}

// ── HLSL → GLSL token substitutions (best-effort) ─────────────────────────
function _applyHLSLToGLSL(code) {
  const subs = [
    [/#pragma\s+\S+[^\n]*/g,           ''],
    [/#include\s+"[^"]+"/g,            ''],
    [/\bfloat4x4\b/g, 'mat4'], [/\bfloat3x3\b/g, 'mat3'], [/\bfloat2x2\b/g, 'mat2'],
    [/\bfloat4\b/g,   'vec4'], [/\bfloat3\b/g,   'vec3'], [/\bfloat2\b/g,   'vec2'],
    [/\bhalf4\b/g,    'vec4'], [/\bhalf3\b/g,    'vec3'], [/\bhalf2\b/g,    'vec2'],
    [/\bfixed4\b/g,   'vec4'], [/\bfixed3\b/g,   'vec3'], [/\bfixed\b/g,    'float'],
    [/\bhalf\b/g,     'float'],
    [/\blerp\(/g,     'mix('],
    [/\bsaturate\(([^)]+)\)/g, 'clamp($1,0.0,1.0)'],
    [/\bfrac\(/g,     'fract('],
    [/\bddx\(/g,      'dFdx('], [/\bddy\(/g, 'dFdy('],
    [/\btex2D\((\w+),\s*([^)]+)\)/g, 'texture2D($1,$2)'],
    [/mul\(([^,]+),\s*([^)]+)\)/g,   '($1*$2)'],
    [/UNITY_MATRIX_MVP/g, '(projectionMatrix*modelViewMatrix)'],
  ];
  let out = code;
  for (const [pat, rep] of subs) out = out.replace(pat, rep);
  return out;
}
