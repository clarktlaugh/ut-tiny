import { WebGLRenderer } from 'three';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
if (!canvas) throw new Error('missing #game canvas');

const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setClearColor(0x101418);

function resize(): void {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.clear();
}

window.addEventListener('resize', resize);
resize();
