// Keep the drawing buffer and perspective matched to the preview panel.
class PreviewViewport {
  constructor(preview) {
    this.preview = preview;
    this.resize = () => {
      const { canvas, renderer, camera } = preview;
      const { width, height } = canvas.parentElement.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      const previousFit = this.fitDistance();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(Math.round(width), Math.round(height), false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      if (this.center) {
        const target = preview.controls?.target || this.center;
        camera.position.sub(target).multiplyScalar(this.fitDistance() / previousFit).add(target);
      }
    };
    this.resize();
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(preview.canvas.parentElement);
  }

  fitDistance() {
    const camera = this.preview.camera;
    const vertical = camera.fov * Math.PI / 360;
    const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
    return (this.radius || 1) * 1.15 / Math.sin(Math.min(vertical, horizontal));
  }

  frame(center, radius) {
    const { camera, controls } = this.preview;
    this.center = center.clone();
    this.radius = Math.max(radius, 0.1);
    const target = controls?.target || center;
    const direction = camera.position.clone().sub(target).normalize();
    camera.position.copy(center).addScaledVector(direction, this.fitDistance());
    camera.near = Math.max(0.001, this.radius / 1000);
    camera.far = Math.max(100, this.fitDistance() + this.radius * 10);
    camera.updateProjectionMatrix();
    camera.lookAt(center);
    if (controls) { controls.target.copy(center); controls.update(); }
  }

  stop() { this.observer.disconnect(); }
}
