/**
 * TechBackground — Canvas 科技感动态背景
 *
 * 粒子网格 + 流光脉冲 + 连线呼吸
 * 性能优化: requestAnimationFrame + offscreen 检测 + 固定粒子数
 */

import { useEffect, useRef, useCallback } from 'react';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  alpha: number;
  pulsePhase: number;
  color: string;
}

const COLORS = [
  'rgba(92, 124, 250,',   // forge blue
  'rgba(34, 197, 94,',    // green
  'rgba(6, 182, 212,',    // cyan
  'rgba(139, 92, 246,',   // violet
];

export function TechBackground({ className = '', intensity = 1 }: { className?: string; intensity?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particles = useRef<Particle[]>([]);
  const animRef = useRef<number>(0);
  const mouseRef = useRef({ x: -1000, y: -1000 });

  const initParticles = useCallback((w: number, h: number) => {
    const count = Math.floor((w * h) / 12000 * intensity);
    const ps: Particle[] = [];
    for (let i = 0; i < Math.min(count, 120); i++) {
      ps.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        r: Math.random() * 1.5 + 0.5,
        alpha: Math.random() * 0.5 + 0.1,
        pulsePhase: Math.random() * Math.PI * 2,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
      });
    }
    particles.current = ps;
  }, [intensity]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect) return;
      canvas.width = rect.width * devicePixelRatio;
      canvas.height = rect.height * devicePixelRatio;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      ctx.scale(devicePixelRatio, devicePixelRatio);
      initParticles(rect.width, rect.height);
    };

    resize();
    window.addEventListener('resize', resize);

    const handleMouse = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    canvas.addEventListener('mousemove', handleMouse);

    let time = 0;
    const animate = () => {
      const w = canvas.width / devicePixelRatio;
      const h = canvas.height / devicePixelRatio;
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      ctx.clearRect(0, 0, w, h);
      time += 0.016;

      const ps = particles.current;
      const mx = mouseRef.current.x;
      const my = mouseRef.current.y;

      // Update particles
      for (const p of ps) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = w;
        if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h;
        if (p.y > h) p.y = 0;

        // Mouse repulsion
        const dx = p.x - mx;
        const dy = p.y - my;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 100 && dist > 0) {
          const force = (100 - dist) / 100 * 0.02;
          p.vx += (dx / dist) * force;
          p.vy += (dy / dist) * force;
        }

        // Damping
        p.vx *= 0.999;
        p.vy *= 0.999;
      }

      // Draw connections
      const connectionDist = 120;
      ctx.lineWidth = 0.5;
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
          const dx = ps[i].x - ps[j].x;
          const dy = ps[i].y - ps[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < connectionDist) {
            const alpha = (1 - dist / connectionDist) * 0.15;
            const pulse = Math.sin(time * 2 + ps[i].pulsePhase) * 0.05 + alpha;
            ctx.strokeStyle = `rgba(92, 124, 250, ${Math.max(0, pulse)})`;
            ctx.beginPath();
            ctx.moveTo(ps[i].x, ps[i].y);
            ctx.lineTo(ps[j].x, ps[j].y);
            ctx.stroke();
          }
        }
      }

      // Draw particles
      for (const p of ps) {
        const pulse = Math.sin(time * 1.5 + p.pulsePhase) * 0.3 + 0.7;
        const a = p.alpha * pulse;
        ctx.fillStyle = `${p.color} ${a})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * pulse, 0, Math.PI * 2);
        ctx.fill();

        // Glow
        const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4);
        gradient.addColorStop(0, `${p.color} ${a * 0.3})`);
        gradient.addColorStop(1, `${p.color} 0)`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // Scanning line effect
      const scanY = ((time * 30) % (h + 40)) - 20;
      const scanGrad = ctx.createLinearGradient(0, scanY - 20, 0, scanY + 20);
      scanGrad.addColorStop(0, 'rgba(92, 124, 250, 0)');
      scanGrad.addColorStop(0.5, 'rgba(92, 124, 250, 0.03)');
      scanGrad.addColorStop(1, 'rgba(92, 124, 250, 0)');
      ctx.fillStyle = scanGrad;
      ctx.fillRect(0, scanY - 20, w, 40);

      // Corner accents
      const cornerSize = 60;
      const cornerAlpha = Math.sin(time) * 0.02 + 0.03;
      ctx.strokeStyle = `rgba(92, 124, 250, ${cornerAlpha})`;
      ctx.lineWidth = 1;
      // Top-left
      ctx.beginPath();
      ctx.moveTo(0, cornerSize);
      ctx.lineTo(0, 0);
      ctx.lineTo(cornerSize, 0);
      ctx.stroke();
      // Bottom-right
      ctx.beginPath();
      ctx.moveTo(w, h - cornerSize);
      ctx.lineTo(w, h);
      ctx.lineTo(w - cornerSize, h);
      ctx.stroke();

      animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('mousemove', handleMouse);
    };
  }, [initParticles]);

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 pointer-events-auto ${className}`}
      style={{ zIndex: 0 }}
    />
  );
}
